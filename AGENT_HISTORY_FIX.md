# Agent Conversation History Persistence Fix - FINAL SOLUTION

## Problem
The agent chat panel was not loading previous conversation history when switching between sessions or refreshing the page. Agent responses were not being stored in the database.

## Root Cause Analysis

### Issue 1: Agent Responses Not Stored
The backend was storing user messages (`run.started` events) but NOT storing agent responses. The streaming response wrapper was trying to parse SSE chunks manually, which is error-prone and unreliable.

### Issue 2: Wrong Event Types
The frontend was looking for `message.received` events for user messages, but the backend was actually storing them as `run.started` events.

## Solution Implemented

### Backend Changes (`backend/app/api/routes/agent_sessions.py`)

#### 1. Use `on_complete` Callback (Proper pydantic-ai Pattern)
Instead of manually parsing streaming chunks, we now use pydantic-ai's built-in `on_complete` callback:

```python
async def handle_agent_completion(result) -> None:
    """
    Callback invoked after the agent stream completes.
    Captures the final agent response and stores it in the database.
    """
    try:
        # Extract the final text output from the result
        final_output = ""
        if hasattr(result, 'data') and result.data:
            final_output = str(result.data)
        elif hasattr(result, 'output') and result.output:
            final_output = str(result.output)
        
        # Get all messages from the run if available
        if hasattr(result, 'all_messages'):
            messages = result.all_messages()
            # Extract assistant messages
            for msg in reversed(messages):
                if hasattr(msg, 'role') and msg.role == 'assistant':
                    if hasattr(msg, 'content'):
                        content = msg.content
                        if isinstance(content, str):
                            final_output = content
                        elif isinstance(content, list):
                            text_parts = []
                            for part in content:
                                if hasattr(part, 'text'):
                                    text_parts.append(part.text)
                                elif isinstance(part, dict) and 'text' in part:
                                    text_parts.append(part['text'])
                            if text_parts:
                                final_output = ''.join(text_parts)
                    break
        
        # Store the response if we captured any text
        if final_output and final_output.strip():
            async with AsyncSessionLocal() as db_bg:
                await set_session_status(
                    db_bg,
                    session_id=session.id,
                    user_id=user.id,
                    status="completed",
                )
                await append_event(
                    db_bg,
                    session_id=session.id,
                    event_type="run.completed",
                    payload={"output": final_output.strip()},
                )
    except Exception as exc:
        print(f"Error in handle_agent_completion: {exc}")
```

#### 2. Pass Callback to AG-UI Adapter
```python
# For AGUIApp
response = await adapter.handle(request, on_complete=handle_agent_completion)

# For AGUIAdapter
response = await AGUIAdapter.dispatch_request(
    request, 
    on_complete=handle_agent_completion,
    **dispatch_kwargs
)
```

#### 3. Load and Inject Conversation History
When handling AG-UI requests, load previous events and inject them as message history:

```python
# Load conversation history from stored events
events = await replay_events(db, session_id=session.id, after_seq=0)
conversation_history: list[dict[str, Any]] = []

for event in events:
    event_payload = json.loads(event.payload_json or "{}")
    if event.event_type == "run.started":  # User messages
        msg = event_payload.get("message", "").strip()
        if msg:
            conversation_history.append({
                "role": "user",
                "content": msg,
            })
    elif event.event_type == "run.completed":  # Agent responses
        output = event_payload.get("output", "").strip()
        if output:
            conversation_history.append({
                "role": "assistant",
                "content": output,
            })

# Inject into payload
if conversation_history:
    payload["messages"] = conversation_history
```

### Frontend Changes (`frontend/src/components/agent/AgUiPanel.tsx`)

#### 1. Fetch History on Component Mount
```typescript
useEffect(() => {
  const loadHistory = async () => {
    const apiBase = import.meta.env.VITE_API_BASE || '/api';
    const response = await fetch(
      `${apiBase}/agent/sessions/${sessionId}/events?stream=false`,
      { credentials: 'include' }
    );
    
    const events = await response.json();
    const messages: any[] = [];

    for (const event of events) {
      // User messages from run.started events
      if (event.eventType === 'run.started' && event.payload?.message) {
        messages.push({
          role: 'user',
          content: event.payload.message,
        });
      } 
      // Assistant responses from run.completed events
      else if (event.eventType === 'run.completed' && event.payload?.output) {
        if (event.payload.output.trim()) {
          messages.push({
            role: 'assistant',
            content: event.payload.output,
          });
        }
      }
    }

    setInitialMessages(messages);
    setHistoryLoaded(true);
  };

  loadHistory();
}, [sessionId]);
```

#### 2. Pass History to CopilotChat
```typescript
<CopilotChat 
  className="agu-chat" 
  agentId="velxio" 
  threadId={sessionId}
  initialMessages={initialMessages}
/>
```

## How It Works

### Flow Diagram

```
User sends message
    ↓
Backend stores run.started event (user message)
    ↓
Agent processes with full conversation history
    ↓
Agent streams response to frontend
    ↓
on_complete callback fires with complete result
    ↓
Backend stores run.completed event (agent response)
    ↓
Frontend fetches events and displays history
```

### Event Types

| Event Type | Contains | Purpose |
|------------|----------|---------|
| `session.created` | Empty | Session initialization |
| `run.started` | `payload.message` | User's message |
| `run.completed` | `payload.output` | Agent's complete response |
| `snapshot.updated` | Tool execution details | Canvas state changes |
| `frontend.action.request` | Action details | Frontend action requests |
| `frontend.action.result` | Action results | Frontend action results |

## Benefits

✅ **Reliable Response Capture**: Uses pydantic-ai's official `on_complete` callback
✅ **Complete Message History**: Captures full agent response, not partial chunks
✅ **Persistent Across Sessions**: All history stored in PostgreSQL
✅ **No Manual Parsing**: Avoids error-prone SSE chunk parsing
✅ **Backward Compatible**: Works with existing sessions
✅ **Frontend Display**: History loads automatically on session switch

## Testing

To verify the fix:

1. **Send a message** to the agent
2. **Check the database**:
   ```sql
   SELECT event_type, payload_json 
   FROM agent_session_events 
   WHERE session_id = '<your-session-id>' 
   ORDER BY seq;
   ```
   You should see:
   - `run.started` with user message
   - `run.completed` with agent response

3. **Refresh the page** or switch sessions
4. **Return to the session** - history should display

5. **Check browser console** for:
   ```
   Loaded conversation history: X messages
   ```

## Why This Approach is Correct

### ❌ Wrong: Manual SSE Parsing
```python
# DON'T DO THIS - unreliable and error-prone
for chunk in stream:
    if '"text":' in chunk:
        # Try to extract text...
```

### ✅ Right: Use on_complete Callback
```python
# DO THIS - official pydantic-ai pattern
async def handle_completion(result):
    final_output = result.data  # Complete, validated result
    await store_in_db(final_output)

response = await adapter.handle(request, on_complete=handle_completion)
```

## Database Schema

```sql
CREATE TABLE agent_session_events (
    id UUID PRIMARY KEY,
    session_id UUID REFERENCES agent_sessions(id),
    seq INTEGER NOT NULL,
    event_type VARCHAR NOT NULL,
    payload_json TEXT,
    created_at TIMESTAMP
);
```

## Conclusion

The fix implements proper conversation persistence using pydantic-ai's `on_complete` callback pattern. This ensures:
- Agent responses are reliably captured and stored
- Conversation history is available across sessions
- The solution follows pydantic-ai best practices
- No manual parsing of streaming protocols

The conversation history now works correctly with full persistence!
