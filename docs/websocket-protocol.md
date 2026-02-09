# WebSocket Protocol Reference

Complete documentation of the agent-coworker WebSocket protocol for building alternative UIs on top of the existing server/agent logic.

## Connection

- **URL**: `ws://127.0.0.1:{port}/ws` (default port `7337`)
- **No authentication** — server binds to localhost only
- **No heartbeat/keepalive** — relies on the WebSocket layer
- **One session per connection** — disconnecting destroys the session; there is no resumption

## Handshake Flow

```
Client                          Server
  |                               |
  |-------- WS Connect ---------->|
  |                               | creates AgentSession
  |<------ server_hello ----------|  (sessionId + config)
  |                               |
  |---- client_hello (optional) ->|  (silently acknowledged)
  |                               |
  |---- user_message / others --->|  (must include sessionId)
```

1. Client opens a WebSocket to `ws://127.0.0.1:{port}/ws`
2. Server creates an `AgentSession` and immediately sends `server_hello` with a UUID `sessionId`
3. Client optionally sends `client_hello` to identify itself
4. Client includes `sessionId` in **every** subsequent message

---

## Type Definitions

```typescript
// Providers
type ProviderName =
  | "google"
  | "openai"
  | "anthropic"
  | "gemini-cli"
  | "codex-cli"
  | "claude-code";

// Shared types
interface ConfigSubset {
  provider: string;
  model: string;
  workingDirectory: string;
  outputDirectory: string;
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string; // present-continuous label, e.g. "Running tests"
}

interface SessionBackupCheckpoint {
  id: string;                 // e.g. "cp-0001"
  index: number;              // 1-based checkpoint index
  createdAt: string;          // ISO timestamp
  trigger: "auto" | "manual"; // auto per agent completion, or manual request
  changed: boolean;           // false when no workspace diff vs original
  patchBytes: number;         // compressed patch size on disk
}

interface SessionBackupState {
  status: "initializing" | "ready" | "failed";
  sessionId: string;
  workingDirectory: string;
  backupDirectory: string | null; // ~/.cowork/session-backups/{sessionId}
  createdAt: string;
  originalSnapshot: { kind: "pending" | "directory" | "tar_gz" };
  checkpoints: SessionBackupCheckpoint[];
  failureReason?: string;
}
```

---

## Client -> Server Messages

All messages are JSON. Every message (except `client_hello`) must include `sessionId`.

### client_hello

Optional initial handshake from client.

```jsonc
{
  "type": "client_hello",
  "client": "my-ui",        // identifier for your client
  "version": "0.1.0"        // optional
}
```

### user_message

Send user text to the agent. **Only one at a time** — sending while the agent is busy returns an error.

```jsonc
{
  "type": "user_message",
  "sessionId": "...",
  "text": "What files are in this directory?",
  "clientMessageId": "abc-123"  // optional, echoed back for dedup
}
```

### ask_response

Reply to an `ask` event from the server.

```jsonc
{
  "type": "ask_response",
  "sessionId": "...",
  "requestId": "req-ask-001",  // from the ask event
  "answer": "Option A"
}
```

### approval_response

Approve or deny a command the agent wants to run.

```jsonc
{
  "type": "approval_response",
  "sessionId": "...",
  "requestId": "req-approval-001",  // from the approval event
  "approved": true
}
```

### set_model

Switch AI model and/or provider at runtime.

```jsonc
{
  "type": "set_model",
  "sessionId": "...",
  "model": "gpt-4-turbo",
  "provider": "openai"  // optional
}
```

### connect_provider

Authenticate with a provider (API key or OAuth).

```jsonc
// With API key
{
  "type": "connect_provider",
  "sessionId": "...",
  "provider": "openai",
  "apiKey": "sk-proj-..."
}

// OAuth flow (no apiKey)
{
  "type": "connect_provider",
  "sessionId": "...",
  "provider": "codex-cli"
}
```

### list_tools

Request the list of available tools.

```jsonc
{
  "type": "list_tools",
  "sessionId": "..."
}
```

### reset

Clear conversation history and todos.

```jsonc
{
  "type": "reset",
  "sessionId": "..."
}
```

### session_backup_get

Request backup/checkpoint state for the active session.

```jsonc
{
  "type": "session_backup_get",
  "sessionId": "..."
}
```

### session_backup_checkpoint

Create a manual checkpoint immediately (in addition to automatic per-turn checkpoints).

```jsonc
{
  "type": "session_backup_checkpoint",
  "sessionId": "..."
}
```

### session_backup_restore

Restore the workspace to the original snapshot or a specific checkpoint.

