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


def extract_text_from_file(filename: str, media_type: str, data_url: str) -> str:
    """
    Decodes a Data URI and extracts text content based on the media type.
    Supports PDF (via pypdf), Word documents (via python-docx), and plain text.
    """
    import base64
    import io

    try:
        if not data_url.startswith("data:"):
            return f"[Error: Attachment '{filename}' is not a valid data URI]"

        header, data = data_url.split(",", 1)
        is_base64 = ";base64" in header

        if is_base64:
            decoded_bytes = base64.b64decode(data)
        else:
            import urllib.parse
            decoded_bytes = urllib.parse.unquote(data).encode("utf-8")

        # Handle plain text / code files
        if media_type.startswith("text/") or media_type in ("application/json", "application/javascript", "text/plain"):
            return decoded_bytes.decode("utf-8", errors="ignore")

        # Handle PDF documents
        elif media_type == "application/pdf":
            try:
                import pypdf
                pdf_file = io.BytesIO(decoded_bytes)
                reader = pypdf.PdfReader(pdf_file)
                text_parts = []
                for idx, page in enumerate(reader.pages):
                    page_text = page.extract_text()
                    if page_text:
                        text_parts.append(f"--- Page {idx + 1} ---\n{page_text}")
                return "\n".join(text_parts) if text_parts else "[No text content found in PDF]"
            except ImportError:
                return f"[Error: pypdf library is not installed in the backend environment. Cannot parse PDF '{filename}']"
            except Exception as e:
                return f"[Error reading PDF '{filename}': {e}]"

        # Handle Word documents (.docx)
        elif media_type in (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/msword"
        ):
            try:
                import docx
                doc_file = io.BytesIO(decoded_bytes)
                doc = docx.Document(doc_file)
                paragraphs = [p.text for p in doc.paragraphs]
                return "\n".join(paragraphs) if paragraphs else "[No text content found in Word document]"
            except ImportError:
                return f"[Error: python-docx library is not installed in the backend environment. Cannot parse Word document '{filename}']"
            except Exception as e:
                return f"[Error reading Word document '{filename}': {e}]"

        else:
            return f"[Unsupported non-image attachment format: {media_type}]"

    except Exception as e:
        return f"[Error parsing attachment '{filename}': {e}]"


def process_incoming_payload_attachments(payload: dict[str, any]) -> dict[str, any]:
    """
    Scans the incoming messages payload for non-image file parts, extracts their text
    content, and converts those parts to standard text parts with header metadata.
    This ensures models without native document vision or search capabilities can
    still read and act on files like PDFs, Word files, and plain text uploads.
    """
    messages = payload.get("messages", [])
    if not isinstance(messages, list):
        return payload

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        parts = msg.get("parts")
        if not isinstance(parts, list):
            continue

        new_parts = []
        for part in parts:
            if not isinstance(part, dict):
                new_parts.append(part)
                continue

            part_type = part.get("type")
            media_type = part.get("mediaType", "")
            
            if part_type == "file" and media_type:
                # Keep images as file parts so multimodal models can use vision
                if media_type.startswith("image/"):
                    new_parts.append(part)
                else:
                    filename = part.get("filename", "document")
                    url = part.get("url", "")
                    
                    # Extract text content
                    file_text = extract_text_from_file(filename, media_type, url)
                    
                    # Format as structured prompt context
                    formatted_content = (
                        f"Uploaded File: {filename} ({media_type})\n"
                        f"--- START OF FILE CONTENT ---\n"
                        f"{file_text}\n"
                        f"--- END OF FILE CONTENT ---"
                    )
                    
                    # Replace file part with a text part
                    new_parts.append({
                        "type": "text",
                        "text": formatted_content
                    })
            else:
                new_parts.append(part)
                
        msg["parts"] = new_parts

    return payload

