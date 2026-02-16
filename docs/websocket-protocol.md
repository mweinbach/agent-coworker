# WebSocket Protocol Reference

Complete documentation of the agent-coworker WebSocket protocol for building alternative UIs on top of the existing server/agent logic.

This document is the canonical external protocol contract for all clients. Thin clients should rely on this file and `src/server/protocol.ts` for message names and payload shapes.

## Connection

- **URL**: `ws://127.0.0.1:{port}/ws` (default port `7337`)
- **No authentication** — server binds to localhost only
- **Ping/pong keepalive** — clients may send `ping` with `sessionId`; the server responds with `pong`
- **One session per connection** — disconnecting destroys the session; there is no resumption

## Public Capabilities

- Session lifecycle: `server_hello`, `session_settings`, `session_busy`, `reset`
- Conversational turn streaming: `user_message`, `model_stream_chunk`, `assistant_message`, `reasoning`, `log`, `todos`
- Human-in-the-loop control: `ask`/`ask_response`, `approval`/`approval_response`, `cancel`
- Provider/model control: `provider_catalog_get`, `provider_auth_methods_get`, `provider_auth_authorize`, `provider_auth_callback`, `provider_auth_set_api_key`, `set_model`, `refresh_provider_status`, `provider_catalog`, `provider_auth_methods`, `provider_auth_challenge`, `provider_auth_result`, `provider_status`
- Tool, command, and skill metadata: `list_tools`, `tools`, `list_commands`, `commands`, `execute_command`, `list_skills`, `read_skill`, `enable_skill`, `disable_skill`, `delete_skill`
- MCP runtime toggling: `set_enable_mcp`
- Session backup/restore: `session_backup_get`, `session_backup_checkpoint`, `session_backup_restore`, `session_backup_delete_checkpoint`
- Observability + harness: `observability_status`, `observability_query`, `observability_query_result`, `harness_context_get`, `harness_context_set`, `harness_slo_evaluate`, `harness_slo_result`
- Keepalive and structured errors: `ping`/`pong`, `error`

## Handshake Flow

```
Client                          Server
  |                               |
  |-------- WS Connect ---------->|
  |                               | creates AgentSession
  |<------ server_hello ----------|  (sessionId + protocolVersion + capabilities + config)
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

## Protocol v3 Migration (from v2)

Protocol version `3.0` introduces an explicit breaking change:

- `connect_provider` is removed. Clients must use `provider_auth_authorize`, `provider_auth_callback`, and `provider_auth_set_api_key`.

Recommended migration order for clients:

1. Remove `connect_provider` messages from client code.
2. Route provider connection UX through `provider_auth_*` messages.
3. Assert `server_hello.protocolVersion === "3.0"` at connect time.

`model_stream_chunk` is additive and capability-gated via `server_hello.capabilities.modelStreamChunk`.

## Type Definitions

```typescript
// Providers
type ProviderName =
  | "google"
  | "openai"
  | "anthropic"
  | "codex-cli"
  | "claude-code";

// Shared types
interface ConfigSubset {
  provider: string;
  model: string;
  workingDirectory: string;
  outputDirectory: string;
}

type ProtocolVersion = string; // current server value: "3.0"

