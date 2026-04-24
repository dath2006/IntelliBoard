"""Agent session context management - handles conversation history and state."""

import json
from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import AgentSession as AgentSessionModel


@dataclass
class AgentMessage:
    """Single message in agent conversation."""
    role: str  # "user" or "assistant"
    content: str
    timestamp: datetime
    tool_calls: Optional[list[str]] = None
    artifacts: Optional[dict[str, Any]] = None
    status: str = "received"  # "sent", "received", "error"


@dataclass
class SessionContext:
    """Context for a single agent session."""
    session_id: str
    user_id: str
    project_id: str
    conversation_history: list[AgentMessage] = field(default_factory=list)
    current_circuit: dict[str, Any] = field(default_factory=dict)
    active_code: dict[str, Any] = field(default_factory=dict)


class ContextManager:
    """Manages agent session context and persistence."""

    def __init__(self, db_session: AsyncSession):
        self.db = db_session

    async def create_session(self, user_id: str, project_id: str) -> str:
        """Create new agent session."""
        session = AgentSessionModel(
            project_id=project_id,
            user_id=user_id,
            conversation_messages="[]",
            current_circuit_snapshot="{}",
            current_code_snapshot="{}",
            session_metadata=json.dumps({
                "total_turns": 0,
                "tool_calls_made": [],
                "errors_encountered": [],
                "created_at": datetime.utcnow().isoformat()
            })
        )
        self.db.add(session)
        await self.db.flush()
        return session.id

    async def load_session(self, session_id: str) -> SessionContext:
        """Load session from database."""
        result = await self.db.execute(
            select(AgentSessionModel).where(AgentSessionModel.id == session_id)
        )
        db_session = result.scalars().first()
        
        if not db_session:
            raise ValueError(f"Session {session_id} not found")
        
        # Parse conversation messages
        messages_data = json.loads(db_session.conversation_messages or "[]")
        conversation_history = [
            AgentMessage(
                role=msg.get("role"),
                content=msg.get("content"),
                timestamp=datetime.fromisoformat(msg.get("timestamp", datetime.utcnow().isoformat())),
                tool_calls=msg.get("tool_calls"),
                artifacts=msg.get("artifacts"),
                status=msg.get("status", "received")
            )
            for msg in messages_data
        ]
        
        # Parse circuit and code snapshots
        current_circuit = json.loads(db_session.current_circuit_snapshot or "{}")
        active_code = json.loads(db_session.current_code_snapshot or "{}")
        
        return SessionContext(
            session_id=db_session.id,
            user_id=db_session.user_id,
            project_id=db_session.project_id,
            conversation_history=conversation_history,
            current_circuit=current_circuit,
            active_code=active_code
        )

    async def append_message(self, session_id: str, message: AgentMessage) -> None:
        """Append message to conversation history."""
        db_session = await self.db.execute(
            select(AgentSessionModel).where(AgentSessionModel.id == session_id)
        )
        db_session = db_session.scalars().first()
        
        if not db_session:
            raise ValueError(f"Session {session_id} not found")
        
        # Load current messages
        messages_data = json.loads(db_session.conversation_messages or "[]")
        
        # Append new message
        message_dict = {
            "role": message.role,
            "content": message.content,
            "timestamp": message.timestamp.isoformat(),
            "tool_calls": message.tool_calls,
            "artifacts": message.artifacts,
            "status": message.status
        }
        messages_data.append(message_dict)
        
        # Update session
        db_session.conversation_messages = json.dumps(messages_data)
        db_session.updated_at = datetime.utcnow()
        
        # Update metadata: increment turn count
        metadata = json.loads(db_session.session_metadata or "{}")
        metadata["total_turns"] = metadata.get("total_turns", 0) + 1
        db_session.session_metadata = json.dumps(metadata)
        
        await self.db.flush()

    async def update_circuit_state(self, session_id: str, circuit: dict[str, Any]) -> None:
        """Update circuit snapshot."""
        db_session = await self.db.execute(
            select(AgentSessionModel).where(AgentSessionModel.id == session_id)
        )
        db_session = db_session.scalars().first()
        
        if not db_session:
            raise ValueError(f"Session {session_id} not found")
        
        db_session.current_circuit_snapshot = json.dumps(circuit)
        db_session.updated_at = datetime.utcnow()
        await self.db.flush()

    async def update_code_state(self, session_id: str, code_files: dict[str, str]) -> None:
        """Update code snapshot."""
        db_session = await self.db.execute(
            select(AgentSessionModel).where(AgentSessionModel.id == session_id)
        )
        db_session = db_session.scalars().first()
        
        if not db_session:
            raise ValueError(f"Session {session_id} not found")
        
        db_session.current_code_snapshot = json.dumps(code_files)
        db_session.updated_at = datetime.utcnow()
        await self.db.flush()

    async def get_context_window(
        self, session_id: str, max_messages: int = 20
    ) -> list[AgentMessage]:
        """Get recent messages within token budget."""
        context = await self.load_session(session_id)
        
        # Return last N messages (most recent conversation)
        return context.conversation_history[-max_messages:]

    async def list_sessions_for_project(
        self, project_id: str, user_id: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        """List all sessions for a project."""
        result = await self.db.execute(
            select(AgentSessionModel)
            .where(
                (AgentSessionModel.project_id == project_id) &
                (AgentSessionModel.user_id == user_id)
            )
            .order_by(AgentSessionModel.created_at.desc())
            .limit(limit)
        )
        sessions = result.scalars().all()
        
        session_list = []
        for session in sessions:
            messages = json.loads(session.conversation_messages or "[]")
            first_user_msg = next(
                (m for m in messages if m.get("role") == "user"),
                {"content": "New conversation"}
            )
            
            session_list.append({
                "id": session.id,
                "project_id": session.project_id,
                "created_at": session.created_at.isoformat(),
                "updated_at": session.updated_at.isoformat(),
                "message_count": len(messages),
                "preview_text": first_user_msg.get("content", "")[:50]
            })
        
        return session_list
