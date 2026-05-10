from pydantic_ai.ui.vercel_ai import VercelAIAdapter

# We keep the conversion utility for cases where we need to manually process messages
# or reconstruct history from the database in Pydantic AI format.


def _sanitize_tool_name(name: str | None) -> str:
    """
    Sanitize tool names to comply with OpenAI API pattern ^[a-zA-Z0-9_-]+$.
    Replaces invalid characters (like dots) with underscores.
    """
    if not name:
        return "tool"
    # Replace dots and other invalid characters with underscores
    sanitized = name.replace(".", "_").replace(" ", "_")
    # Remove any other characters that don't match the pattern
    import re
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "_", sanitized)
    return sanitized or "tool"


def convert_vercel_messages_to_pydantic(messages: list[dict[str, any]]) -> list[any]:
    """
    Converts Vercel AI SDK messages into Pydantic AI ModelMessages.
    """
    from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
    import datetime

    pydantic_messages = []

    for m in messages:
        role = m.get("role")
        content = m.get("content", "")
        tool_invocations = m.get("toolInvocations", [])

        if role == "user":
            parts = [TextPart(content=content)] if content else []
            pydantic_messages.append(ModelRequest(parts=parts))

        elif role == "assistant":
            parts = []
            if content:
                parts.append(TextPart(content=content))

            for ti in tool_invocations:
                parts.append(ToolCallPart(
                    tool_name=_sanitize_tool_name(ti.get("toolName")),
                    args=ti.get("args"),
                    tool_call_id=ti.get("toolCallId")
                ))

            if parts:
                pydantic_messages.append(ModelResponse(parts=parts, timestamp=datetime.datetime.now()))

            # If there are results in these invocations, they follow as a request from the \"user\" (system side)
            results_parts = []
            for ti in tool_invocations:
                if "result" in ti:
                    results_parts.append(ToolReturnPart(
                        tool_name=_sanitize_tool_name(ti.get("toolName")),
                        content=ti.get("result"),
                        tool_call_id=ti.get("toolCallId"),
                        timestamp=datetime.datetime.now()
                    ))
            if results_parts:
                pydantic_messages.append(ModelRequest(parts=results_parts))

    return pydantic_messages