```jsonc
// Restore to original snapshot
{
  "type": "session_backup_restore",
  "sessionId": "..."
}

// Restore to a checkpoint
{
  "type": "session_backup_restore",
  "sessionId": "...",
  "checkpointId": "cp-0003"
}
```

### session_backup_delete_checkpoint

Delete a checkpoint (metadata + stored patch).

```jsonc
{
  "type": "session_backup_delete_checkpoint",
  "sessionId": "...",
  "checkpointId": "cp-0003"
}
```

---

## Server -> Client Events

All events are JSON with a `type` and `sessionId`.

### server_hello

First message after connection. Contains the session ID and current configuration.

```jsonc
{
  "type": "server_hello",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "config": {
    "provider": "openai",
    "model": "gpt-4-turbo",
    "workingDirectory": "/Users/user/project",
    "outputDirectory": "/Users/user/project/output"
  }
}
```

### session_busy

Agent processing state. Use this to disable/enable input in your UI.

```jsonc
{ "type": "session_busy", "sessionId": "...", "busy": true }
{ "type": "session_busy", "sessionId": "...", "busy": false }
```

### user_message

Echo of the received user message (confirmation).

```jsonc
{
  "type": "user_message",
  "sessionId": "...",
  "text": "What files are in this directory?",
  "clientMessageId": "abc-123"
}
```

### assistant_message

The agent's response text (markdown).

```jsonc
{
  "type": "assistant_message",
  "sessionId": "...",
  "text": "I found the following files:\n- package.json\n- README.md"
}
```

### reasoning

Extended thinking / chain-of-thought output.

```jsonc
{
  "type": "reasoning",
  "sessionId": "...",
  "kind": "reasoning",  // or "summary" (OpenAI o1 models)
  "text": "The user is asking me to list files..."
}
```

### log

Debug/info log line from the agent or server.

```jsonc
{
  "type": "log",
  "sessionId": "...",
  "line": "[connect openai] starting oauth..."
}
```

### todos

Task list update. Sent whenever the todo list changes during a turn.

```jsonc
{
  "type": "todos",
  "sessionId": "...",
  "todos": [
    { "content": "Fix auth bug", "status": "in_progress", "activeForm": "Fixing auth bug" },
    { "content": "Run tests",    "status": "pending",     "activeForm": "Running tests" }
  ]
}
```

### ask

Agent is asking the user a question. **Blocks the agent** until you reply with `ask_response`.

```jsonc
// Free-text question
{
  "type": "ask",
  "sessionId": "...",
  "requestId": "req-ask-001",
  "question": "What is your name?"
}

// Multiple choice
{
  "type": "ask",
  "sessionId": "...",
  "requestId": "req-ask-002",
  "question": "Which option?",
  "options": ["Option A", "Option B", "Option C"]
}
```

### approval

Agent wants to run a command and needs permission. **Blocks the agent** until you reply with `approval_response`.

```jsonc
{
  "type": "approval",
  "sessionId": "...",
  "requestId": "req-approval-001",
  "command": "rm -rf /tmp/old-builds",
  "dangerous": true
}
```

### config_updated

Provider or model was changed (via `set_model` or `connect_provider`).

```jsonc
{
  "type": "config_updated",
  "sessionId": "...",
  "config": {
    "provider": "anthropic",
    "model": "claude-3-opus",
    "workingDirectory": "/Users/user/project",
    "outputDirectory": "/Users/user/project/output"
  }
}
```

### tools

List of available tool names (response to `list_tools`).

```jsonc
{
  "type": "tools",
  "sessionId": "...",
  "tools": ["bash", "edit", "glob", "grep", "read", "write"]
}
```

### session_backup_state

Backup/checkpoint status update. Emitted on explicit requests and whenever checkpoint state changes.

```jsonc
{
  "type": "session_backup_state",
  "sessionId": "...",
  "reason": "auto_checkpoint", // requested | auto_checkpoint | manual_checkpoint | restore | delete
  "backup": {
    "status": "ready",
    "sessionId": "...",
    "workingDirectory": "/Users/user/project",
    "backupDirectory": "/Users/user/.cowork/session-backups/...",
    "createdAt": "2026-02-09T00:00:00.000Z",
    "originalSnapshot": { "kind": "directory" },
    "checkpoints": [
      {
        "id": "cp-0001",
        "index": 1,
        "createdAt": "2026-02-09T00:00:10.000Z",
        "trigger": "auto",
        "changed": true,
        "patchBytes": 2048
      }
    ]
  }
}
```

### reset_done

Confirms the conversation was cleared (response to `reset`).

```jsonc
{ "type": "reset_done", "sessionId": "..." }
```

### error

Any error condition.

