# Bundling & Integration Guide

This guide explains how to build custom applications on top of the cowork server. Whether you are building a native desktop app, a web frontend, a mobile companion, or a headless CI harness, the integration surface is the same: a WebSocket connection to the cowork server.

## Architecture Recap

Cowork is designed around one principle: **the server is the product boundary**. All business logic — sessions, tool execution, provider auth, MCP, persistence, safety checks, and streaming — lives server-side. Clients are thin rendering layers that send typed `ClientMessage` objects and receive typed `ServerEvent` objects over a single WebSocket.

```
┌────────────────────────────┐
│     Your Application       │
│  (React, Swift, Flutter,   │
│   Electron, web, CLI...)   │
└────────────┬───────────────┘
             │ WebSocket (ws://...)
             ▼
┌────────────────────────────┐
│     cowork-server          │
│  Sessions, Agent Loop,     │
│  Tools, Providers, MCP,    │
│  Persistence, Backups      │
└────────────────────────────┘
```

Multiple clients can connect to the same server simultaneously. Each WebSocket connection binds to one session.

## Integration Modes

There are two ways to run the server for your application.

### Mode 1: Sidecar Binary (Recommended for Native Apps)

Compile the server to a standalone binary and ship it alongside your app. This is how the Electron desktop app works.

**Build the binary:**

```bash
bun run build:server-binary
# Output: dist/cowork-server (or dist/cowork-server.exe on Windows)
# Also copies: dist/prompts/, dist/config/, dist/docs/
```

The build script (`scripts/build_cowork_server_binary.ts`) uses `bun build --compile` and copies the required resource directories (`prompts/`, `config/`, `docs/`) next to the binary.

**Spawn as a subprocess:**

```typescript
import { spawn } from "node:child_process";

const child = spawn("./cowork-server", [
  "--dir", "/path/to/workspace",
  "--port", "0",     // ephemeral port
  "--json",          // emit machine-readable startup event
], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    // Optional: point to bundled resources if not colocated
    COWORK_BUILTIN_DIR: "/path/to/dist",
  },
});
```

**Wait for the startup event:**

When launched with `--json`, the server prints a single JSON line to stdout once listening:

```json
{
  "type": "server_listening",
  "url": "ws://127.0.0.1:54321/ws",
  "host": "127.0.0.1",
  "port": 54321,
  "cwd": "/path/to/workspace"
}
```

Parse this to discover the WebSocket URL. See `apps/desktop/electron/services/serverManager.ts` for a production-grade implementation including startup timeout, stderr capture, graceful shutdown, and retry logic for Bun crashes.

**Server CLI flags:**

| Flag | Description |
|------|-------------|
| `--dir`, `-d` | Working directory for the agent |
| `--host`, `-H` | Bind hostname (default: `127.0.0.1`) |
| `--port`, `-p` | Bind port (default: `7337`, use `0` for ephemeral) |
| `--yolo`, `-y` | Skip command approval prompts |
| `--json`, `-j` | Emit machine-readable startup JSON to stdout |

### Mode 2: Embedded Server (Same Process)

Import `startAgentServer()` directly if your host application also runs on Bun/Node.

```typescript
import { startAgentServer } from "agent-coworker/src/server/startServer";

const { server, config, url } = await startAgentServer({
  cwd: process.cwd(),
  hostname: "127.0.0.1",
  port: 0, // ephemeral
});

// url is the WebSocket endpoint, e.g. "ws://127.0.0.1:54321/ws"
console.log("Server ready at", url);

// Graceful shutdown
process.on("SIGTERM", () => server.stop());
```

This is how the CLI entrypoint works (`src/index.ts`): it launches the REPL, which starts the server in-process on an ephemeral port and connects over WebSocket.

## Connecting a Client

### Using AgentSocket (TypeScript/JavaScript)

The repo ships a production-ready JSON-RPC WebSocket client at `src/client/jsonRpcSocket.ts`:

```typescript
import { AgentSocket } from "agent-coworker/src/client";

const socket = new AgentSocket({
  url: "ws://127.0.0.1:54321/ws",
  client: "my-app",           // identifies your client in server logs
  version: "1.0.0",           // optional version tag

  onEvent(evt) {
    // Handle all ServerEvent types here
    switch (evt.type) {
      case "server_hello":
        console.log("Session:", evt.sessionId);
        break;
      case "assistant_message":
        console.log("Agent:", evt.text);
        break;
      case "ask":
        // Agent is asking the user a question
        break;
      case "approval":
        // Agent needs permission to run a command
        break;
      // ... handle other event types
    }
  },

  onClose(reason) {
    console.log("Disconnected:", reason);
  },

  // Optional: automatic reconnection
  autoReconnect: true,
  maxReconnectAttempts: 10,

  // Optional: resume a previous session
  resumeSessionId: "previous-session-id",
});

socket.connect();
```

