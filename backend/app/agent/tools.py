from __future__ import annotations

from typing import Any

from app.agent.catalog import (
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
    return await service.search_libraries(query)


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
