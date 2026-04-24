import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base


class AgentSession(Base):
    """Stores AI agent conversation sessions tied to projects."""

    __tablename__ = "agent_sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id: Mapped[str] = mapped_column(String, ForeignKey("projects.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    
    # Conversation history: list of {role, content, timestamp, tool_calls, artifacts}
    conversation_messages: Mapped[str] = mapped_column(Text, default="[]")
    
    # Latest snapshots of circuit and code state
    current_circuit_snapshot: Mapped[str] = mapped_column(Text, default="{}")
    current_code_snapshot: Mapped[str] = mapped_column(Text, default="{}")
    
    # Session metadata: {total_turns, tool_calls_made, errors_encountered, last_agent_tool}
    session_metadata: Mapped[str] = mapped_column(Text, default="{}")
    
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    project: Mapped["Project"] = relationship("Project", back_populates="agent_sessions")  # noqa: F821
    user: Mapped["User"] = relationship("User", back_populates="agent_sessions")  # noqa: F821
