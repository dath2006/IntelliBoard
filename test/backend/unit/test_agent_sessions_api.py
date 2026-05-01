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
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'agent_api.db'}", echo=False)
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


def test_session_create_list_message_events_and_stop(api_context: TestClient):
    create_res = api_context.post("/api/agent/sessions", json={"projectId": "project-1"})
    assert create_res.status_code == 201
    session_id = create_res.json()["id"]

    list_res = api_context.get("/api/agent/sessions", params={"project_id": "project-1"})
    assert list_res.status_code == 200
    assert list_res.json()[0]["id"] == session_id

    message_res = api_context.post(
        f"/api/agent/sessions/{session_id}/messages",
        json={"message": "Build a blinking LED"},
    )
    assert message_res.status_code == 200
    assert message_res.json()["status"] == "queued"

    events_res = api_context.get(f"/api/agent/sessions/{session_id}/events")
    assert events_res.status_code == 200
    text = events_res.text
    assert "event: session.created" in text
    assert "event: message.received" in text

    stop_res = api_context.post(f"/api/agent/sessions/{session_id}/stop")
    assert stop_res.status_code == 200
    assert stop_res.json()["status"] == "stopped"


def test_session_apply_and_discard(api_context: TestClient):
    create_res = api_context.post("/api/agent/sessions", json={"projectId": "project-1"})
    session_id = create_res.json()["id"]

    apply_res = api_context.post(f"/api/agent/sessions/{session_id}/apply")
    assert apply_res.status_code == 200
    assert apply_res.json()["status"] == "waiting_approval"

    discard_res = api_context.post(f"/api/agent/sessions/{session_id}/discard")
    assert discard_res.status_code == 200
    assert discard_res.json()["status"] == "stopped"


def test_session_create_rejects_missing_source(api_context: TestClient):
    res = api_context.post("/api/agent/sessions", json={})

    assert res.status_code == 422
