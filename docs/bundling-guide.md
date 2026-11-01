# Bundling & Integration Guide

This guide explains how to build custom applications on top of the cowork server. Whether you are building a native desktop app, a web frontend, a mobile companion, or a headless CI harness, the integration surface is the same: a WebSocket connection to the cowork server.

## Architecture Recap

Cowork is designed around one principle: **the server is the product boundary**. All business logic — sessions, tool execution, provider auth, MCP, persistence, safety checks, and streaming — lives server-side. Clients are thin rendering layers that send JSON-RPC requests and receive JSON-RPC notifications over a single WebSocket.

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

# Cross-compile a native Windows ARM64 executable from another supported host:
bun run build:server-binary -- \
  --platform win32 \
  --arch arm64 \
  --outfile dist/cowork-server-windows-arm64/cowork-server.exe
```

The build script (`scripts/build_cowork_server_binary.ts`) compiles the native Rust `cowork-server` release binary via `cargo build --release --locked -p cowork-server` across macOS, Windows, and Linux x64/ARM64 targets and copies the required resource directories (`prompts/`, `config/`, `docs/`, `skills/`) next to the binary. Every target, including Windows ARM64, receives a native Rust executable; no Bun or Node runtime is needed on target machines. Use `--platform` / `--arch` or `COWORK_BUILD_PLATFORM` / `COWORK_BUILD_ARCH` to select a target triple.

**Spawn as a subprocess:**

```typescript
import { spawn } from "node:child_process";

