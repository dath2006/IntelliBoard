from __future__ import annotations

import difflib

from app.agent.board_mapping import canonical_board_kind, is_supported_board_kind
from app.agent.schemas import (
    ProjectSnapshotV2,
    SnapshotBoard,
    BoardCompileState,
    SnapshotComponent,
    SnapshotFile,
    SnapshotWire,
    WireWaypoint,
    ToolResult,
)
from app.agent.safety import ensure_safe_file_name


def add_board(
    snapshot: ProjectSnapshotV2,
    *,
    board_kind: str,
    board_id: str | None = None,
    x: float = 50.0,
    y: float = 50.0,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    board_kind = canonical_board_kind(board_kind)
    if not is_supported_board_kind(board_kind):
        raise ValueError(f"unsupported board kind: {board_kind}")
    updated = snapshot.model_copy(deep=True)
    new_id = board_id or _unique_id(board_kind, {b.id for b in updated.boards})
    _ensure_missing(new_id, _entity_ids(updated), "entity")
    group_id = f"group-{new_id}"
    updated.boards.append(
        SnapshotBoard(id=new_id, boardKind=board_kind, x=x, y=y, activeFileGroupId=group_id)
    )
    updated.fileGroups[group_id] = [SnapshotFile(name=_default_file_name(board_kind), content="")]
    if updated.activeBoardId is None:
        updated.activeBoardId = new_id
        updated.activeGroupId = group_id
    return _validate(updated), ToolResult(ok=True, changedBoardIds=[new_id], changedFileGroups=[group_id])


def change_board_kind(
    snapshot: ProjectSnapshotV2,
    *,
    board_id: str,
    board_kind: str,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    board_kind = canonical_board_kind(board_kind)
    if not is_supported_board_kind(board_kind):
        raise ValueError(f"unsupported board kind: {board_kind}")
    updated = snapshot.model_copy(deep=True)
    board = _board(updated, board_id)
    board.boardKind = board_kind
    _invalidate_board(updated, board_id, "board_kind_changed")
    return _validate(updated), ToolResult(ok=True, changedBoardIds=[board_id], invalidatedBoardIds=[board_id])


def remove_board(
    snapshot: ProjectSnapshotV2,
    *,
    board_id: str,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    updated = snapshot.model_copy(deep=True)
    board = _board(updated, board_id)
    updated.boards = [b for b in updated.boards if b.id != board_id]
    updated.wires = [
        w for w in updated.wires if w.start.componentId != board_id and w.end.componentId != board_id
    ]
    updated.fileGroups.pop(board.activeFileGroupId, None)
    if updated.activeBoardId == board_id:
        updated.activeBoardId = updated.boards[0].id if updated.boards else None
    if updated.activeGroupId == board.activeFileGroupId:
        updated.activeGroupId = (
            updated.boards[0].activeFileGroupId
            if updated.boards
            else (next(iter(updated.fileGroups), None))
        )
    return _validate(updated), ToolResult(ok=True, changedBoardIds=[board_id], changedFileGroups=[board.activeFileGroupId])


def add_component(
    snapshot: ProjectSnapshotV2,
    *,
    component_id: str,
    metadata_id: str,
    x: float,
    y: float,
    properties: dict | None = None,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    updated = snapshot.model_copy(deep=True)
    _ensure_missing(component_id, _entity_ids(updated), "entity")
    updated.components.append(
        SnapshotComponent(
            id=component_id,
            metadataId=metadata_id,
            x=x,
            y=y,
            properties=properties or {},
        )
    )
    return _validate(updated), ToolResult(ok=True, changedComponentIds=[component_id])


def update_component(
    snapshot: ProjectSnapshotV2,
    *,
    component_id: str,
    x: float | None = None,
    y: float | None = None,
    properties: dict | None = None,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    updated = snapshot.model_copy(deep=True)
    component = _component(updated, component_id)
    if x is not None:
        component.x = x
    if y is not None:
        component.y = y
    if properties is not None:
        component.properties = {**component.properties, **properties}
    return _validate(updated), ToolResult(ok=True, changedComponentIds=[component_id])


def move_component(
    snapshot: ProjectSnapshotV2,
    *,
    component_id: str,
    x: float,
    y: float,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    return update_component(snapshot, component_id=component_id, x=x, y=y)


def remove_component(
    snapshot: ProjectSnapshotV2,
    *,
    component_id: str,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    updated = snapshot.model_copy(deep=True)
    _component(updated, component_id)
    updated.components = [c for c in updated.components if c.id != component_id]
    updated.wires = [
        w
        for w in updated.wires
        if w.start.componentId != component_id and w.end.componentId != component_id
    ]
    return _validate(updated), ToolResult(ok=True, changedComponentIds=[component_id])


def connect_pins(
    snapshot: ProjectSnapshotV2,
    *,
    wire_id: str,
    start_component_id: str,
    start_pin: str,
    end_component_id: str,
    end_pin: str,
    color: str = "#22c55e",
    signal_type: str | None = None,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    updated = snapshot.model_copy(deep=True)
    _ensure_missing(wire_id, {w.id for w in updated.wires}, "wire")
    ids = _entity_ids(updated)
    if start_component_id not in ids or end_component_id not in ids:
        raise ValueError("wire endpoints must reference existing boards or components")

    # Canonicalize component pin names against the component schema so the agent
    # consistently uses the exact pin casing/format published by the catalog
    # (e.g. 7segment exposes "A".."G","DP" but models often emit "a".."g","dp").
    start_pin = _canonical_entity_pin(updated, start_component_id, start_pin)
    end_pin = _canonical_entity_pin(updated, end_component_id, end_pin)

    updated.wires.append(
        SnapshotWire.model_validate(
            {
                "id": wire_id,
                "start": {"componentId": start_component_id, "pinName": start_pin, "x": 0.0, "y": 0.0},
                "end": {"componentId": end_component_id, "pinName": end_pin, "x": 0.0, "y": 0.0},
                "waypoints": [],
                "color": color,
                "signalType": signal_type,
            }
        )
    )
    return _validate(updated), ToolResult(ok=True, changedWireIds=[wire_id])


def _canonical_entity_pin(snapshot: ProjectSnapshotV2, entity_id: str, pin_name: str) -> str:
    board = next((b for b in snapshot.boards if b.id == entity_id), None)
    if board is not None:
        schema_component_id = board.boardKind
    else:
        component = next((c for c in snapshot.components if c.id == entity_id), None)
        if component is None:
            raise ValueError(f"component not found: {entity_id}")
        schema_component_id = component.metadataId
    return _canonical_schema_pin(entity_id=entity_id, schema_component_id=schema_component_id, pin_name=pin_name)


def _canonical_schema_pin(*, entity_id: str, schema_component_id: str, pin_name: str) -> str:
    raw = (pin_name or "").strip()
    if not raw:
        raise ValueError(f"pinName is required for component {entity_id}")

    # Import lazily to avoid circular imports at module load time.
    from app.agent.catalog import get_component_schema

    schema = get_component_schema(schema_component_id)
    pin_names = schema.get("pinNames") or []
    if not isinstance(pin_names, list) or not pin_names:
        # Schema is missing pinNames; we can't validate/canonicalize.
        return raw

    # Exact match wins.
    if raw in pin_names:
        return raw

    # Case-insensitive match → return canonical spelling from schema.
    raw_lc = raw.lower()
    for p in pin_names:
        if isinstance(p, str) and p.lower() == raw_lc:
            return p

    # Punctuation-insensitive match (generic): helps with aliases like COM1 → COM.1,
    # 1l → 1.l, gnd1 → GND.1, etc.
    def _key(s: str) -> str:
        return "".join(ch for ch in s.lower() if ch.isalnum())

    raw_key = _key(raw)
    for p in pin_names:
        if isinstance(p, str) and _key(p) == raw_key:
            return p

    # Common fallback: allow ".1" variant when schema uses numbered pins.
    if "." not in raw:
        raw_dot = f"{raw}.1"
        raw_dot_lc = raw_dot.lower()
        for p in pin_names:
            if isinstance(p, str) and p.lower() == raw_dot_lc:
                return p

    allowed = ", ".join(str(p) for p in pin_names[:30])
    more = " ..." if len(pin_names) > 30 else ""
    raise ValueError(
        f'Invalid pin "{raw}" for component {entity_id} ({schema_component_id}). '
        f"Allowed pins: {allowed}{more}"
    )


def disconnect_wire(snapshot: ProjectSnapshotV2, *, wire_id: str) -> tuple[ProjectSnapshotV2, ToolResult]:
    updated = snapshot.model_copy(deep=True)
    _wire(updated, wire_id)
    updated.wires = [w for w in updated.wires if w.id != wire_id]
    return _validate(updated), ToolResult(ok=True, changedWireIds=[wire_id])


def route_wire(
    snapshot: ProjectSnapshotV2,
    *,
    wire_id: str,
    waypoints: list[dict[str, float]],
) -> tuple[ProjectSnapshotV2, ToolResult]:
    updated = snapshot.model_copy(deep=True)
    wire = _wire(updated, wire_id)
    wire.waypoints = [WireWaypoint.model_validate(point) for point in waypoints]
    return _validate(updated), ToolResult(ok=True, changedWireIds=[wire_id])


def create_file(
    snapshot: ProjectSnapshotV2,
    *,
    group_id: str,
    name: str,
    content: str = "",
) -> tuple[ProjectSnapshotV2, ToolResult]:
    updated = snapshot.model_copy(deep=True)
    ensure_safe_file_name(name)
    files = updated.fileGroups.setdefault(group_id, [])
    if any(f.name == name for f in files):
        raise ValueError(f"file already exists: {name}")
    files.append(SnapshotFile(name=name, content=content))
    invalidated = _invalidate_boards_for_group(updated, group_id, "file_changed")
    return _validate(updated), ToolResult(
        ok=True,
        changedFileGroups=[group_id],
        invalidatedBoardIds=invalidated,
    )


def replace_file_range(
    snapshot: ProjectSnapshotV2,
    *,
    group_id: str,
    file_name: str,
    start_line: int,
    end_line: int,
    replacement: str,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    if start_line < 1 or end_line < start_line:
        raise ValueError("invalid line range")
    ensure_safe_file_name(file_name)
    updated = snapshot.model_copy(deep=True)
    file = _file(updated, group_id, file_name)
    lines = file.content.splitlines(keepends=True)
    max_line = len(lines) + 1
    if start_line > max_line:
        raise ValueError("line range exceeds file length")
    if end_line > max_line:
        end_line = max_line
    replacement = _normalize_replacement_text(replacement)
    replacement_lines = replacement.splitlines(keepends=True)
    file.content = "".join(lines[: start_line - 1] + replacement_lines + lines[end_line:])
    invalidated = _invalidate_boards_for_group(updated, group_id, "file_changed")
    return _validate(updated), ToolResult(
        ok=True,
        changedFileGroups=[group_id],
        invalidatedBoardIds=invalidated,
    )


def apply_file_patch(
    snapshot: ProjectSnapshotV2,
    *,
    group_id: str,
    file_name: str,
    original: str,
    modified: str,
) -> tuple[ProjectSnapshotV2, ToolResult]:
    updated = snapshot.model_copy(deep=True)
    ensure_safe_file_name(file_name)
    file = _file(updated, group_id, file_name)
    if file.content != original:
        diff = "\n".join(difflib.unified_diff(original.splitlines(), file.content.splitlines()))
        raise ValueError(f"file content does not match patch base\n{diff}")
    file.content = modified
    invalidated = _invalidate_boards_for_group(updated, group_id, "file_changed")
    return _validate(updated), ToolResult(
        ok=True,
        changedFileGroups=[group_id],
        invalidatedBoardIds=invalidated,
    )


def _validate(snapshot: ProjectSnapshotV2) -> ProjectSnapshotV2:
    return ProjectSnapshotV2.model_validate(snapshot.model_dump())


def _entity_ids(snapshot: ProjectSnapshotV2) -> set[str]:
    return {b.id for b in snapshot.boards} | {c.id for c in snapshot.components}


def _ensure_missing(entity_id: str, existing: set[str], label: str) -> None:
    if entity_id in existing:
        raise ValueError(f"{label} already exists: {entity_id}")


def _unique_id(base: str, existing: set[str]) -> str:
    if base not in existing:
        return base
    index = 2
    while f"{base}-{index}" in existing:
        index += 1
    return f"{base}-{index}"


def _board(snapshot: ProjectSnapshotV2, board_id: str) -> SnapshotBoard:
    board = next((b for b in snapshot.boards if b.id == board_id), None)
    if board is None:
        raise ValueError(f"board not found: {board_id}")
    return board


def _component(snapshot: ProjectSnapshotV2, component_id: str) -> SnapshotComponent:
    component = next((c for c in snapshot.components if c.id == component_id), None)
    if component is None:
        raise ValueError(f"component not found: {component_id}")
    return component


def _wire(snapshot: ProjectSnapshotV2, wire_id: str) -> SnapshotWire:
    wire = next((w for w in snapshot.wires if w.id == wire_id), None)
    if wire is None:
        raise ValueError(f"wire not found: {wire_id}")
    return wire


def _file(snapshot: ProjectSnapshotV2, group_id: str, file_name: str) -> SnapshotFile:
    if group_id not in snapshot.fileGroups:
        raise ValueError(f"file group not found: {group_id}")
    file = next((f for f in snapshot.fileGroups[group_id] if f.name == file_name), None)
    if file is None:
        raise ValueError(f"file not found: {file_name}")
    return file


def _default_file_name(board_kind: str) -> str:
    if board_kind == "raspberry-pi-3":
        return "script.py"
    return "sketch.ino"


def _invalidate_board(snapshot: ProjectSnapshotV2, board_id: str, reason: str) -> None:
    snapshot.compileState[board_id] = BoardCompileState(stale=True, reason=reason)


def _invalidate_boards_for_group(snapshot: ProjectSnapshotV2, group_id: str, reason: str) -> list[str]:
    board_ids = [board.id for board in snapshot.boards if board.activeFileGroupId == group_id]
    for board_id in board_ids:
        _invalidate_board(snapshot, board_id, reason)
    return board_ids


def _normalize_replacement_text(replacement: str) -> str:
    """Normalize common escaped line breaks from tool payloads.

    Some model/tool payloads may send literal "\\n" / "\\r\\n" text instead
    of actual newline characters. Convert only those common escapes to avoid
    collapsing code into a single line.
    """
    if "\\n" in replacement or "\\r" in replacement:
        replacement = replacement.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
    return replacement
