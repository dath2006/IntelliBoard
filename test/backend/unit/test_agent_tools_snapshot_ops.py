import pytest

from app.agent.schemas import ProjectSnapshotV2, SnapshotBoard, SnapshotComponent, SnapshotFile
from app.agent.snapshot_ops import (
    add_board,
    add_component,
    apply_file_patch,
    change_board_kind,
    connect_pins,
    create_file,
    disconnect_wire,
    move_component,
    remove_board,
    remove_component,
    replace_file_range,
    route_wire,
    update_component,
)
from app.agent.tools import (
    get_component_detail,
    get_project_outline,
    list_files,
    read_file,
    search_component_catalog,
)


def base_snapshot() -> ProjectSnapshotV2:
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
        components=[SnapshotComponent(id="led-1", metadataId="led", x=200.0, y=100.0, properties={})],
        fileGroups={
            "group-arduino-uno": [
                SnapshotFile(name="sketch.ino", content="line1\nline2\nline3\n")
            ]
        },
        activeGroupId="group-arduino-uno",
    )


def test_change_board_kind_keeps_board_id_stable():
    updated, result = change_board_kind(base_snapshot(), board_id="arduino-uno", board_kind="esp32")

    assert updated.boards[0].id == "arduino-uno"
    assert updated.boards[0].boardKind == "esp32"
    assert result.changedBoardIds == ["arduino-uno"]
    assert result.invalidatedBoardIds == ["arduino-uno"]
    assert updated.compileState["arduino-uno"].reason == "board_kind_changed"


def test_connect_pins_accepts_board_kind_alias_when_board_id_is_legacy():
    snap, _ = change_board_kind(base_snapshot(), board_id="arduino-uno", board_kind="esp32")

    updated, _ = connect_pins(
        snap,
        wire_id="wire-esp32-alias",
        start_component_id="esp32",
        start_pin="D13",
        end_component_id="led-1",
        end_pin="A",
    )

    wire = next(w for w in updated.wires if w.id == "wire-esp32-alias")
    assert wire.start.componentId == "arduino-uno"


def test_add_board_creates_unique_id_and_file_group():
    updated, result = add_board(base_snapshot(), board_kind="arduino-uno")

    assert updated.boards[1].id == "arduino-uno-2"
    assert "group-arduino-uno-2" in updated.fileGroups
    assert result.changedFileGroups == ["group-arduino-uno-2"]


def test_remove_board_removes_connected_wires_and_group():
    snap, _ = connect_pins(
        base_snapshot(),
        wire_id="wire-1",
        start_component_id="arduino-uno",
        start_pin="13",
        end_component_id="led-1",
        end_pin="A",
    )

    updated, _ = remove_board(snap, board_id="arduino-uno")

    assert updated.boards == []
    assert updated.wires == []
    assert "group-arduino-uno" not in updated.fileGroups
    assert updated.activeBoardId is None


def test_component_crud_and_wire_cleanup():
    snap, _ = add_component(
        base_snapshot(),
        component_id="button-1",
        metadata_id="pushbutton",
        x=300.0,
        y=100.0,
        properties={"color": "green"},
    )
    snap, _ = update_component(snap, component_id="button-1", x=320.0, properties={"label": "A"})
    snap, _ = connect_pins(
        snap,
        wire_id="wire-button",
        start_component_id="arduino-uno",
        start_pin="2",
        end_component_id="button-1",
        end_pin="1.l",
    )

    updated, _ = remove_component(snap, component_id="button-1")

    assert all(c.id != "button-1" for c in updated.components)
    assert updated.wires == []


def test_move_component_updates_position():
    updated, result = move_component(base_snapshot(), component_id="led-1", x=250.0, y=150.0)

    assert updated.components[0].x == 250.0
    assert updated.components[0].y == 150.0
    assert result.changedComponentIds == ["led-1"]


def test_wire_route_and_disconnect():
    snap, _ = connect_pins(
        base_snapshot(),
        wire_id="wire-1",
        start_component_id="arduino-uno",
        start_pin="13",
        end_component_id="led-1",
        end_pin="A",
    )
    snap, _ = route_wire(snap, wire_id="wire-1", waypoints=[{"x": 10.0, "y": 20.0}])
    assert snap.wires[0].waypoints[0].x == 10.0

    updated, _ = disconnect_wire(snap, wire_id="wire-1")
    assert updated.wires == []


def test_file_operations():
    snap, result = create_file(
        base_snapshot(),
        group_id="group-arduino-uno",
        name="helper.h",
        content="#pragma once\n",
    )
    assert len(snap.fileGroups["group-arduino-uno"]) == 2
    assert snap.compileState["arduino-uno"].reason == "file_changed"
    assert result.invalidatedBoardIds == ["arduino-uno"]

    snap, _ = replace_file_range(
        snap,
        group_id="group-arduino-uno",
        file_name="sketch.ino",
        start_line=2,
        end_line=2,
        replacement="changed\n",
    )
    assert snap.fileGroups["group-arduino-uno"][0].content == "line1\nchanged\nline3\n"
    assert snap.compileState["arduino-uno"].reason == "file_changed"

    snap, _ = apply_file_patch(
        snap,
        group_id="group-arduino-uno",
        file_name="helper.h",
        original="#pragma once\n",
        modified="#pragma once\nvoid f();\n",
    )
    assert "void f" in snap.fileGroups["group-arduino-uno"][1].content


def test_apply_file_patch_rejects_stale_base():
    with pytest.raises(ValueError, match="patch base"):
        apply_file_patch(
            base_snapshot(),
            group_id="group-arduino-uno",
            file_name="sketch.ino",
            original="wrong",
            modified="new",
        )


def test_read_tools_return_compact_context():
    outline = get_project_outline(base_snapshot())
    assert outline["components"] == [{"id": "led-1", "metadataId": "led", "x": 200.0, "y": 100.0}]
    assert outline["fileGroups"]["group-arduino-uno"] == [{"name": "sketch.ino", "chars": 18}]

    detail = get_component_detail(base_snapshot(), "led-1")
    assert detail["metadataId"] == "led"

    files = list_files(base_snapshot())
    assert files == [{"groupId": "group-arduino-uno", "name": "sketch.ino", "chars": 18}]

    section = read_file(
        base_snapshot(),
        group_id="group-arduino-uno",
        file_name="sketch.ino",
        start_line=2,
        end_line=3,
    )
    assert section["content"] == "line2\nline3"


def test_search_component_catalog_returns_compact_matches():
    results = search_component_catalog("led", limit=5)

    assert results
    assert all("thumbnail" not in item for item in results)
    assert any(item["id"] == "led" for item in results)
