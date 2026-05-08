# History Display Fix - MessagesSnapshotEvent Approach

## Problem

Conversation history was not displaying in the AG-UI chat interface. The backend was injecting history into the payload for agent context, but the UI remained empty because AG-UI protocol doesn't automatically render history messages.

## Root Cause

The AG-UI protocol is designed for stateless agent communication:
- History is sent to the agent for context (in `payload["messages"]`)
- But the UI doesn't automatically display these messages
- The protocol expects explicit UI events to render messages
- `useAgent` hook doesn't work with AG-UI (not supported)
- `initialMessages` prop is ignored by AG-UI adapter

## Solution

**Emit a `MessagesSnapshotEvent` at the start of the stream** to force the UI to display history. This is the proper AG-UI way to "replay" history to the frontend.

### Implementation

**Backend (`backend/app/api/routes/agent_sessions.py`):**

```python
async def stream_with_history():
    # 1. Emit MessagesSnapshotEvent first to display history in UI
    if conversation_history:
        snapshot_event = {
            "type": "messages_snapshot",
            "messages": conversation_history  # Already formatted from events
        }
        yield f"data: {json.dumps(snapshot_event)}\n\n"
    
    # 2. Then stream the actual agent response
    try:
        base_response = await adapter.handle(request, on_complete=handle_agent_completion)
    except TypeError:
        base_response = await adapter.handle(request)
    
    # 3. Forward the agent's streaming response
    if hasattr(base_response, 'body_iterator'):
        async for chunk in base_response.body_iterator:
            yield chunk
    else:
        yield base_response.body

# Return as StreamingResponse
response = StreamingResponse(
    stream_with_history(),
    media_type="text/event-stream",
    headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
)
```

**Key Points:**
1. **Load history from database** - Already done via `replay_events()`
2. **Format for AG-UI** - Messages have `id`, `role`, `content`
3. **Emit snapshot event first** - Before the agent stream starts
4. **Then stream agent response** - Normal AG-UI streaming continues

**Frontend (`frontend/src/components/agent/AgUiPanel.tsx`):**

```typescript
// Clean and simple - no manual history loading needed
const AgUiChatCore = ({ sessionId, ...props }) => {
  useAgentSync(sessionId);
  
  // Backend emits MessagesSnapshotEvent at stream start to display history
  return <CopilotChat className="agu-chat" agentId="velxio" threadId={sessionId} />;
};
```

**No frontend changes needed!** The backend handles everything.

## How It Works

### Flow:

1. **User opens session** → Frontend renders `CopilotChat` with `threadId={sessionId}`
2. **First message sent** → Frontend calls `/agent/ag-ui?sessionId=...`
3. **Backend loads history** → Fetches events from database
4. **Backend emits snapshot** → Sends `MessagesSnapshotEvent` as first SSE event
5. **UI displays history** → CopilotKit renders all history messages
6. **Agent processes request** → With full conversation context
7. **Backend streams response** → New message appears below history
8. **Seamless conversation** → History + new messages in one continuous UI

### Event Format:

```json
{
  "type": "messages_snapshot",
  "messages": [
    {
      "id": "msg-1-user",
      "role": "user",
      "content": "Build a circuit"
    },
    {
      "id": "msg-2-assistant",
      "role": "assistant",
      "content": "I'll build an LED circuit..."
    }
  ]
}
```

## Benefits

✅ **Proper AG-UI Protocol** - Uses official event mechanism  
✅ **No Frontend Hacks** - No `useAgent`, no manual rendering  
✅ **No Flash** - History appears immediately, no loading state  
✅ **Seamless UX** - History and new messages in one continuous chat  
✅ **Automatic Styling** - CopilotKit handles all message rendering  
✅ **Maintainable** - Clean separation of concerns  
✅ **Scalable** - Works for any conversation length  

## Technical Details

### Why MessagesSnapshotEvent?

AG-UI protocol defines several event types:
- `messages_snapshot` - Full message history (what we use)
- `message_delta` - Streaming text chunks
- `tool_call` - Tool execution events
- `error` - Error messages

The `messages_snapshot` event tells the UI: "Here's the complete message history, render it all."

### Message Format Requirements:

```typescript
{
  id: string,           // Unique identifier
  role: 'user' | 'assistant',  // Strictly typed
  content: string,      // Message text
}
```

**Important:**
- Roles MUST be `'user'` or `'assistant'` (not `'system'` or `'tool'`)
- Each message needs a unique `id`
- Content must be a string (not array or object)

### Streaming Response Structure:

```
data: {"type": "messages_snapshot", "messages": [...]}

data: {"type": "message_delta", "delta": "I'll"}

data: {"type": "message_delta", "delta": " build"}

data: {"type": "message_delta", "delta": " a circuit"}

data: {"type": "message_complete"}
```

## Files Modified

1. **`backend/app/api/routes/agent_sessions.py`**
   - Wrapped `adapter.handle()` response in `stream_with_history()`
   - Emits `MessagesSnapshotEvent` before agent stream
   - Returns `StreamingResponse` with proper headers

2. **`frontend/src/components/agent/AgUiPanel.tsx`**
   - Removed all manual history loading code
   - Removed `useAgent` import (not supported by AG-UI)
   - Clean component that just renders `CopilotChat`

3. **`frontend/src/App.css`**
   - Added CSS to hide empty message boxes after tool calls

## Testing

- [ ] Open a session with existing conversation history
- [ ] Verify history appears immediately (no loading state)
- [ ] Verify history messages use CopilotKit's native styling
- [ ] Send a new message and verify it appears below history
- [ ] Verify no visual split between history and new messages
- [ ] Check browser console for no errors
- [ ] Verify tool calls display correctly
- [ ] Test on mobile/tablet for responsive behavior

## Troubleshooting

**History not appearing:**
- Check backend logs for "Loaded conversation history" message
- Verify `conversation_history` is not empty
- Check browser network tab for SSE events
- Look for `messages_snapshot` event in the stream

**Messages appear twice:**
- Ensure frontend is not manually loading history
- Check that `AgentHistoryInjector` component is removed
- Verify no duplicate event emissions in backend

**Styling issues:**
- History should use CopilotKit's native components automatically
- No custom CSS needed for history messages
- If styling differs, check message format (id, role, content)

## References

- [AG-UI Protocol Specification](https://github.com/pydantic/pydantic-ai)
- [Pydantic AI Streaming Documentation](https://ai.pydantic.dev/streaming/)
- [FastAPI StreamingResponse](https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse)
- [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
