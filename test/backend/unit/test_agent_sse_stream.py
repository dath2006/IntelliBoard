from __future__ import annotations

import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes.agent_sessions import router as agent_router
from app.core.dependencies import require_auth
from app.database.session import Base, get_db
from app.models.agent_session import AgentSession  # noqa: F401
from app.models.agent_session_event import AgentSessionEvent  # noqa: F401
from app.models.project import Project
from app.models.usage_event import UsageEvent  # noqa: F401
from app.models.user import User


@pytest_asyncio.fixture
async def api_context(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'agent_sse.db'}", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:
        user = User(id="user-1", username="alice", email="alice@example.com")
        project = Project(
            id="project-1",
            user_id=user.id,
            name="Project",
            slug="project",
            board_type="arduino-uno",
            code="void setup(){} void loop(){}",
            components_json="[]",
            wires_json="[]",
        )
        session.add_all([user, project])
        await session.commit()

    app = FastAPI()
    app.include_router(agent_router, prefix="/api/agent")

    async def override_get_db():
        async with Session() as session:
            yield session

    async def override_require_auth():
        async with Session() as session:
            return await session.get(User, "user-1")

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_auth] = override_require_auth

    with TestClient(app) as client:
        yield client

    await engine.dispose()


def test_sse_stream_replays_events(api_context: TestClient):
    create_res = api_context.post("/api/agent/sessions", json={"projectId": "project-1"})
    assert create_res.status_code == 201
    session_id = create_res.json()["id"]

    message_res = api_context.post(
        f"/api/agent/sessions/{session_id}/messages",
        json={"message": "hello"},
    )
    assert message_res.status_code == 200

    url = f"/api/agent/sessions/{session_id}/events"
    response = api_context.get(url)

    assert response.status_code == 200
    assert "event: session.created" in response.text
    assert "event: message.received" in response.text
    assert response.text.index("event: session.created") < response.text.index("event: message.received")

    replay_response = api_context.get(url, params={"after": 1})
    assert replay_response.status_code == 200
    assert "event: session.created" not in replay_response.text
    assert "event: message.received" in replay_response.text


def test_sse_disconnect_reconnect_replays_after_seq(api_context: TestClient):
    create_res = api_context.post("/api/agent/sessions", json={"projectId": "project-1"})
    assert create_res.status_code == 201
    session_id = create_res.json()["id"]

    stream_url = f"/api/agent/sessions/{session_id}/events?stream=true"
    last_seq = None
    with api_context.stream("GET", stream_url, timeout=2.0) as response:
        assert response.status_code == 200
        for line in response.iter_lines():
            if not line:
                continue
            text = line.decode() if isinstance(line, bytes) else line
            if text.startswith("id:"):
                last_seq = int(text.split(":", 1)[1].strip())
            if "event: session.created" in text and last_seq is not None:
                break

    assert last_seq is not None

    message_res = api_context.post(
        f"/api/agent/sessions/{session_id}/messages",
        json={"message": "reconnect"},
    )
    assert message_res.status_code == 200

    replay_url = f"/api/agent/sessions/{session_id}/events"
    replay_res = api_context.get(replay_url, params={"after": last_seq})
    assert replay_res.status_code == 200
    assert "event: message.received" in replay_res.text
