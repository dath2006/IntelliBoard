import json

from app.agent.schemas import ProjectSnapshotV2, SnapshotBoard, SnapshotComponent, SnapshotFile
from app.agent.snapshot_compat import (
    dump_snapshot_json,
    legacy_to_snapshot_v2,
    load_snapshot_json,
    snapshot_v2_to_legacy,
)


def test_legacy_single_board_to_v2():
    snapshot = legacy_to_snapshot_v2(
        board_type="arduino-uno",
        files=[{"name": "sketch.ino", "content": "void setup(){}"}],
        components_json=json.dumps(
            [
                {"id": "arduino-uno", "metadataId": "arduino-uno", "x": 10, "y": 20},
                {"id": "led-1", "metadataId": "led", "x": 200, "y": 100, "properties": {"color": "red"}},
            ]
        ),
        wires_json=json.dumps(
            [
                {
                    "id": "wire-1",
                    "start": {"componentId": "arduino-uno", "pinName": "13", "x": 0, "y": 0},
                    "end": {"componentId": "led-1", "pinName": "A", "x": 0, "y": 0},
                    "color": "#22c55e",
                }
            ]
        ),
    )

    assert snapshot.version == 2
    assert snapshot.activeBoardId == "arduino-uno"
    assert snapshot.boards[0].boardKind == "arduino-uno"
    assert [c.id for c in snapshot.components] == ["led-1"]
    assert snapshot.fileGroups["group-arduino-uno"][0].name == "sketch.ino"


def test_legacy_code_fallback_creates_sketch_file():
    snapshot = legacy_to_snapshot_v2(
        board_type="arduino-mega",
        code="void setup(){} void loop(){}",
        components_json="[]",
        wires_json="[]",
    )

    group = snapshot.boards[0].activeFileGroupId
    assert snapshot.fileGroups[group][0].name == "sketch.ino"
    assert "void setup" in snapshot.fileGroups[group][0].content


def test_snapshot_to_legacy_uses_active_board_files_only():
    snapshot = ProjectSnapshotV2(
        boards=[
            SnapshotBoard(
                id="arduino-uno",
                boardKind="arduino-uno",
                x=0.0,
                y=0.0,
                activeFileGroupId="group-arduino-uno",
            ),
            SnapshotBoard(
                id="esp32",
                boardKind="esp32",
                x=200.0,
                y=0.0,
                activeFileGroupId="group-esp32",
            ),
        ],
        activeBoardId="esp32",
        components=[SnapshotComponent(id="led-1", metadataId="led", x=10.0, y=10.0, properties={})],
        fileGroups={
            "group-arduino-uno": [SnapshotFile(name="sketch.ino", content="uno code")],
            "group-esp32": [SnapshotFile(name="main.cpp", content="esp32 code")],
        },
        activeGroupId="group-esp32",
    )

    legacy = snapshot_v2_to_legacy(snapshot)

    assert legacy["board_type"] == "esp32"
    assert legacy["files"] == [{"name": "main.cpp", "content": "esp32 code"}]
    assert legacy["code"] == "esp32 code"
    assert json.loads(legacy["components_json"])[0]["id"] == "led-1"


def test_zero_board_analog_legacy_conversion():
    snapshot = legacy_to_snapshot_v2(
        board_type="analog",
        files=[],
        components_json=[
            {"id": "r1", "metadataId": "resistor", "x": 10, "y": 20, "properties": {"value": "1k"}},
            {"id": "c1", "metadataId": "capacitor", "x": 100, "y": 20, "properties": {"value": "1u"}},
        ],
        wires_json=[
            {
                "id": "wire-rc",
                "start": {"componentId": "r1", "pinName": "2", "x": 0, "y": 0},
                "end": {"componentId": "c1", "pinName": "1", "x": 0, "y": 0},
            }
        ],
    )

    assert snapshot.boards == []
    assert snapshot.activeBoardId is None
    assert snapshot.activeGroupId == "group-standalone"
    assert len(snapshot.components) == 2


def test_snapshot_json_round_trip():
    snapshot = legacy_to_snapshot_v2(
        board_type="arduino-uno",
        files=[{"name": "sketch.ino", "content": "code"}],
        components_json="[]",
        wires_json="[]",
    )

    encoded = dump_snapshot_json(snapshot)
    decoded = load_snapshot_json(encoded)

    assert decoded == snapshot
