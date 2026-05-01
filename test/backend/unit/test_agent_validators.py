from app.agent.board_mapping import fqbn_for_board_kind
from app.agent.schemas import ProjectSnapshotV2, SnapshotBoard, SnapshotFile
from app.agent.validators import (
    validate_compile_readiness,
    validate_pin_mapping,
    validate_snapshot,
)


def snapshot(board_kind: str = "arduino-uno", with_files: bool = True) -> ProjectSnapshotV2:
    group_id = "group-board"
    return ProjectSnapshotV2(
        boards=[
            SnapshotBoard(
                id="board",
                boardKind=board_kind,
                x=0.0,
                y=0.0,
                activeFileGroupId=group_id,
            )
        ],
        activeBoardId="board",
        fileGroups={group_id: [SnapshotFile(name="sketch.ino", content="code")] if with_files else []},
        activeGroupId=group_id,
    )


def test_board_kind_to_fqbn_mapping():
    assert fqbn_for_board_kind("arduino-uno") == "arduino:avr:uno"
    assert fqbn_for_board_kind("raspberry-pi-3") is None


def test_validate_snapshot_rejects_unknown_board_kind_semantically():
    snap = ProjectSnapshotV2.model_construct(
        version=2,
        boards=[
            SnapshotBoard.model_construct(
                id="board",
                boardKind="unknown-board",
                x=0.0,
                y=0.0,
                languageMode="arduino",
                activeFileGroupId="group-board",
            )
        ],
        activeBoardId="board",
        components=[],
        wires=[],
        fileGroups={"group-board": []},
        activeGroupId="group-board",
    )

    result = validate_snapshot(snap)

    assert result.ok is False
    assert result.issues[0].code == "unsupported_board_kind"


def test_validate_pin_mapping_passes_for_clean_snapshot():
    result = validate_pin_mapping(snapshot())

    assert result.ok is True


def test_validate_compile_readiness_success():
    result = validate_compile_readiness(snapshot(), board_id="board")

    assert result.ok is True
    assert result.fqbn == "arduino:avr:uno"


def test_validate_compile_readiness_missing_board():
    result = validate_compile_readiness(snapshot(), board_id="missing")

    assert result.ok is False
    assert result.issues[0].code == "missing_board"


def test_validate_compile_readiness_non_compilable_board():
    result = validate_compile_readiness(snapshot("raspberry-pi-3"), board_id="board")

    assert result.ok is False
    assert result.issues[0].code == "not_compilable"


def test_validate_compile_readiness_missing_files():
    result = validate_compile_readiness(snapshot(with_files=False), board_id="board")

    assert result.ok is False
    assert result.issues[0].code == "missing_files"
