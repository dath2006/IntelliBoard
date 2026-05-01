from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.snapshot_compat import (
    dump_snapshot_json,
    legacy_to_snapshot_v2,
    load_snapshot_json,
    snapshot_v2_to_legacy,
)
from app.core.dependencies import get_current_user, require_auth
from app.database.session import get_db
from app.models.project import Project
from app.models.user import User
from app.schemas.project import ProjectCreateRequest, ProjectResponse, ProjectUpdateRequest, SketchFile
from app.services.metrics import record_project_open, record_save
from app.services.project_files import delete_files, read_files, write_files
from app.utils.slug import slugify

router = APIRouter()


def _files_for_project(project: Project) -> list[SketchFile]:
    """Load files from disk; fall back to legacy code field if disk is empty."""
    if project.snapshot_json:
        try:
            legacy = snapshot_v2_to_legacy(load_snapshot_json(project.snapshot_json))
            return [SketchFile(**f) for f in legacy["files"]]
        except Exception:
            pass
    disk = read_files(project.id)
    if disk:
        return [SketchFile(name=f["name"], content=f["content"]) for f in disk]
    # Legacy: single sketch.ino from DB code field
    if project.code:
        return [SketchFile(name="sketch.ino", content=project.code)]
    return []


def _to_response(project: Project, owner_username: str) -> ProjectResponse:
    legacy = None
    if project.snapshot_json:
        try:
            legacy = snapshot_v2_to_legacy(load_snapshot_json(project.snapshot_json))
        except Exception:
            legacy = None
    return ProjectResponse(
        id=project.id,
        name=project.name,
        slug=project.slug,
        description=project.description,
        is_public=project.is_public,
        board_type=legacy["board_type"] if legacy else project.board_type,
        files=_files_for_project(project),
        code=legacy["code"] if legacy else project.code,
        components_json=legacy["components_json"] if legacy else project.components_json,
        wires_json=legacy["wires_json"] if legacy else project.wires_json,
        snapshot_json=project.snapshot_json,
        owner_username=owner_username,
        created_at=project.created_at,
        updated_at=project.updated_at,
        compile_count=project.compile_count,
        compile_error_count=project.compile_error_count,
        run_count=project.run_count,
        update_count=project.update_count,
        last_compiled_at=project.last_compiled_at,
        last_run_at=project.last_run_at,
    )


def _snapshot_from_create_body(body: ProjectCreateRequest) -> tuple[str, dict]:
    if body.snapshot_json:
        snapshot = load_snapshot_json(body.snapshot_json)
    else:
        files = [f.model_dump() for f in body.files] if body.files is not None else None
        snapshot = legacy_to_snapshot_v2(
            board_type=body.board_type,
            files=files,
            code=body.code,
            components_json=body.components_json,
            wires_json=body.wires_json,
        )
    return dump_snapshot_json(snapshot), snapshot_v2_to_legacy(snapshot)


def _snapshot_from_update_body(project: Project, body: ProjectUpdateRequest) -> tuple[str | None, dict | None]:
    if body.snapshot_json:
        snapshot = load_snapshot_json(body.snapshot_json)
        return dump_snapshot_json(snapshot), snapshot_v2_to_legacy(snapshot)

    legacy_fields_changed = any(
        field in body.model_fields_set
        for field in ("board_type", "files", "code", "components_json", "wires_json")
    )
    if not legacy_fields_changed and project.snapshot_json:
        return None, None

    existing_files = _files_for_project(project)
    files = (
        [f.model_dump() for f in body.files]
        if body.files is not None
        else [f.model_dump() for f in existing_files]
    )
    snapshot = legacy_to_snapshot_v2(
        board_type=body.board_type if body.board_type is not None else project.board_type,
        files=files,
        code=body.code if body.code is not None else project.code,
        components_json=(
            body.components_json if body.components_json is not None else project.components_json
        ),
        wires_json=body.wires_json if body.wires_json is not None else project.wires_json,
    )
    return dump_snapshot_json(snapshot), snapshot_v2_to_legacy(snapshot)


async def _unique_slug(db: AsyncSession, user_id: str, base_slug: str) -> str:
    slug = base_slug or "project"
    counter = 1
    while True:
        result = await db.execute(
            select(Project).where(Project.user_id == user_id, Project.slug == slug)
        )
        if not result.scalar_one_or_none():
            return slug
        slug = f"{base_slug}-{counter}"
        counter += 1


# ── My projects (literal route — must be before /{project_id}) ───────────────

@router.get("/projects/me", response_model=list[ProjectResponse])
async def my_projects(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    result = await db.execute(
        select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc())
    )
    projects = result.scalars().all()
    return [_to_response(p, user.username) for p in projects]


