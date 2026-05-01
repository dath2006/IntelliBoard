import pytest
from pydantic import ValidationError

from app.agent.schemas import (
    ConnectPinsInput,
    ProjectSnapshotV2,
    ReplaceFileRangeInput,
    SnapshotBoard,
    SnapshotComponent,
    SnapshotFile,
    SnapshotWire,
)


def valid_snapshot() -> ProjectSnapshotV2:
    return ProjectSnapshotV2(
        boards=[
            SnapshotBoard(
                id="arduino-uno",
                boardKind="arduino-uno",
                x=50.0,
                y=50.0,
                activeFileGroupId="group-arduino-uno",
            )
        ],
        activeBoardId="arduino-uno",
        components=[
            SnapshotComponent(
                id="led-1",
                metadataId="led",
                x=320.0,
                y=120.0,
                properties={"color": "red"},
            )
        ],
        wires=[
            SnapshotWire.model_validate(
                {
                    "id": "wire-1",
                    "start": {"componentId": "arduino-uno", "pinName": "13", "x": 0.0, "y": 0.0},
                    "end": {"componentId": "led-1", "pinName": "A", "x": 0.0, "y": 0.0},
                    "waypoints": [],
                    "color": "#22c55e",
                }
            )
        ],
        fileGroups={
            "group-arduino-uno": [
                SnapshotFile(name="sketch.ino", content="void setup(){} void loop(){}")
            ]
        },
        activeGroupId="group-arduino-uno",
    )


def test_accepts_valid_snapshot():
    snapshot = valid_snapshot()

    assert snapshot.version == 2
    assert snapshot.activeBoardId == "arduino-uno"
    assert snapshot.components[0].metadataId == "led"


def test_accepts_zero_board_analog_snapshot():
    snapshot = ProjectSnapshotV2(
        boards=[],
        activeBoardId=None,
        components=[
            SnapshotComponent(id="r1", metadataId="resistor", x=10.0, y=10.0, properties={}),
            SnapshotComponent(id="c1", metadataId="capacitor", x=100.0, y=10.0, properties={}),
        ],
        wires=[
            SnapshotWire.model_validate(
                {
                    "id": "wire-rc",
                    "start": {"componentId": "r1", "pinName": "2", "x": 0.0, "y": 0.0},
                    "end": {"componentId": "c1", "pinName": "1", "x": 0.0, "y": 0.0},
                }
            )
        ],
        fileGroups={},
        activeGroupId=None,
    )

    assert snapshot.boards == []
    assert snapshot.activeBoardId is None


def test_rejects_duplicate_board_ids():
    with pytest.raises(ValidationError, match="duplicate board id"):
        ProjectSnapshotV2(
            boards=[
                SnapshotBoard(id="board", boardKind="arduino-uno", x=0.0, y=0.0, activeFileGroupId="g"),
                SnapshotBoard(id="board", boardKind="arduino-mega", x=0.0, y=0.0, activeFileGroupId="g"),
            ],
            activeBoardId="board",
            fileGroups={"g": [SnapshotFile(name="sketch.ino", content="")]},
            activeGroupId="g",
        )


def test_rejects_missing_active_board():
    with pytest.raises(ValidationError, match="activeBoardId"):
        ProjectSnapshotV2(
            boards=[],
            activeBoardId="missing",
            fileGroups={},
            activeGroupId=None,
        )


def test_rejects_board_missing_file_group():
    with pytest.raises(ValidationError, match="missing file group"):
        ProjectSnapshotV2(
            boards=[
                SnapshotBoard(
                    id="arduino-uno",
                    boardKind="arduino-uno",
                    x=0.0,
                    y=0.0,
                    activeFileGroupId="missing-group",
                )
            ],
            activeBoardId="arduino-uno",
            fileGroups={},
            activeGroupId=None,
        )


def test_rejects_wire_endpoint_to_missing_entity():
    with pytest.raises(ValidationError, match="start references missing"):
        ProjectSnapshotV2(
            boards=[],
            components=[],
            wires=[
                SnapshotWire.model_validate(
                    {
                        "id": "wire-1",
                        "start": {"componentId": "missing", "pinName": "A", "x": 0.0, "y": 0.0},
                        "end": {"componentId": "also-missing", "pinName": "B", "x": 0.0, "y": 0.0},
                    }
                )
            ],
        )


def test_rejects_file_path_traversal():
    with pytest.raises(ValidationError, match="traversal"):
        SnapshotFile(name="../secret.ino", content="")


def test_rejects_extra_fields():
    with pytest.raises(ValidationError):
        ProjectSnapshotV2.model_validate({"version": 2, "unknown": True})


def test_replace_file_range_rejects_inverted_range():
    with pytest.raises(ValidationError, match="endLine"):
        ReplaceFileRangeInput(
            groupId="g",
            fileName="sketch.ino",
            startLine=10,
            endLine=2,
            replacement="",
        )


def test_connect_pins_input_accepts_minimal_wire():
    payload = ConnectPinsInput.model_validate(
        {
            "start": {"componentId": "arduino-uno", "pinName": "13", "x": 0.0, "y": 0.0},
            "end": {"componentId": "led-1", "pinName": "A", "x": 0.0, "y": 0.0},
        }
    )

    assert payload.color == "#22c55e"
