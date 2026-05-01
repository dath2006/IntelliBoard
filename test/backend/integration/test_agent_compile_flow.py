from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.agent import snapshot_ops
from app.agent import tools as agent_tools
from app.agent.schemas import ProjectSnapshotV2, SnapshotBoard, SnapshotFile
from app.agent.sessions import create_session, load_draft_snapshot, update_draft_snapshot
from app.database.session import Base
from app.models.user import User


class CompileRecorder:
    def __init__(self):
        self.calls: list[tuple[list[dict[str, str]], str]] = []

    async def __call__(self, files: list[dict[str, str]], fqbn: str) -> dict[str, object]:
        self.calls.append((files, fqbn))
        return {
            "success": True,
            "stdout": "ok",
            "stderr": "",
            "hex_content": "00",
        }


@pytest_asyncio.fixture
async def db_context(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'agent_compile.db'}", echo=False)
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


@pytest.mark.asyncio
async def test_agent_compile_flow_invalidates_on_changes(db_context):
    session, Session = db_context
    user = await create_user(session)

    agent_session = await create_session(session, user_id=user.id, base_snapshot=base_snapshot())
    draft = await load_draft_snapshot(session, session_id=agent_session.id, user_id=user.id)

    recorder = CompileRecorder()
    result = await agent_tools.compile_board(
        draft,
        board_id="arduino-uno",
        compile_adapter=recorder,
    )

    assert result["success"] is True
    assert recorder.calls[0][1] == "arduino:avr:uno"
    assert recorder.calls[0][0][0]["name"] == "sketch.ino"

    updated, _ = snapshot_ops.replace_file_range(
        draft,
        group_id="group-arduino-uno",
        file_name="sketch.ino",
        start_line=1,
        end_line=1,
        replacement="void setup(){}\n",
    )
    assert updated.compileState["arduino-uno"].reason == "file_changed"
    await update_draft_snapshot(
        session,
        session_id=agent_session.id,
        user_id=user.id,
        draft_snapshot=updated,
    )

    result2 = await agent_tools.compile_board(
        updated,
        board_id="arduino-uno",
        compile_adapter=recorder,
    )
    assert result2["success"] is True

    changed, _ = snapshot_ops.change_board_kind(
        updated,
        board_id="arduino-uno",
        board_kind="raspberry-pi-3",
    )
    assert changed.compileState["arduino-uno"].reason == "board_kind_changed"

    result3 = await agent_tools.compile_board(
        changed,
        board_id="arduino-uno",
        compile_adapter=recorder,
    )
    assert result3["success"] is False
    assert result3["readiness"]["issues"][0]["code"] == "not_compilable"
