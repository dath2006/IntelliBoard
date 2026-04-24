"""Agent-facing accessors for the knowledge DB service."""

from app.services.knowledge_db import KnowledgeDBService, get_knowledge_db, initialize_knowledge_db

__all__ = ["KnowledgeDBService", "get_knowledge_db", "initialize_knowledge_db"]
