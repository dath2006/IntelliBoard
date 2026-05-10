from __future__ import annotations

import asyncio
from typing import Any

from app.agent.catalog import (
    get_canvas_runtime_pins as _get_canvas_runtime_pins,
    get_component_schema as _get_component_schema,
    list_component_schema_gaps as _list_component_schema_gaps,
    search_component_catalog as _search_component_catalog,
)
from app.agent.schemas import ProjectSnapshotV2
from app.agent.validators import validate_compile_readiness


def get_project_outline(snapshot: ProjectSnapshotV2) -> dict[str, Any]:
    return {
        "version": snapshot.version,
        "activeBoardId": snapshot.activeBoardId,
        "boards": [
            {
                "id": board.id,
                "boardKind": board.boardKind,
                "x": board.x,
                "y": board.y,
                "languageMode": board.languageMode,
                "activeFileGroupId": board.activeFileGroupId,
            }
            for board in snapshot.boards
        ],
        "components": [
            {
                "id": component.id,
                "metadataId": component.metadataId,
                "x": component.x,
                "y": component.y,
            }
            for component in snapshot.components
        ],
        "wires": [
            {
                "id": wire.id,
                "start": {"componentId": wire.start.componentId, "pinName": wire.start.pinName},
                "end": {"componentId": wire.end.componentId, "pinName": wire.end.pinName},
                "color": wire.color,
                "signalType": wire.signalType,
            }
            for wire in snapshot.wires
        ],
        "fileGroups": {
            group_id: [{"name": file.name, "chars": len(file.content)} for file in files]
            for group_id, files in snapshot.fileGroups.items()
        },
        "activeGroupId": snapshot.activeGroupId,
    }


def get_component_detail(snapshot: ProjectSnapshotV2, component_id: str) -> dict[str, Any]:
    component = next((c for c in snapshot.components if c.id == component_id), None)
    if component is None:
        raise ValueError(f"component not found: {component_id}")
    return component.model_dump()