interface ServerCapabilities {
  modelStreamChunk?: "v1";
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

type ObservabilityQueryType = "logql" | "promql" | "traceql";
type HarnessSloOperator = "<" | "<=" | ">" | ">=" | "==" | "!=";

interface HarnessContextPayload {
  runId: string;
  taskId?: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  metadata?: Record<string, string>;
}

interface ObservabilityQueryRequest {
  queryType: ObservabilityQueryType;
  query: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

interface HarnessSloCheck {
  id: string;
  type: "latency" | "error_rate" | "custom";
  queryType: ObservabilityQueryType;
  query: string;
  op: HarnessSloOperator;
  threshold: number;
  windowSec: number;
}

type CommandSource = "command" | "mcp" | "skill";

interface CommandInfo {
  name: string;
  description?: string;
  source: CommandSource;
  hints: string[]; // eg: ["$1", "$ARGUMENTS"]
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
  "model": "gpt-5.2",
  "provider": "openai"  // optional
}
```

### refresh_provider_status

Request the server's latest provider authorization/verification status (and account identity where available).

```jsonc
{
  "type": "refresh_provider_status",
  "sessionId": "..."
}
```

### provider_catalog_get

Request provider catalog metadata (all providers, default models, connected providers).

```jsonc
{
  "type": "provider_catalog_get",
  "sessionId": "..."
}
```

### provider_auth_methods_get

Request supported provider auth methods.

```jsonc
{
  "type": "provider_auth_methods_get",
  "sessionId": "..."
}
```

### provider_auth_authorize

Start an auth challenge for an OAuth-capable method.

```jsonc
{
  "type": "provider_auth_authorize",
  "sessionId": "...",
  "provider": "codex-cli",
  "methodId": "oauth_cli"
}
```

### provider_auth_callback

Complete an auth flow after authorize (or submit a code when required).

```jsonc
{
  "type": "provider_auth_callback",
  "sessionId": "...",
  "provider": "codex-cli",
  "methodId": "oauth_cli",
  "code": "optional-if-method-requires-code"
}
```

### provider_auth_set_api_key

Set an API key for a provider auth method.

```jsonc
{
  "type": "provider_auth_set_api_key",
  "sessionId": "...",
  "provider": "openai",
  "methodId": "api_key",
  "apiKey": "sk-proj-..."
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

### list_commands

Request slash command metadata available for this session. Includes built-ins, config-defined templates, and enabled skills.

```jsonc
{
  "type": "list_commands",
  "sessionId": "..."
}
```

### execute_command

Execute a server-side slash command by name and optional arguments. The server resolves the command template and runs a normal agent turn with the expanded text.

```jsonc
{
  "type": "execute_command",
  "sessionId": "...",
  "name": "review",
  "arguments": "HEAD~3..HEAD",
  "clientMessageId": "cm-123" // optional
}
```

### list_skills

Request the list of discovered skills. Desktop UIs may also surface disabled global skills
from `~/.cowork/disabled-skills` (they are marked with `"enabled": false`).

```jsonc
{
  "type": "list_skills",
  "sessionId": "..."
}
```

### read_skill

Read the contents of a single skill's `SKILL.md`.

```jsonc
{
  "type": "read_skill",
  "sessionId": "...",
  "skillName": "pdf"
}
```

### disable_skill

Disable a global skill by moving it from `~/.cowork/skills/<name>` to `~/.cowork/disabled-skills/<name>`.

```jsonc
{
  "type": "disable_skill",
  "sessionId": "...",
  "skillName": "pdf"
}
```

### enable_skill

Enable a global skill by moving it from `~/.cowork/disabled-skills/<name>` back to `~/.cowork/skills/<name>`.

```jsonc
{
  "type": "enable_skill",
  "sessionId": "...",
  "skillName": "pdf"
}
```

### delete_skill

Delete a global skill directory permanently.

```jsonc
{
  "type": "delete_skill",
  "sessionId": "...",
  "skillName": "pdf"
}
```

### set_enable_mcp

Enable/disable MCP tool discovery/execution for this session.

```jsonc
{
  "type": "set_enable_mcp",
  "sessionId": "...",
  "enableMcp": true
}
```

### harness_context_get

Fetch the current harness context payload for this session.

```jsonc
{
  "type": "harness_context_get",
  "sessionId": "..."
}
```

### harness_context_set

Set/replace the harness context payload for this session.

```jsonc
{
  "type": "harness_context_set",
  "sessionId": "...",
  "context": {
    "runId": "run-01",
    "taskId": "task-123",
    "objective": "Improve startup reliability",
    "acceptanceCriteria": ["startup < 800ms", "no startup errors"],
    "constraints": ["no product behavior changes"],
    "metadata": { "owner": "platform" }
  }
}
```

### observability_query

Run an observability query (`logql` / `promql` / `traceql`) using configured local endpoints.

```jsonc
{
  "type": "observability_query",
  "sessionId": "...",
  "query": {
    "queryType": "promql",
    "query": "sum(rate(vector_component_errors_total[5m]))",
    "fromMs": 1738736400000,
    "toMs": 1738736700000,
    "limit": 200
  }
}
```

### harness_slo_evaluate

Evaluate one or more SLO checks against observability data.

```jsonc
{
  "type": "harness_slo_evaluate",
  "sessionId": "...",
  "checks": [
    {
      "id": "vector_errors",
      "type": "custom",
      "queryType": "promql",
      "query": "sum(rate(vector_component_errors_total[5m]))",
      "op": "<=",
      "threshold": 0,
      "windowSec": 300
    }
  ]
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

### cancel

Abort the currently running agent turn. The server aborts the underlying LLM call and rejects any pending ask/approval deferreds. A `session_busy { busy: false }` event is emitted once the cancellation completes.

```jsonc
{
  "type": "cancel",
  "sessionId": "..."
}
```

### ping

Lightweight keepalive probe. Requires a valid `sessionId` for this connection. The server responds with `pong` echoing that same `sessionId`.

```jsonc
{ "type": "ping", "sessionId": "..." }
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

First message after connection. Contains the session ID, protocol version, feature capabilities, and current configuration.

```jsonc
{
  "type": "server_hello",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "protocolVersion": "3.0",
  "capabilities": {
    "modelStreamChunk": "v1"
  },
  "config": {
    "provider": "openai",
    "model": "gpt-5.2",
    "workingDirectory": "/Users/user/project",
    "outputDirectory": "/Users/user/project/output"
  }
}
```

`capabilities.modelStreamChunk === "v1"` means the server emits structured `model_stream_chunk` events.

### session_settings

Session-level toggles/settings. Sent on connect (after `server_hello`) and whenever they change.

```jsonc
{
  "type": "session_settings",
  "sessionId": "...",
  "enableMcp": true
}
```

### provider_catalog

Provider catalog payload (available providers, default models, connected providers).

```jsonc
{
  "type": "provider_catalog",
  "sessionId": "...",
  "all": [
    {
      "id": "openai",
      "name": "OpenAI",
      "models": ["gpt-5.2", "gpt-5.2-codex"],
      "defaultModel": "gpt-5.2"
    }
  ],
  "default": { "openai": "gpt-5.2" },
  "connected": ["openai"]
}
```

### provider_auth_methods

Provider auth methods keyed by provider id.

```jsonc
{
  "type": "provider_auth_methods",
  "sessionId": "...",
  "methods": {
    "openai": [{ "id": "api_key", "type": "api", "label": "API key" }],
    "codex-cli": [{ "id": "oauth_cli", "type": "oauth", "label": "Sign in with Codex CLI", "oauthMode": "auto" }]
  }
}
```

### provider_auth_challenge

Challenge details returned by `provider_auth_authorize`.

```jsonc
{
  "type": "provider_auth_challenge",
  "sessionId": "...",
  "provider": "codex-cli",
  "methodId": "oauth_cli",
  "challenge": {
    "method": "auto",
    "instructions": "Run Codex CLI sign-in, then continue.",
    "command": "codex login"
  }
}
```

### provider_auth_result

Result of `provider_auth_set_api_key` or `provider_auth_callback`.

```jsonc
{
  "type": "provider_auth_result",
  "sessionId": "...",
  "provider": "openai",
  "methodId": "api_key",
  "ok": true,
  "mode": "api_key",
  "message": "Provider key saved."
}
```

### provider_status

Provider authorization / verification status. Sent in response to `refresh_provider_status`.

```jsonc
{
  "type": "provider_status",
  "sessionId": "...",
  "providers": [
    {
      "provider": "codex-cli",
      "authorized": true,
      "verified": true,
      "mode": "oauth",
      "account": { "email": "user@example.com", "name": "User Name" },
      "message": "Verified via OIDC userinfo.",
      "checkedAt": "2026-02-09T21:37:00.000Z"
    }
  ]
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

### model_stream_chunk

Structured per-part stream output from the active provider/model turn. This is additive with legacy `reasoning` and `assistant_message` events.

```jsonc
{
  "type": "model_stream_chunk",
  "sessionId": "...",
  "turnId": "turn-uuid",
  "index": 7,
  "provider": "openai",
  "model": "gpt-5.2",
  "partType": "text_delta",
  "part": {
    "id": "txt_1",
    "text": "Hello"
  },
  "rawPart": { "type": "text-delta", "id": "txt_1", "text": "Hello" } // optional
}
```

Ordering and stability guarantees:

- `turnId` is stable for all chunks in one top-level user turn.
- `index` is monotonic (0-based) and preserves original provider emission order within that `turnId`.
- `partType` uses stable snake_case values.
- `part` is normalized for stable parsing and UI rendering.
- `rawPart` is optional and sanitized JSON-safe (truncated/cycle-protected), not guaranteed verbatim.
- Legacy `reasoning` and `assistant_message` events are still emitted for compatibility.

`partType` contract (`part` required fields):

| `partType` | Required `part` fields |
|---|---|
| `start` | `{}` |
| `finish` | `{ finishReason, rawFinishReason?, totalUsage? }` |
| `abort` | `{ reason? }` |
| `error` | `{ error }` |
| `start_step` | `{ request?, warnings? }` |
| `finish_step` | `{ response?, usage?, finishReason, rawFinishReason?, providerMetadata? }` |
| `text_start` | `{ id, providerMetadata? }` |
| `text_delta` | `{ id, text, providerMetadata? }` |
| `text_end` | `{ id, providerMetadata? }` |
| `reasoning_start` | `{ id, mode, providerMetadata? }` |
| `reasoning_delta` | `{ id, mode, text, providerMetadata? }` |
| `reasoning_end` | `{ id, mode, providerMetadata? }` |
| `tool_input_start` | `{ id, toolName, providerExecuted?, dynamic?, title?, providerMetadata? }` |
| `tool_input_delta` | `{ id, delta, providerMetadata? }` |
| `tool_input_end` | `{ id, providerMetadata? }` |
| `tool_call` | `{ toolCallId, toolName, input, dynamic?, invalid?, error?, providerMetadata? }` |
| `tool_result` | `{ toolCallId, toolName, output, dynamic?, providerMetadata? }` |
| `tool_error` | `{ toolCallId, toolName, error, dynamic?, providerMetadata? }` |
| `tool_output_denied` | `{ toolCallId, toolName, reason?, providerMetadata? }` |
| `tool_approval_request` | `{ approvalId, toolCall }` |
| `source` | `{ source }` |
| `file` | `{ file }` |
| `raw` | `{ raw }` |
| `unknown` | `{ sdkType, raw? }` |

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
  "dangerous": true,
  "reasonCode": "matches_dangerous_pattern"
}
```

`reasonCode` values:

- `safe_auto_approved`
- `matches_dangerous_pattern`
- `contains_shell_control_operator`
- `requires_manual_review`
- `file_read_command_requires_review`
- `outside_allowed_scope`

### config_updated

Provider/model runtime config changed (currently emitted by `set_model`).

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

### commands

Command metadata list (response to `list_commands`).

```jsonc
{
  "type": "commands",
  "sessionId": "...",
  "commands": [
    {
      "name": "review",
      "description": "review changes [commit|branch|pr], defaults to uncommitted",
      "source": "command",
      "hints": ["$ARGUMENTS"]
    },
    {
      "name": "my-mcp-prompt",
      "description": "Prompt exposed by MCP",
      "source": "mcp",
      "hints": ["$1", "$2"]
    }
  ]
}
```

### skills_list

List of discovered skills (response to `list_skills`).

```jsonc
{
  "type": "skills_list",
  "sessionId": "...",
  "skills": [
    {
      "name": "pdf",
      "path": "/Users/user/project/.agent/skills/pdf/SKILL.md",
      "source": "project", // or "global" (from ~/.cowork/skills), "user" (~/.agent/skills), "built-in"
      "enabled": true,
      "triggers": ["pdf", ".pdf", "form"],
      "description": "Use when tasks involve reading, creating, or reviewing PDF files...",
      // Optional UI metadata loaded from skillDir/agents/*.yaml (best-effort).
      "interface": {
        "displayName": "PDF Skill",
        "shortDescription": "Create, edit, and review PDFs",
        "iconSmall": "data:image/svg+xml;base64,...",
        "iconLarge": "data:image/png;base64,...",
        "defaultPrompt": "Create, edit, or review this PDF and summarize the key output or changes.",
        "agents": ["openai"]
      }
    }
  ]
}
```

### skill_content

Skill metadata + its `SKILL.md` content (response to `read_skill`).

```jsonc
{
  "type": "skill_content",
  "sessionId": "...",
  "skill": {
    "name": "pdf",
    "path": "/Users/user/project/.agent/skills/pdf/SKILL.md",
    "source": "project",
    "enabled": true,
    "triggers": ["pdf", ".pdf", "form"],
    "description": "Use when tasks involve reading, creating, or reviewing PDF files...",
    "interface": {
      "displayName": "PDF Skill",
      "shortDescription": "Create, edit, and review PDFs",
      "iconSmall": "data:image/svg+xml;base64,...",
      "iconLarge": "data:image/png;base64,...",
      "defaultPrompt": "Create, edit, or review this PDF and summarize the key output or changes.",
      "agents": ["openai"]
    }
  },
  // SKILL.md content with any leading YAML front matter stripped (so it renders cleanly in UIs).
  "content": "# PDF Skill\\n\\n..."
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

### observability_status

Emitted on connection with the session's observability configuration.

```jsonc
{
  "type": "observability_status",
  "sessionId": "...",
  "enabled": true,
  "observability": {
    "mode": "local_docker",
    "otlpHttpEndpoint": "http://127.0.0.1:14318",
    "queryApi": {
      "logsBaseUrl": "http://127.0.0.1:19428",
      "metricsBaseUrl": "http://127.0.0.1:18428",
      "tracesBaseUrl": "http://127.0.0.1:10428"
    },
    "defaultWindowSec": 300
  }
}
```

### harness_context

Current harness context payload for the session (`null` if unset).

```jsonc
{
  "type": "harness_context",
  "sessionId": "...",
  "context": {
    "runId": "run-01",
    "objective": "Improve startup reliability",
    "acceptanceCriteria": ["startup < 800ms"],
    "constraints": ["no product behavior changes"],
    "updatedAt": "2026-02-11T12:00:00.000Z"
  }
}
```

### observability_query_result

Result envelope for a single observability query.

```jsonc
{
  "type": "observability_query_result",
  "sessionId": "...",
  "result": {
    "queryType": "promql",
    "query": "sum(rate(vector_component_errors_total[5m]))",
    "fromMs": 1738736400000,
    "toMs": 1738736700000,
    "status": "ok",
    "data": { "status": "success", "data": { "resultType": "vector", "result": [] } }
  }
}
```

### harness_slo_result

Evaluation summary for one or more SLO checks.

```jsonc
{
  "type": "harness_slo_result",
  "sessionId": "...",
  "result": {
    "reportOnly": true,
    "strictMode": false,
    "passed": true,
    "fromMs": 1738736400000,
    "toMs": 1738736700000,
    "checks": [
      {
        "id": "vector_errors",
        "type": "custom",
        "queryType": "promql",
        "query": "sum(rate(vector_component_errors_total[5m]))",
        "op": "<=",
        "threshold": 0,
        "windowSec": 300,
        "actual": 0,
        "pass": true
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
  "message": "Agent is busy",
  "code": "busy",
  "source": "session"
}
```

`code` values:

- `invalid_json`
- `invalid_payload`
- `missing_type`
- `unknown_type`
- `unknown_session`
- `busy`
- `validation_failed`
- `permission_denied`
- `provider_error`
- `backup_error`
- `observability_error`
- `internal_error`

`source` values:

- `protocol`
- `session`
- `tool`
- `provider`
- `backup`
- `observability`
- `permissions`

### pong

Keepalive response to a client `ping`. The `sessionId` echoes the incoming ping `sessionId`.

```jsonc
{ "type": "pong", "sessionId": "..." }
```

---

## Message Flow Examples

### Normal Conversation

```
client  -> user_message { text: "Hello" }
server  <- user_message { text: "Hello" }           (echo)
server  <- session_busy { busy: true }
server  <- model_stream_chunk { turnId, index, partType, part, ... } (0..N)
server  <- todos [...]                                (0..N)
server  <- reasoning { kind: "reasoning", text: ... } (0..N)
server  <- assistant_message { text: "Hi! ..." }
server  <- session_busy { busy: false }
```

### Structured Stream Notes

`model_stream_chunk` is the primary structured turn stream. `reasoning` and `assistant_message` remain for compatibility with older clients.

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

### Cancel In-Flight Turn

```
client  -> user_message { text: "Refactor the entire codebase" }
server  <- session_busy { busy: true }
server  <- reasoning { ... }
client  -> cancel { sessionId: "..." }
         ... server aborts LLM call ...
server  <- session_busy { busy: false }
```

### Keepalive Ping/Pong

```
client  -> ping { sessionId: "..." }
server  <- pong { sessionId: "..." }
```

### Model Change

```
client  -> set_model { model: "gpt-5.2", provider: "openai" }
server  <- config_updated { config: { provider: "openai", model: "gpt-5.2", ... } }
```

### Provider Bootstrap

```
server  <- server_hello { sessionId: "..." }
server  <- session_settings { ... }
client  -> provider_catalog_get { sessionId: "..." }
client  -> provider_auth_methods_get { sessionId: "..." }
client  -> refresh_provider_status { sessionId: "..." }
server  <- provider_catalog { ... }
server  <- provider_auth_methods { ... }
server  <- provider_status { ... }
```

### Provider Auth (OAuth)

```
client  -> provider_auth_authorize { provider: "codex-cli", methodId: "oauth_cli" }
server  <- provider_auth_challenge { challenge: { method: "auto", command: "codex login", ... } }
client  -> provider_auth_callback { provider: "codex-cli", methodId: "oauth_cli" }
server  <- provider_auth_result { ok: true, mode: "oauth", ... }
server  <- provider_status { ... }
server  <- provider_catalog { ... }
```

### Command Execution

```
client  -> list_commands { sessionId: "..." }
server  <- commands { commands: [...] }

client  -> execute_command { name: "review", arguments: "HEAD~2..HEAD" }
server  <- user_message { text: "/review HEAD~2..HEAD" }   (echo)
server  <- session_busy { busy: true }
server  <- assistant_message { text: "..." }
server  <- session_busy { busy: false }
```

### Backup / Checkpoint Flow

```
client  -> session_backup_get { sessionId: "..." }
server  <- session_backup_state { reason: "requested", backup: {...} }

client  -> user_message { text: "make changes" }
server  <- ...normal turn events...
server  <- session_backup_state { reason: "auto_checkpoint", backup: {...checkpoints:+1...} }

client  -> session_backup_restore { checkpointId: "cp-0001" }
server  <- session_backup_state { reason: "restore", backup: {...} }
```

---

## Error Reference

| `code` | Typical Cause |
|---|---|
| `invalid_json` | Malformed JSON payload |
| `invalid_payload` | Parsed JSON is not an object |
| `missing_type` | Missing/non-string `type` |
| `unknown_type` | Unrecognized `type` |
| `unknown_session` | `sessionId` mismatch for this connection |
| `busy` | Request sent while session is actively running |
| `validation_failed` | Required field missing/invalid |
| `permission_denied` | Path/URL/policy guard blocked action |
| `provider_error` | Provider auth or model operation failure |
| `backup_error` | Session backup/checkpoint operation failure |
| `observability_error` | Query/evaluation or observability failure |
| `internal_error` | Unexpected runtime failure |

| `source` | Subsystem |
|---|---|
| `protocol` | Parse/shape/session validation in websocket handler |
| `session` | Core `AgentSession` logic |
| `tool` | Tool execution lifecycle |
| `provider` | Provider connect/model operations |
| `backup` | Backup/checkpoint manager |
| `observability` | Observability/harness query path |
| `permissions` | Permission and scope guards |

---

## Important Behaviors

- **One message at a time**: sending `user_message` while `session_busy` is `true` returns `"Agent is busy"`.
- **requestId pairing**: `ask` and `approval` events block the agent until you respond with the matching `requestId`.
- **Session = connection**: disconnecting disposes the session and rejects all pending ask/approval deferreds. There is no reconnection or session resumption.
- **Localhost only**: the server binds to `127.0.0.1`; no auth, no TLS.
- **Automatic snapshots/checkpoints**: on session start, the server snapshots the working directory into `~/.cowork/session-backups/{sessionId}`. After every agent turn completion, it stores a compressed binary diff checkpoint against the original snapshot.

---

## Desktop / Wrapper Integration

### Server CLI (machine-readable)

For desktop wrappers (e.g. Electron), the server supports:

- Ephemeral ports with `--port 0`
- JSON startup output with `--json`

Example:

```bash
bun src/server/index.ts --dir /path/to/project --port 0 --json
```

On success, stdout prints a single JSON line:

```json
{"type":"server_listening","url":"ws://127.0.0.1:12345/ws","port":12345,"cwd":"/path/to/project"}
```

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