```jsonc
{
  "type": "error",
  "sessionId": "...",
  "message": "Agent is busy"
}
```

---

## Message Flow Examples

### Normal Conversation

```
client  -> user_message { text: "Hello" }
server  <- user_message { text: "Hello" }           (echo)
server  <- session_busy { busy: true }
server  <- todos [...]                                (0..N)
server  <- reasoning { kind: "reasoning", text: ... } (0..N)
server  <- assistant_message { text: "Hi! ..." }
server  <- session_busy { busy: false }
```

### Command Approval

```
client  -> user_message { text: "delete the temp files" }
server  <- session_busy { busy: true }
server  <- approval { requestId: "r1", command: "rm -rf /tmp/*", dangerous: true }
         ... agent blocks, waiting ...
client  -> approval_response { requestId: "r1", approved: true }
         ... agent continues ...
server  <- assistant_message { text: "Done, deleted temp files." }
server  <- session_busy { busy: false }
```

### Ask Flow

```
server  <- ask { requestId: "r2", question: "Which database?", options: ["PostgreSQL","MySQL"] }
         ... agent blocks, waiting ...
client  -> ask_response { requestId: "r2", answer: "PostgreSQL" }
         ... agent continues ...
```

### Model Change

```
client  -> set_model { model: "gpt-4-turbo", provider: "openai" }
server  <- config_updated { config: { provider: "openai", model: "gpt-4-turbo", ... } }
```

### Backup / Checkpoint Flow

```
client  -> session_backup_get {}
server  <- session_backup_state { reason: "requested", backup: {...} }

client  -> user_message { text: "make changes" }
server  <- ...normal turn events...
server  <- session_backup_state { reason: "auto_checkpoint", backup: {...checkpoints:+1...} }

client  -> session_backup_restore { checkpointId: "cp-0001" }
server  <- session_backup_state { reason: "restore", backup: {...} }
```

---

## Error Reference

| Error Message | Cause |
|---|---|
| `Invalid JSON` | Malformed JSON |
| `Expected object` | Parsed JSON is not an object |
| `Missing type` | No `type` field or not a string |
| `Unknown type: X` | Unrecognized message type |
| `Unknown sessionId: X` | `sessionId` doesn't match this connection |
| `Agent is busy` | Sent `user_message` / `reset` / `set_model` while agent is processing |
| `Connection flow already running` | Another `connect_provider` is in progress |
| `Unsupported provider: X` | Invalid provider name |
| `Model id is required` | Empty model string in `set_model` |
| `connect failed: X` | Provider connection/auth failed |
| `session_backup_get missing sessionId` | Invalid `session_backup_get` payload |
| `session_backup_checkpoint missing sessionId` | Invalid `session_backup_checkpoint` payload |
| `session_backup_restore missing sessionId` | Invalid `session_backup_restore` payload |
| `session_backup_restore invalid checkpointId` | `checkpointId` is present but not a string |
| `session_backup_delete_checkpoint missing sessionId` | Invalid `session_backup_delete_checkpoint` payload |
| `session_backup_delete_checkpoint missing checkpointId` | Missing/empty checkpoint id |
| `Unknown checkpoint id: X` | Requested delete/restore checkpoint does not exist |

---

## Important Behaviors

- **One message at a time**: sending `user_message` while `session_busy` is `true` returns `"Agent is busy"`.
- **requestId pairing**: `ask` and `approval` events block the agent until you respond with the matching `requestId`.
- **Session = connection**: disconnecting disposes the session and rejects all pending ask/approval deferreds. There is no reconnection or session resumption.
- **Localhost only**: the server binds to `127.0.0.1`; no auth, no TLS.
- **Automatic snapshots/checkpoints**: on session start, the server snapshots the working directory into `~/.cowork/session-backups/{sessionId}`. After every agent turn completion, it stores a compressed binary diff checkpoint against the original snapshot.

---

## Source Files

| File | Responsibility |
|---|---|
| `src/server/protocol.ts` | Type definitions, message validation (`safeParseClientMessage`) |
| `src/server/startServer.ts` | Bun.serve setup, WebSocket open/message/close handlers |
| `src/server/session.ts` | `AgentSession` state, event emission, agent turn execution |
| `src/server/sessionBackup.ts` | Session snapshot/diff checkpoint lifecycle, restore/compaction logic under `~/.cowork/session-backups` |
| `src/server/index.ts` | CLI entry point, arg parsing (`--port`, `--dir`, `--yolo`) |
| `src/cli/repl.ts` | Reference client implementation (CLI REPL) |
| `src/types.ts` | Shared types (`AgentConfig`, `TodoItem`, etc.) |
