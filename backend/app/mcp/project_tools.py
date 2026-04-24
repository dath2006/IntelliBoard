"""MCP project persistence tools for agent workflows."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select

from app.database.session import AsyncSessionLocal
from app.models.project import Project
from app.services.project_files import read_files, write_files
from app.utils.slug import slugify


_BOARD_TYPE_MAP = {
    "arduino:avr:uno": "arduino-uno",
    "arduino:avr:mega": "arduino-mega",
    "arduino:avr:nano": "arduino-nano",
    "rp2040:rp2040:rpipico": "raspberry-pi-pico",
    "esp32:esp32:esp32": "esp32-devkit-v1",
}


def _board_type_from_fqbn(board_fqbn: str) -> str:
    return _BOARD_TYPE_MAP.get(board_fqbn, "arduino-uno")


async def _unique_slug(
    db,
    user_id: str,
    base_slug: str,
    exclude_project_id: Optional[str] = None,
) -> str:
    slug = base_slug or "project"
    counter = 1

    while True:
        stmt = select(Project).where(Project.user_id == user_id, Project.slug == slug)
        if exclude_project_id:
            stmt = stmt.where(Project.id != exclude_project_id)

        exists = (await db.execute(stmt)).scalar_one_or_none()
        if not exists:
            return slug

        slug = f"{base_slug}-{counter}"
        counter += 1


async def save_project_to_db(
    circuit: dict[str, Any],
    code_files: list[dict[str, str]],
    project_name: str,
    user_id: str,
    description: str | None = None,
    is_public: bool = True,
) -> dict[str, Any]:
    """Create a new project and persist associated sketch files."""
    board_fqbn = circuit.get("board_fqbn", "arduino:avr:uno")
    components = circuit.get("components", [])
    connections = circuit.get("connections", [])
    base_slug = slugify(project_name) or "project"

    async with AsyncSessionLocal() as db:
        slug = await _unique_slug(db, user_id, base_slug)

        project = Project(
            user_id=user_id,
            name=project_name,
            slug=slug,
            description=description,
            is_public=is_public,
            board_type=_board_type_from_fqbn(board_fqbn),
            code=code_files[0]["content"] if code_files else "",
            components_json=json.dumps(components),
            wires_json=json.dumps(connections),
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )

        db.add(project)
        await db.commit()
        await db.refresh(project)

        if code_files:
            write_files(project.id, code_files)

        return {
            "success": True,
            "project_id": project.id,
            "slug": project.slug,
            "board_type": project.board_type,
            "file_count": len(code_files),
        }


async def load_project_from_db(project_id: str, user_id: str) -> dict[str, Any]:
    """Load a project owned by a user and convert to agent-friendly payload."""
    async with AsyncSessionLocal() as db:
        project = (
            await db.execute(
                select(Project).where(Project.id == project_id, Project.user_id == user_id)
            )
        ).scalar_one_or_none()

        if not project:
            return {"success": False, "error": "Project not found."}

        disk_files = read_files(project.id)
        files = disk_files if disk_files else [{"name": "sketch.ino", "content": project.code or ""}]

        try:
            components = json.loads(project.components_json or "[]")
        except json.JSONDecodeError:
            components = []

        try:
            connections = json.loads(project.wires_json or "[]")
        except json.JSONDecodeError:
            connections = []

        return {
            "success": True,
            "project": {
                "id": project.id,
                "name": project.name,
                "slug": project.slug,
                "description": project.description,
                "is_public": project.is_public,
                "board_type": project.board_type,
                "circuit": {
                    "board_fqbn": circuit_fqbn_from_board_type(project.board_type),
                    "components": components,
                    "connections": connections,
                },
                "code_files": files,
                "updated_at": project.updated_at.isoformat(),
            },
        }


async def update_project_in_db(
    project_id: str,
    circuit: dict[str, Any],
    code_files: list[dict[str, str]],
    user_id: str,
    project_name: Optional[str] = None,
    description: Optional[str] = None,
    is_public: Optional[bool] = None,
) -> dict[str, Any]:
    """Update project metadata, circuit snapshot, and source files."""
    async with AsyncSessionLocal() as db:
        project = (
            await db.execute(
                select(Project).where(Project.id == project_id, Project.user_id == user_id)
            )
        ).scalar_one_or_none()

        if not project:
            return {"success": False, "error": "Project not found."}

        if project_name is not None and project_name.strip():
            project.name = project_name
            project.slug = await _unique_slug(
                db,
                user_id,
                slugify(project_name) or "project",
                exclude_project_id=project.id,
            )

        if description is not None:
            project.description = description

        if is_public is not None:
            project.is_public = is_public

        board_fqbn = circuit.get("board_fqbn", "arduino:avr:uno")
        project.board_type = _board_type_from_fqbn(board_fqbn)
        project.components_json = json.dumps(circuit.get("components", []))
        project.wires_json = json.dumps(circuit.get("connections", []))

        if code_files:
            project.code = code_files[0].get("content", "")
            write_files(project.id, code_files)

        project.updated_at = datetime.now(timezone.utc)

        await db.commit()
        await db.refresh(project)

        return {
            "success": True,
            "project_id": project.id,
            "slug": project.slug,
            "board_type": project.board_type,
            "updated_at": project.updated_at.isoformat(),
        }


def circuit_fqbn_from_board_type(board_type: str) -> str:
    """Convert persisted board type back to FQBN for agent workflows."""
    reverse = {value: key for key, value in _BOARD_TYPE_MAP.items()}
    return reverse.get(board_type, "arduino:avr:uno")
