# Seamless History UI Fix - Using useAgent Hook

## Problem

When opening a previous chat session, the conversation history appeared in a separate container with a black background at the top, while new messages appeared in a different container below. This created a visual split that made it look like two separate chat interfaces.

**User Experience Issue:**
- History messages: Black background, upper half
- New messages: Different background, lower half  
- Visual disconnect between history and new conversation
- Confusing UX - looks like two different chats

## Root Cause

The AG-UI protocol (used by CopilotKit with pydantic-ai) does NOT display conversation history in the UI by design. It only sends history to the agent for context. The standard `initialMessages` prop fails with AG-UI because the UI state is strictly managed by the agent proxy.

**Why initialMessages Doesn't Work:**
- AG-UI expects history to be synchronized via protocol-level events
- The agent proxy manages UI state internally
- `initialMessages` prop is ignored by the AG-UI adapter
- Manual rendering creates visual inconsistency

## Solution

Use the **`useAgent` hook** to programmatically inject history messages directly into the agent's internal message store. This is the most reliable way to display history with AG-UI.

### Implementation

**Component Structure:**

```typescript
// 1. History Injector Component
const AgentHistoryInjector: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { agent } = useAgent(); // Get agent instance
  const [historyMessages, setHistoryMessages] = useState<any[]>([]);
  const injectedRef = useRef(false);

  // Load history from backend
  useEffect(() => {
    const loadHistory = async () => {
      const response = await fetch(`/api/agent/sessions/${sessionId}/events?stream=false`);
      const events = await response.json();
      
      const messages = events
        .filter(e => e.eventType === 'run.started' || e.eventType === 'run.completed')
        .map(e => ({
          id: `msg-${e.seq}-${e.eventType === 'run.started' ? 'user' : 'assistant'}`,
          role: e.eventType === 'run.started' ? 'user' : 'assistant',
          content: e.payload.message || e.payload.output,
          createdAt: new Date(e.createdAt),
        }));
      
      setHistoryMessages(messages);
    };
    loadHistory();
  }, [sessionId]);

  // Inject history into agent when ready
  useEffect(() => {
    if (!agent || injectedRef.current || historyMessages.length === 0) {
      return;
    }

    // Avoid duplicates - check if agent already has messages
    if (agent.messages && agent.messages.length > 0) {
      return;
    }

    // Inject history using setMessages
    if (typeof agent.setMessages === 'function') {
      const formattedMessages = historyMessages.map(msg => ({
        id: msg.id || crypto.randomUUID(),
        role: msg.role, // Must be strictly 'user' or 'assistant'
        content: msg.content,
        createdAt: msg.createdAt || new Date(),
      }));
      
      agent.setMessages(formattedMessages);
      injectedRef.current = true;
    }
  }, [agent, historyMessages]);

  return null;
};

// 2. Chat Component
const AgUiChatCore = ({ sessionId, ...props }) => {
  return (
    <>
      <AgentHistoryInjector sessionId={sessionId} />
      <CopilotChat className="agu-chat" agentId="velxio" threadId={sessionId} />
    </>
  );
};
```

### Key Implementation Details

**1. Message Role Mapping:**
```typescript
// Backend events → Frontend roles
'run.started' → 'user'
'run.completed' → 'assistant'
```

Roles MUST be strictly `'user'` or `'assistant'`. AG-UI may hide other roles like `'system'` or `'tool'`.

**2. De-duplication:**
```typescript
// Check if agent already has messages
if (agent.messages && agent.messages.length > 0) {
  return; // Skip injection
}

// Use ref to prevent re-injection on re-renders
const injectedRef = useRef(false);
if (injectedRef.current) return;
```

**3. Message Format:**
```typescript
{
  id: string,           // Unique identifier (use crypto.randomUUID())
  role: 'user' | 'assistant',  // Strictly typed
  content: string,      // Message text
  createdAt: Date,      // Timestamp
}
```

**4. Thread Persistence:**
```typescript
<CopilotChat 
  agentId="velxio" 
  threadId={sessionId}  // Pass sessionId as threadId
/>
```

This ensures the backend recognizes the existing session.

## How It Works

1. **History Loading**: `AgentHistoryInjector` fetches conversation history from `/agent/sessions/{id}/events`
2. **Message Parsing**: Extracts user messages from `run.started` events and assistant responses from `run.completed` events
3. **Agent Access**: Uses `useAgent()` hook to get the agent instance
4. **Direct Injection**: Calls `agent.setMessages(formattedMessages)` to inject history
5. **Seamless Display**: CopilotKit renders the injected messages using its native UI components
6. **Continuous Conversation**: New messages appear below history with no visual break

## Benefits

✅ **Native CopilotKit Rendering**: History uses CopilotKit's built-in message components  
✅ **No Visual Split**: Single continuous conversation  
✅ **Automatic Styling**: All messages use CopilotKit's styles  
✅ **No Manual CSS**: No need to replicate CopilotKit's styling  
✅ **Proper State Management**: History is part of agent's internal state  
✅ **De-duplication**: Prevents duplicate messages on re-renders  

## Technical Notes

### Why useAgent Hook?

The `useAgent` hook provides direct access to the agent's internal state:
- `agent.messages` - Current message array
- `agent.setMessages()` - Replace all messages
- `agent.addMessage()` - Add a single message

This bypasses the AG-UI protocol's stateless design and forces the UI to display history.

### Backend's Role

The backend still injects history into the AG-UI payload for agent context:
```python
payload["messages"] = conversation_history + [latest_user_msg]
```

This ensures the **agent** has full conversation context for generating responses, while the **frontend** uses `useAgent` to display history in the UI.

### Timing Considerations

- History must be injected **after** the agent is initialized
- Check `agent.messages.length === 0` to avoid duplicates
- Use `useRef` to track injection status across re-renders

## Files Modified

1. **`frontend/src/components/agent/AgUiPanel.tsx`**
   - Added `AgentHistoryInjector` component
   - Uses `useAgent()` hook to access agent instance
   - Calls `agent.setMessages()` to inject history
   - Modified `AgUiChatCore` to include history injector

2. **`frontend/src/App.css`**
   - Removed manual history rendering styles
   - CopilotKit handles all message styling automatically

## Testing Checklist

- [ ] Open a session with existing conversation history
- [ ] Verify history messages appear in CopilotKit's native UI
- [ ] Verify no visual split or styling differences
- [ ] Send a new message and verify it appears seamlessly below history
- [ ] Verify no duplicate messages on component re-renders
- [ ] Test on mobile/tablet for responsive behavior
- [ ] Verify user messages are blue and right-aligned
- [ ] Verify assistant messages are dark and left-aligned
- [ ] Check console for "Injecting history messages into agent" log
- [ ] Verify `agent.messages` contains history after injection

## Troubleshooting

**History not appearing:**
- Check if `agent.setMessages` is available (console.warn if not)
- Verify message roles are strictly `'user'` or `'assistant'`
- Check if `agent.messages.length > 0` is blocking injection

**Duplicate messages:**
- Ensure `injectedRef.current` check is working
- Verify `agent.messages.length === 0` check before injection
- Check if component is re-mounting unnecessarily

**Styling issues:**
- History should use CopilotKit's native components automatically
- No custom CSS needed for history messages
- If styling differs, check message format (id, role, content, createdAt)

## References

- [CopilotKit useAgent Hook Documentation](https://docs.copilotkit.ai/reference/hooks/useAgent)
- [AG-UI Protocol Specification](https://github.com/pydantic/pydantic-ai)
- [Message Format Requirements](https://docs.copilotkit.ai/reference/types/Message)