def search_component_catalog(
    query: str,
    *,
    category: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    return _search_component_catalog(query, category=category, limit=limit)


def get_component_schema(component_id: str) -> dict[str, Any]:
    return _get_component_schema(component_id)


async def get_canvas_runtime_pins(snapshot: ProjectSnapshotV2, instance_id: str) -> dict[str, Any]:
    """Return ONLY the pin names the live canvas DOM reported for this instance.

    Resolves the metadataId from the snapshot (boards → boardKind, components →
    metadataId), then reads directly from the runtime pin catalog that the
    frontend populates by reading element.pinInfo from the rendered wokwi
    elements.

    Pin names are normalised to the canonical snapshot format before being
    returned (e.g. ESP32 "D2" → "2") so the agent always uses names that are
    consistent with existing wires in the project.

    The catalog is polled up to 4 times (every 500 ms, 2 s total) while the
    frontend canvas renders and sends its pinInfo — this covers the race window
    after a snapshot.updated event.  If still unavailable after retries the
    agent should NOT attempt to wire and should inform the user.
    """
    # Resolve instance → metadataId.
    board = next((b for b in snapshot.boards if b.id == instance_id), None)
    if board is not None:
        # Retry loop: wait for the frontend pin-flush to arrive.
        for attempt in range(5):
            result = _get_canvas_runtime_pins(board.boardKind)
            if result.get("available"):
                break
            if attempt < 4:
                await asyncio.sleep(0.5)
        result["instanceId"] = instance_id
        result["instanceType"] = "board"
        return result

    component = next((c for c in snapshot.components if c.id == instance_id), None)
    if component is not None:
        # Retry loop: wait for the frontend pin-flush to arrive.
        for attempt in range(5):
            result = _get_canvas_runtime_pins(component.metadataId)
            if result.get("available"):
                break
            if attempt < 4:
                await asyncio.sleep(0.5)
        result["instanceId"] = instance_id
        result["instanceType"] = "component"
        # Components are not boards — no board-specific prefix normalisation needed.
        return result

    return {
        "instanceId": instance_id,
        "available": False,
        "pinNames": [],
        "error": f"instance not found in snapshot: {instance_id!r}",
    }



async def get_canvas_runtime_pins_batch(
    snapshot: ProjectSnapshotV2, instance_ids: list[str]
) -> dict[str, Any]:
    """Return runtime pin info for multiple instances, deduplicating by metadata_id.

    Instances that share the same underlying metadata_id (e.g. ten 'wokwi-led'
    components) only trigger one actual catalog lookup + retry loop instead of N.
    Each instance still gets its own entry in the results list with the correct
    instanceId, but pin data is shared from the single lookup.
    """
    if not instance_ids:
        return {"results": []}

    # Build a mapping: instance_id → (metadata_key, instance_type)
    instance_meta: dict[str, tuple[str, str]] = {}
    not_found: list[str] = []
    for iid in instance_ids:
        board = next((b for b in snapshot.boards if b.id == iid), None)
        if board is not None:
            instance_meta[iid] = (board.boardKind, "board")
            continue
        component = next((c for c in snapshot.components if c.id == iid), None)
        if component is not None:
            instance_meta[iid] = (component.metadataId, "component")
            continue
        not_found.append(iid)

    # Deduplicate: only poll each unique metadata_key once.
    unique_keys = set(meta_key for meta_key, _ in instance_meta.values())
    resolved: dict[str, dict[str, Any]] = {}
    for meta_key in unique_keys:
        for attempt in range(5):
            result = _get_canvas_runtime_pins(meta_key)
            if result.get("available"):
                break
            if attempt < 4:
                await asyncio.sleep(0.5)
        resolved[meta_key] = result

    # Build per-instance results.
    results: list[dict[str, Any]] = []
    for iid in instance_ids:
        if iid in instance_meta:
            meta_key, itype = instance_meta[iid]
            entry = {**resolved[meta_key], "instanceId": iid, "instanceType": itype}
            results.append(entry)
        else:
            results.append({
                "instanceId": iid,
                "available": False,
                "pinNames": [],
                "error": f"instance not found in snapshot: {iid!r}",
            })

    return {"results": results}


def list_component_schema_gaps(limit: int = 20) -> dict[str, Any]:
    return _list_component_schema_gaps(limit=limit)


def list_files(snapshot: ProjectSnapshotV2, group_id: str | None = None) -> list[dict[str, Any]]:
    groups = [group_id] if group_id is not None else list(snapshot.fileGroups)
    result: list[dict[str, Any]] = []
    for gid in groups:
        if gid not in snapshot.fileGroups:
            raise ValueError(f"file group not found: {gid}")
        result.extend(
            {"groupId": gid, "name": file.name, "chars": len(file.content)}
            for file in snapshot.fileGroups[gid]
        )
    return result


def read_file(
    snapshot: ProjectSnapshotV2,
    *,
    group_id: str,
    file_name: str,
    start_line: int | None = None,
    end_line: int | None = None,
) -> dict[str, Any]:
    files = snapshot.fileGroups.get(group_id)
    if files is None:
        raise ValueError(f"file group not found: {group_id}")
    file = next((f for f in files if f.name == file_name), None)
    if file is None:
        raise ValueError(f"file not found: {file_name}")
    if start_line is None and end_line is None:
        return {"groupId": group_id, "name": file.name, "content": file.content}
    start = start_line or 1
    end = end_line or len(file.content.splitlines())
    if start < 1 or end < start:
        raise ValueError("invalid line range")
    lines = file.content.splitlines()
    return {
        "groupId": group_id,
        "name": file.name,
        "startLine": start,
        "endLine": end,
        "content": "\n".join(lines[start - 1 : end]),
    }


async def compile_board(snapshot: ProjectSnapshotV2, board_id: str, compile_adapter=None) -> dict[str, Any]:
    readiness = validate_compile_readiness(snapshot, board_id=board_id)
    if not readiness.ok or readiness.fqbn is None:
        return {"success": False, "readiness": readiness.model_dump()}
    board = next(b for b in snapshot.boards if b.id == board_id)
    files = [
        {"name": file.name, "content": file.content}
        for file in snapshot.fileGroups.get(board.activeFileGroupId, [])
    ]
    if compile_adapter is not None:
        return await compile_adapter(files, readiness.fqbn)

    from app.api.routes.compile import compile_files

    result = await compile_files(files, readiness.fqbn)
    return result.model_dump()


async def search_libraries(query: str, arduino_service=None) -> dict[str, Any]:
    service = arduino_service
    if service is None:
        from app.api.routes.compile import arduino_cli

        service = arduino_cli
    if not query.strip():
        return {"success": True, "libraries": [], "total": 0}
    result = await service.search_libraries(query)
    if not result.get("success"):
        return result

    libraries = result.get("libraries") or []
    limit = 25
    trimmed: list[dict[str, Any]] = []
    for lib in libraries[:limit]:
        latest = lib.get("latest") or {}
        trimmed.append(
            {
                "name": lib.get("name") or latest.get("name") or "",
                "version": latest.get("version") or "",
                "author": latest.get("author") or lib.get("author") or "",
                "sentence": latest.get("sentence") or latest.get("paragraph") or "",
            }
        )

    return {
        "success": True,
        "libraries": trimmed,
        "total": len(libraries),
        "truncated": len(libraries) > limit,
    }


async def install_library(name: str, arduino_service=None) -> dict[str, Any]:
    service = arduino_service
    if service is None:
        from app.api.routes.compile import arduino_cli

        service = arduino_cli
    return await service.install_library(name)


async def list_installed_libraries(arduino_service=None) -> dict[str, Any]:
    service = arduino_service
    if service is None:
        from app.api.routes.compile import arduino_cli

        service = arduino_cli
    return await service.list_installed_libraries()
