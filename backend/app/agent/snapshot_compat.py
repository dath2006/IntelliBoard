from __future__ import annotations

import json
from typing import Any

from app.agent.board_mapping import canonical_board_kind
from app.agent.schemas import ProjectSnapshotV2, SnapshotBoard, SnapshotComponent, SnapshotFile, SnapshotWire


DEFAULT_BOARD_KIND = "arduino-uno"
DEFAULT_BOARD_POSITION = {"x": 50.0, "y": 50.0}
BOARD_COMPONENT_IDS = {
    "arduino-uno",
    "arduino-nano",
    "arduino-mega",
    "raspberry-pi-pico",
    "pi-pico-w",
    "raspberry-pi-3",
    "esp32",
    "esp32-devkit-c-v4",
    "esp32-cam",
    "wemos-lolin32-lite",
    "esp32-s3",
    "xiao-esp32-s3",
    "arduino-nano-esp32",
    "esp32-c3",
    "xiao-esp32-c3",
    "aitewinrobot-esp32c3-supermini",
    "attiny85",
}


def legacy_to_snapshot_v2(
    *,
    board_type: str | None,
    files: list[dict[str, str]] | None = None,
    code: str | None = None,
    components_json: str | list[dict[str, Any]] | None = None,
    wires_json: str | list[dict[str, Any]] | None = None,
) -> ProjectSnapshotV2:
    """Convert current project API fields to the canonical snapshot shape."""
    normalized_files = _normalize_files(files, code)
    components = _parse_json_list(components_json)
    wires = _parse_json_list(wires_json)

    if board_type in {"", "analog", "none", "boardless"}:
        boards = []
        active_board_id = None
        group_id = "group-standalone"
    else:
        board_kind = canonical_board_kind(board_type or DEFAULT_BOARD_KIND)
        board_id = board_kind
        group_id = f"group-{board_id}"
        boards = [
            SnapshotBoard(
                id=board_id,
                boardKind=board_kind,
                x=DEFAULT_BOARD_POSITION["x"],
                y=DEFAULT_BOARD_POSITION["y"],
                activeFileGroupId=group_id,
            )
        ]
        active_board_id = board_id

    file_groups = {group_id: [SnapshotFile(**f) for f in normalized_files]}

    return ProjectSnapshotV2(
        boards=boards,
        activeBoardId=active_board_id,
        components=[_component_from_legacy(c) for c in components if not _is_board_component(c)],
        wires=[_wire_from_legacy(w) for w in wires],
        fileGroups=file_groups,
        activeGroupId=group_id,
    )


def snapshot_v2_to_legacy(snapshot: ProjectSnapshotV2) -> dict[str, Any]:
    """Derive backwards-compatible fields from the active board only."""
    active_board = _active_board(snapshot)
    active_group_id = (
        active_board.activeFileGroupId
        if active_board is not None
        else snapshot.activeGroupId
    )
    files = [
        {"name": f.name, "content": f.content}
        for f in snapshot.fileGroups.get(active_group_id or "", [])
    ]
    code = _legacy_code(files)

    return {
        "board_type": active_board.boardKind if active_board is not None else DEFAULT_BOARD_KIND,
        "files": files,
        "code": code,
        "components_json": json.dumps([c.model_dump() for c in snapshot.components]),
        "wires_json": json.dumps([w.model_dump() for w in snapshot.wires]),
    }


def load_snapshot_json(snapshot_json: str) -> ProjectSnapshotV2:
    payload = json.loads(snapshot_json)
    return ProjectSnapshotV2.model_validate(payload)


def dump_snapshot_json(snapshot: ProjectSnapshotV2) -> str:
    return snapshot.model_dump_json()


def _normalize_files(
    files: list[dict[str, str]] | None,
    code: str | None,
) -> list[dict[str, str]]:
    if files:
        return [{"name": f["name"], "content": f.get("content", "")} for f in files]
    if code:
        return [{"name": "sketch.ino", "content": code}]
    return [{"name": "sketch.ino", "content": ""}]


def _parse_json_list(value: str | list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if not value:
        return []
    parsed = json.loads(value)
    if not isinstance(parsed, list):
        raise ValueError("expected JSON list")
    return parsed


def _component_from_legacy(raw: dict[str, Any]) -> SnapshotComponent:
    metadata_id = raw.get("metadataId") or raw.get("type") or ""
    metadata_id = str(metadata_id).removeprefix("wokwi-").removeprefix("velxio-")
    return SnapshotComponent(
        id=str(raw.get("id", "")),
        metadataId=metadata_id,
        x=float(raw.get("x", raw.get("left", 0))),
        y=float(raw.get("y", raw.get("top", 0))),
        properties=dict(raw.get("properties", raw.get("attrs", {}))),
    )


def _wire_from_legacy(raw: dict[str, Any]) -> SnapshotWire:
    return SnapshotWire.model_validate(
        {
            "id": str(raw.get("id", "")),
            "start": raw.get("start", {}),
            "end": raw.get("end", {}),
            "waypoints": raw.get("waypoints", []),
            "color": raw.get("color", "#22c55e"),
            "signalType": raw.get("signalType"),
        }
    )


def _is_board_component(raw: dict[str, Any]) -> bool:
    raw_id = str(raw.get("id", ""))
    raw_type = str(raw.get("metadataId") or raw.get("type") or "")
    normalized_type = raw_type.removeprefix("wokwi-").removeprefix("velxio-")
    return raw_id in BOARD_COMPONENT_IDS or normalized_type in BOARD_COMPONENT_IDS


def _active_board(snapshot: ProjectSnapshotV2) -> SnapshotBoard | None:
    if snapshot.activeBoardId:
        for board in snapshot.boards:
            if board.id == snapshot.activeBoardId:
                return board
    return snapshot.boards[0] if snapshot.boards else None


def _legacy_code(files: list[dict[str, str]]) -> str:
    for file in files:
        if file["name"].endswith(".ino"):
            return file["content"]
    return files[0]["content"] if files else ""
