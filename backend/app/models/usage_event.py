import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base


class UsageEvent(Base):
    """Append-only event log for product analytics.

    One row per user action (compile, run, save, …). Counters on User and
    Project are derived from this table by MetricsService and kept in sync
    for O(1) dashboard reads.
    """

    __tablename__ = "usage_events"
    __table_args__ = (
        Index("ix_usage_events_user_created", "user_id", "created_at"),
        Index("ix_usage_events_project_created", "project_id", "created_at"),
        Index("ix_usage_events_type_created", "event_type", "created_at"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    project_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 'compile', 'compile_error', 'run', 'save', 'create', 'project_open'
    event_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    board_fqbn: Mapped[str | None] = mapped_column(String(80), nullable=True)
    board_family: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_kind: Mapped[str | None] = mapped_column(String(60), nullable=True)
    # ISO-3166 alpha-2 country code from CF-IPCountry, captured at event time.
    country: Mapped[str | None] = mapped_column(String(2), nullable=True, index=True)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