**Key `AgentSocket` features:**

- **Automatic handshake**: Sends `client_hello` on connect, captures `sessionId` from `server_hello`
- **Session resume**: Pass `resumeSessionId` to reconnect to an existing session
- **Auto-reconnect**: Exponential backoff with jitter (500ms base, 30s cap)
- **Keepalive**: Sends `ping` every 30s (configurable via `pingIntervalMs`)
- **Message queueing**: Messages sent during disconnection are queued and flushed on reconnect
- **Custom WebSocket**: Pass `WebSocketImpl` to use a non-standard WebSocket (React Native, etc.)

### Raw WebSocket (Any Language)

If you are not using TypeScript, connect with any WebSocket client. The protocol is plain JSON over WebSocket text frames.

**1. Connect** to `ws://<host>:<port>/ws` (append `?resumeSessionId=<id>` to resume).

**2. Send `client_hello`:**

```json
{ "type": "client_hello", "client": "my-app", "version": "1.0.0" }
```

**3. Receive `server_hello`:**

```json
{
  "type": "server_hello",
  "sessionId": "abc-123",
  "protocolVersion": "7.28",
  "config": { "provider": "anthropic", "model": "claude-sonnet-4-6", "workingDirectory": "/home/user/project" },
  "isResume": false,
  "busy": false
}
```

**4. Send messages, receive events.** All messages include `"sessionId"` and `"type"`.

See [websocket-protocol.md](websocket-protocol.md) for the full contract — every message type, every field, every validation rule.

## Core Event Loop

A minimal client must handle these events:

| Event | When | What to Do |
|-------|------|------------|
| `server_hello` | On connect | Store `sessionId`, read config |
| `session_busy` | Turn starts/ends | Show/hide loading indicator (`busy: true/false`) |
| `model_stream_chunk` | During a turn | Render streaming text/tool calls (see below) |
| `assistant_message` | Turn completes | Display final assistant response |
| `ask` | Agent needs input | Show question to user, send `ask_response` back |
| `approval` | Agent needs permission | Show command, send `approval_response` back |
| `error` | Something went wrong | Display error, check `source` field |
| `log` | Agent emits a log line | Optionally display in a debug pane |

### Sending a User Message

```json
{
  "type": "user_message",
  "sessionId": "abc-123",
  "text": "Refactor the login component to use hooks"
}
```

### Responding to Asks and Approvals

```json
{ "type": "ask_response", "sessionId": "abc-123", "requestId": "req-1", "answer": "Yes, use JWT" }
```

```json
{ "type": "approval_response", "sessionId": "abc-123", "requestId": "req-2", "approved": true }
```

## Model Stream Events

During a turn, the server emits `model_stream_chunk` events with streaming LLM output. Each chunk has a `partType` field:

| Part Type | Meaning |
|-----------|---------|
| `text_delta` | Incremental assistant text |
| `reasoning_delta` | Incremental reasoning/thinking text |
| `tool_call` | Complete tool invocation (name, args, result) |
| `tool_input_delta` | Streaming tool input (for large tool args) |
| `tool_result` | Tool execution result |
| `tool_approval_request` | Tool needs user approval before executing |
| `start` / `finish` | Turn lifecycle boundaries |
| `error` / `abort` | Turn failed or was cancelled |

**Stream normalization**: The `modelStream.ts` module (`src/client/modelStream.ts`) provides `mapModelStreamChunk()` to normalize provider-specific streaming differences into a unified `ModelStreamUpdate` type. Use it to avoid writing provider-specific rendering logic.

For session resume, `modelStreamReplay.ts` can reconstruct streamed turns from persisted raw events using provider-specific projectors (Google Interactions, OpenAI Responses).

## Session Management

### Multiple Sessions

Each WebSocket connection binds to one session. To manage multiple sessions (like chat threads), open one socket per session. The desktop app uses this pattern:

