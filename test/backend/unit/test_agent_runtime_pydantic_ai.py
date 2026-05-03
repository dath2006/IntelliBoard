from __future__ import annotations

import json

import pytest
import pytest_asyncio
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.agent.agent import run_agent_session
from app.agent.schemas import ProjectSnapshotV2, SnapshotBoard, SnapshotFile
from app.agent.sessions import create_session, replay_events
from app.core.config import settings
from app.database.session import Base
from app.models.user import User


def base_snapshot() -> ProjectSnapshotV2:
    board_id = "arduino-uno"
    group_id = f"group-{board_id}"
    return ProjectSnapshotV2(
        boards=[
            SnapshotBoard(
                id=board_id,
                boardKind=board_id,
                x=50.0,
                y=50.0,
                activeFileGroupId=group_id,
            )
        ],
        activeBoardId=board_id,
        fileGroups={group_id: [SnapshotFile(name="sketch.ino", content="void setup(){}\n")]},
        activeGroupId=group_id,
    )


@pytest_asyncio.fixture
async def db_context(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'agent_runtime.db'}", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as session:
        yield session, Session
    await engine.dispose()


async def create_user(session, user_id: str = "user-1") -> User:
    user = User(id=user_id, username=f"{user_id}-name", email=f"{user_id}@example.com")
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


@pytest.mark.asyncio
async def test_run_agent_session_with_test_model(db_context, monkeypatch):
    session, Session = db_context
    user = await create_user(session)
    agent_session = await create_session(session, user_id=user.id, base_snapshot=base_snapshot())

    monkeypatch.setattr(settings, "AGENT_ENABLED", True)
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "test-key")

    output = await run_agent_session(
        agent_session.id,
        user.id,
        "Ping",
        model_override=TestModel(call_tools=[]),
        session_factory=Session,
    )

    assert output == "success (no tool calls)"

    async with Session() as check_session:
        events = await replay_events(check_session, session_id=agent_session.id)
        event_types = [event.event_type for event in events]

    assert "run.started" in event_types
    assert "run.completed" in event_types


async def stream_tool_call_model(messages, _agent_info):
    for msg in messages:
        parts = getattr(msg, "parts", [])
        if any(isinstance(part, ToolReturnPart) for part in parts):
            yield "done"
            return
    yield {0: DeltaToolCall(name="get_project_outline", json_args="{}", tool_call_id="call-1")}


@pytest.mark.asyncio
async def test_run_agent_session_emits_tool_events(db_context, monkeypatch):
    session, Session = db_context
    user = await create_user(session, "user-2")
    agent_session = await create_session(session, user_id=user.id, base_snapshot=base_snapshot())

    monkeypatch.setattr(settings, "AGENT_ENABLED", True)
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "test-key")

    output = await run_agent_session(
        agent_session.id,
        user.id,
        "Outline",
        model_override=FunctionModel(stream_function=stream_tool_call_model),
        session_factory=Session,
    )

    assert output == "done"

    async with Session() as check_session:
        events = await replay_events(check_session, session_id=agent_session.id)
        event_types = [event.event_type for event in events]

    assert "tool.call.started" in event_types
    assert "tool.call.result" in event_types
    started = next(event for event in events if event.event_type == "tool.call.started")
    result = next(event for event in events if event.event_type == "tool.call.result")
    started_payload = json.loads(started.payload_json or "{}")
    result_payload = json.loads(result.payload_json or "{}")
    assert "input" in started_payload
    assert started_payload.get("tool") == "get_project_outline"
    assert "output" in result_payload