const child = spawn("./cowork-server", [
  "--dir", "/path/to/workspace",
  "--port", "0",     // ephemeral port
  "--json",          // emit machine-readable startup events
], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    // Exit cooperatively when parent closes stdin (cross-platform, <10s)
    COWORK_DESKTOP_PARENT_MANAGED: "1",
    // Optional: point to bundled resources if not colocated
    COWORK_BUILTIN_DIR: "/path/to/dist",
  },
});
```

**Wait for the startup event:**

With `--json`, wait for `server_listening` to discover the bound listener. This does not mean the runtime is installed: verification and downloads run in the background. With `COWORK_DESKTOP_STARTUP_EVENTS=1`, the server also emits `server_startup_progress` for actual installer progress, which may arrive before or after `server_listening`. A disabled or skipped bootstrap need not emit any progress. After connecting, use `cowork/runtime/diagnostics/read` to check the latest progress or startup error.

```json
{
  "type": "server_listening",
  "url": "ws://127.0.0.1:54321/ws",
  "wsUrl": "ws://127.0.0.1:54321/ws",
  "host": "127.0.0.1",
  "port": 54321,
  "cwd": "/path/to/workspace",
  "browserAccessToken": null
}
```

Parse this to discover the WebSocket URL. When binding to a non-loopback host such as `0.0.0.0` (or when serving browser Origins), `browserAccessToken` must be sent to `/ws` as the `coworkBrowserToken` query parameter and to `/cowork/*` HTTP routes as the `X-Cowork-Browser-Token` header. See `apps/desktop/electron/services/serverManager.ts` for a production-grade implementation including startup timeout, `server_startup_progress` forwarding, stderr capture, and cooperative stdin-EOF shutdown.

**Server CLI flags:**

| Flag | Description |
|------|-------------|
| `--dir`, `-d` | Working directory for the agent |
| `--host`, `-H` | Bind hostname (default: `127.0.0.1`) |
| `--port`, `-p` | Bind port (default: `7337`, use `0` for ephemeral) |
| `--yolo`, `-y` | YOLO mode: no approval prompts, shell commands run outside the OS sandbox |
| `--json`, `-j` | Emit machine-readable startup NDJSON to stdout |
| `--mobile-h3` | Enable self-signed TLS QR-pairing gateway for mobile companions |

### Mode 2: Embedded Rust Library (In-Process)

If your host application is written in Rust, depend on `crates/cowork-server` and call `cowork_server::start_server` directly on an ephemeral loopback port. This is how the standalone Rust CLI binary (`crates/cowork-cli/src/main.rs`) embeds the server in-process when `--url` is not provided, before connecting over WebSocket (`cowork.jsonrpc.v1`).

## Connecting a Client

### Using JsonRpcSocket (TypeScript/JavaScript)

The repo ships a production-ready JSON-RPC WebSocket client at `src/client/jsonRpcSocket.ts`:

```typescript
import { JsonRpcSocket } from "agent-coworker/src/client/jsonRpcSocket";

const socket = new JsonRpcSocket({
  url: "ws://127.0.0.1:54321/ws",
  clientInfo: { name: "my-app", version: "1.0.0" },
  onNotification(message) {
    switch (message.method) {
      case "thread/started":
        console.log("Thread:", message.params);
        break;
      case "item/agentMessage/delta":
        console.log("Agent delta:", message.params);
        break;
    }
  },
  onClose: (reason) => console.log("Disconnected:", reason),
  autoReconnect: true,
  maxReconnectAttempts: 10,
});

socket.connect();
await socket.readyPromise;
const { thread } = await socket.request("thread/start", { cwd: "/path/to/workspace" }) as {
  thread: { id: string };
};
await socket.request("turn/start", {
  threadId: thread.id,
  input: [{ type: "text", text: "Refactor the login component to use hooks" }],
});
```

**Key `JsonRpcSocket` features:**

- **Automatic handshake**: Sends `initialize`, waits for the result, then sends `initialized`
- **Thread resume**: Call `thread/resume` with a persisted `threadId`
- **Auto-reconnect**: Exponential backoff with jitter (500ms base, 30s cap)
- **Message queueing**: Messages sent during disconnection are queued and flushed on reconnect
- **Custom WebSocket**: Pass `WebSocketImpl` to use a non-standard WebSocket (React Native, etc.)

### Raw WebSocket (Any Language)

If you are not using TypeScript, connect with any WebSocket client. The protocol is plain JSON over WebSocket text frames.

**1. Connect** to `ws://<host>:<port>/ws`, optionally offering the `cowork.jsonrpc.v1` WebSocket subprotocol. For non-loopback listeners, append `?coworkBrowserToken=<browserAccessToken>` using the startup token.

**2. Send `initialize`:**

```json
{ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "my-app", "version": "1.0.0" } } }
```

**3. Receive the `initialize` result, then send `initialized`:**

```json
{ "id": 1, "result": { "protocolVersion": "0.1", "transport": { "type": "websocket", "protocolMode": "jsonrpc" } } }
{ "method": "initialized" }
```

Mobile H3 HTTP JSON-RPC clients receive the same initialize shape with `transport.type` and `transport.protocolMode` set to `"h3"`.

**4. Send JSON-RPC requests and receive notifications.** Start or resume a thread, then use `turn/start` and render `turn/*` + `item/*` notifications.

See [websocket-protocol.md](websocket-protocol.md) for the full contract — every message type, every field, every validation rule.

## Core JSON-RPC Loop

A minimal client must handle these notifications and server requests:

| Method | When | What to Do |
|-------|------|------------|
| `thread/started` | Thread binds | Store thread metadata |
| `turn/started` / `turn/completed` | Turn lifecycle | Show/hide loading indicator |
| `item/started` / `item/completed` | Feed item lifecycle | Render the latest item snapshot |
| `item/agentMessage/delta` | Assistant text streams | Append text to the active agent message |
| `item/reasoning/delta` | Reasoning streams | Append reasoning to the active reasoning item |
| `item/tool/requestUserInput` | Server request | Show question and respond with the same JSON-RPC id |
| `item/commandExecution/requestApproval` | Server request | Show command and respond with the same JSON-RPC id |

### Sending a User Message

```json
{
  "id": 2,
  "method": "turn/start",
  "params": {
    "threadId": "abc-123",
    "input": [{ "type": "text", "text": "Refactor the login component to use hooks" }]
  }
}
```

### Responding to Asks and Approvals

```json
{ "id": "req-1", "result": { "answer": "Yes, use JWT" } }
```

```json
{ "id": "req-2", "result": { "approved": true } }
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

For client-side raw stream reconstruction, `src/shared/modelStreamReplay.ts` can replay streamed turns from persisted raw events using provider-specific projectors (Google Interactions, OpenAI Responses), complementing server-owned `ThreadJournal` (`crates/cowork-storage/src/thread_journal.rs`) and `SessionSnapshot` projection (`crates/cowork-inference/src/projector.rs`).

## Session Management

### Multiple Sessions

Each WebSocket connection binds to one session. To manage multiple sessions (like chat threads), open one socket per session. The desktop app uses this pattern:

- **Control socket**: One socket for workspace-level operations (listing sessions, provider auth, skills management)
- **Thread sockets**: One socket per open thread/conversation, each with its own `sessionId`

### Session Resume

Threads survive disconnects and server restarts:

1. Store the `thread.id` returned by `thread/start` and the highest received journal sequence `seq`.
2. Reconnect, complete `initialize` / `initialized`, and send `thread/resume` with `{ "threadId": "<id>", "afterSeq": <lastSeq> }`.
3. The server replays missed monotonic `ThreadJournal` events (or falls back to a full `SessionSnapshot` via `thread/read`) and re-emits any pending `requestUserInput` / `requestApproval` prompts.

### Session Persistence

Sessions are stored in SQLite (`~/.cowork/sessions.db`). Resume works across server restarts — the server rehydrates session state from the database.

List persisted threads via:

```json
{
  "id": 3,
  "method": "thread/list",
  "params": { "cwd": "/path/to/workspace" }
}
```

## Configuration

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `AGENT_PROVIDER` | Override provider (`google`, `openai`, `anthropic`) |
| `AGENT_MODEL` | Override model ID |
| `AGENT_WORKING_DIR` | Override working directory |
| `COWORK_BUILTIN_DIR` | Path to bundled resources (prompts, config, docs) |
| `COWORK_BOOTSTRAP_DEFAULT_SKILLS` | Download the default marketplace plugin set on startup (desktop defaults to `1`) |
| `COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP` | Skip first-run skill installation |
| `COWORK_RUNTIME_ALLOW_NETWORK` | Allow the server to download the platform runtime release (desktop defaults to `1`) |
| `COWORK_RUNTIME_FULL_VERIFY` | Re-hash the entire signed runtime tree on every verification instead of reusing a fingerprint |

#### Runtime integrity verification

The Cowork runtime is a signed tree of roughly 38k files and 2.4 GB. Hashing it is
expensive, and it was being hashed twice over: once at startup (the exact-tree
check) and again on every turn, because `buildRuntimeEnv` re-verified every
entrypoint closure — 76% of the tree — each time it assembled the tool
environment. On a Windows machine with Defender active that cost ~128 s before the
first turn and ~12 s per turn after it.

Verification is now anchored on a stat fingerprint of the whole signed tree: every
path, kind, size, link count, and mtime. A full hash still runs whenever the
fingerprint is not already known-good, and on success it is recorded both in
memory and in `<runtime-dir>.verified.json` (alongside the signed manifest's
signature hash). Every later verification — the next turn, or the next launch —
re-collects the fingerprint and re-hashes only when it differs, when the signed
manifest changes, or when `COWORK_RUNTIME_FULL_VERIFY` is set. Because the
fingerprint covers the whole tree, it also still catches files added anywhere
under the runtime, which a per-closure check could not. The record is written only
when the tree is byte-identical immediately before and after the hash pass, and is
removed when a runtime is replaced, pruned, or rolled back.

The trade-off is explicit: an attacker who rewrites a runtime file *and* restores
its exact size and mtime is not caught by the fingerprint alone. The recursive
directory watcher invalidates trust as changes arrive, but it is an optimization,
not the guarantee — the fingerprint is re-collected before every use regardless.
Set `COWORK_RUNTIME_FULL_VERIFY=1` to opt back into hashing every time.

Runtime ZIP extraction validates symlink containment before creating links and
rejects archive entries beneath symlink paths. Signature verification still runs
before activation. Installation, activation, fallback, and pruning share an
OS-released SQLite lifecycle mutex; stale heartbeat files are not deleted to steal
ownership from another installer. Runtime consumers also hold process-lifetime
SQLite read leases. Pruning keeps leased versions in addition to current and one
fallback; forced replacement refuses an in-use version. Crashes release the lease
without heartbeat expiry or PID guessing. Older binaries and orphaned subprocesses
outliving their parent do not participate. Stop older Cowork processes before upgrading
across the former file-lock protocol. If an obsolete legacy lock blocks provisioning,
inspect and remove it only after confirming those older processes are stopped.

### Runtime Config Patching

Clients can modify session config at runtime via `cowork/session/config/set`:

```json
{
  "id": 4,
  "method": "cowork/session/config/set",
  "params": {
    "threadId": "abc-123",
    "config": {
      "yolo": true,
      "maxSteps": 50,
      "enableMemory": true,
      "backupsEnabled": true
    }
  }
}
```

`backupsEnabled` is opt-in and should usually stay off for git workspaces that can use `git diff`, `git stash`, and `git worktree` for checkpointing. See `SessionConfigPatch` in `src/shared/protocolTypes.ts` and `crates/cowork-protocol/src/schemas.rs` for all available fields.

## Server Lifecycle Management

For native apps that spawn the server as a sidecar, you need to handle:

**Startup**: Spawn `cowork-server --json` with `COWORK_DESKTOP_PARENT_MANAGED=1`, wait for the `server_listening` JSON line on stdout, then connect.

**Health monitoring**: Poll `GET /cowork/health` or observe WebSocket connectivity.

**Graceful shutdown**: Close child `stdin` (EOF) when `COWORK_DESKTOP_PARENT_MANAGED=1` is set (cross-platform, works identically on Windows, macOS, and Linux) or send `SIGTERM`/`SIGINT` on POSIX. The server flushes pending session snapshots, closes active WebSockets, and reaps child processes within `<10s`.

**Crash recovery**: If the server process exits unexpectedly, your app can restart it and reconnect clients via `thread/resume`. Sessions are persisted to SQLite, so state is not lost.

See `apps/desktop/electron/services/serverManager.ts` for a complete reference implementation of sidecar lifecycle management.

## Reference Implementation: Desktop App

The Electron desktop app (`apps/desktop/`) is the canonical example of a native app wrapping the cowork server. Key patterns to study:

| Concern | File | Pattern |
|---------|------|---------|
| Sidecar spawn & lifecycle | `apps/desktop/electron/services/serverManager.ts` | Spawn Rust binary, parse startup NDJSON, stdin-EOF shutdown |
| Socket management | `apps/desktop/src/app/store.helpers/controlSocket.ts` | Per-workspace control sockets |
| Thread sockets | `apps/desktop/src/app/store.helpers/runtimeState.ts` | Per-thread `JsonRpcSocket` map |
| Feed reduction | `apps/desktop/src/app/store.helpers/threadEventReducer.ts` | JSON-RPC notifications -> Zustand state |
| State management | `apps/desktop/src/app/store.ts` | Zustand store with action namespaces |
| IPC bridge | `apps/desktop/electron/ipc.ts` | Electron main <-> renderer communication |

## Checklist: Building a New Client

1. **Choose integration mode**: sidecar `cowork-server` binary (recommended for native/TS apps) or embedded `cowork_server::start_server` (for Rust apps)
2. **Connect via WebSocket**: Use `JsonRpcSocket` (`src/client/jsonRpcSocket.ts`) or implement JSON-RPC-lite (`cowork.jsonrpc.v1`) directly
3. **Handle the core event loop**: `initialize` / `initialized`, `thread/started`, `turn/started`, `item/*` deltas and completions, `item/tool/requestUserInput`, `item/commandExecution/requestApproval`, `turn/completed`
4. **Implement ask/approval UX**: The agent blocks tool execution until the client responds with the matching JSON-RPC request `id`
5. **Handle thread resume**: Store `threadId` + `lastSeq`, reconnect with `thread/resume`
6. **Optional: normalize model streams**: Use `src/client/modelStream.ts` for stream chunk projection helpers
7. **Optional: multi-session support**: One workspace control socket + per-thread sockets
8. **Optional: provider auth flows**: Use `cowork/provider/*` routes for in-app provider setup and OAuth PKCE

## Further Reading

- [WebSocket Protocol Reference](websocket-protocol.md) — Full message contract (all types, fields, validation rules)
- [Architecture Overview](architecture.md) — System components and data flow
- [Custom Tools Guide](custom-tools.md) — Extending the agent's capabilities
- [MCP Guide](mcp-guide.md) — Model Context Protocol server configuration
- [Harness Config](harness/config.md) — Configuration precedence and flags
- [Session Storage](session-storage-architecture.md) — SQLite persistence details
