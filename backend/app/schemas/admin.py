from datetime import datetime

from pydantic import BaseModel, EmailStr


class AdminSetupRequest(BaseModel):
    username: str
    email: EmailStr
    password: str


class AdminUserResponse(BaseModel):
    id: str
    username: str
    email: str
    avatar_url: str | None
    is_active: bool
    is_admin: bool
    created_at: datetime
    project_count: int = 0
    # Usage metrics
    total_compiles: int = 0
    total_compile_errors: int = 0
    total_runs: int = 0
    last_active_at: datetime | None = None
    boards_used: list[str] = []  # distinct board families this user has compiled
    signup_country: str | None = None
    last_country: str | None = None

    model_config = {"from_attributes": True}


class AdminUserUpdateRequest(BaseModel):
    username: str | None = None
    email: EmailStr | None = None
    password: str | None = None
    is_active: bool | None = None
    is_admin: bool | None = None


class AdminProjectResponse(BaseModel):
    id: str
    name: str
    slug: str
    description: str | None
    is_public: bool
    board_type: str
    owner_username: str
    owner_id: str
    created_at: datetime
    updated_at: datetime
    # Usage metrics
    compile_count: int = 0
    compile_error_count: int = 0
    run_count: int = 0
    update_count: int = 0
    last_compiled_at: datetime | None = None
    last_run_at: datetime | None = None

    model_config = {"from_attributes": True}


# ── Dashboard / metrics responses ────────────────────────────────────────────


class OverviewResponse(BaseModel):
    total_users: int
    total_projects: int
    public_projects: int
    private_projects: int
    total_compiles: int
    total_compile_errors: int
    total_runs: int
    compile_success_rate: float  # 0..1
    dau: int  # active users in last 24h
    wau: int  # active users in last 7d
    mau: int  # active users in last 30d
    new_users_30d: int
    new_projects_30d: int


class TimeseriesPoint(BaseModel):
    bucket: str  # ISO date / hour
    value: int


class TimeseriesResponse(BaseModel):
    metric: str
    bucket: str  # 'day' | 'hour' | 'week'
    range_days: int
    points: list[TimeseriesPoint]


class BoardBreakdown(BaseModel):
    board_family: str | None
    board_fqbn: str | None
    compile_count: int
    compile_error_count: int
    run_count: int
    distinct_users: int
    distinct_projects: int


class BoardsResponse(BaseModel):
    families: list[BoardBreakdown]
    fqbns: list[BoardBreakdown]


class BoardDiversityBucket(BaseModel):
    bucket: str  # '1', '2', '3+'
    user_count: int


class BoardDiversityResponse(BaseModel):
    buckets: list[BoardDiversityBucket]
    total_users_with_compiles: int


class TopUserEntry(BaseModel):
    user_id: str
    username: str
    value: int


class TopProjectEntry(BaseModel):
    project_id: str
    project_name: str
    owner_username: str
    value: int


class UserMetricsResponse(BaseModel):
    user_id: str
    username: str
    total_compiles: int
    total_compile_errors: int
    total_runs: int
    last_active_at: datetime | None
    boards_used: list[str]
    fqbns_used: list[str]
    project_count: int
    timeseries: list[TimeseriesPoint]


class CountryEntry(BaseModel):
    country: str | None  # ISO-3166 alpha-2 (or None for unknown / dev)
    user_count: int  # users currently or recently in this country (last_country)
    signup_count: int  # users who signed up from this country
    compile_count: int
    run_count: int
    distinct_users_active: int  # distinct users with any UsageEvent from this country


class CountriesResponse(BaseModel):
    range_days: int
    entries: list[CountryEntry]


class ProjectMetricsResponse(BaseModel):
    project_id: str
    project_name: str
    owner_username: str
    compile_count: int
    compile_error_count: int
    run_count: int
    update_count: int
    last_compiled_at: datetime | None
    last_run_at: datetime | None
    timeseries: list[TimeseriesPoint]
