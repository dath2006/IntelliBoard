from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import require_admin
from app.core.security import hash_password
from app.database.session import get_db
from app.models.project import Project
from app.models.usage_event import UsageEvent
from app.models.user import User
from app.schemas.admin import (
    AdminProjectResponse,
    AdminSetupRequest,
    AdminUserResponse,
    AdminUserUpdateRequest,
    BoardBreakdown,
    BoardDiversityBucket,
    BoardDiversityResponse,
    BoardsResponse,
    CountriesResponse,
    CountryEntry,
    OverviewResponse,
    ProjectMetricsResponse,
    TimeseriesPoint,
    TimeseriesResponse,
    TopProjectEntry,
    TopUserEntry,
    UserMetricsResponse,
)
from app.utils.slug import is_valid_username

router = APIRouter()


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Setup ─────────────────────────────────────────────────────────────────────

@router.get("/setup/status")
async def setup_status(db: AsyncSession = Depends(get_db)):
    """Check whether any admin user exists."""
    result = await db.execute(select(User).where(User.is_admin == True))  # noqa: E712
    has_admin = result.scalar_one_or_none() is not None
    return {"has_admin": has_admin}


@router.post("/setup", response_model=AdminUserResponse, status_code=status.HTTP_201_CREATED)
async def setup_admin(body: AdminSetupRequest, db: AsyncSession = Depends(get_db)):
    """Create the first admin user. Fails if an admin already exists."""
    existing_admin = await db.execute(select(User).where(User.is_admin == True))  # noqa: E712
    if existing_admin.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Admin already configured.")

    username = body.username.lower().strip()
    if not is_valid_username(username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-30 chars, only lowercase letters/numbers/underscores/hyphens.",
        )
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    # Check uniqueness
    conflict = await db.execute(
        select(User).where((User.username == username) | (User.email == body.email))
    )
    if conflict.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username or email already taken.")

    user = User(
        username=username,
        email=body.email,
        hashed_password=hash_password(body.password),
        is_admin=True,
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return await _user_with_metrics(db, user)


# ── Users ─────────────────────────────────────────────────────────────────────

async def _user_with_metrics(db: AsyncSession, user: User) -> AdminUserResponse:
    count_result = await db.execute(
        select(func.count()).where(Project.user_id == user.id)
    )
    project_count = count_result.scalar() or 0

    boards_result = await db.execute(
        select(distinct(UsageEvent.board_family))
        .where(UsageEvent.user_id == user.id, UsageEvent.board_family.is_not(None))
    )
    boards_used = [b for b in boards_result.scalars().all() if b]

    return AdminUserResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        avatar_url=user.avatar_url,
        is_active=user.is_active,
        is_admin=user.is_admin,
        created_at=user.created_at,
        project_count=project_count,
        total_compiles=user.total_compiles,
        total_compile_errors=user.total_compile_errors,
        total_runs=user.total_runs,
        last_active_at=user.last_active_at,
        boards_used=boards_used,
        signup_country=user.signup_country,
        last_country=user.last_country,
    )


