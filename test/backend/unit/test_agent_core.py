"""Unit tests for backend agent core behavior.

These tests validate:
1. Request-scoped API key handling in get_velxio_agent().
2. Artifact extraction and snapshot persistence in agent_chat().
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

# Ensure backend/ is importable.
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "backend"))

from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ToolCallPart,
    ToolReturnPart,
)

from app.agent.context import AgentMessage, SessionContext
from app.agent.agent import agent_chat, get_velxio_agent


class TestGetVelxioAgent:
    @pytest.mark.anyio
    async def test_restores_previous_api_key(self, monkeypatch: pytest.MonkeyPatch):
        captured_key: list[str | None] = []

        def fake_create_velxio_agent():
            captured_key.append(os.environ.get("OPENAI_API_KEY"))
            return object()

        monkeypatch.setattr("app.agent.agent.create_velxio_agent", fake_create_velxio_agent)
        monkeypatch.setenv("OPENAI_API_KEY", "orig-key")

        _ = await get_velxio_agent("temp-key")

        assert captured_key == ["temp-key"]
        assert os.environ.get("OPENAI_API_KEY") == "orig-key"

    @pytest.mark.anyio
    async def test_clears_temp_api_key_when_none_previously_set(self, monkeypatch: pytest.MonkeyPatch):
        captured_key: list[str | None] = []

        def fake_create_velxio_agent():
            captured_key.append(os.environ.get("OPENAI_API_KEY"))
            return object()

        monkeypatch.setattr("app.agent.agent.create_velxio_agent", fake_create_velxio_agent)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        _ = await get_velxio_agent("temp-key")

        assert captured_key == ["temp-key"]
        assert "OPENAI_API_KEY" not in os.environ


class TestAgentChat:
    @pytest.mark.anyio
    async def test_extracts_tool_artifacts_and_updates_snapshots(self, monkeypatch: pytest.MonkeyPatch):
        state: dict[str, object] = {
            "circuit_updates": [],
            "code_updates": [],
            "messages": [],
        }

        class FakeContextManager:
            def __init__(self, _db):
                pass

            async def load_session(self, session_id: str) -> SessionContext:
                return SessionContext(
                    session_id=session_id,
                    user_id="u1",
                    project_id="p1",
                    conversation_history=[],
                    current_circuit={},
                    active_code={},
                )

            async def get_context_window(self, _session_id: str, max_messages: int = 20):
                return []

            async def update_circuit_state(self, _session_id: str, circuit: dict):
                state["circuit_updates"].append(circuit)

            async def update_code_state(self, _session_id: str, code_files: dict):
                state["code_updates"].append(code_files)

            async def append_message(self, _session_id: str, message: AgentMessage):
                state["messages"].append(message)

        class FakeAgent:
            async def run(self, _prompt: str, **kwargs):
                handler = kwargs["event_stream_handler"]

                async def event_gen():
                    yield FunctionToolCallEvent(
                        part=ToolCallPart(
                            tool_name="create_circuit",
                            args={"components": [{"id": "led1"}]},
                            tool_call_id="tc-1",
                        )
                    )
                    yield FunctionToolResultEvent(
                        result=ToolReturnPart(
                            tool_name="create_circuit",
                            tool_call_id="tc-1",
                            content={
                                "components": [{"id": "led1", "type": "wokwi-led"}],
                                "connections": [],
                            },
                        )
                    )
                    yield FunctionToolResultEvent(
                        result=ToolReturnPart(
                            tool_name="fix_errors",
                            tool_call_id="tc-2",
                            content={"fixed_code": "void setup(){}\nvoid loop(){}"},
                        )
                    )
                    yield PartStartEvent(index=0, part=TextPart(content="Hello"))
                    yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta=" world"))

                await handler(None, event_gen())
                return SimpleNamespace(output="Final answer")

        monkeypatch.setattr("app.agent.agent.ContextManager", FakeContextManager)

        emitted_events: list[dict] = []

        async def emit_event(event: dict):
            emitted_events.append(event)

        db_session = AsyncMock()
        db_session.flush = AsyncMock()

        result = await agent_chat(
            agent=FakeAgent(),
            db_session=db_session,
            session_id="s1",
            user_prompt="build a blinking LED",
            emit_event=emit_event,
        )

        assert result["response_text"] == "Final answer"
        assert "artifacts" in result
        assert "circuit_changes" in result["artifacts"]
        assert "code_changes" in result["artifacts"]

        assert len(state["circuit_updates"]) == 1
        assert len(state["code_updates"]) == 1

        # User + assistant messages must be persisted.
        assert len(state["messages"]) == 2
        assistant_msg = state["messages"][1]
        assert assistant_msg.role == "assistant"
        assert assistant_msg.tool_calls == ["create_circuit"]
        assert assistant_msg.artifacts is not None

        # Streaming events should include tool and response chunk events.
        event_types = [e.get("type") for e in emitted_events]
        assert "tool_call" in event_types
        assert "tool_result" in event_types
        assert "response_chunk" in event_types

        # Tool result must occur after tool call and before final response chunks complete.
        first_tool_call = event_types.index("tool_call")
        first_tool_result = event_types.index("tool_result")
        first_response_chunk = event_types.index("response_chunk")
        assert first_tool_call < first_tool_result < first_response_chunk
