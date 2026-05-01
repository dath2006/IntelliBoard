from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.agent.schemas import ProjectSnapshotV2, SnapshotBoard, SnapshotFile
from app.agent.sessions import (
    append_event,
    apply_draft_to_project,
    create_session,
    discard_draft,
    list_sessions,
    load_draft_snapshot,
    replay_events,
    update_draft_snapshot,
)
from app.database.session import Base
from app.models.agent_session import AgentSession  # noqa: F401
from app.models.agent_session_event import AgentSessionEvent  # noqa: F401
from app.models.project import Project
from app.models.usage_event import UsageEvent  # noqa: F401
from app.models.user import User


def snapshot(board_kind: str = "arduino-uno") -> ProjectSnapshotV2:
    board_id = board_kind
    group_id = f"group-{board_id}"
    return ProjectSnapshotV2(
        boards=[
            SnapshotBoard(
                id=board_id,
                boardKind=board_kind,
                x=50.0,
                y=50.0,
                activeFileGroupId=group_id,
            )
        ],
        activeBoardId=board_id,
        fileGroups={group_id: [SnapshotFile(name="sketch.ino", content="void setup(){}")]},
        activeGroupId=group_id,
    )


@pytest_asyncio.fixture
async def db_session(tmp_path):
    db_path = tmp_path / "agent_sessions.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as session:
        yield session
    await engine.dispose()


async def create_user(db_session, user_id: str = "user-1") -> User:
    user = User(id=user_id, username=f"{user_id}-name", email=f"{user_id}@example.com")
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest.mark.asyncio
async def test_create_and_list_sessions(db_session):
    user = await create_user(db_session)

    created = await create_session(
        db_session,
        user_id=user.id,
        project_id="project-1",
        base_snapshot=snapshot(),
        model_name="openai:gpt-5.2",
    )
    sessions = await list_sessions(db_session, user_id=user.id, project_id="project-1")

    assert created.id == sessions[0].id
    assert sessions[0].status == "queued"
    assert sessions[0].model_name == "openai:gpt-5.2"
    assert sessions[0].base_snapshot_json == sessions[0].draft_snapshot_json


@pytest.mark.asyncio
async def test_event_sequence_and_replay_ordering(db_session):
    user = await create_user(db_session)
    session = await create_session(db_session, user_id=user.id, base_snapshot=snapshot())

    first = await append_event(db_session, session_id=session.id, event_type="tool.started", payload={"tool": "a"})
    second = await append_event(db_session, session_id=session.id, event_type="tool.finished", payload={"tool": "a"})
    replayed = await replay_events(db_session, session_id=session.id, after_seq=1)

    assert first.seq == 1
    assert second.seq == 2
    assert [event.seq for event in replayed] == [2]
    assert replayed[0].event_type == "tool.finished"


@pytest.mark.asyncio
async def test_update_and_load_draft_snapshot(db_session):
    user = await create_user(db_session)
    session = await create_session(db_session, user_id=user.id, base_snapshot=snapshot())
    draft = snapshot("esp32")

    await update_draft_snapshot(
        db_session,
        session_id=session.id,
        user_id=user.id,
        draft_snapshot=draft,
        status="running",
    )
    loaded = await load_draft_snapshot(db_session, session_id=session.id, user_id=user.id)

    assert loaded.activeBoardId == "esp32"
    assert loaded.boards[0].boardKind == "esp32"


@pytest.mark.asyncio
async def test_discard_draft_resets_to_base(db_session):
    user = await create_user(db_session)
    session = await create_session(db_session, user_id=user.id, base_snapshot=snapshot())
    await update_draft_snapshot(
        db_session,
        session_id=session.id,
        user_id=user.id,
        draft_snapshot=snapshot("esp32"),
    )

    discarded = await discard_draft(db_session, session_id=session.id, user_id=user.id)
    loaded = await load_draft_snapshot(db_session, session_id=session.id, user_id=user.id)

    assert discarded.status == "stopped"
    assert loaded.activeBoardId == "arduino-uno"


@pytest.mark.asyncio
async def test_apply_draft_updates_project_snapshot(db_session):
    user = await create_user(db_session)
    project = Project(
        id="project-1",
        user_id=user.id,
        name="Project",
        slug="project",
        board_type="arduino-uno",
    )
    db_session.add(project)
    await db_session.commit()

    session = await create_session(
        db_session,
        user_id=user.id,
        project_id=project.id,
        base_snapshot=snapshot(),
    )
    await update_draft_snapshot(
        db_session,
        session_id=session.id,
        user_id=user.id,
        draft_snapshot=snapshot("esp32"),
    )

    applied, draft, updated_project = await apply_draft_to_project(
        db_session,
        session_id=session.id,
        user_id=user.id,
    )

    assert applied.status == "waiting_approval"
    assert draft.activeBoardId == "esp32"
    assert updated_project is not None
    assert updated_project.snapshot_json == applied.draft_snapshot_json
    assert updated_project.board_type == "esp32"
    assert updated_project.code == "void setup(){}"
    assert applied.base_snapshot_json == applied.draft_snapshot_json