- **Control socket**: One socket for workspace-level operations (listing sessions, provider auth, skills management)
- **Thread sockets**: One socket per open thread/conversation, each with its own `sessionId`

### Session Resume

Sessions survive disconnects. To resume:

1. Store the `sessionId` from `server_hello`
2. Reconnect with `?resumeSessionId=<id>` in the URL
3. The server replays buffered events (up to 256) that occurred while disconnected
4. Pending `ask`/`approval` prompts are re-emitted

### Session Persistence

Sessions are stored in SQLite (`~/.cowork/sessions.db`). Resume works across server restarts — the server rehydrates session state from the database.

List and query sessions via:

```json
{ "type": "list_sessions", "sessionId": "abc-123", "scope": "workspace" }
```

## Configuration

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `AGENT_PROVIDER` | Override provider (`google`, `openai`, `anthropic`) |
| `AGENT_MODEL` | Override model ID |
| `AGENT_WORKING_DIR` | Override working directory |
| `COWORK_BUILTIN_DIR` | Path to bundled resources (prompts, config, docs) |
| `COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP` | Skip first-run skill installation |

### Runtime Config Patching

Clients can modify session config at runtime via `set_config`:

```json
{
  "type": "set_config",
  "sessionId": "abc-123",
  "config": {
    "yolo": true,
    "maxSteps": 50,
    "enableMemory": true,
    "backupsEnabled": true
  }
}
```

See `SessionConfigPatch` in `src/server/protocol.ts` for all available fields.

## Server Lifecycle Management

For native apps that spawn the server as a sidecar, you need to handle:

**Startup**: Spawn the process, wait for the `server_listening` JSON on stdout, then connect.

**Health monitoring**: The server emits `pong` in response to `ping`. If pongs stop arriving, the server may have crashed.

**Graceful shutdown**: Send `SIGTERM` (or `SIGINT`) to the server process. It flushes pending session snapshots and stops child processes. If the server does not exit within 3 seconds, escalate to `SIGKILL`.

**Crash recovery**: If the server process exits unexpectedly, your app can restart it and reconnect clients using `resumeSessionId`. Sessions are persisted to SQLite, so state is not lost.

See `apps/desktop/electron/services/serverManager.ts` for a complete reference implementation of sidecar lifecycle management.

## Reference Implementation: Desktop App

The Electron desktop app (`apps/desktop/`) is the canonical example of a native app wrapping the cowork server. Key patterns to study:

| Concern | File | Pattern |
|---------|------|---------|
| Sidecar spawn & lifecycle | `electron/services/serverManager.ts` | Spawn binary, parse startup JSON, graceful kill |
| Socket management | `src/app/store.helpers/controlSocket.ts` | Per-workspace control sockets |
| Thread sockets | `src/app/store.helpers/runtimeState.ts` | Per-thread AgentSocket map |
| Event reduction | `src/app/store.helpers/threadEventReducer.ts` | ServerEvent -> Zustand state |
| State management | `src/app/store.tsx` | Zustand store with action namespaces |
| IPC bridge | `electron/ipc.ts` | Electron main <-> renderer communication |

## Checklist: Building a New Client

1. **Choose integration mode**: sidecar binary (recommended for native apps) or embedded server (for Bun/Node apps)
2. **Connect via WebSocket**: Use `AgentSocket` (TS/JS) or implement the JSON protocol directly
3. **Handle the core event loop**: `server_hello`, `session_busy`, `model_stream_chunk`, `assistant_message`, `ask`, `approval`, `error`
4. **Implement ask/approval UX**: The agent will block waiting for your response
5. **Handle session resume**: Store `sessionId`, reconnect with `resumeSessionId`
6. **Optional: normalize model streams**: Use `modelStream.ts` or implement your own normalizer for `model_stream_chunk` events
7. **Optional: multi-session support**: One control socket + per-thread sockets
8. **Optional: provider auth flows**: Handle `provider_auth_challenge` events if you want in-app provider setup

## Further Reading

- [WebSocket Protocol Reference](websocket-protocol.md) — Full message contract (all types, fields, validation rules)
- [Architecture Overview](architecture.md) — System components and data flow
- [Custom Tools Guide](custom-tools.md) — Extending the agent's capabilities
- [MCP Guide](mcp-guide.md) — Model Context Protocol server configuration
- [Harness Config](harness/config.md) — Configuration precedence and flags
- [Session Storage](session-storage-architecture.md) — SQLite persistence details