@router.get("/users", response_model=list[AdminUserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    users = result.scalars().all()
    return [await _user_with_metrics(db, u) for u in users]


@router.get("/users/{user_id}", response_model=AdminUserResponse)
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    return await _user_with_metrics(db, user)


@router.put("/users/{user_id}", response_model=AdminUserResponse)
async def update_user(
    user_id: str,
    body: AdminUserUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    if body.username is not None:
        new_username = body.username.lower().strip()
        if not is_valid_username(new_username):
            raise HTTPException(status_code=400, detail="Invalid username format.")
        if new_username != user.username:
            conflict = await db.execute(select(User).where(User.username == new_username))
            if conflict.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="Username already taken.")
        user.username = new_username

    if body.email is not None:
        if body.email != user.email:
            conflict = await db.execute(select(User).where(User.email == body.email))
            if conflict.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="Email already in use.")
        user.email = body.email

    if body.password is not None:
        if len(body.password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
        user.hashed_password = hash_password(body.password)

    if body.is_active is not None:
        user.is_active = body.is_active

    if body.is_admin is not None:
        # Prevent removing admin from yourself
        if user.id == admin.id and not body.is_admin:
            raise HTTPException(status_code=400, detail="Cannot remove your own admin privileges.")
        user.is_admin = body.is_admin

    await db.commit()
    await db.refresh(user)
    return await _user_with_metrics(db, user)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account.")

    # Delete all user's projects first
    projects_result = await db.execute(select(Project).where(Project.user_id == user_id))
    for project in projects_result.scalars().all():
        await db.delete(project)

    await db.delete(user)
    await db.commit()


# ── Projects ──────────────────────────────────────────────────────────────────

def _project_to_response(project: Project, owner_username: str) -> AdminProjectResponse:
    return AdminProjectResponse(
        id=project.id,
        name=project.name,
        slug=project.slug,
        description=project.description,
        is_public=project.is_public,
        board_type=project.board_type,
        owner_username=owner_username,
        owner_id=project.user_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
        compile_count=project.compile_count,
        compile_error_count=project.compile_error_count,
        run_count=project.run_count,
        update_count=project.update_count,
        last_compiled_at=project.last_compiled_at,
        last_run_at=project.last_run_at,
    )


@router.get("/projects", response_model=list[AdminProjectResponse])
async def list_all_projects(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    result = await db.execute(
        select(Project, User.username)
        .join(User, User.id == Project.user_id)
        .order_by(Project.created_at.desc())
    )
    rows = result.all()
    return [_project_to_response(project, username) for project, username in rows]


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    await db.delete(project)
    await db.commit()


# ── Metrics dashboard ─────────────────────────────────────────────────────────

@router.get("/metrics/overview", response_model=OverviewResponse)
async def metrics_overview(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    now = _now()
    day_ago = now - timedelta(days=1)
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    total_users = (await db.execute(select(func.count(User.id)))).scalar() or 0
    total_projects = (await db.execute(select(func.count(Project.id)))).scalar() or 0
    public_projects = (
        await db.execute(select(func.count(Project.id)).where(Project.is_public == True))  # noqa: E712
    ).scalar() or 0

    total_compiles = (await db.execute(select(func.coalesce(func.sum(User.total_compiles), 0)))).scalar() or 0
    total_compile_errors = (
        await db.execute(select(func.coalesce(func.sum(User.total_compile_errors), 0)))
    ).scalar() or 0
    total_runs = (await db.execute(select(func.coalesce(func.sum(User.total_runs), 0)))).scalar() or 0

    success = max(total_compiles - total_compile_errors, 0)
    success_rate = (success / total_compiles) if total_compiles else 0.0

    dau = (
        await db.execute(
            select(func.count(distinct(User.id))).where(User.last_active_at >= day_ago)
        )
    ).scalar() or 0
    wau = (
        await db.execute(
            select(func.count(distinct(User.id))).where(User.last_active_at >= week_ago)
        )
    ).scalar() or 0
    mau = (
        await db.execute(
            select(func.count(distinct(User.id))).where(User.last_active_at >= month_ago)
        )
    ).scalar() or 0

    new_users_30d = (
        await db.execute(select(func.count(User.id)).where(User.created_at >= month_ago))
    ).scalar() or 0
    new_projects_30d = (
        await db.execute(select(func.count(Project.id)).where(Project.created_at >= month_ago))
    ).scalar() or 0

    return OverviewResponse(
        total_users=total_users,
        total_projects=total_projects,
        public_projects=public_projects,
        private_projects=total_projects - public_projects,
        total_compiles=total_compiles,
        total_compile_errors=total_compile_errors,
        total_runs=total_runs,
        compile_success_rate=round(success_rate, 4),
        dau=dau,
        wau=wau,
        mau=mau,
        new_users_30d=new_users_30d,
        new_projects_30d=new_projects_30d,
    )


_VALID_METRICS = {"compile", "compile_error", "run", "save", "create", "project_open"}
_VALID_BUCKETS = {"hour", "day", "week"}


@router.get("/metrics/timeseries", response_model=TimeseriesResponse)
async def metrics_timeseries(
    metric: str = Query("compile"),
    range_days: int = Query(30, ge=1, le=365),
    bucket: str = Query("day"),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    if metric not in _VALID_METRICS:
        raise HTTPException(status_code=400, detail=f"metric must be one of {sorted(_VALID_METRICS)}")
    if bucket not in _VALID_BUCKETS:
        raise HTTPException(status_code=400, detail=f"bucket must be one of {sorted(_VALID_BUCKETS)}")

    since = _now() - timedelta(days=range_days)

    # SQLite-compatible time bucketing via strftime
    if bucket == "hour":
        fmt = "%Y-%m-%d %H:00"
    elif bucket == "week":
        fmt = "%Y-%W"
    else:
        fmt = "%Y-%m-%d"

    bucket_expr = func.strftime(fmt, UsageEvent.created_at).label("bucket")
    result = await db.execute(
        select(bucket_expr, func.count(UsageEvent.id))
        .where(UsageEvent.event_type == metric, UsageEvent.created_at >= since)
        .group_by(bucket_expr)
        .order_by(bucket_expr)
    )
    points = [TimeseriesPoint(bucket=row[0], value=row[1]) for row in result.all()]
    return TimeseriesResponse(metric=metric, bucket=bucket, range_days=range_days, points=points)


@router.get("/metrics/boards", response_model=BoardsResponse)
async def metrics_boards(
    range_days: int = Query(90, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    since = _now() - timedelta(days=range_days)

    async def _agg(group_col):
        compile_subq = (
            select(
                group_col.label("g"),
                func.count(UsageEvent.id).label("compile_count"),
                func.sum(
                    func.case((UsageEvent.event_type == "compile_error", 1), else_=0)
                ).label("compile_error_count"),
                func.count(distinct(UsageEvent.user_id)).label("distinct_users"),
                func.count(distinct(UsageEvent.project_id)).label("distinct_projects"),
            )
            .where(
                UsageEvent.event_type.in_(("compile", "compile_error")),
                UsageEvent.created_at >= since,
                group_col.is_not(None),
            )
            .group_by(group_col)
            .subquery()
        )

        run_subq = (
            select(
                group_col.label("g"),
                func.count(UsageEvent.id).label("run_count"),
            )
            .where(
                UsageEvent.event_type == "run",
                UsageEvent.created_at >= since,
                group_col.is_not(None),
            )
            .group_by(group_col)
            .subquery()
        )

        rows = (
            await db.execute(
                select(
                    compile_subq.c.g,
                    compile_subq.c.compile_count,
                    compile_subq.c.compile_error_count,
                    func.coalesce(run_subq.c.run_count, 0),
                    compile_subq.c.distinct_users,
                    compile_subq.c.distinct_projects,
                ).outerjoin(run_subq, compile_subq.c.g == run_subq.c.g)
            )
        ).all()
        return rows

    family_rows = await _agg(UsageEvent.board_family)
    fqbn_rows = await _agg(UsageEvent.board_fqbn)

    families = [
        BoardBreakdown(
            board_family=row[0],
            board_fqbn=None,
            compile_count=row[1] or 0,
            compile_error_count=row[2] or 0,
            run_count=row[3] or 0,
            distinct_users=row[4] or 0,
            distinct_projects=row[5] or 0,
        )
        for row in family_rows
    ]
    fqbns = [
        BoardBreakdown(
            board_family=None,
            board_fqbn=row[0],
            compile_count=row[1] or 0,
            compile_error_count=row[2] or 0,
            run_count=row[3] or 0,
            distinct_users=row[4] or 0,
            distinct_projects=row[5] or 0,
        )
        for row in fqbn_rows
    ]

    families.sort(key=lambda b: b.compile_count, reverse=True)
    fqbns.sort(key=lambda b: b.compile_count, reverse=True)

    return BoardsResponse(families=families, fqbns=fqbns)


@router.get("/metrics/board-diversity", response_model=BoardDiversityResponse)
async def metrics_board_diversity(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """How many distinct board families each user has compiled.

    Critical signal for freemium tiering: users sticking to one board are
    cheap to serve; multi-board users likely warrant paid tiers.
    """
    per_user = (
        select(
            UsageEvent.user_id,
            func.count(distinct(UsageEvent.board_family)).label("n"),
        )
        .where(
            UsageEvent.event_type.in_(("compile", "compile_error")),
            UsageEvent.user_id.is_not(None),
            UsageEvent.board_family.is_not(None),
        )
        .group_by(UsageEvent.user_id)
        .subquery()
    )
    rows = (await db.execute(select(per_user.c.n))).scalars().all()

    buckets = {"1": 0, "2": 0, "3+": 0}
    for n in rows:
        if n <= 1:
            buckets["1"] += 1
        elif n == 2:
            buckets["2"] += 1
        else:
            buckets["3+"] += 1

    return BoardDiversityResponse(
        buckets=[BoardDiversityBucket(bucket=k, user_count=v) for k, v in buckets.items()],
        total_users_with_compiles=len(rows),
    )


_VALID_TOP_METRICS = {"compiles": User.total_compiles, "runs": User.total_runs}


@router.get("/metrics/top-users", response_model=list[TopUserEntry])
async def metrics_top_users(
    metric: str = Query("compiles"),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    if metric not in _VALID_TOP_METRICS:
        raise HTTPException(status_code=400, detail="metric must be 'compiles' or 'runs'")
    col = _VALID_TOP_METRICS[metric]
    rows = (
        await db.execute(
            select(User.id, User.username, col)
            .where(col > 0)
            .order_by(col.desc())
            .limit(limit)
        )
    ).all()
    return [TopUserEntry(user_id=r[0], username=r[1], value=r[2] or 0) for r in rows]


_VALID_TOP_PROJECT_METRICS = {
    "compiles": Project.compile_count,
    "runs": Project.run_count,
    "updates": Project.update_count,
}


@router.get("/metrics/top-projects", response_model=list[TopProjectEntry])
async def metrics_top_projects(
    metric: str = Query("compiles"),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    if metric not in _VALID_TOP_PROJECT_METRICS:
        raise HTTPException(status_code=400, detail="metric must be 'compiles', 'runs' or 'updates'")
    col = _VALID_TOP_PROJECT_METRICS[metric]
    rows = (
        await db.execute(
            select(Project.id, Project.name, User.username, col)
            .join(User, User.id == Project.user_id)
            .where(col > 0)
            .order_by(col.desc())
            .limit(limit)
        )
    ).all()
    return [
        TopProjectEntry(project_id=r[0], project_name=r[1], owner_username=r[2], value=r[3] or 0)
        for r in rows
    ]


@router.get("/metrics/users/{user_id}", response_model=UserMetricsResponse)
async def metrics_for_user(
    user_id: str,
    range_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    boards = [
        b for b in (
            await db.execute(
                select(distinct(UsageEvent.board_family)).where(
                    UsageEvent.user_id == user_id, UsageEvent.board_family.is_not(None)
                )
            )
        ).scalars().all() if b
    ]
    fqbns = [
        f for f in (
            await db.execute(
                select(distinct(UsageEvent.board_fqbn)).where(
                    UsageEvent.user_id == user_id, UsageEvent.board_fqbn.is_not(None)
                )
            )
        ).scalars().all() if f
    ]
    project_count = (
        await db.execute(select(func.count(Project.id)).where(Project.user_id == user_id))
    ).scalar() or 0

    since = _now() - timedelta(days=range_days)
    bucket_expr = func.strftime("%Y-%m-%d", UsageEvent.created_at).label("bucket")
    rows = (
        await db.execute(
            select(bucket_expr, func.count(UsageEvent.id))
            .where(
                UsageEvent.user_id == user_id,
                UsageEvent.event_type == "compile",
                UsageEvent.created_at >= since,
            )
            .group_by(bucket_expr)
            .order_by(bucket_expr)
        )
    ).all()

    return UserMetricsResponse(
        user_id=user.id,
        username=user.username,
        total_compiles=user.total_compiles,
        total_compile_errors=user.total_compile_errors,
        total_runs=user.total_runs,
        last_active_at=user.last_active_at,
        boards_used=boards,
        fqbns_used=fqbns,
        project_count=project_count,
        timeseries=[TimeseriesPoint(bucket=r[0], value=r[1]) for r in rows],
    )


@router.get("/metrics/countries", response_model=CountriesResponse)
async def metrics_countries(
    range_days: int = Query(90, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """Per-country breakdown.

    Combines two views:
      - User-table: how many users currently set to each country (last_country)
        and how many signed up from there (signup_country).
      - UsageEvent: compile/run volume + distinct active users per country
        within the requested range.
    """
    since = _now() - timedelta(days=range_days)

    # Per-country compile / run / distinct-user from events
    event_rows = (
        await db.execute(
            select(
                UsageEvent.country,
                func.sum(
                    func.case(
                        (UsageEvent.event_type.in_(("compile", "compile_error")), 1),
                        else_=0,
                    )
                ).label("compiles"),
                func.sum(
                    func.case((UsageEvent.event_type == "run", 1), else_=0)
                ).label("runs"),
                func.count(distinct(UsageEvent.user_id)).label("active_users"),
            )
            .where(UsageEvent.created_at >= since)
            .group_by(UsageEvent.country)
        )
    ).all()

    # User-table aggregates (all-time, not range-bound)
    last_rows = (
        await db.execute(
            select(User.last_country, func.count(User.id))
            .group_by(User.last_country)
        )
    ).all()
    signup_rows = (
        await db.execute(
            select(User.signup_country, func.count(User.id))
            .group_by(User.signup_country)
        )
    ).all()

    last_map = {row[0]: row[1] for row in last_rows}
    signup_map = {row[0]: row[1] for row in signup_rows}

    # Union all keys we've seen
    all_keys = (
        {row[0] for row in event_rows}
        | set(last_map.keys())
        | set(signup_map.keys())
    )

    event_map = {row[0]: row for row in event_rows}
    entries: list[CountryEntry] = []
    for key in all_keys:
        evt = event_map.get(key)
        entries.append(
            CountryEntry(
                country=key,
                user_count=last_map.get(key, 0),
                signup_count=signup_map.get(key, 0),
                compile_count=int(evt[1] or 0) if evt else 0,
                run_count=int(evt[2] or 0) if evt else 0,
                distinct_users_active=int(evt[3] or 0) if evt else 0,
            )
        )

    # Sort by total signal (users + active + compiles) descending
    entries.sort(
        key=lambda e: (e.user_count + e.distinct_users_active, e.compile_count),
        reverse=True,
    )

    return CountriesResponse(range_days=range_days, entries=entries)


@router.get("/metrics/projects/{project_id}", response_model=ProjectMetricsResponse)
async def metrics_for_project(
    project_id: str,
    range_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    owner = (await db.execute(select(User).where(User.id == project.user_id))).scalar_one_or_none()

    since = _now() - timedelta(days=range_days)
    bucket_expr = func.strftime("%Y-%m-%d", UsageEvent.created_at).label("bucket")
    rows = (
        await db.execute(
            select(bucket_expr, func.count(UsageEvent.id))
            .where(
                UsageEvent.project_id == project_id,
                UsageEvent.event_type == "compile",
                UsageEvent.created_at >= since,
            )
            .group_by(bucket_expr)
            .order_by(bucket_expr)
        )
    ).all()

    return ProjectMetricsResponse(
        project_id=project.id,
        project_name=project.name,
        owner_username=owner.username if owner else "",
        compile_count=project.compile_count,
        compile_error_count=project.compile_error_count,
        run_count=project.run_count,
        update_count=project.update_count,
        last_compiled_at=project.last_compiled_at,
        last_run_at=project.last_run_at,
        timeseries=[TimeseriesPoint(bucket=r[0], value=r[1]) for r in rows],
    )
