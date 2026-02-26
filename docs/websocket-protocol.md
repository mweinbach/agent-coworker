# WebSocket Protocol Reference

Canonical protocol contract for `agent-coworker` WebSocket clients.

## Connection

- URL: `ws://127.0.0.1:{port}/ws`
- Session resume: `?resumeSessionId=<sessionId>`
- Current protocol version: `7.0`

## Table of Contents

- [Connection](#connection)
- [Protocol Version Notes](#protocol-v7-notes)
  - [v7 Notes](#protocol-v7-notes)
  - [v6 Notes](#protocol-v6-notes)
  - [v5 Notes](#protocol-v5-notes)
  - [v4 Notes](#protocol-v4-notes)
- [Connection Lifecycle](#connection-lifecycle)
- [Validation Rules](#validation-rules)
- [Shared Types](#shared-types)
  - [ProviderName](#providername) | [PublicConfig](#publicconfig) | [ProviderCatalogEntry](#providercatalogentry) | [ProviderAuthMethod](#providerauthmethod) | [ProviderAuthChallenge](#providerauthchallenge) | [ProviderStatus](#providerstatus)
  - [TodoItem](#todoitem) | [CommandInfo](#commandinfo) | [SkillEntry](#skillentry) | [HarnessContextPayload](#harnesscontextpayload)
  - [SessionBackupPublicState](#sessionbackuppublicstate) | [ObservabilityHealth](#observabilityhealth)
  - [ModelStreamPartType](#modelstreamparttype) | [ApprovalRiskCode](#approvalriskcode) | [ServerErrorCode](#servererrorcode) | [ServerErrorSource](#servererrorsource)
- [Client -> Server Messages](#client---server-messages)
  - Handshake: [client_hello](#client_hello)
  - Conversation: [user_message](#user_message) | [ask_response](#ask_response) | [approval_response](#approval_response) | [cancel](#cancel) | [reset](#reset)
  - Model & Provider: [set_model](#set_model) | [refresh_provider_status](#refresh_provider_status) | [provider_catalog_get](#provider_catalog_get) | [provider_auth_methods_get](#provider_auth_methods_get) | [provider_auth_authorize](#provider_auth_authorize) | [provider_auth_callback](#provider_auth_callback) | [provider_auth_set_api_key](#provider_auth_set_api_key)
  - Tools & Commands: [list_tools](#list_tools) | [list_commands](#list_commands) | [execute_command](#execute_command)
  - Skills: [list_skills](#list_skills) | [read_skill](#read_skill) | [disable_skill](#disable_skill) | [enable_skill](#enable_skill) | [delete_skill](#delete_skill)
  - MCP: [set_enable_mcp](#set_enable_mcp) | [mcp_servers_get](#mcp_servers_get) | [mcp_server_upsert](#mcp_server_upsert) | [mcp_server_delete](#mcp_server_delete) | [mcp_server_validate](#mcp_server_validate) | [mcp_server_auth_authorize](#mcp_server_auth_authorize) | [mcp_server_auth_callback](#mcp_server_auth_callback) | [mcp_server_auth_set_api_key](#mcp_server_auth_set_api_key) | [mcp_servers_migrate_legacy](#mcp_servers_migrate_legacy)
  - Session Management: [session_close](#session_close) | [get_messages](#get_messages) | [set_session_title](#set_session_title) | [list_sessions](#list_sessions) | [delete_session](#delete_session) | [set_config](#set_config) | [upload_file](#upload_file)
  - Backup: [session_backup_get](#session_backup_get) | [session_backup_checkpoint](#session_backup_checkpoint) | [session_backup_restore](#session_backup_restore) | [session_backup_delete_checkpoint](#session_backup_delete_checkpoint)
  - Harness: [harness_context_get](#harness_context_get) | [harness_context_set](#harness_context_set)
  - Keepalive: [ping](#ping)
- [Server -> Client Events](#server---client-events)
  - Handshake & Lifecycle: [server_hello](#server_hello) | [session_settings](#session_settings) | [session_info](#session_info) | [session_busy](#session_busy) | [session_config](#session_config)
  - Conversation: [user_message](#user_message-1) | [model_stream_chunk](#model_stream_chunk) | [assistant_message](#assistant_message) | [reasoning](#reasoning) | [log](#log) | [todos](#todos) | [reset_done](#reset_done)
  - Prompts: [ask](#ask) | [approval](#approval)
  - Provider: [provider_catalog](#provider_catalog) | [provider_auth_methods](#provider_auth_methods) | [provider_auth_challenge](#provider_auth_challenge) | [provider_auth_result](#provider_auth_result) | [provider_status](#provider_status) | [config_updated](#config_updated)
  - Tools & Skills: [tools](#tools) | [commands](#commands) | [skills_list](#skills_list) | [skill_content](#skill_content)
  - MCP: [mcp_servers](#mcp_servers) | [mcp_server_validation](#mcp_server_validation) | [mcp_server_auth_challenge](#mcp_server_auth_challenge) | [mcp_server_auth_result](#mcp_server_auth_result)
  - Session Data: [messages](#messages) | [sessions](#sessions) | [session_deleted](#session_deleted) | [file_uploaded](#file_uploaded) | [turn_usage](#turn_usage)
  - Backup & Observability: [session_backup_state](#session_backup_state) | [observability_status](#observability_status)
  - Harness: [harness_context](#harness_context)
  - Error & Keepalive: [error](#error) | [pong](#pong)

## Protocol v7 Notes

Changes in `7.0`:

- MCP server management moved to granular control messages (`mcp_server_upsert`, `mcp_server_delete`, `mcp_server_validate`, auth/migration flows).
- `mcp_servers` event now returns layered effective servers, file diagnostics, and legacy visibility.
- New MCP server events: `mcp_server_validation`, `mcp_server_auth_challenge`, `mcp_server_auth_result`.
- MCP config layering now targets `.cowork` (`workspace`, `user`, built-in) with `.agent` legacy fallback read-only visibility.

## Protocol v6 Notes

Changes in `6.0`:

- New client message: `session_close`.
- Session lifetime is now explicit. Disconnected sessions are not auto-disposed by timeout.
- Session/history storage is canonicalized in core SQLite (`~/.cowork/sessions.db`) with backward-compatible startup import of legacy JSON snapshots.
- `server_hello` may include `resumedFromStorage` on cold resume (rehydrated from persisted state).

## Protocol v5 Notes

Changes in `5.0`:

- `server_hello` now includes optional reconnect fields: `isResume`, `busy`, `messageCount`, `hasPendingAsk`, `hasPendingApproval`.
- `session_busy` now includes optional context: `turnId`, `cause`, `outcome`.
- `tools` event shape changed from `string[]` to `Array<{ name: string; description: string }>`.
- `session_info.titleSource` now includes `"manual"` option.
- New server events: `turn_usage`, `messages`, `sessions`, `session_deleted`, `session_config`, `file_uploaded`.
- New client messages: `get_messages`, `set_session_title`, `list_sessions`, `delete_session`, `set_config`, `upload_file`.
- Pending `ask`/`approval` prompts are replayed on reconnect.
- `session_backup_state` is pushed automatically on connect.

## Protocol v4 Notes

Breaking changes in `4.0`:

- Removed client messages: `observability_query`, `harness_slo_evaluate`
- Removed server events: `observability_query_result`, `harness_slo_result`
- `observability_status` now reports Langfuse-oriented status/config only.

## Connection Lifecycle

When a WebSocket connection opens, the server sends these events in order:

1. `server_hello` — session ID, config, protocol version, capabilities
2. `session_settings` — current runtime settings (e.g. MCP toggle)
3. `session_config` — current runtime config (`yolo`, `observabilityEnabled`, `subAgentModel`, `maxSteps`)
4. `session_info` — session metadata including title
5. `observability_status` — Langfuse observability state
6. `provider_catalog` — available providers and models (async)
7. `provider_auth_methods` — auth method registry
8. `provider_status` — current provider auth/connection status (async)
9. `mcp_servers` — layered MCP snapshot (async)
10. `session_backup_state` — backup/checkpoint state (async)

If connecting with `?resumeSessionId=<id>`, the server resumes the existing session instead of creating a new one (warm in-memory attach or cold rehydrate from persisted storage). `session_close` disposes active runtime bindings but retains persisted history for later resume/view. On resume, `server_hello` includes additional fields (`isResume`, `busy`, `messageCount`, `hasPendingAsk`, `hasPendingApproval`) and may include `resumedFromStorage: true` for cold rehydrate.

## Validation Rules

All client messages are validated by `safeParseClientMessage()` before dispatch:

1. Must be valid JSON. Error: `"Invalid JSON"`
2. Must be a plain object. Error: `"Expected object"`
3. Must have a `type` string field. Error: `"Missing type"`
4. `type` must be a known client message type. Error: `"Unknown type: <value>"`
5. Every message except `client_hello` requires a non-empty `sessionId` that matches the current session. Mismatch produces error code `unknown_session`.

**Non-empty string** means `typeof v === "string" && v.trim().length > 0`. Whitespace-only strings are rejected.

Any validation failure produces an `error` server event (see [error](#error)).

Server events can also be validated client-side via `safeParseServerEvent()` / `safeParseServerEventDetailed()`. If a received event fails envelope validation (unknown type, missing required fields, invalid JSON), clients should ignore/drop that event rather than treating it as a protocol-level fatal error. Clients may optionally surface diagnostics (for example, via `onInvalidEvent`) without changing runtime behavior.

## Shared Types

Types referenced across multiple messages.

### ProviderName

```
"google" | "openai" | "anthropic" | "codex-cli"
```

### PublicConfig

Returned in `server_hello` and `config_updated`:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "workingDirectory": "/path/to/project"
}
```

`outputDirectory` is optional and only present when explicitly configured.

### ProviderCatalogEntry

```json
{
  "id": "openai",
  "name": "OpenAI",
  "models": ["gpt-4o", "gpt-4o-mini", "o3"],
  "defaultModel": "gpt-4o"
}
```

### ProviderAuthMethod

```json
{
  "id": "api_key",
  "type": "api",
  "label": "API Key",
  "oauthMode": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Method identifier (e.g. `"api_key"`, `"oauth_cli"`, `"exa_api_key"`) |
| `type` | `"api" \| "oauth"` | Auth method category |
| `label` | `string` | Human-readable label |
| `oauthMode` | `"auto" \| "code"` | Optional. Only present for OAuth methods |

### ProviderAuthChallenge

```json
{
  "method": "code",
  "instructions": "Visit the URL below and paste the authorization code.",
  "url": "https://accounts.example.com/oauth/authorize?...",
  "command": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `method` | `"auto" \| "code"` | Whether the flow completes automatically or requires a code |
| `instructions` | `string` | Human-readable instructions |
| `url` | `string?` | Optional OAuth URL |
| `command` | `string?` | Optional CLI command |

### ProviderStatus

```json
{
  "provider": "openai",
  "authorized": true,
  "verified": true,
  "mode": "api_key",
  "account": { "email": "user@example.com", "name": "User" },
  "message": "Connected",
  "checkedAt": "2026-02-19T18:00:00.000Z",
  "savedApiKeyMasks": { "api_key": "sk-...xxxx" }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `ProviderName` | Provider identifier |
| `authorized` | `boolean` | Whether auth credentials exist |
| `verified` | `boolean` | Whether credentials have been verified working |
| `mode` | `"missing" \| "error" \| "api_key" \| "oauth" \| "oauth_pending"` | Current auth mode |
| `account` | `{ email?: string, name?: string } \| null` | Account info if available |
| `message` | `string` | Human-readable status message |
| `checkedAt` | `string` | ISO 8601 timestamp of last check |
| `savedApiKeyMasks` | `Record<string, string>?` | Optional masked key values keyed by method id. Never includes raw secrets |

### TodoItem

```json
{
  "content": "Fix the login bug",
  "status": "in_progress",
  "activeForm": "Fixing the login bug"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | Todo text |
| `status` | `"pending" \| "in_progress" \| "completed"` | Current status |
| `activeForm` | `string` | Present-continuous description shown during progress |

### CommandInfo

```json
{
  "name": "review",
  "description": "Run a code review",
  "source": "skill",
  "hints": ["/review"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Command name |
| `description` | `string?` | Optional description |
| `source` | `"command" \| "mcp" \| "skill"` | Where the command comes from |
| `hints` | `string[]` | Trigger hints (e.g. slash command aliases) |

### SkillEntry

```json
{
  "name": "commit",
  "path": "/home/user/.agent/skills/commit/SKILL.md",
  "source": "global",
  "enabled": true,
  "triggers": ["/commit"],
  "description": "Create a git commit",
  "interface": {
    "displayName": "Commit",
    "shortDescription": "Create a git commit",
    "iconSmall": "data:image/png;base64,...",
    "iconLarge": null,
    "defaultPrompt": null,
    "agents": null
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Skill name |
| `path` | `string` | Filesystem path to SKILL.md |
| `source` | `"project" \| "user" \| "global" \| "built-in"` | Skill source tier |
| `enabled` | `boolean` | Whether the skill is active |
| `triggers` | `string[]` | Trigger patterns |
| `description` | `string` | Skill description |
| `interface` | `object?` | Optional UI metadata: `displayName?`, `shortDescription?`, `iconSmall?`, `iconLarge?`, `defaultPrompt?`, `agents?` |

### HarnessContextPayload

```json
{
  "runId": "run-abc-123",
  "taskId": "task-1",
  "objective": "Fix the authentication bug",
  "acceptanceCriteria": ["Login works with valid credentials", "Invalid credentials show error"],
  "constraints": ["Do not modify the database schema"],
  "metadata": { "priority": "high" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runId` | `string` | Yes | Non-empty run identifier |
| `taskId` | `string` | No | Optional task identifier |
| `objective` | `string` | Yes | Non-empty objective text |
| `acceptanceCriteria` | `string[]` | Yes | Array of strings (can be empty) |
| `constraints` | `string[]` | Yes | Array of strings (can be empty) |
| `metadata` | `Record<string, string>` | No | Optional key-value metadata (all values must be strings) |

### SessionBackupPublicState

```json
{
  "status": "ready",
  "sessionId": "abc-123",
  "workingDirectory": "/path/to/project",
  "backupDirectory": "/path/to/backup",
  "createdAt": "2026-02-19T18:00:00.000Z",
  "originalSnapshot": { "kind": "directory" },
  "checkpoints": [
    {
      "id": "cp-0001",
      "index": 0,
      "createdAt": "2026-02-19T18:05:00.000Z",
      "trigger": "auto",
      "changed": true,
      "patchBytes": 1234
    }
  ],
  "failureReason": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"initializing" \| "ready" \| "failed"` | Backup system status |
| `sessionId` | `string` | Session identifier |
| `workingDirectory` | `string` | Project working directory |
| `backupDirectory` | `string \| null` | Backup storage path |
| `createdAt` | `string` | ISO 8601 timestamp |
| `originalSnapshot` | `{ kind: "pending" \| "directory" \| "tar_gz" }` | Original state snapshot info |
| `checkpoints` | `SessionBackupPublicCheckpoint[]` | List of checkpoints (see below) |
| `failureReason` | `string?` | Present when `status` is `"failed"` |

**SessionBackupPublicCheckpoint:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Checkpoint identifier (e.g. `"cp-0001"`) |
| `index` | `number` | Sequential index |
| `createdAt` | `string` | ISO 8601 timestamp |
| `trigger` | `"auto" \| "manual"` | What triggered this checkpoint |
| `changed` | `boolean` | Whether files changed since last checkpoint |
| `patchBytes` | `number` | Size of the patch data |

### ObservabilityHealth

```json
{
  "status": "ready",
  "reason": "runtime_ready",
  "message": null,
  "updatedAt": "2026-02-19T08:45:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"disabled" \| "ready" \| "degraded"` | Health status |
| `reason` | `string` | Machine-readable reason code |
| `message` | `string?` | Optional detail message (present for degraded states) |
| `updatedAt` | `string` | ISO 8601 timestamp |

### ModelStreamPartType

```
"start" | "finish" | "abort" | "error"
| "start_step" | "finish_step"
| "text_start" | "text_delta" | "text_end"
| "reasoning_start" | "reasoning_delta" | "reasoning_end"
| "tool_input_start" | "tool_input_delta" | "tool_input_end"
| "tool_call" | "tool_result" | "tool_error"
| "tool_output_denied" | "tool_approval_request"
| "source" | "file" | "raw" | "unknown"
```

### ApprovalRiskCode

```
"safe_auto_approved"
| "matches_dangerous_pattern"
| "contains_shell_control_operator"
| "requires_manual_review"
| "file_read_command_requires_review"
| "outside_allowed_scope"
```

### ServerErrorCode

```
"invalid_json" | "invalid_payload" | "missing_type" | "unknown_type"
| "unknown_session" | "busy" | "validation_failed" | "permission_denied"
| "provider_error" | "backup_error" | "observability_error" | "internal_error"
```

### ServerErrorSource

```
"protocol" | "session" | "tool" | "provider"
| "backup" | "observability" | "permissions"
```

---

## Client -> Server Messages

### client_hello

Optional client identity handshake. This is the only message that does NOT require `sessionId`.

```json
{ "type": "client_hello", "client": "tui", "version": "1.0.0" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"client_hello"` | Yes | — |
| `client` | `string` | Yes | Client identifier (e.g. `"tui"`, `"cli"`, or custom) |
| `version` | `string` | No | Client version string |

**Response:** None. The server acknowledges by ignoring this message; `server_hello` is sent on connection open regardless.

---

### user_message

Send a user prompt to the session.

```json
{ "type": "user_message", "sessionId": "...", "text": "Explain this code", "clientMessageId": "msg-1" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"user_message"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `text` | `string` | Yes | Prompt text (empty string is allowed) |
| `clientMessageId` | `string` | No | Client-side correlation ID, echoed back in the server's `user_message` event |

**Response:** Triggers a full turn lifecycle:
1. `user_message` (echo)
2. `session_busy` (`busy: true`)
3. Zero or more: `model_stream_chunk`, `log`, `todos`, `ask`, `approval`
4. `reasoning` (if applicable)
5. `assistant_message`
6. `session_busy` (`busy: false`)

**Error:** Returns `error` with code `busy` if a turn is already running.

---

### ask_response

Respond to an `ask` event.

```json
{ "type": "ask_response", "sessionId": "...", "requestId": "req-abc", "answer": "yes" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"ask_response"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `requestId` | `string` | Yes | Non-empty. Must match the `requestId` from a pending `ask` event |
| `answer` | `string` | Yes | User response text. Must be non-empty after trimming whitespace, or the explicit skip token `"[skipped]"` |

If `answer` is empty/whitespace, the server emits an `error` (`code: "validation_failed"`, `source: "session"`) and re-emits the pending `ask` event with the same `requestId`.

---

### approval_response

Respond to an `approval` event.

```json
{ "type": "approval_response", "sessionId": "...", "requestId": "req-abc", "approved": true }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"approval_response"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `requestId` | `string` | Yes | Non-empty. Must match the `requestId` from a pending `approval` event |
| `approved` | `boolean` | Yes | `true` to approve, `false` to deny. Must be a boolean (not a string) |

---

### set_model

Update session model and optionally provider. On success, server emits `config_updated` and persists the selection as the default for new sessions in the current project.

```json
{ "type": "set_model", "sessionId": "...", "model": "gpt-4o", "provider": "openai" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"set_model"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `model` | `string` | Yes | Non-empty model identifier |
| `provider` | `ProviderName` | No | If omitted, keeps current provider. Must be a valid `ProviderName` if present |

**Response:** `config_updated`, `session_info`, `provider_catalog`
**Error:** `busy` if a turn is running. `validation_failed` if provider is invalid. `internal_error` may be emitted if persisting project defaults fails after the in-session update is already applied.

---

### refresh_provider_status

Request provider status refresh.

```json
{ "type": "refresh_provider_status", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"refresh_provider_status"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `provider_status`

---

### provider_catalog_get

Request provider catalog metadata.

```json
{ "type": "provider_catalog_get", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"provider_catalog_get"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `provider_catalog`

---

### provider_auth_methods_get

Request supported auth methods for all providers.

```json
{ "type": "provider_auth_methods_get", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"provider_auth_methods_get"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `provider_auth_methods`

---

### provider_auth_authorize

Start a provider auth challenge flow.

```json
{ "type": "provider_auth_authorize", "sessionId": "...", "provider": "openai", "methodId": "api_key" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"provider_auth_authorize"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `provider` | `ProviderName` | Yes | Must be a valid provider |
| `methodId` | `string` | Yes | Non-empty. Must be a registered auth method for the given provider |

**Response:** `provider_auth_challenge` on success, `error` on failure.
**Error:** `busy` if a turn is running. `validation_failed` if provider or methodId is invalid/unknown.

---

### provider_auth_callback

Complete a provider OAuth callback flow.

```json
{ "type": "provider_auth_callback", "sessionId": "...", "provider": "codex-cli", "methodId": "oauth_cli", "code": "abc123" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"provider_auth_callback"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `provider` | `ProviderName` | Yes | Must be a valid provider |
| `methodId` | `string` | Yes | Non-empty. Must be a registered auth method for the given provider |
| `code` | `string` | No | Authorization code for OAuth flows that require it |

**Response:** `provider_auth_result`, then `provider_status` and `provider_catalog` on success.

---

### provider_auth_set_api_key

Set a provider API key.

```json
{ "type": "provider_auth_set_api_key", "sessionId": "...", "provider": "openai", "methodId": "api_key", "apiKey": "sk-..." }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"provider_auth_set_api_key"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `provider` | `ProviderName` | Yes | Must be a valid provider |
| `methodId` | `string` | Yes | Non-empty. Must be a registered auth method for the given provider |
| `apiKey` | `string` | Yes | Non-empty API key value |

**Response:** `provider_auth_result`, then `provider_status` and `provider_catalog` on success.

---

### list_tools

Request the list of available tool names.

```json
{ "type": "list_tools", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"list_tools"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `tools`

---

### list_commands

Request available slash commands.

```json
{ "type": "list_commands", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"list_commands"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `commands`

---

### execute_command

Execute a configured slash command. The command template is expanded and sent as a user message.

```json
{ "type": "execute_command", "sessionId": "...", "name": "review", "arguments": "src/main.ts", "clientMessageId": "msg-2" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"execute_command"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `name` | `string` | Yes | Non-empty command name |
| `arguments` | `string` | No | Raw argument text appended to the command |
| `clientMessageId` | `string` | No | Client-side correlation ID |

**Response:** Same turn lifecycle as `user_message`.
**Error:** `validation_failed` if the command name is empty, unknown, or expands to an empty prompt.

---

### list_skills

Request skill metadata list.

```json
{ "type": "list_skills", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"list_skills"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `skills_list`

---

### read_skill

Read a skill's content.

```json
{ "type": "read_skill", "sessionId": "...", "skillName": "commit" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"read_skill"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `skillName` | `string` | Yes | Non-empty skill name |

**Response:** `skill_content`

---

### disable_skill

Disable a global skill.

```json
{ "type": "disable_skill", "sessionId": "...", "skillName": "commit" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"disable_skill"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `skillName` | `string` | Yes | Non-empty skill name |

**Response:** `skills_list` (refreshed list). Only global skills can be disabled.
**Error:** `busy` if a turn is running. `validation_failed` if the skill is not found or not a global skill.

---

### enable_skill

Enable a previously disabled global skill.

```json
{ "type": "enable_skill", "sessionId": "...", "skillName": "commit" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"enable_skill"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `skillName` | `string` | Yes | Non-empty skill name |

**Response:** `skills_list` (refreshed list). Only global skills can be enabled.
**Error:** `busy` if a turn is running. `validation_failed` if the skill is not found or not a global skill.

---

### delete_skill

Delete a global skill permanently.

```json
{ "type": "delete_skill", "sessionId": "...", "skillName": "commit" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"delete_skill"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `skillName` | `string` | Yes | Non-empty skill name |

**Response:** `skills_list` (refreshed list). Only global skills can be deleted.
**Error:** `busy` if a turn is running. `validation_failed` if the skill is not found or not a global skill.

---

### set_enable_mcp

Toggle MCP (Model Context Protocol) tool loading for the session.

```json
{ "type": "set_enable_mcp", "sessionId": "...", "enableMcp": true }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"set_enable_mcp"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `enableMcp` | `boolean` | Yes | `true` to enable, `false` to disable. Must be a boolean |

**Response:** `session_settings`
**Error:** `busy` if a turn is running. `internal_error` may be emitted if persisting project defaults fails after the in-session update is already applied.

---

### mcp_servers_get

Read the layered MCP server snapshot (workspace/user/system plus legacy fallback visibility).

```json
{ "type": "mcp_servers_get", "sessionId": "..." }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"mcp_servers_get"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |

**Response:** `mcp_servers`

---

### mcp_server_upsert

Create or update a workspace MCP server entry in `<workspace>/.cowork/mcp-servers.json`.

```json
{
  "type": "mcp_server_upsert",
  "sessionId": "...",
  "server": {
    "name": "grep",
    "transport": { "type": "http", "url": "https://mcp.grep.app" },
    "auth": { "type": "oauth", "oauthMode": "auto" }
  },
  "previousName": "old-name"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"mcp_server_upsert"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `server` | `MCPServerConfig` | Yes | Server entry to validate and persist |
| `previousName` | `string` | No | Previous server name when renaming |

**Response:** `mcp_servers`
**Error:** `validation_failed` on invalid shape, `busy` if a turn is running.

---

### mcp_server_delete

Delete a workspace MCP server by name.

```json
{ "type": "mcp_server_delete", "sessionId": "...", "name": "grep" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"mcp_server_delete"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `name` | `string` | Yes | Non-empty server name |

**Response:** `mcp_servers`

---

### mcp_server_validate

Validate MCP connectivity/auth for a specific effective server.

```json
{ "type": "mcp_server_validate", "sessionId": "...", "name": "grep" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"mcp_server_validate"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `name` | `string` | Yes | Non-empty server name |

**Response:** `mcp_server_validation`

---

### mcp_server_auth_authorize

Start MCP OAuth authorization for a server.

```json
{ "type": "mcp_server_auth_authorize", "sessionId": "...", "name": "grep" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"mcp_server_auth_authorize"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `name` | `string` | Yes | Non-empty server name |

**Response:** `mcp_server_auth_challenge`

---

### mcp_server_auth_callback

Complete MCP OAuth flow with an optional manual code (auto callback path can omit `code`).

```json
{ "type": "mcp_server_auth_callback", "sessionId": "...", "name": "grep", "code": "abc123" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"mcp_server_auth_callback"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `name` | `string` | Yes | Non-empty server name |
| `code` | `string` | No | Optional manual auth code |

**Response:** `mcp_server_auth_result`

---

### mcp_server_auth_set_api_key

Persist MCP API key credential for a server (credentials are stored in `.cowork/auth/mcp-credentials.json`).

```json
{ "type": "mcp_server_auth_set_api_key", "sessionId": "...", "name": "grep", "apiKey": "..." }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"mcp_server_auth_set_api_key"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `name` | `string` | Yes | Non-empty server name |
| `apiKey` | `string` | Yes | Non-empty API key payload |

**Response:** `mcp_server_auth_result`

---

### mcp_servers_migrate_legacy

Migrate legacy `.agent/mcp-servers.json` entries into `.cowork` scope.

```json
{ "type": "mcp_servers_migrate_legacy", "sessionId": "...", "scope": "workspace" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"mcp_servers_migrate_legacy"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `scope` | `"workspace" \| "user"` | Yes | Migration destination scope |

**Response:** `mcp_servers`

---

### cancel

Cancel the currently running agent turn. Aborts the model stream and rejects any pending ask/approval prompts.

```json
{ "type": "cancel", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"cancel"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** The in-progress turn will end and emit `session_busy` (`busy: false`). No-op if no turn is running.

---

### session_close

Close and dispose the active runtime session binding. Persisted history remains available and can be resumed later.

```json
{ "type": "session_close", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"session_close"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** Active runtime session is closed and socket is disconnected. Future messages on that socket are invalid; reconnect with `resumeSessionId` to continue from persisted history.

---

### ping

Keepalive ping.

```json
{ "type": "ping", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"ping"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `pong`

---

### session_backup_get

Request current backup/checkpoint state.

```json
{ "type": "session_backup_get", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"session_backup_get"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `session_backup_state` with `reason: "requested"`

---

### session_backup_checkpoint

Create a manual checkpoint of the current working directory state.

```json
{ "type": "session_backup_checkpoint", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"session_backup_checkpoint"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `session_backup_state` with `reason: "manual_checkpoint"`
**Error:** `busy` if a turn is running. `backup_error` if the backup system is unavailable.

---

### session_backup_restore

Restore the working directory to original state or a specific checkpoint.

```json
{ "type": "session_backup_restore", "sessionId": "...", "checkpointId": "cp-0001" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"session_backup_restore"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `checkpointId` | `string` | No | If omitted, restores to original (pre-session) state. If present, must be non-empty |

**Response:** `session_backup_state` with `reason: "restore"`
**Error:** `busy` if a turn is running. `backup_error` if unavailable.

---

### session_backup_delete_checkpoint

Delete a named checkpoint.

```json
{ "type": "session_backup_delete_checkpoint", "sessionId": "...", "checkpointId": "cp-0001" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"session_backup_delete_checkpoint"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `checkpointId` | `string` | Yes | Non-empty checkpoint identifier |

**Response:** `session_backup_state` with `reason: "delete"`
**Error:** `busy` if a turn is running. `validation_failed` if the checkpoint ID is unknown.

---

### harness_context_get

Get current harness context for the session.

```json
{ "type": "harness_context_get", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"harness_context_get"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `harness_context`

---

### harness_context_set

Set harness context payload. This is the most heavily validated client message.

```json
{
  "type": "harness_context_set",
  "sessionId": "...",
  "context": {
    "runId": "run-abc-123",
    "taskId": "task-1",
    "objective": "Fix the authentication bug",
    "acceptanceCriteria": ["Login works"],
    "constraints": ["No schema changes"],
    "metadata": { "priority": "high" }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"harness_context_set"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `context` | `HarnessContextPayload` | Yes | See [HarnessContextPayload](#harnesscontextpayload). All sub-fields are individually validated |

**Response:** `harness_context`

---

### reset

Reset conversation history and todo state. Clears all messages and todos.

```json
{ "type": "reset", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"reset"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `todos` (empty list), then `reset_done`
**Error:** `busy` if a turn is running.

---

### get_messages

Retrieve message history with pagination.

```json
{ "type": "get_messages", "sessionId": "...", "offset": 0, "limit": 50 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"get_messages"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `offset` | `number` | No | Start index (default 0). Must be >= 0 |
| `limit` | `number` | No | Max messages to return (default 100). Must be >= 1 |

**Response:** `messages`

---

### set_session_title

Manually set the session title.

```json
{ "type": "set_session_title", "sessionId": "...", "title": "My custom title" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"set_session_title"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `title` | `string` | Yes | Non-empty title string |

**Response:** `session_info` with `titleSource: "manual"`

---

### list_sessions

Enumerate all persisted sessions from the server's canonical session store.

```json
{ "type": "list_sessions", "sessionId": "..." }
```

| Field | Type | Required |
|-------|------|----------|
| `type` | `"list_sessions"` | Yes |
| `sessionId` | `string` | Yes |

**Response:** `sessions`

---

### delete_session

Delete a persisted session by its ID. Cannot delete the active session.

```json
{ "type": "delete_session", "sessionId": "...", "targetSessionId": "old-session-id" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"delete_session"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `targetSessionId` | `string` | Yes | Non-empty ID of the session to delete |

**Response:** `session_deleted`
**Error:** `validation_failed` if attempting to delete the active session.

---

### set_config

Update runtime configuration values.

```json
{
  "type": "set_config",
  "sessionId": "...",
  "config": {
    "yolo": true,
    "maxSteps": 200
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"set_config"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `config` | `object` | Yes | Patch object with optional fields |
| `config.yolo` | `boolean` | No | Auto-approve all commands |
| `config.observabilityEnabled` | `boolean` | No | Toggle observability |
| `config.subAgentModel` | `string` | No | Non-empty sub-agent model ID |
| `config.maxSteps` | `number` | No | Max steps per turn (1-1000) |

**Response:** `session_config`

---

### upload_file

Upload a file to the session's uploads directory.

```json
{ "type": "upload_file", "sessionId": "...", "filename": "image.png", "contentBase64": "iVBORw0KGgo..." }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"upload_file"` | Yes | — |
| `sessionId` | `string` | Yes | Non-empty session ID |
| `filename` | `string` | Yes | Non-empty filename (basename only, no path separators) |
| `contentBase64` | `string` | Yes | Base64-encoded file content (max ~10MB encoded / ~7.5MB decoded) |

**Response:** `file_uploaded`
**Error:** `busy` if a turn is running. `validation_failed` if filename is invalid or file too large.

---

## Server -> Client Events

### server_hello

Initial handshake event sent immediately on WebSocket connection.

```json
{
  "type": "server_hello",
  "sessionId": "abc-123-def",
  "protocolVersion": "7.0",
  "capabilities": {
    "modelStreamChunk": "v1"
  },
  "config": {
    "provider": "openai",
    "model": "gpt-4o",
    "workingDirectory": "/path/to/project"
  },
  "isResume": true,
  "resumedFromStorage": true,
  "busy": false,
  "messageCount": 12,
  "hasPendingAsk": false,
  "hasPendingApproval": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"server_hello"` | — |
| `sessionId` | `string` | The session identifier. Use this for all subsequent messages |
| `protocolVersion` | `string?` | Protocol version (currently `"7.0"`) |
| `capabilities` | `object?` | Optional capabilities object. Currently: `{ modelStreamChunk: "v1" }` |
| `config` | `PublicConfig` | Session config: `provider`, `model`, `workingDirectory`, and optionally `outputDirectory` |
| `isResume` | `boolean?` | Present and `true` only when resuming a disconnected session |
| `resumedFromStorage` | `boolean?` | Present and `true` on cold resume (rehydrated from persisted store) |
| `busy` | `boolean?` | Whether the session is mid-turn (only on resume) |
| `messageCount` | `number?` | Number of messages in history (only on resume) |
| `hasPendingAsk` | `boolean?` | Whether there's a pending `ask` prompt (only on resume) |
| `hasPendingApproval` | `boolean?` | Whether there's a pending `approval` prompt (only on resume) |

---

### session_settings

Current runtime session settings. Sent on connection and after `set_enable_mcp`.

```json
{
  "type": "session_settings",
  "sessionId": "...",
  "enableMcp": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_settings"` | — |
| `sessionId` | `string` | Session identifier |
| `enableMcp` | `boolean` | Whether MCP tool loading is enabled |

---

### session_info

Canonical session metadata snapshot. Sent on connection and whenever title, provider, or model changes.

```json
{
  "type": "session_info",
  "sessionId": "...",
  "title": "Summarize websocket title service",
  "titleSource": "model",
  "titleModel": "gpt-4o-mini",
  "createdAt": "2026-02-19T18:10:00.000Z",
  "updatedAt": "2026-02-19T18:10:03.000Z",
  "provider": "openai",
  "model": "gpt-4o"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_info"` | — |
| `sessionId` | `string` | Session identifier |
| `title` | `string` | Session title (defaults to `"New conversation"`) |
| `titleSource` | `"default" \| "model" \| "heuristic" \| "manual"` | How the title was generated |
| `titleModel` | `string \| null` | Model used for title generation, or `null` |
| `createdAt` | `string` | ISO 8601 session creation timestamp |
| `updatedAt` | `string` | ISO 8601 last update timestamp |
| `provider` | `ProviderName` | Current provider |
| `model` | `string` | Current model |

---

### mcp_servers

Layered MCP server snapshot with auth status, source attribution, and legacy visibility.

```json
{
  "type": "mcp_servers",
  "sessionId": "...",
  "servers": [
    {
      "name": "grep",
      "transport": { "type": "http", "url": "https://mcp.grep.app" },
      "source": "workspace",
      "inherited": false,
      "authMode": "oauth",
      "authScope": "workspace",
      "authMessage": "OAuth token available."
    }
  ],
  "legacy": {
    "workspace": { "path": "/workspace/.agent/mcp-servers.json", "exists": true },
    "user": { "path": "/Users/me/.agent/mcp-servers.json", "exists": false }
  },
  "files": [
    {
      "source": "workspace",
      "path": "/workspace/.cowork/mcp-servers.json",
      "exists": true,
      "editable": true,
      "legacy": false,
      "serverCount": 1
    }
  ],
  "warnings": ["workspace_legacy: mcp-servers.json: invalid JSON: ..."]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"mcp_servers"` | — |
| `sessionId` | `string` | Session identifier |
| `servers` | `Array<MCPServerConfig & { source, inherited, authMode, authScope, authMessage }>` | Effective servers with layer/auth metadata |
| `legacy` | `{ workspace, user }` | Legacy `.agent` file paths and existence flags |
| `files` | `Array<{ source, path, exists, editable, legacy, parseError?, serverCount }>` | File-level diagnostics per layer |
| `warnings` | `string[]` | Optional non-fatal parse warnings |

---

### mcp_server_validation

Result of `mcp_server_validate` (or best-effort auto-validation after save/auth operations).

```json
{
  "type": "mcp_server_validation",
  "sessionId": "...",
  "name": "grep",
  "ok": true,
  "mode": "oauth",
  "message": "MCP server validation succeeded.",
  "toolCount": 12,
  "latencyMs": 143
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"mcp_server_validation"` | — |
| `sessionId` | `string` | Session identifier |
| `name` | `string` | Server name |
| `ok` | `boolean` | Validation status |
| `mode` | `"none" \| "missing" \| "api_key" \| "oauth" \| "oauth_pending" \| "error"` | Effective auth mode |
| `message` | `string` | Validation detail |
| `toolCount` | `number?` | Tools discovered on success |
| `latencyMs` | `number?` | Validation duration in milliseconds |

---

### mcp_server_auth_challenge

MCP OAuth challenge payload for browser/manual code completion.

```json
{
  "type": "mcp_server_auth_challenge",
  "sessionId": "...",
  "name": "grep",
  "challenge": {
    "method": "auto",
    "instructions": "Complete sign-in in your browser.",
    "url": "https://mcp.grep.app?...",
    "expiresAt": "2026-02-20T21:10:00.000Z"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"mcp_server_auth_challenge"` | — |
| `sessionId` | `string` | Session identifier |
| `name` | `string` | Server name |
| `challenge` | `{ method, instructions, url?, expiresAt? }` | OAuth challenge metadata |

---

### mcp_server_auth_result

Result for MCP auth operations (`mcp_server_auth_callback` / `mcp_server_auth_set_api_key`).

```json
{
  "type": "mcp_server_auth_result",
  "sessionId": "...",
  "name": "grep",
  "ok": true,
  "mode": "api_key",
  "message": "API key saved."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"mcp_server_auth_result"` | — |
| `sessionId` | `string` | Session identifier |
| `name` | `string` | Server name |
| `ok` | `boolean` | Auth operation status |
| `mode` | `"none" \| "missing" \| "api_key" \| "oauth" \| "oauth_pending" \| "error"` | Optional resulting auth mode |
| `message` | `string` | Result detail |

---

### provider_catalog

Provider catalog metadata. Sent on connection and after model changes.

```json
{
  "type": "provider_catalog",
  "sessionId": "...",
  "all": [
    { "id": "openai", "name": "OpenAI", "models": ["gpt-4o", "gpt-4o-mini"], "defaultModel": "gpt-4o" }
  ],
  "default": { "openai": "gpt-4o", "google": "gemini-2.5-pro" },
  "connected": ["openai"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"provider_catalog"` | — |
| `sessionId` | `string` | Session identifier |
| `all` | `ProviderCatalogEntry[]` | All available providers with their models |
| `default` | `Record<string, string>` | Default model per provider (includes current session's selection) |
| `connected` | `string[]` | Provider IDs that have active auth |

---

### provider_auth_methods

Auth method registry for all providers.

```json
{
  "type": "provider_auth_methods",
  "sessionId": "...",
  "methods": {
    "openai": [{ "id": "api_key", "type": "api", "label": "API Key" }],
    "codex-cli": [
      { "id": "oauth_cli", "type": "oauth", "label": "OAuth (CLI)", "oauthMode": "auto" },
      { "id": "api_key", "type": "api", "label": "API Key" }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"provider_auth_methods"` | — |
| `sessionId` | `string` | Session identifier |
| `methods` | `Record<string, ProviderAuthMethod[]>` | Auth methods keyed by provider name |

---

### provider_auth_challenge

Auth challenge payload returned after `provider_auth_authorize`.

```json
{
  "type": "provider_auth_challenge",
  "sessionId": "...",
  "provider": "codex-cli",
  "methodId": "oauth_cli",
  "challenge": {
    "method": "code",
    "instructions": "Visit the URL and paste the code.",
    "url": "https://auth.example.com/authorize?...",
    "command": null
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"provider_auth_challenge"` | — |
| `sessionId` | `string` | Session identifier |
| `provider` | `ProviderName` | Provider this challenge is for |
| `methodId` | `string` | Auth method identifier |
| `challenge` | `ProviderAuthChallenge` | Challenge details (see [ProviderAuthChallenge](#providerauthchallenge)) |

---

### provider_auth_result

Auth completion result after `provider_auth_callback` or `provider_auth_set_api_key`.

```json
{
  "type": "provider_auth_result",
  "sessionId": "...",
  "provider": "openai",
  "methodId": "api_key",
  "ok": true,
  "mode": "api_key",
  "message": "API key verified successfully."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"provider_auth_result"` | — |
| `sessionId` | `string` | Session identifier |
| `provider` | `ProviderName` | Provider |
| `methodId` | `string` | Auth method identifier |
| `ok` | `boolean` | Whether auth succeeded |
| `mode` | `"api_key" \| "oauth" \| "oauth_pending"` | Optional. Present on success |
| `message` | `string` | Human-readable result message |

---

### provider_status

Current provider connection/auth status list. Sent on connection, after auth changes, and on `refresh_provider_status`.

```json
{
  "type": "provider_status",
  "sessionId": "...",
  "providers": [
    {
      "provider": "openai",
      "authorized": true,
      "verified": true,
      "mode": "api_key",
      "account": { "email": "user@example.com" },
      "message": "Connected",
      "checkedAt": "2026-02-19T18:00:00.000Z",
      "savedApiKeyMasks": { "api_key": "sk-...xxxx" }
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"provider_status"` | — |
| `sessionId` | `string` | Session identifier |
| `providers` | `ProviderStatus[]` | Status for each provider (see [ProviderStatus](#providerstatus)) |

Notes:
- `savedApiKeyMasks` values are always masked and never include raw secret values.

---

### session_busy

Busy/idle state transitions for an agent turn with context.

```json
{ "type": "session_busy", "sessionId": "...", "busy": true, "turnId": "turn-abc", "cause": "user_message" }
```

```json
{ "type": "session_busy", "sessionId": "...", "busy": false, "turnId": "turn-abc", "outcome": "completed" }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_busy"` | — |
| `sessionId` | `string` | Session identifier |
| `busy` | `boolean` | `true` when a turn starts, `false` when it ends |
| `turnId` | `string?` | Unique turn identifier (present on both busy=true and busy=false) |
| `cause` | `"user_message" \| "command"?` | What triggered the turn (present on busy=true) |
| `outcome` | `"completed" \| "cancelled" \| "error"?` | How the turn ended (present on busy=false) |

---

### user_message

Echoed/accepted user message. Sent when a `user_message` or `execute_command` client message is processed.

```json
{ "type": "user_message", "sessionId": "...", "text": "Explain this code", "clientMessageId": "msg-1" }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"user_message"` | — |
| `sessionId` | `string` | Session identifier |
| `text` | `string` | The user message text (for `execute_command`, this is the slash command display text) |
| `clientMessageId` | `string?` | Echoed from the client message if provided |

---

### model_stream_chunk

Incremental model stream chunk. Emitted during a turn for each streaming part from the active runtime/model pipeline.

```json
{
  "type": "model_stream_chunk",
  "sessionId": "...",
  "turnId": "turn-abc",
  "index": 0,
  "provider": "openai",
  "model": "gpt-4o",
  "partType": "text_delta",
  "part": { "text": "Hello" },
  "rawPart": { ... }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"model_stream_chunk"` | — |
| `sessionId` | `string` | Session identifier |
| `turnId` | `string` | Unique turn identifier (groups all chunks for one turn). Fallback: `"unknown-turn"` |
| `index` | `number` | Sequential chunk index within the turn (starting at 0). Fallback: `-1` |
| `provider` | `ProviderName \| "unknown"` | Provider that generated this chunk. Fallback: `"unknown"` |
| `model` | `string` | Model that generated this chunk. Fallback: `"unknown"` |
| `partType` | `ModelStreamPartType` | Part type (see [ModelStreamPartType](#modelstreamparttype)) |
| `part` | `object` | Normalized part payload. Shape varies by `partType`. If a non-object part is received, it is normalized to `{ "value": <original> }` |
| `rawPart` | `unknown?` | Optional raw provider/runtime part (present when `includeRawChunks` is enabled). Default mode is sanitized; set `COWORK_MODEL_STREAM_RAW_MODE=full` to increase payload detail |

---

### assistant_message

Final assistant text for a turn. Sent after the model finishes generating.

```json
{ "type": "assistant_message", "sessionId": "...", "text": "Here is the explanation..." }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"assistant_message"` | — |
| `sessionId` | `string` | Session identifier |
| `text` | `string` | Final assistant response text |

---

### reasoning

Reasoning or summary text produced by the model during a turn.

```json
{ "type": "reasoning", "sessionId": "...", "kind": "reasoning", "text": "Let me think about..." }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"reasoning"` | — |
| `sessionId` | `string` | Session identifier |
| `kind` | `"reasoning" \| "summary"` | Whether this is reasoning (e.g. Anthropic extended thinking) or a summary (e.g. OpenAI reasoning summary) |
| `text` | `string` | Reasoning/summary text |

---

### log

Tool or runtime log line.

```json
{ "type": "log", "sessionId": "...", "line": "[tool:bash] Running: ls -la" }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"log"` | — |
| `sessionId` | `string` | Session identifier |
| `line` | `string` | Log line text |

---

### todos

Current todo state list. Sent whenever the todo list changes.

```json
{
  "type": "todos",
  "sessionId": "...",
  "todos": [
    { "content": "Fix login bug", "status": "in_progress", "activeForm": "Fixing login bug" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"todos"` | — |
| `sessionId` | `string` | Session identifier |
| `todos` | `TodoItem[]` | Full todo list (see [TodoItem](#todoitem)) |

---

### reset_done

Confirmation that a `reset` completed.

```json
{ "type": "reset_done", "sessionId": "..." }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"reset_done"` | — |
| `sessionId` | `string` | Session identifier |

---

### ask

Prompt requiring a text or option response from the user. The turn is paused until an `ask_response` is received.

```json
{
  "type": "ask",
  "sessionId": "...",
  "requestId": "req-abc",
  "question": "Which file should I modify?",
  "options": ["src/main.ts", "src/index.ts"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"ask"` | — |
| `sessionId` | `string` | Session identifier |
| `requestId` | `string` | Unique request ID. Send this back in `ask_response` |
| `question` | `string` | The question to present to the user |
| `options` | `string[]?` | Optional list of suggested options |

Client guidance:
- Use `"[skipped]"` as an explicit skip response when the user dismisses/skips.
- Do not send blank answers. Blank/whitespace `ask_response.answer` values are rejected and the same ask is re-sent.

---

### approval

Prompt requiring command approval. The turn is paused until an `approval_response` is received.

```json
{
  "type": "approval",
  "sessionId": "...",
  "requestId": "req-def",
  "command": "rm -rf /tmp/build",
  "dangerous": true,
  "reasonCode": "matches_dangerous_pattern"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"approval"` | — |
| `sessionId` | `string` | Session identifier |
| `requestId` | `string` | Unique request ID. Send this back in `approval_response` |
| `command` | `string` | The shell command requesting approval |
| `dangerous` | `boolean` | Whether the command matches dangerous patterns |
| `reasonCode` | `ApprovalRiskCode` | Why approval is needed (see [ApprovalRiskCode](#approvalriskcode)) |

---

### config_updated

Updated session public config after a `set_model` or other runtime change.

```json
{
  "type": "config_updated",
  "sessionId": "...",
  "config": {
    "provider": "openai",
    "model": "gpt-4o",
    "workingDirectory": "/path/to/project"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"config_updated"` | — |
| `sessionId` | `string` | Session identifier |
| `config` | `PublicConfig` | Updated config (same shape as `server_hello.config`) |

---

### tools

Tool metadata list response to `list_tools`.

```json
{
  "type": "tools",
  "sessionId": "...",
  "tools": [
    { "name": "bash", "description": "Execute a shell command" },
    { "name": "read", "description": "Read a file from disk" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"tools"` | — |
| `sessionId` | `string` | Session identifier |
| `tools` | `Array<{ name: string; description: string }>` | Sorted list of tools with name and first line of description. Note: MCP tools are loaded dynamically during turns and not included |

---

### commands

Command metadata list response to `list_commands`.

```json
{
  "type": "commands",
  "sessionId": "...",
  "commands": [
    { "name": "review", "description": "Run a code review", "source": "skill", "hints": ["/review"] }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"commands"` | — |
| `sessionId` | `string` | Session identifier |
| `commands` | `CommandInfo[]` | Available commands (see [CommandInfo](#commandinfo)) |

---

### skills_list

Skill metadata list response to `list_skills`. Also sent after skill enable/disable/delete operations.

```json
{
  "type": "skills_list",
  "sessionId": "...",
  "skills": [
    { "name": "commit", "path": "...", "source": "global", "enabled": true, "triggers": ["/commit"], "description": "Create a git commit" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"skills_list"` | — |
| `sessionId` | `string` | Session identifier |
| `skills` | `SkillEntry[]` | All skills including disabled ones (see [SkillEntry](#skillentry)) |

---

### skill_content

Skill content payload response to `read_skill`.

```json
{
  "type": "skill_content",
  "sessionId": "...",
  "skill": { "name": "commit", "path": "...", "source": "global", "enabled": true, "triggers": ["/commit"], "description": "..." },
  "content": "# Commit Skill\n\nCreate a git commit..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"skill_content"` | — |
| `sessionId` | `string` | Session identifier |
| `skill` | `SkillEntry` | Skill metadata (see [SkillEntry](#skillentry)) |
| `content` | `string` | Skill file content (front matter stripped) |

---

### session_backup_state

Backup/checkpoint state. Sent in response to backup operations and after automatic checkpoints.

```json
{
  "type": "session_backup_state",
  "sessionId": "...",
  "reason": "manual_checkpoint",
  "backup": {
    "status": "ready",
    "sessionId": "...",
    "workingDirectory": "/path/to/project",
    "backupDirectory": "/path/to/backup",
    "createdAt": "2026-02-19T18:00:00.000Z",
    "originalSnapshot": { "kind": "directory" },
    "checkpoints": []
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_backup_state"` | — |
| `sessionId` | `string` | Session identifier |
| `reason` | `"requested" \| "auto_checkpoint" \| "manual_checkpoint" \| "restore" \| "delete"` | What triggered this state emission |
| `backup` | `SessionBackupPublicState` | Full backup state (see [SessionBackupPublicState](#sessionbackuppublicstate)) |

---

### observability_status

Langfuse observability status. Sent on connection and when health changes.

```json
{
  "type": "observability_status",
  "sessionId": "...",
  "enabled": true,
  "health": {
    "status": "ready",
    "reason": "runtime_ready",
    "updatedAt": "2026-02-19T08:45:00.000Z"
  },
  "config": {
    "provider": "langfuse",
    "baseUrl": "https://cloud.langfuse.com",
    "otelEndpoint": "https://cloud.langfuse.com/api/public/otel/v1/traces",
    "tracingEnvironment": "dev",
    "release": "abc123",
    "hasPublicKey": true,
    "hasSecretKey": true,
    "configured": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"observability_status"` | — |
| `sessionId` | `string` | Session identifier |
| `enabled` | `boolean` | Whether observability is enabled |
| `health` | `ObservabilityHealth` | Health status (see [ObservabilityHealth](#observabilityhealth)) |
| `config` | `object \| null` | Langfuse config or `null` if not configured |

Config fields (when non-null):

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `"langfuse"` | Always `"langfuse"` |
| `baseUrl` | `string` | Langfuse base URL |
| `otelEndpoint` | `string` | OTEL traces endpoint |
| `tracingEnvironment` | `string?` | Optional environment label |
| `release` | `string?` | Optional release identifier |
| `hasPublicKey` | `boolean` | Whether a public key is configured |
| `hasSecretKey` | `boolean` | Whether a secret key is configured |
| `configured` | `boolean` | Whether both keys are present |

Notes:
- Secret values are never sent over this event.
- `health.message` is optional and present for degraded states with details.

---

### harness_context

Current harness context state for the session.

```json
{
  "type": "harness_context",
  "sessionId": "...",
  "context": {
    "runId": "run-abc-123",
    "taskId": "task-1",
    "objective": "Fix the authentication bug",
    "acceptanceCriteria": ["Login works"],
    "constraints": ["No schema changes"],
    "metadata": { "priority": "high" },
    "updatedAt": "2026-02-19T18:15:00.000Z"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"harness_context"` | — |
| `sessionId` | `string` | Session identifier |
| `context` | `(HarnessContextPayload & { updatedAt: string }) \| null` | Context with timestamp, or `null` if no context is set |

When non-null, `context` contains all [HarnessContextPayload](#harnesscontextpayload) fields plus an `updatedAt` ISO 8601 timestamp.

---

### turn_usage

Token usage data for a completed turn. Emitted after `assistant_message` when the provider returns usage data.

```json
{
  "type": "turn_usage",
  "sessionId": "...",
  "turnId": "turn-abc",
  "usage": {
    "promptTokens": 1234,
    "completionTokens": 567,
    "totalTokens": 1801
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"turn_usage"` | — |
| `sessionId` | `string` | Session identifier |
| `turnId` | `string` | Turn this usage belongs to |
| `usage.promptTokens` | `number` | Input tokens consumed |
| `usage.completionTokens` | `number` | Output tokens generated |
| `usage.totalTokens` | `number` | Total tokens |

---

### messages

Message history response to `get_messages`.

```json
{
  "type": "messages",
  "sessionId": "...",
  "messages": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi there!" }
  ],
  "total": 42,
  "offset": 0,
  "limit": 100
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"messages"` | — |
| `sessionId` | `string` | Session identifier |
| `messages` | `unknown[]` | Slice of AI SDK `ModelMessage` objects |
| `total` | `number` | Total number of messages in history |
| `offset` | `number` | Start index of this slice |
| `limit` | `number` | Requested limit |

---

### sessions

Persisted session list response to `list_sessions`.

```json
{
  "type": "sessions",
  "sessionId": "...",
  "sessions": [
    {
      "sessionId": "abc-123",
      "title": "Fix login bug",
      "provider": "openai",
      "model": "gpt-4o",
      "createdAt": "2026-02-19T18:00:00.000Z",
      "updatedAt": "2026-02-19T18:30:00.000Z",
      "messageCount": 24
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"sessions"` | — |
| `sessionId` | `string` | Session identifier |
| `sessions` | `PersistedSessionSummary[]` | List sorted by `updatedAt` descending |

**PersistedSessionSummary:**

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Session identifier |
| `title` | `string` | Session title |
| `provider` | `ProviderName` | Provider |
| `model` | `string` | Model |
| `createdAt` | `string` | ISO 8601 creation timestamp |
| `updatedAt` | `string` | ISO 8601 last update timestamp |
| `messageCount` | `number` | Number of messages in history |

---

### session_deleted

Confirmation of session deletion response to `delete_session`.

```json
{ "type": "session_deleted", "sessionId": "...", "targetSessionId": "old-session-id" }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_deleted"` | — |
| `sessionId` | `string` | Session identifier |
| `targetSessionId` | `string` | ID of the deleted session |

---

### session_config

Current runtime config. Sent on connection and after `set_config`.

```json
{
  "type": "session_config",
  "sessionId": "...",
  "config": {
    "yolo": false,
    "observabilityEnabled": true,
    "subAgentModel": "gpt-4o-mini",
    "maxSteps": 100
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_config"` | — |
| `sessionId` | `string` | Session identifier |
| `config.yolo` | `boolean` | Whether all commands are auto-approved |
| `config.observabilityEnabled` | `boolean` | Whether observability is enabled |
| `config.subAgentModel` | `string` | Sub-agent model identifier |
| `config.maxSteps` | `number` | Maximum steps per turn |

---

### file_uploaded

File upload confirmation response to `upload_file`.

```json
{ "type": "file_uploaded", "sessionId": "...", "filename": "image.png", "path": "/path/to/uploads/image.png" }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"file_uploaded"` | — |
| `sessionId` | `string` | Session identifier |
| `filename` | `string` | Sanitized filename |
| `path` | `string` | Absolute path where the file was written |

---

### error

Structured error event. Can be emitted in response to any client message or during a turn.

```json
{
  "type": "error",
  "sessionId": "...",
  "message": "Agent is busy",
  "code": "busy",
  "source": "session"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"error"` | — |
| `sessionId` | `string` | Session identifier |
| `message` | `string` | Human-readable error description |
| `code` | `ServerErrorCode` | Machine-readable error code (see [ServerErrorCode](#servererrorcode)) |
| `source` | `ServerErrorSource` | Error origin (see [ServerErrorSource](#servererrorsource)) |

---

### pong

Keepalive pong in response to `ping`.

```json
{ "type": "pong", "sessionId": "..." }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"pong"` | — |
| `sessionId` | `string` | Session identifier |
