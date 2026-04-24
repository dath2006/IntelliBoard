"""Agent session lifecycle management."""

from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import AgentSession as AgentSessionModel


async def create_session(
    db: AsyncSession,
    user_id: str,
    project_id: str
) -> str:
    """Create a brand new session for a project."""
    new_session = AgentSessionModel(
        project_id=project_id,
        user_id=user_id
    )
    db.add(new_session)
    await db.flush()
    return new_session.id


async def get_or_create_session(
    db: AsyncSession,
    user_id: str,
    project_id: str
) -> str:
    """Get existing session for project or create new one."""
    # Check if session exists for this project
    result = await db.execute(
        select(AgentSessionModel)
        .where(
            (AgentSessionModel.project_id == project_id) &
            (AgentSessionModel.user_id == user_id)
        )
        .order_by(AgentSessionModel.created_at.desc())
        .limit(1)
    )
    existing = result.scalars().first()
    
    if existing:
        return existing.id
    
    return await create_session(db, user_id, project_id)


async def delete_session(
    db: AsyncSession,
    session_id: str,
    user_id: str
) -> None:
    """Delete session (user verification)."""
    # Verify ownership
    result = await db.execute(
        select(AgentSessionModel).where(
            (AgentSessionModel.id == session_id) &
            (AgentSessionModel.user_id == user_id)
        )
    )
    session = result.scalars().first()
    
    if not session:
        raise ValueError(f"Session {session_id} not found or not owned by user")
    
    await db.delete(session)
    await db.flush()


async def cleanup_old_sessions(
    db: AsyncSession,
    days_old: int = 90
) -> int:
    """Delete sessions older than specified days. Runs as background task."""
    cutoff_date = datetime.utcnow() - timedelta(days=days_old)
    
    result = await db.execute(
        delete(AgentSessionModel).where(
            AgentSessionModel.created_at < cutoff_date
        )
    )
    
    await db.flush()
    return result.rowcount