# ── GET by ID ────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}", response_model=ProjectResponse)
async def get_project_by_id(
    project_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")

    is_own = current_user and current_user.id == project.user_id
    is_admin = current_user and current_user.is_admin
    if not project.is_public and not is_own and not is_admin:
        raise HTTPException(status_code=403, detail="This project is private.")

    owner_result = await db.execute(select(User).where(User.id == project.user_id))
    owner = owner_result.scalar_one_or_none()

    # Record open events from non-owners (views), not owner edits.
    if not is_own:
        await record_project_open(db, user=current_user, project_id=project.id, request=request)

    return _to_response(project, owner.username if owner else "")


# ── Create ───────────────────────────────────────────────────────────────────

@router.post("/projects/", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    base_slug = slugify(body.name) or "project"
    slug = await _unique_slug(db, user.id, base_slug)
    snapshot_json, legacy = _snapshot_from_create_body(body)

    project = Project(
        user_id=user.id,
        name=body.name,
        slug=slug,
        description=body.description,
        is_public=body.is_public,
        board_type=legacy["board_type"],
        code=legacy["code"],
        components_json=legacy["components_json"],
        wires_json=legacy["wires_json"],
        snapshot_json=snapshot_json,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)

    # Write sketch files to volume
    files = [SketchFile(**f) for f in legacy["files"]]
    if files:
        write_files(project.id, [f.model_dump() for f in files])

    await record_save(db, user=user, project=project, is_create=True, request=request)
    return _to_response(project, user.username)


# ── Update ───────────────────────────────────────────────────────────────────

@router.put("/projects/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    body: ProjectUpdateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    if project.user_id != user.id:
        raise HTTPException(status_code=403, detail="Forbidden.")

    if body.name is not None:
        project.name = body.name
        new_base = slugify(body.name)
        if new_base != project.slug:
            project.slug = await _unique_slug(db, user.id, new_base)
    if body.description is not None:
        project.description = body.description
    if body.is_public is not None:
        project.is_public = body.is_public

    snapshot_json, legacy = _snapshot_from_update_body(project, body)
    if snapshot_json is not None and legacy is not None:
        project.snapshot_json = snapshot_json
        project.board_type = legacy["board_type"]
        project.code = legacy["code"]
        project.components_json = legacy["components_json"]
        project.wires_json = legacy["wires_json"]
    else:
        if body.board_type is not None:
            project.board_type = body.board_type
        if body.code is not None:
            project.code = body.code
        if body.components_json is not None:
            project.components_json = body.components_json
        if body.wires_json is not None:
            project.wires_json = body.wires_json

    project.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(project)

    # Write updated files to volume
    if legacy is not None:
        write_files(project.id, legacy["files"])
    elif body.files is not None:
        write_files(project.id, [f.model_dump() for f in body.files])
    elif body.code is not None:
        # Legacy: update sketch.ino from code field only if no files were sent
        existing = read_files(project.id)
        if not existing:
            write_files(project.id, [{"name": "sketch.ino", "content": body.code}])

    await record_save(db, user=user, project=project, is_create=False, request=request)
    return _to_response(project, user.username)


# ── Delete ───────────────────────────────────────────────────────────────────

@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    if project.user_id != user.id:
        raise HTTPException(status_code=403, detail="Forbidden.")
    await db.delete(project)
    await db.commit()
    delete_files(project_id)


# ── User public projects ─────────────────────────────────────────────────────

@router.get("/user/{username}", response_model=list[ProjectResponse])
async def user_projects(
    username: str,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    result = await db.execute(select(User).where(User.username == username))
    owner = result.scalar_one_or_none()
    if not owner:
        raise HTTPException(status_code=404, detail="User not found.")

    is_own = current_user and current_user.id == owner.id
    query = select(Project).where(Project.user_id == owner.id)
    if not is_own:
        query = query.where(Project.is_public == True)  # noqa: E712
    query = query.order_by(Project.updated_at.desc())

    projects = (await db.execute(query)).scalars().all()
    return [_to_response(p, owner.username) for p in projects]


# ── Get by username/slug ─────────────────────────────────────────────────────

@router.get("/user/{username}/{slug}", response_model=ProjectResponse)
async def get_project_by_slug(
    username: str,
    slug: str,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    result = await db.execute(select(User).where(User.username == username))
    owner = result.scalar_one_or_none()
    if not owner:
        raise HTTPException(status_code=404, detail="User not found.")

    result2 = await db.execute(
        select(Project).where(Project.user_id == owner.id, Project.slug == slug)
    )
    project = result2.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")

    is_own = current_user and current_user.id == owner.id
    if not project.is_public and not is_own:
        raise HTTPException(status_code=403, detail="This project is private.")

    return _to_response(project, owner.username)
