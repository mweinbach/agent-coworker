# WebSocket Protocol Reference

Canonical JSON-RPC protocol contract for `agent-coworker` WebSocket clients.

Cowork supports one live WebSocket protocol on `/ws`: JSON-RPC-lite. The canonical subprotocol is `cowork.jsonrpc.v1`; clients may also omit the subprotocol and still speak JSON-RPC-lite on the socket. Existing persisted desktop workspaces are normalized to `jsonrpc` on load.

## Connection

- URL: `ws://127.0.0.1:{port}/ws`
- Session resume: `?resumeSessionId=<sessionId>`
- Current protocol version: `7.30`
- WebSocket protocol mode: `jsonrpc`

## Protocol negotiation

Cowork negotiates JSON-RPC only. When multiple subprotocols are offered, the server selects `cowork.jsonrpc.v1` if present and rejects any unsupported subprotocol list that does not include it. The `?protocol=` query parameter and server-side protocol default override have been removed.

### Supported WebSocket subprotocol

- `cowork.jsonrpc.v1`

### Example: implicit JSON-RPC mode

```ts
const ws = new WebSocket("ws://127.0.0.1:7337/ws");
```

### Example: JSON-RPC subprotocol

```ts
const ws = new WebSocket("ws://127.0.0.1:7337/ws", "cowork.jsonrpc.v1");
```

## JSON-RPC-lite overview

The JSON-RPC mode follows the Codex-style wire shape:

- request: `{ "id": 1, "method": "thread/start", "params": { ... } }`
- response: `{ "id": 1, "result": { ... } }`
- error: `{ "id": 1, "error": { "code": -32601, "message": "..." } }`
- notification: `{ "method": "turn/started", "params": { ... } }`
- server request: `{ "id": "req-123", "method": "item/commandExecution/requestApproval", "params": { ... } }`

`"jsonrpc": "2.0"` is intentionally omitted on the wire. Each WebSocket text frame carries exactly one JSON-RPC-lite message.

### JSON-RPC handshake

JSON-RPC connections do **not** receive an immediate `server_hello`.

Clients must:

1. send `initialize`
2. wait for the `initialize` result
3. send the `initialized` notification
4. only then call `thread/*`, `turn/*`, or `cowork/*` methods

Any request before the handshake completes is rejected with a JSON-RPC error:

```json
{ "id": 1, "error": { "code": -32002, "message": "Not initialized" } }
```

### JSON-RPC capabilities

`initialize.params.capabilities` currently supports:

- `experimentalApi: boolean` (reserved compatibility field; server currently returns `true` regardless of this input)
- `optOutNotificationMethods: string[]`

### Core JSON-RPC methods currently available

- `thread/start`
- `thread/resume`
- `thread/list`
- `thread/read`
- `thread/unsubscribe`
- `thread/hydrate`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `cowork/workspace/bootstrap`

`turn/start` and `turn/steer` also accept an optional `clientMessageId` string so JSON-RPC clients can correlate optimistic user UI state with the projected `user_message` notification stream.

#### File attachments in `turn/start` and `turn/steer`

The `input` array accepts three part types:

- `{ "type": "text", "text": "..." }` — a text message part
- `{ "type": "file", "filename": "image.png", "contentBase64": "iVBORw0KGgo...", "mimeType": "image/png" }` — an inline file attachment
- `{ "type": "uploadedFile", "filename": "large-video.mov", "path": "/workspace/User Uploads/large-video.mov", "mimeType": "video/quicktime" }` — a previously uploaded file reference

Inline `file` parts are capped at about `25MB` of decoded file content each, with a combined inline budget of about `25MB` per turn. All file attachments are surfaced to the model as hidden system notes containing the saved path in the workspace uploads directory.

For inline `file` parts, models that support multimodal input (`supportsImageInput: true`) also receive image bytes directly. Google/Gemini sessions additionally receive inline audio, video, and PDF bytes when those parts are sent as inline `file` attachments. `uploadedFile` parts are path-only references and are not inlined into the provider payload.

Use `cowork/session/file/upload` first when a file is too large for inline transport or when the client wants to avoid sending multimodal bytes inline.

Example request with an inline file attachment:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "turn/start",
  "params": {
    "threadId": "abc-123",
    "input": [
      { "type": "text", "text": "What's in this image?" },
      { "type": "file", "filename": "photo.jpg", "contentBase64": "...", "mimeType": "image/jpeg" }
    ]
  }
}
```

Example request with a previously uploaded file path:

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "turn/start",
  "params": {
    "threadId": "abc-123",
    "input": [
      { "type": "text", "text": "Analyze this large capture." },
      {
        "type": "uploadedFile",
        "filename": "capture.mov",
        "path": "/workspace/User Uploads/capture.mov",
        "mimeType": "video/quicktime"
      }
    ]
  }
}
```

### Cowork JSON-RPC control namespace

Cowork also exposes a workspace-scoped control namespace over the same JSON-RPC connection. Some methods return typed session event payloads inside `{ "event": ... }` or `{ "events": [...] }` so clients can share reducers for control state and live notifications.

Currently implemented `cowork/*` methods include:

- session/thread controls
  - `cowork/session/title/set`
  - `cowork/session/state/read`
  - `cowork/session/model/set`
  - `cowork/session/usageBudget/set`
  - `cowork/session/config/set`
  - `cowork/session/harnessContext/get`
  - `cowork/session/harnessContext/set`
  - `cowork/session/defaults/apply`
  - `cowork/session/file/upload`
  - `cowork/session/delete`
  - `cowork/session/agent/inspect`
  - `cowork/session/a2ui/action`
- provider controls
  - `cowork/provider/catalog/read`
  - `cowork/provider/authMethods/read`
  - `cowork/provider/status/refresh`
  - `cowork/provider/auth/authorize`
  - `cowork/provider/auth/logout`
  - `cowork/provider/auth/callback`
  - `cowork/provider/auth/setApiKey`
  - `cowork/provider/auth/copyApiKey`
- MCP controls
  - `cowork/mcp/servers/read`
  - `cowork/mcp/server/upsert`
  - `cowork/mcp/server/delete`
  - `cowork/mcp/server/validate`
  - `cowork/mcp/server/auth/authorize`
  - `cowork/mcp/server/auth/callback`
  - `cowork/mcp/server/auth/setApiKey`
  - `cowork/mcp/legacy/migrate`
- skills controls
  - `cowork/skills/catalog/read`
  - `cowork/skills/list`
  - `cowork/skills/read`
  - `cowork/skills/disable`
  - `cowork/skills/enable`
  - `cowork/skills/delete`
  - `cowork/skills/installation/read`
  - `cowork/skills/install/preview`
  - `cowork/skills/install`
  - `cowork/skills/installation/enable`
  - `cowork/skills/installation/disable`
  - `cowork/skills/installation/delete`
  - `cowork/skills/installation/update`
  - `cowork/skills/installation/copy`
  - `cowork/skills/installation/checkUpdate`
- plugin controls
  - `cowork/plugins/catalog/read`
  - `cowork/plugins/read`
  - `cowork/plugins/install/preview`
  - `cowork/plugins/install`
  - `cowork/plugins/enable`
  - `cowork/plugins/disable`
- memory controls
  - `cowork/memory/list`
  - `cowork/memory/upsert`
  - `cowork/memory/delete`
- workspace backup controls
  - `cowork/backups/workspace/read`
  - `cowork/backups/workspace/delta/read`
  - `cowork/backups/workspace/checkpoint`
  - `cowork/backups/workspace/restore`
  - `cowork/backups/workspace/deleteCheckpoint`
  - `cowork/backups/workspace/deleteEntry`

The desktop JSON-RPC path now uses this namespace so one workspace connection can drive:

- thread lifecycle
- message turns
- approvals / asks
- provider panels
- plugin catalog + detail
- skills management
- MCP management
- memories

`cowork/plugins/read`, `cowork/plugins/enable`, and `cowork/plugins/disable` accept an optional `scope` field (`workspace` or `user`) so callers can address a specific installed copy when the same plugin id exists in both scopes.
- workspace backups

`thread/list` and workspace-scoped `cowork/*` control methods now default omitted `cwd` to the sidecar/server working directory. Mobile and other remote clients no longer need to know a host filesystem path just to list threads or read workspace control state.

`cowork/session/state/read` returns the current workspace control session state as a bundle of `config_updated`, `session_settings`, and `session_config` session events so JSON-RPC clients can hydrate provider/model defaults before diffing local settings.

`cowork/session/defaults/apply` remains the composite "apply provider/model, editable defaults, and MCP enablement" write. Supplying only `cwd` targets the workspace control session; supplying `threadId` as well applies the same composite write directly to that loaded thread session.

`cowork/session/file/upload` writes a file into the workspace uploads directory and returns a `file_uploaded` session event envelope. JSON-RPC clients can then reference that saved file from `turn/start` or `turn/steer` with an `uploadedFile` input part when the file is too large to send inline.

`cowork/session/agent/inspect` is a thread-scoped, root-only read for child agents. It returns the same detailed inspection payload as the root `inspectAgent` tool: the latest child summary, the full latest assistant text, a parsed structured child report when the final assistant text includes a recognized JSON footer, and compact session/last-turn usage snapshots for the child.

### Research JSON-RPC methods

Research traffic is scoped to the active workspace and separate from chat threads. The desktop `Research` tab reaches the service through that workspace's JSON-RPC connection. Export artifacts and staged uploads live under `~/.cowork/research/*`; canonical metadata rows live in the shared SQLite database with a workspace discriminator.

Requests:

- `research/start`
  - params: `{ input, title?, settings?, attachedFileIds? }`
  - result: `{ research }`
  - starts a new Deep Research interaction and begins background streaming
- `research/list`
  - params: `{}`
  - result: `{ research: ResearchRecord[] }`
  - lists persisted research rows for the active workspace ordered by `updatedAt DESC`
- `research/get`
  - params: `{ researchId }`
  - result: `{ research: ResearchRecord | null }`
- `research/cancel`
  - params: `{ researchId }`
  - result: `{ research: ResearchRecord | null }`
  - best-effort cancels the upstream Google interaction, then marks the local row `cancelled`
- `research/rename`
  - params: `{ researchId, title }`
  - result: `{ research: ResearchRecord | null }`
  - updates the stored `title` on a research row, persists, and broadcasts `research/updated`
- `research/followup`
  - params: `{ parentResearchId, input, title?, settings?, attachedFileIds? }`
  - result: `{ research }`
  - starts a child research row using `previous_interaction_id`
- `research/uploadFile`
  - params: `{ filename, mimeType, contentBase64 }`
  - result: `{ file }`
  - stages a pending upload under `~/.cowork/research/uploads`; payloads are capped at 20 MiB decoded size
- `research/discardUploads`
  - params: `{ fileIds }`
  - result: `{ status: "discarded" }`
  - best-effort deletes staged uploads that were never consumed by `research/start` or `research/followup`
- `research/attachFile`
  - params: `{ researchId, fileId }`
  - result: `{ research: ResearchRecord | null }`
  - attaches a previously staged upload to an existing row
- `research/subscribe`
  - params: `{ researchId, afterEventId? }`
  - result: `{ research: ResearchRecord | null }`
  - registers the socket for live `research/*` notifications and optionally replays buffered notifications after `afterEventId`
- `research/unsubscribe`
  - params: `{ researchId }`
  - result: `{ status: "unsubscribed" }`
- `research/export`
  - params: `{ researchId, format: "markdown" | "pdf" | "docx" }`
  - result: `{ path, sizeBytes }`
  - writes `report.md`, `report.pdf`, or `report.docx` under `~/.cowork/research/<id>/`

`ResearchRecord` currently persists:

- `id`
- `workspacePath`
- `parentResearchId`
- `title`
- `prompt`
- `status` (`pending | running | completed | cancelled | failed`)
- `interactionId`
- `lastEventId`
- `inputs` (`fileSearchStoreName?`, attached files)
- `settings` including plan-approval preference
- `outputsMarkdown`
- `thoughtSummaries`
- `sources`
- `createdAt`
- `updatedAt`
- `error`

Current Google Deep Research wiring notes:

- `background: true` is always used
- `google_search` and `url_context` remain effectively always on
- attached files are forwarded through `file_search`

### Research notifications

Sockets subscribed with `research/subscribe` can receive:

- `research/updated`
  - params: `{ research }`
  - emitted for lifecycle/status/input changes
- `research/textDelta`
  - params: `{ researchId, delta, eventId? }`
  - append-only markdown stream
- `research/thoughtDelta`
  - params: `{ researchId, thought, eventId? }`
  - thought summaries extracted from Deep Research events
- `research/sourceFound`
  - params: `{ researchId, source, eventId? }`
  - deduped citations discovered in text/file/place annotations
- `research/completed`
  - params: `{ researchId, research }`
- `research/failed`
  - params: `{ researchId, status: "failed" | "cancelled", error }`

`cowork/session/a2ui/action` forwards a user interaction on an A2UI surface (Phase 2) to the running agent. Clients dispatch it when a user clicks a `Button`, submits a `TextField`, or toggles a `Checkbox` inside an A2UI surface.

Request params:

```ts
{
  threadId: string;
  surfaceId: string;
  componentId: string;
  eventType: string;            // e.g. "click", "submit", "change"
  payload?: Record<string, unknown>;
  clientMessageId?: string;
}
```

The harness validates that the surface exists, is not deleted, and contains `componentId`. If validation fails the server replies with a JSON-RPC invalidParams error. On success the harness synthesizes a structured user message and delivers it:

- If a turn is already running, the action is delivered as a steer against that turn, and the result carries `delivery: "delivered-as-steer"` and the active `turnId`.
- Otherwise, the harness starts a new turn carrying the action text as the user message, and the result carries `delivery: "delivered-as-turn"` and the new `turnId`.

The synthesized text is deterministic and human-readable (starts with `[a2ui.action] The user interacted with surface "<id>".`) so the agent can respond with further `a2ui` tool calls or plain text.

### Core JSON-RPC notifications currently available

- `thread/started`
- `turn/started`
- `item/started`
- `item/reasoning/delta`
- `item/agentMessage/delta`
- `item/completed`
- `turn/completed`
- `serverRequest/resolved`
- `cowork/session/settings`
- `cowork/session/info`
- `cowork/session/configUpdated`
- `cowork/session/config`
- `cowork/session/usage`
- `cowork/session/steerAccepted`
- `cowork/session/turnUsage`
- `cowork/session/budgetWarning`
- `cowork/session/budgetExceeded`
- `cowork/session/agentList`
- `cowork/session/agentSpawned`
- `cowork/session/agentStatus`
- `cowork/session/agentWaitResult`

### Server-initiated JSON-RPC requests currently available

- `item/tool/requestUserInput`
- `item/commandExecution/requestApproval`

### JSON-RPC replay and read model

- `thread/list` now returns `messageCount` and `lastEventSeq` on every thread summary
- `thread/read.coworkSnapshot` is the authoritative projected-feed hydration payload for UI clients and matches live `turn/*` + `item/*` ordering
- `thread/read` can return a journal-projected `turns` array when `includeTurns: true`
- `thread/hydrate` returns the same payload as `thread/read` (thread summary, turns, and snapshot) without subscribing the client to live thread events. Optional `afterSeq` skips journal events up to and including that cursor when building the `turns` array (useful for pull-based catchup); `journalTailSeq` is returned when `includeTurns: true` so callers can advance the cursor. Ideal for lightweight previews.
- `thread/resume` accepts `afterSeq` to replay journaled notifications after a known cursor, then reattaches the live thread sink so reconnecting clients do not receive the same journaled events twice
- `cowork/workspace/bootstrap` returns persisted and live threads for a workspace plus workspace control state; used by desktop/mobile clients on initial load
- Cowork persists canonical thread journal events in sqlite so reconnect / restart replay is no longer limited to an in-memory socket buffer

### Projected Conversation Contract

Harness-projected conversation items are now the only supported UI rendering contract for live chat and hydration:

- live updates: `turn/*` + `item/*`
- hydration: `thread/read.coworkSnapshot`

UI clients should render chat from projected items and should not depend on provider-specific session event payloads such as `model_stream_*`, `assistant_message`, or `reasoning` for chat presentation.

`item/started` and `item/completed` carry a discriminated `item` union. `turnId` is nullable so the harness can project feed items that are not owned by a model turn.

Projected item kinds:

- `userMessage`
- `agentMessage`
- `reasoning`
- `toolCall`
- `system`
- `log`
- `todos`
- `error`

Non-turn feed items such as `system`, `log`, `todos`, and `error` are emitted with `turnId: null`.

Ask/approval prompts still arrive as server requests, but the harness also emits matching projected `system` feed items so snapshots and live feeds stay aligned.

`item/completed` should be treated as the latest snapshot for that projected item id. For long-lived items, especially `toolCall`, the harness may emit multiple `item/completed` notifications for the same id as the projected state advances.

### JSON-RPC overload behavior

Cowork reserves JSON-RPC error code `-32001` for bounded-queue overload handling:

```json
{ "id": 42, "error": { "code": -32001, "message": "Server overloaded; retry later." } }
```

Clients should treat this as retryable and use backoff with jitter.

## JSON-RPC method and notification reference

The remainder of this document describes the JSON-RPC method and notification payloads.

## Contents

- [Connection](#connection)
- [Protocol negotiation](#protocol-negotiation)
- [JSON-RPC-lite overview](#json-rpc-lite-overview)
- [Cowork JSON-RPC control namespace](#cowork-json-rpc-control-namespace)
- [Projected Conversation Contract](#projected-conversation-contract)
- [JSON-RPC method and notification reference](#json-rpc-method-and-notification-reference)
- [Shared Types](#shared-types)
- [Session event payload shapes](#session-event-payload-shapes)

## Protocol v7 Notes

Changes in `7.28`:

- New client message: `apply_session_defaults`.
- Clients can now apply provider/model, editable session defaults, and MCP enablement in one composite write instead of replaying `set_model`, `set_config`, and `set_enable_mcp` separately.
- The harness now serializes session-db bootstrap and write mutations across processes so desktop and CLI instances can safely share the same per-user SQLite database.

Changes in `7.30`:

- `agent_wait` now accepts optional `mode: "any" | "all"`. Omitted mode defaults to `"any"`.
- `agent_wait_result` now includes the resolved `mode`, always returns the latest known child status snapshot for every requested id, and includes `readyAgentIds` for the terminal subset even on timeout.

Changes in `7.29`:

- `thread/list`, `thread/start`, `thread/resume`, and `thread/read` thread payloads now include `messageCount` and `lastEventSeq` directly on the wire.
- Desktop clients should treat the thread list payload as authoritative for list badges and counters instead of backfilling from renderer cache.

Changes in `7.27`:

- `skills_catalog` may now include `clearedMutationPendingKeys` so clients can clear only the mutation spinners completed by that catalog refresh.

Changes in `7.26`:

- Added installation-based skills catalog messages/events for desktop skill management:
  - client: `skills_catalog_get`, `skill_installation_get`, `skill_install_preview`, `skill_install`, `skill_installation_enable`, `skill_installation_disable`, `skill_installation_delete`, `skill_installation_copy`, `skill_installation_check_update`, `skill_installation_update`
  - server: `skills_catalog`, `skill_installation`, `skill_install_preview`, `skill_installation_update_check`
- Legacy `list_skills`, `read_skill`, `disable_skill`, `enable_skill`, and `delete_skill` remain supported for backward compatibility.
- Skill mutations are now installation-based and are blocked while any live session in the same workspace is running.

Changes in `7.25`:

- New client message: `get_session_snapshot`.
- New server event: `session_snapshot`.
- `list_sessions` now accepts optional `scope: "all" | "workspace"`; `"workspace"` filters persisted root sessions to the requester session's current `workingDirectory`.
- Harness-owned session snapshots are now the authoritative desktop/thread hydration source. Renderer-local caches are warm-start only; `.cowork` plus websocket APIs remain canonical.

Changes in `7.24`:

- `set_config.config.providerOptions.google.thinkingConfig.thinkingLevel` and `session_config.config.providerOptions.google.thinkingConfig.thinkingLevel` now support model-specific Gemini reasoning effort overrides. Omitting `thinkingLevel` keeps Gemini on its dynamic default.

Changes in `7.23`:

- `set_config.config.providerOptions.google` and `session_config.config.providerOptions.google` now support `nativeWebSearch`.
- Enabling `providerOptions.google.nativeWebSearch` switches Google/Gemini sessions to the Interactions API built-in `google_search` + `url_context` tools in place of the local `webSearch` and `webFetch` tools.

Changes in `7.22`:

- Added `lmstudio` as a first-class dynamic local provider.
- `provider_catalog` entries may now include optional provider-level `state` (`"ready" | "empty" | "unreachable"`) and `message` fields for dynamic providers such as LM Studio.
- `set_config.config.providerOptions.lmstudio` and `session_config.config.providerOptions.lmstudio` now support `baseUrl`, `contextLength`, `autoLoad`, and `reloadOnContextMismatch`.

Changes in `7.21`:

- `set_config.config.providerOptions.codex-cli` and `session_config.config.providerOptions.codex-cli` now support `webSearchBackend: "native" | "exa"` so Codex workspaces can deliberately choose between built-in Responses web search and the local Exa tool. Native is the default when the field is omitted.

Changes in `7.20`:

- `set_config.config.providerOptions.codex-cli` and `session_config.config.providerOptions.codex-cli` now support native web-search fields: `webSearchMode`, `webSearch.contextSize`, `webSearch.allowedDomains`, and `webSearch.location`.
- `model_stream_raw` may now carry OpenAI Responses `web_search_call` items so clients can synthesize native web-search activity alongside normalized stream chunks.

Changes in `7.19`:

- New client message: `steer_message`, which targets the active turn by `expectedTurnId` and buffers steering until the next safe model-step boundary.
- New server event: `steer_accepted`, emitted when a steer is accepted for the current active turn.
- Resumed `server_hello` now includes `turnId` when the session is still busy so reconnecting clients can steer safely without waiting for a fresh `session_busy`.

Changes in `7.18`:

- `agent_wait` now completes with an explicit `agent_wait_result` event so websocket clients can distinguish timeout from terminal child completion without inferring it from `agent_status`.
- `server_hello` now includes the documented child-session metadata already exposed via `session_info`, including mode, depth, requested/effective model and reasoning fields, execution state, and the latest assistant preview when available.

Changes in `7.17`:

- Child-agent routing now supports canonical `provider:modelId` refs for explicit cross-provider child targets.
- `set_config` / `session_config` now expose `childModelRoutingMode`, `preferredChildModelRef`, and `allowedChildModelRefs` for workspace-scoped child routing policy.

Changes in `7.16`:

- Child-agent websocket control is now fully normalized around `agent_*` messages and `agent_spawned` / `agent_list` / `agent_status` events.
- Child sessions now report `sessionKind: "agent"` plus role, mode, depth, effective model, and effective reasoning metadata in `server_hello` and `session_info`.
- `preferredChildModel` remains as legacy same-provider fallback state; `preferredChildModelRef` is the canonical child target reference field, especially for cross-provider routing.

Changes in `7.15`:

- `set_config.config` now accepts `clearToolOutputOverflowChars: true` to remove a persisted workspace overflow override and resume inheriting the built-in or user-level default.
- `clearToolOutputOverflowChars` is mutually exclusive with `toolOutputOverflowChars`; use `null` to disable spill files explicitly and the clear flag to inherit again.

Changes in `7.14`:

- `session_config.config` now includes optional `defaultToolOutputOverflowChars`, the persisted workspace overflow default when one is explicitly configured.
- Clients should use `defaultToolOutputOverflowChars` as the source of truth for future sessions; `toolOutputOverflowChars` remains the live effective spill threshold and may reflect the built-in default even when no workspace override exists.

Changes in `7.13`:

- `set_config.config` now accepts `toolOutputOverflowChars` as a workspace-scoped overflow spill threshold, and `null` disables spill files. This threshold controls when spilling starts; it does not change the fixed inline preview length.
- `session_config.config` now reports the effective `toolOutputOverflowChars` value for the live session.

Changes in `7.12`:

- New client message: `provider_auth_copy_api_key`.
- Added `opencode-zen` as a first-class provider alongside `opencode-go`.

Changes in `7.11`:

- `session_config.config` now includes `defaultBackupsEnabled`, the harness-persisted workspace backup default, alongside the live effective `backupsEnabled` value.
- Desktop and other clients should treat `defaultBackupsEnabled` as the source of truth for future sessions instead of inferring workspace defaults from a live session override.

Changes in `7.10`:

- `set_config.config` now accepts `backupsEnabled`, and `session_config.config` now reports the effective live-session backup toggle.
- New client message: `workspace_backup_delete_entry`.
- `session_backup_state.backup.status` now includes `"disabled"` when session backups are turned off.
- Backup checkpoints now seed the session-start snapshot as `cp-0001` with `trigger: "initial"`.

Changes in `7.9`:

- New client message: `workspace_backup_delta_get`.
- New server event: `workspace_backup_delta`.
- Desktop/admin clients can now request on-demand changed-file previews for a selected backup checkpoint without replaying session-scoped backup events.

Changes in `7.8`:

- New client messages: `workspace_backups_get`, `workspace_backup_checkpoint`, `workspace_backup_restore`, `workspace_backup_delete_checkpoint`.
- New server event: `workspace_backups`.
- Desktop/admin clients can now inspect and manage all backups for the current workspace, including closed and orphaned sessions.

Changes in `7.7`:

- New server events: `budget_warning`, `budget_exceeded`.
- Session usage events now have dedicated budget-threshold alerts in addition to the aggregate `session_usage` snapshot.

Changes in `7.6`:

- New client message: `set_session_usage_budget`.
- Over-budget sessions can now raise or clear usage thresholds without starting another model turn.

Changes in `7.5`:

- New server event: `model_stream_raw`.
- `model_stream_chunk` now includes optional `normalizerVersion` metadata so clients can decide whether to trust persisted normalization or replay provider raw events.

Changes in `7.4`:

- New client message: `provider_auth_logout`.
- Provider auth results may now report logout completions with `methodId: "logout"`.

Changes in `7.3`:

- New client messages: `agent_spawn`, `agent_list_get`, `agent_input_send`, `agent_wait`, `agent_resume`, `agent_close`.
- New server events: `agent_spawned`, `agent_list`, `agent_status`.
- `server_hello` and `session_info` can now identify child sessions via `sessionKind`, `parentSessionId`, `role`, `mode`, `depth`, and effective model/reasoning metadata.
- `list_sessions` remains root-only; child agents are managed through the dedicated `agent_*` controls.

- Added session-level cost tracking support.
- New client message: `get_session_usage`.
- New server event: `session_usage`.

Changes in `7.2`:

- OpenAI-compatible editable `providerOptions` now also include `reasoningSummary` for `openai` and `codex-cli`.

Changes in `7.1`:

- `set_config.config` now accepts editable OpenAI-compatible `providerOptions` for `openai`, `codex-cli`, and `lmstudio`.
- `session_config.config` now includes the same normalized OpenAI-compatible `providerOptions` subset when configured.
- OpenAI API and Codex CLI provider defaults now use `gpt-5.4`.

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

JSON-RPC clients connect to `ws://<host>:<port>/ws`, optionally with the `cowork.jsonrpc.v1` subprotocol. The server does not send an unsolicited hello frame.

1. Client sends `initialize`.
2. Server replies with `initialize.result`, including `protocolVersion`, `serverInfo`, capabilities, and `{ type: "websocket", protocolMode: "jsonrpc" }`.
3. Client sends the `initialized` notification.
4. Client calls `thread/start`, `thread/resume`, `thread/list`, `thread/read`, `turn/start`, `turn/steer`, `turn/interrupt`, `research/*`, or `cowork/*` methods.
5. Server streams canonical JSON-RPC notifications such as `thread/started`, `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, and `turn/completed`.
6. Ask/approval prompts are server-initiated JSON-RPC requests (`item/tool/requestUserInput`, `item/commandExecution/requestApproval`); clients answer with JSON-RPC responses using the same request id.

To resume a thread, call `thread/resume` with `threadId` and optional `afterSeq`. Cold and warm resume both use the same JSON-RPC method.

### Thread Identity Migration (Desktop UI)

The desktop UI can create draft threads with local IDs before the first JSON-RPC `thread/start` call. Once `thread/start` returns the canonical thread id, the desktop client migrates the local record to that id while retaining `legacyTranscriptId` only for on-disk transcript lookup during desktop state migration.

## Validation Rules

All JSON-RPC messages are validated before dispatch:

1. Must be valid JSON. Error: `"Invalid JSON"`
2. Must be a plain object. Error: `"Expected object"`
3. Requests must include an `id` and non-empty `method`; notifications must include a non-empty `method`.
4. Request params are validated by the relevant schema for that method.

**Non-empty string** means `typeof v === "string" && v.trim().length > 0`. Whitespace-only strings are rejected.

Validation failures produce JSON-RPC error responses.

JSON-RPC notifications and method results can also be validated client-side with the generated schema artifacts in `docs/generated/`. If a received notification fails validation, clients should ignore/drop that notification rather than treating it as a protocol-level fatal error. Clients may optionally surface diagnostics without changing runtime behavior.

## Shared Types

Types referenced across multiple messages.

### ProviderName

```
"google" | "openai" | "anthropic" | "bedrock" | "baseten" | "together" | "fireworks" | "nvidia" | "lmstudio" | "opencode-go" | "opencode-zen" | "codex-cli"
```

### PublicConfig

Returned in `server_hello` and `config_updated`:

```json
{
  "provider": "openai",
  "model": "opencode-zen:glm-5",
  "workingDirectory": "/path/to/project"
}
```

`outputDirectory` is optional and only present when explicitly configured.

### ProviderCatalogEntry

```json
{
  "id": "lmstudio",
  "name": "LM Studio",
  "models": [
    {
      "id": "local/qwen-2.5",
      "displayName": "Qwen 2.5 Local",
      "knowledgeCutoff": "Unknown",
      "supportsImageInput": false
    }
  ],
  "defaultModel": "local/qwen-2.5",
  "state": "ready",
  "message": "LM Studio server reachable at http://localhost:1234."
}
```

### ProviderAuthMethod

```json
{
  "id": "api_key",
  "type": "api",
  "label": "API Key",
  "oauthMode": null,
  "fields": [
    { "id": "apiKey", "label": "API key", "kind": "password", "required": true, "secret": true }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Method identifier (e.g. `"api_key"`, `"oauth_cli"`, `"exa_api_key"`) |
| `type` | `"api" \| "oauth"` | Auth method category |
| `label` | `string` | Human-readable label |
| `oauthMode` | `"auto" \| "code"` | Optional. Only present for OAuth methods |
| `fields` | `Array<{ id, label, kind, required?, secret?, placeholder? }>?` | Optional structured credential fields for non-OAuth methods |

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
  "methodId": "api_key",
  "savedApiKeyMasks": { "api_key": "sk-...xxxx" },
  "savedFieldMasks": { "region": "us-west-2" },
  "usage": {
    "planType": "pro",
    "accountId": "acct-123",
    "rateLimits": [
      {
        "limitId": "codex",
        "allowed": true,
        "limitReached": false,
        "primaryWindow": {
          "usedPercent": 4,
          "windowSeconds": 18000,
          "resetAfterSeconds": 13097,
          "resetAt": "2026-03-08T03:01:24.000Z"
        }
      }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `ProviderName` | Provider identifier |
| `authorized` | `boolean` | Whether the provider is immediately usable. For local providers like LM Studio this can be `true` based on reachability rather than stored auth |
| `verified` | `boolean` | Whether credentials have been verified working |
| `mode` | `"missing" \| "error" \| "api_key" \| "oauth" \| "oauth_pending" \| "local" \| "credentials"` | Current auth/connection mode |
| `account` | `{ email?: string, name?: string } \| null` | Account info if available |
| `message` | `string` | Human-readable status message |
| `checkedAt` | `string` | ISO 8601 timestamp of last check |
| `methodId` | `string?` | Optional active auth/config method identifier |
| `savedApiKeyMasks` | `Record<string, string>?` | Optional masked key values keyed by method id. Never includes raw secrets |
| `savedFieldMasks` | `Record<string, string>?` | Optional masked saved structured credential values keyed by field id |
| `usage` | `{ planType?: string, accountId?: string, email?: string, rateLimits: ProviderRateLimitSnapshot[] }?` | Optional backend usage snapshot data, currently populated for Codex OAuth verification |
| `tokenRecoverable` | `boolean?` | When `authorized` is `false`, indicates the token is expired but a refresh token exists. Clients should avoid persisting a "not connected" state when this is `true`, since the next refresh attempt may succeed |

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

### SkillInstallationEntry

```json
{
  "installationId": "0ed1f33e-...",
  "name": "commit",
  "description": "Create a git commit",
  "scope": "global",
  "enabled": true,
  "writable": true,
  "managed": true,
  "effective": true,
  "state": "effective",
  "rootDir": "/home/user/.cowork/skills/commit",
  "skillPath": "/home/user/.cowork/skills/commit/SKILL.md",
  "path": "/home/user/.cowork/skills/commit/SKILL.md",
  "triggers": ["/commit"],
  "descriptionSource": "frontmatter",
  "diagnostics": [],
  "origin": { "kind": "github", "repo": "openai/skills", "ref": "main", "subdir": "skills/commit" }
}
```

Represents one concrete installed copy on disk. Unlike `SkillEntry`, this does **not** dedupe shadowed or disabled copies away.

### SkillCatalogSnapshot

```json
{
  "scopes": [
    { "scope": "project", "skillsDir": "/workspace/.agent/skills", "disabledSkillsDir": "/workspace/.agent/disabled-skills", "writable": true, "readable": true }
  ],
  "effectiveSkills": ["...SkillInstallationEntry"],
  "installations": ["...SkillInstallationEntry"]
}
```

Contains both:

- `effectiveSkills`: the actual enabled, precedence-resolved skill set the runtime will use
- `installations`: every discovered installation copy, including shadowed and disabled ones

### SkillInstallPreview

```json
{
  "source": { "kind": "github_repo", "raw": "openai/skills", "displaySource": "https://github.com/openai/skills", "repo": "openai/skills" },
  "targetScope": "project",
  "candidates": [
    {
      "name": "commit",
      "description": "Create a git commit",
      "relativeRootPath": "skills/commit",
      "wouldBeEffective": true,
      "shadowedInstallationIds": [],
      "diagnostics": []
    }
  ],
  "warnings": []
}
```

Install preview built from a pasted source input before any mutation occurs.

### SkillUpdateCheckResult

```json
{
  "installationId": "0ed1f33e-...",
  "canUpdate": true,
  "preview": { "...": "SkillInstallPreview" }
}
```

Represents whether a managed installation can be refreshed from its recorded origin and, when possible, includes the update preview.

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
      "index": 1,
      "createdAt": "2026-02-19T18:00:00.000Z",
      "trigger": "initial",
      "changed": false,
      "patchBytes": 0
    }
  ],
  "failureReason": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"initializing" \| "ready" \| "disabled" \| "failed"` | Backup system status |
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
| `trigger` | `"initial" \| "auto" \| "manual"` | What triggered this checkpoint |
| `changed` | `boolean` | Whether files changed since last checkpoint |
| `patchBytes` | `number` | Size of the patch data |

### WorkspaceBackupPublicEntry

```json
{
  "targetSessionId": "abc-123",
  "title": "Fix auth flow",
  "provider": "openai",
  "model": "gpt-5.2",
  "lifecycle": "closed",
  "status": "ready",
  "workingDirectory": "/path/to/project",
  "backupDirectory": "/path/to/backup",
  "originalSnapshotKind": "directory",
  "originalSnapshotBytes": 8192,
  "checkpointBytesTotal": 4096,
  "totalBytes": 12288,
  "checkpoints": [],
  "createdAt": "2026-02-19T18:00:00.000Z",
  "updatedAt": "2026-02-19T18:10:00.000Z",
  "closedAt": "2026-02-19T18:09:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `targetSessionId` | `string` | Session identifier that owns the backup directory |
| `title` | `string \| null` | Session title when the session record still exists |
| `provider` | `string \| null` | Session provider when known |
| `model` | `string \| null` | Session model when known |
| `lifecycle` | `"active" \| "closed" \| "deleted"` | Session lifecycle as seen by the admin/control layer |
| `status` | `"initializing" \| "ready" \| "disabled" \| "failed"` | Backup health status |
| `workingDirectory` | `string` | Workspace path this backup belongs to |
| `backupDirectory` | `string \| null` | Backup storage directory |
| `originalSnapshotKind` | `"pending" \| "directory" \| "tar_gz"` | Original snapshot storage kind |
| `originalSnapshotBytes` | `number \| null` | Bytes used by the original snapshot |
| `checkpointBytesTotal` | `number \| null` | Bytes used by checkpoint snapshots (deduplicated by snapshot artifact) |
| `totalBytes` | `number \| null` | Total bytes used by this backup directory |
| `checkpoints` | `SessionBackupPublicCheckpoint[]` | Checkpoint list using the same shape as `SessionBackupPublicState` |
| `createdAt` | `string` | ISO 8601 timestamp |
| `updatedAt` | `string` | Latest relevant timestamp for sorting/display |
| `closedAt` | `string?` | Present when the backup metadata was closed |
| `failureReason` | `string?` | Present when `status` is `"failed"` |

### WorkspaceBackupDeltaPreview

```json
{
  "targetSessionId": "abc-123",
  "checkpointId": "cp-0001",
  "baselineLabel": "Original snapshot",
  "currentLabel": "cp-0001",
  "counts": {
    "added": 2,
    "modified": 4,
    "deleted": 1
  },
  "files": [
    {
      "path": "src/server/protocol.ts",
      "change": "modified",
      "kind": "file"
    }
  ],
  "truncated": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `targetSessionId` | `string` | Session identifier that owns the backup directory |
| `checkpointId` | `string` | Selected checkpoint identifier |
| `baselineLabel` | `string` | Human-readable baseline for the comparison (`Original snapshot` or the prior checkpoint ID) |
| `currentLabel` | `string` | Human-readable label for the selected checkpoint |
| `counts` | `{ added: number; modified: number; deleted: number }` | Aggregate file-change counts for the full delta |
| `files` | `WorkspaceBackupDeltaFile[]` | Changed-file preview list |
| `truncated` | `boolean` | Whether the file list was capped even though the counts reflect the full delta |

### WorkspaceBackupDeltaFile

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Workspace-relative path for the changed entry |
| `change` | `"added" \| "modified" \| "deleted"` | Change classification |
| `kind` | `"file" \| "directory" \| "symlink"` | Filesystem entry kind |

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

### SessionUsageSnapshot

```json
{
  "sessionId": "abc-123",
  "totalTurns": 12,
  "totalPromptTokens": 5000,
  "totalCompletionTokens": 2000,
  "totalTokens": 7000,
  "estimatedTotalCostUsd": 0.45,
  "costTrackingAvailable": true,
  "byModel": [],
  "turns": [],
  "budgetStatus": { ... },
  "createdAt": "2026-03-09T18:00:00.000Z",
  "updatedAt": "2026-03-09T18:05:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Session identifier |
| `totalTurns` | `number` | Total number of recorded turns |
| `totalPromptTokens` | `number` | Cumulative prompt tokens |
| `totalCompletionTokens` | `number` | Cumulative completion tokens |
| `totalTokens` | `number` | Cumulative total tokens |
| `estimatedTotalCostUsd` | `number \| null` | Cumulative estimated cost in USD |
| `costTrackingAvailable` | `boolean` | Whether cost tracking is active for this session |
| `byModel` | `ModelUsageSummary[]` | Usage breakdown by model |
| `turns` | `TurnCostEntry[]` | Detailed log of turns in this session |
| `budgetStatus` | `BudgetStatus` | Current budget configuration and status |
| `createdAt` | `string` | ISO 8601 creation timestamp |
| `updatedAt` | `string` | ISO 8601 last update timestamp |

### ModelUsageSummary

```json
{
  "provider": "openai",
  "model": "gpt-5.4",
  "turns": 4,
  "totalPromptTokens": 3200,
  "totalCompletionTokens": 900,
  "totalTokens": 4100,
  "estimatedCostUsd": 0.0235
}
```

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `ProviderName` | Provider identifier used for the turns in this bucket |
| `model` | `string` | Model identifier used for the turns in this bucket |
| `turns` | `number` | Number of recorded turns for this provider/model pair |
| `totalPromptTokens` | `number` | Prompt/input tokens accumulated for this provider/model pair |
| `totalCompletionTokens` | `number` | Completion/output tokens accumulated for this provider/model pair |
| `totalTokens` | `number` | Total tokens accumulated for this provider/model pair |
| `estimatedCostUsd` | `number \| null` | Estimated cumulative cost for this provider/model pair |

### TurnCostEntry

```json
{
  "turnId": "turn-1",
  "turnIndex": 0,
  "timestamp": "2026-03-09T18:01:00.000Z",
  "provider": "openai",
  "model": "gpt-5.4",
  "usage": {
    "promptTokens": 1200,
    "completionTokens": 300,
    "totalTokens": 1500,
    "cachedPromptTokens": 200,
    "estimatedCostUsd": 0.0084
  },
  "estimatedCostUsd": 0.0084,
  "pricing": {
    "inputPerMillion": 1.25,
    "outputPerMillion": 10,
    "cachedInputPerMillion": 0.125
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `turnId` | `string` | Turn identifier |
| `turnIndex` | `number` | Zero-based turn index inside the session snapshot |
| `timestamp` | `string` | ISO 8601 timestamp for when the turn usage was recorded |
| `provider` | `ProviderName` | Provider used for this turn |
| `model` | `string` | Model used for this turn |
| `usage` | `TurnUsage` | Raw usage counters and optional turn-level estimate metadata |
| `estimatedCostUsd` | `number \| null` | Estimated cost for this turn after pricing resolution |
| `pricing` | `ModelPricing \| null` | Pricing entry used for this estimate, or `null` when unavailable |

### TurnUsage

```json
{
  "promptTokens": 1200,
  "completionTokens": 300,
  "totalTokens": 1500,
  "cachedPromptTokens": 200,
  "estimatedCostUsd": 0.0084
}
```

| Field | Type | Description |
|-------|------|-------------|
| `promptTokens` | `number` | Prompt/input tokens reported for the turn |
| `completionTokens` | `number` | Completion/output tokens reported for the turn |
| `totalTokens` | `number` | Total tokens reported for the turn |
| `cachedPromptTokens` | `number` | Cached prompt/input tokens when the provider exposes them |
| `estimatedCostUsd` | `number` | Runtime-provided turn estimate when available |

### ModelPricing

```json
{
  "inputPerMillion": 1.25,
  "outputPerMillion": 10,
  "cachedInputPerMillion": 0.125
}
```

| Field | Type | Description |
|-------|------|-------------|
| `inputPerMillion` | `number` | USD cost per 1M prompt/input tokens |
| `outputPerMillion` | `number` | USD cost per 1M completion/output tokens |
| `cachedInputPerMillion` | `number` | USD cost per 1M cached prompt/input tokens when discounted pricing exists |

### BudgetStatus

```json
{
  "configured": true,
  "warnAtUsd": 10.0,
  "stopAtUsd": 50.0,
  "warningTriggered": false,
  "stopTriggered": false,
  "currentCostUsd": 0.45
}
```

| Field | Type | Description |
|-------|------|-------------|
| `configured` | `boolean` | Whether any budget thresholds are set |
| `warnAtUsd` | `number \| null` | Warning threshold in USD |
| `stopAtUsd` | `number \| null` | Hard stop threshold in USD |
| `warningTriggered` | `boolean` | Whether the warning threshold has been reached |
| `stopTriggered` | `boolean` | Whether the stop threshold has been exceeded |
| `currentCostUsd` | `number \| null` | Current cumulative cost |

---

## Session event payload shapes

These `SessionEvent` payloads are internal server/session shapes. JSON-RPC clients may see them inside `{ "event": ... }` or `{ "events": [...] }` result envelopes for selected `cowork/*` methods, and persisted desktop/session artifacts may store the same shapes. They are not a standalone WebSocket protocol.


### server_hello

Initial handshake event sent immediately on WebSocket connection.

```json
{
  "type": "server_hello",
  "sessionId": "abc-123-def",
  "protocolVersion": "7.14",
  "capabilities": {
    "modelStreamChunk": "v1"
  },
  "config": {
    "provider": "openai",
    "model": "gpt-5.4",
    "workingDirectory": "/path/to/project"
  },
  "sessionKind": "agent",
  "parentSessionId": "root-123",
  "role": "worker",
  "mode": "collaborative",
  "depth": 1,
  "effectiveModel": "gpt-5.4",
  "executionState": "running",
  "isResume": true,
  "resumedFromStorage": true,
  "busy": true,
  "turnId": "turn-abc",
  "messageCount": 12,
  "hasPendingAsk": false,
  "hasPendingApproval": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"server_hello"` | — |
| `sessionId` | `string` | The session identifier. Use this for all subsequent messages |
| `protocolVersion` | `string?` | Protocol version |
| `capabilities` | `object?` | Optional capabilities object. Currently: `{ modelStreamChunk: "v1" }` |
| `config` | `PublicConfig` | Session config: `provider`, `model`, `workingDirectory`, and optionally `outputDirectory` |
| `sessionKind` | `"root" \| "agent"` | Session identity. Present for both root and child sessions |
| `parentSessionId` | `string?` | Present only for child sessions |
| `role` | `"default" \| "explorer" \| "research" \| "worker" \| "reviewer"?` | Present only for child sessions |
| `mode` | `"collaborative" \| "delegate"?` | Child-agent mode |
| `depth` | `number?` | Child-agent nesting depth |
| `effectiveModel` | `string?` | Effective child model |
| `executionState` | `"pending_init" \| "running" \| "completed" \| "errored" \| "closed"?` | Child-agent execution state |
| `isResume` | `boolean?` | Present and `true` only when resuming a disconnected session |
| `resumedFromStorage` | `boolean?` | Present and `true` on cold resume (rehydrated from persisted store) |
| `busy` | `boolean?` | Whether the session is mid-turn (only on resume) |
| `turnId` | `string?` | Active turn identifier when resuming into a busy session |
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
  "titleModel": "gpt-5.4",
  "createdAt": "2026-02-19T18:10:00.000Z",
  "updatedAt": "2026-02-19T18:10:03.000Z",
  "provider": "openai",
  "model": "gpt-5.4",
  "sessionKind": "agent",
  "parentSessionId": "root-123",
  "role": "worker",
  "mode": "collaborative",
  "depth": 1,
  "effectiveModel": "gpt-5.4",
  "executionState": "running"
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
| `sessionKind` | `"root" \| "agent"?` | Session identity |
| `parentSessionId` | `string?` | Present only for child sessions |
| `role` | `"default" \| "explorer" \| "research" \| "worker" \| "reviewer"?` | Present only for child sessions |
| `mode` | `"collaborative" \| "delegate"?` | Child-agent mode |
| `depth` | `number?` | Child-agent nesting depth |
| `effectiveModel` | `string?` | Effective child model |
| `executionState` | `"pending_init" \| "running" \| "completed" \| "errored" \| "closed"?` | Child-agent execution state |

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
    {
      "id": "openai",
      "name": "OpenAI",
      "models": [
        { "id": "gpt-5.4", "displayName": "GPT-5.4", "knowledgeCutoff": "August 2025", "supportsImageInput": true }
      ],
      "defaultModel": "gpt-5.4"
    },
    {
      "id": "lmstudio",
      "name": "LM Studio",
      "models": [
        { "id": "local/qwen-2.5", "displayName": "Qwen 2.5 Local", "knowledgeCutoff": "Unknown", "supportsImageInput": false }
      ],
      "defaultModel": "local/qwen-2.5",
      "state": "ready"
    }
  ],
  "default": { "openai": "gpt-5.4", "lmstudio": "local/qwen-2.5", "opencode-go": "glm-5", "opencode-zen": "glm-5", "google": "gemini-3.1-pro-preview" },
  "connected": ["openai", "lmstudio", "opencode-go", "opencode-zen"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"provider_catalog"` | — |
| `sessionId` | `string` | Session identifier |
| `all` | `ProviderCatalogEntry[]` | All available providers with their models |
| `default` | `Record<string, string>` | Default model per provider (includes current session's selection) |
| `connected` | `string[]` | Provider IDs that are currently usable. For local providers like LM Studio this can be based on reachability rather than stored auth |

---

### provider_auth_methods

Auth method registry for all providers.

```json
{
  "type": "provider_auth_methods",
  "sessionId": "...",
  "methods": {
    "openai": [{ "id": "api_key", "type": "api", "label": "API key" }],
    "opencode-go": [{ "id": "api_key", "type": "api", "label": "API key" }],
    "opencode-zen": [{ "id": "api_key", "type": "api", "label": "API key" }],
    "codex-cli": [
      { "id": "oauth_cli", "type": "oauth", "label": "Sign in with ChatGPT (browser)", "oauthMode": "auto" },
      { "id": "api_key", "type": "api", "label": "API key" }
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
    "method": "auto",
    "instructions": "Cowork will open the browser sign-in flow and save the returned token locally."
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

Auth completion result after `provider_auth_callback`, `provider_auth_set_api_key`, `provider_auth_copy_api_key`, or `provider_auth_logout`.

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
- `savedFieldMasks` values are always masked or pre-redacted summaries; raw credential values are never emitted.

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

### steer_accepted

Acknowledges that a `steer_message` was accepted for the active turn. The steer is not yet part of persistent history when this event is emitted; it is only committed if and when the runtime drains it at a safe step boundary.

```json
{ "type": "steer_accepted", "sessionId": "...", "turnId": "turn-abc", "text": "Use a shorter answer", "clientMessageId": "steer-1" }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"steer_accepted"` | — |
| `sessionId` | `string` | Session identifier |
| `turnId` | `string` | Active turn identifier |
| `text` | `string` | Accepted steer text |
| `clientMessageId` | `string?` | Echoed from the original `steer_message` if provided |

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
  "model": "gpt-5.4",
  "normalizerVersion": 1,
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
| `normalizerVersion` | `number?` | Optional normalization version for the persisted `partType`/`part` mapping |
| `partType` | `ModelStreamPartType` | Part type (see [ModelStreamPartType](#modelstreamparttype)) |
| `part` | `object` | Normalized part payload. Shape varies by `partType`. If a non-object part is received, it is normalized to `{ "value": <original> }` |
| `rawPart` | `unknown?` | Optional raw provider/runtime part (present when `includeRawChunks` is enabled). Default mode is sanitized; set `COWORK_MODEL_STREAM_RAW_MODE=full` to increase payload detail |

Notes:
- When an oversized non-image tool result is spilled to `.ModelScratchpad`, the `tool_result` chunk carries compact overflow metadata (`overflow`, `filePath`, `chars`, `preview`) instead of the full text payload.
- `preview` is a fixed inline preview of the first 5,000 characters plus a truncation note when additional content was written to disk.
- The runtime emits a companion `file` chunk with `{ "kind": "tool-output-overflow", "toolName": "...", "toolCallId": "...", "path": "...", "chars": 12345, "preview": "..." }`.

---

### model_stream_raw

Provider-native raw model stream event. Emitted before any derived `model_stream_chunk` parts for the same provider event so clients can replay or re-normalize the stream themselves.

```json
{
  "type": "model_stream_raw",
  "sessionId": "...",
  "turnId": "turn-abc",
  "index": 0,
  "provider": "openai",
  "model": "gpt-5.4",
  "format": "openai-responses-v1",
  "normalizerVersion": 1,
  "event": { "type": "response.output_item.added", "item": { "type": "reasoning" } }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"model_stream_raw"` | — |
| `sessionId` | `string` | Session identifier |
| `turnId` | `string` | Unique turn identifier (groups all raw events for one turn). Fallback: `"unknown-turn"` |
| `index` | `number` | Sequential raw-event index within the turn (starting at 0). Fallback: `-1` |
| `provider` | `ProviderName \| "unknown"` | Provider that generated this event. Fallback: `"unknown"` |
| `model` | `string` | Model that generated this event. Fallback: `"unknown"` |
| `format` | `"openai-responses-v1" \| "google-interactions-v1"` | Raw event envelope format |
| `normalizerVersion` | `number` | Version identifier for the client/server raw-event normalizer |
| `event` | `object` | Provider-native raw event payload. If a non-object payload is received, it is normalized to `{ "value": <original> }` |

For OpenAI Responses providers, `event.item.type` may be `web_search_call`. Clients may surface these raw events as synthetic native web-search activity (for example `nativeWebSearch`) without treating them as executable local function tools.

For Google Interactions providers, `event` is the provider-native SSE payload and typically uses `event_type` values like `interaction.start`, `content.delta`, and `interaction.complete`.

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

Internal session event recorded when the harness asks the user for text or option input. On the JSON-RPC wire, the same prompt is sent as the server request `item/tool/requestUserInput`.

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
| `requestId` | `string` | Unique request ID, mirrored in the JSON-RPC server request |
| `question` | `string` | The question to present to the user |
| `options` | `string[]?` | Optional list of suggested options |

Client guidance:
- Use `"[skipped]"` as an explicit skip response when the user dismisses/skips.
- Do not send blank answers. Blank/whitespace JSON-RPC responses are rejected and the same ask is re-sent.

---

### approval

Internal session event recorded when the harness needs command approval. On the JSON-RPC wire, the same prompt is sent as the server request `item/commandExecution/requestApproval`.

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
| `requestId` | `string` | Unique request ID, mirrored in the JSON-RPC server request |
| `command` | `string` | The shell command requesting approval |
| `dangerous` | `boolean` | Whether the command matches dangerous patterns |
| `reasonCode` | `ApprovalRiskCode` | Why approval is needed (see [ApprovalRiskCode](#approvalriskcode)) |

---

### config_updated

Updated session public config after a JSON-RPC model/config method or other runtime change.

```json
{
  "type": "config_updated",
  "sessionId": "...",
  "config": {
    "provider": "openai",
    "model": "gpt-5.4",
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

### skills_catalog

Full skills catalog snapshot for the desktop skills manager.

```json
{
  "type": "skills_catalog",
  "sessionId": "...",
  "catalog": {
    "scopes": [],
    "effectiveSkills": [],
    "installations": []
  },
  "mutationBlocked": false,
  "clearedMutationPendingKeys": ["install:project"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"skills_catalog"` | — |
| `sessionId` | `string` | Session identifier |
| `catalog` | `SkillCatalogSnapshot` | Full catalog snapshot |
| `mutationBlocked` | `boolean` | Whether install/update/delete/enable/disable/copy are currently blocked |
| `clearedMutationPendingKeys` | `string[]?` | Optional pending mutation keys completed by this refresh; omit on plain catalog reads |
| `mutationBlockedReason` | `string?` | Optional explanation when blocked |

---

### skill_installation

Detailed metadata and content payload for one installation copy.

```json
{
  "type": "skill_installation",
  "sessionId": "...",
  "installation": { "installationId": "inst-123", "name": "commit" },
  "content": "# Commit Skill"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"skill_installation"` | — |
| `sessionId` | `string` | Session identifier |
| `installation` | `SkillInstallationEntry \| null` | Detailed installation metadata or `null` when not found |
| `content` | `string \| null` | Skill file content with front matter stripped when readable |

---

### skill_install_preview

Preview payload emitted in response to `skill_install_preview` and after successful install/update operations.

`fromUserPreviewRequest` distinguishes user-initiated previews from install/update side effects so clients can keep “preview loading” state until the matching preview response arrives.

```json
{
  "type": "skill_install_preview",
  "sessionId": "...",
  "fromUserPreviewRequest": true,
  "preview": {
    "source": { "kind": "github_repo", "raw": "openai/skills", "displaySource": "https://github.com/openai/skills" },
    "targetScope": "project",
    "candidates": [],
    "warnings": []
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"skill_install_preview"` | — |
| `sessionId` | `string` | Session identifier |
| `fromUserPreviewRequest` | `boolean?` | `true` for the direct reply to client `skill_install_preview`; `false` after successful `skill_install` / `skill_installation_update`. Omitted on older servers — treat as `true`. |
| `preview` | `SkillInstallPreview` | Install preview payload |

---

### skill_installation_update_check

Update-check result for a managed installation.

```json
{
  "type": "skill_installation_update_check",
  "sessionId": "...",
  "result": {
    "installationId": "inst-123",
    "canUpdate": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"skill_installation_update_check"` | — |
| `sessionId` | `string` | Session identifier |
| `result` | `SkillUpdateCheckResult` | Update-check result |

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
    "checkpoints": [
      {
        "id": "cp-0001",
        "index": 1,
        "createdAt": "2026-02-19T18:00:00.000Z",
        "trigger": "initial",
        "changed": false,
        "patchBytes": 0
      }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_backup_state"` | — |
| `sessionId` | `string` | Session identifier |
| `reason` | `"requested" \| "auto_checkpoint" \| "manual_checkpoint" \| "restore" \| "delete"` | What triggered this state emission |
| `backup` | `SessionBackupPublicState` | Full backup state (see [SessionBackupPublicState](#sessionbackuppublicstate)) |

Notes:
- New backups seed `cp-0001` immediately from the session-start snapshot with `trigger: "initial"`.
- When backups are turned off for a live session, `backup.status` is `"disabled"` and both `backupDirectory` and `checkpoints` are empty.

---

### workspace_backups

Workspace-scoped backup snapshot for the control session's current `workingDirectory`.

```json
{
  "type": "workspace_backups",
  "sessionId": "...",
  "workspacePath": "/path/to/project",
  "backups": [
    {
      "targetSessionId": "abc-123",
      "lifecycle": "deleted",
      "status": "ready",
      "workingDirectory": "/path/to/project",
      "backupDirectory": "/path/to/backup",
      "originalSnapshotKind": "directory",
      "originalSnapshotBytes": 8192,
      "checkpointBytesTotal": 4096,
      "totalBytes": 12288,
      "checkpoints": [],
      "createdAt": "2026-02-19T18:00:00.000Z",
      "updatedAt": "2026-02-19T18:10:00.000Z"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"workspace_backups"` | — |
| `sessionId` | `string` | Control-session identifier |
| `workspacePath` | `string` | Workspace path this snapshot covers |
| `backups` | `WorkspaceBackupPublicEntry[]` | One entry per backup directory for the workspace |

---

### workspace_backup_delta

Changed-file preview for a specific workspace backup checkpoint.

```json
{
  "type": "workspace_backup_delta",
  "sessionId": "...",
  "targetSessionId": "abc-123",
  "checkpointId": "cp-0001",
  "baselineLabel": "Original snapshot",
  "currentLabel": "cp-0001",
  "counts": {
    "added": 2,
    "modified": 4,
    "deleted": 1
  },
  "files": [
    {
      "path": "src/server/protocol.ts",
      "change": "modified",
      "kind": "file"
    }
  ],
  "truncated": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"workspace_backup_delta"` | — |
| `sessionId` | `string` | Control-session identifier |
| `targetSessionId` | `string` | Session identifier that owns the backup directory |
| `checkpointId` | `string` | Selected checkpoint identifier |
| `baselineLabel` | `string` | Comparison baseline label |
| `currentLabel` | `string` | Selected checkpoint label |
| `counts` | `{ added: number; modified: number; deleted: number }` | Aggregate file-change counts for the full delta |
| `files` | `WorkspaceBackupDeltaFile[]` | Changed-file preview list |
| `truncated` | `boolean` | Whether the preview file list was capped |

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

### a2ui_surface

Resolved generative-UI surface state emitted when the agent calls the `a2ui` tool. Published after every envelope application and carries the post-reduction snapshot (not the raw envelope).

This event is emitted only when the harness has A2UI enabled. A2UI is on by default, but any config layer can disable it with `"enableA2ui": false`, and the environment can override it with `AGENT_ENABLE_A2UI=false`. Clients can safely ignore the event when they do not implement an A2UI renderer.

```json
{
  "type": "a2ui_surface",
  "sessionId": "...",
  "surfaceId": "greeter",
  "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json",
  "version": "v0.9",
  "revision": 3,
  "deleted": false,
  "theme": { "primaryColor": "#0f766e" },
  "root": {
    "id": "root",
    "type": "Column",
    "children": [
      { "id": "title", "type": "Heading", "props": { "text": "Hello" } },
      { "id": "body",  "type": "Text",    "props": { "text": { "path": "/message" } } }
    ]
  },
  "dataModel": { "message": "Welcome to A2UI." },
  "updatedAt": "2026-03-01T12:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"a2ui_surface"` | — |
| `sessionId` | `string` | Session identifier |
| `surfaceId` | `string` | Unique id inside the session. Subsequent events for the same id replace the previous state. |
| `catalogId` | `string` | URL identifying the A2UI component catalog the agent wrote against. Clients that only render the v0.9 basic catalog should show a fallback when the id does not match. |
| `version` | `"v0.9"` | A2UI protocol version. |
| `revision` | `integer` | Monotonically increases every time the harness folds a new envelope. |
| `deleted` | `boolean` | `true` after `deleteSurface`. Clients should unmount the surface. |
| `theme` | `Record<string, unknown> \| undefined` | Opaque theme blob from `createSurface.theme`. |
| `root` | `Record<string, unknown> \| undefined` | Current root component tree. |
| `dataModel` | `unknown \| undefined` | Current JSON data model the component tree reads via `{ path, ... }` bindings. |
| `updatedAt` | `string` | ISO 8601 of the last fold. |

On the JSON-RPC transport, the harness also projects the event into the standard `item/started` + `item/completed` notifications as a `uiSurface` ProjectedItem, and additionally emits a dedicated `cowork/session/a2ui/surface` notification carrying the raw event shape above. Thin clients can consume either; the ProjectedItem path keeps the surface in sync with the session feed.

See [`src/shared/a2ui`](../src/shared/a2ui) for the envelope schema, reducer, and binding evaluator, and [`skills/a2ui/SKILL.md`](../skills/a2ui/SKILL.md) for the agent-facing guide.

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
    "totalTokens": 1801,
    "cachedPromptTokens": 234,
    "estimatedCostUsd": 0.0042
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"turn_usage"` | — |
| `sessionId` | `string` | Session identifier |
| `turnId` | `string` | Turn this usage belongs to |
| `usage.promptTokens` | `number` | Total input tokens consumed, including cached prompt tokens when the provider reports them |
| `usage.completionTokens` | `number` | Output tokens generated |
| `usage.totalTokens` | `number` | Total tokens |
| `usage.cachedPromptTokens` | `number` | Cached input tokens reported for the turn, when available |
| `usage.estimatedCostUsd` | `number` | Turn cost estimate in USD when the runtime can provide one |

---

### session_usage

Accumulated session usage and budget status. Sent in response to `get_session_usage`, `set_session_usage_budget`, and automatically when tracked usage changes. Threshold crossings also emit [budget_warning](#budget_warning) and [budget_exceeded](#budget_exceeded) immediately.

```json
{
  "type": "session_usage",
  "sessionId": "...",
  "usage": {
    "sessionId": "abc-123",
    "totalTurns": 12,
    "totalPromptTokens": 5000,
    "totalCompletionTokens": 2000,
    "totalTokens": 7000,
    "estimatedTotalCostUsd": 0.45,
    "costTrackingAvailable": true,
    "byModel": [],
    "turns": [],
    "budgetStatus": {
      "configured": true,
      "warnAtUsd": 10.0,
      "stopAtUsd": 50.0,
      "warningTriggered": false,
      "stopTriggered": false,
      "currentCostUsd": 0.45
    },
    "createdAt": "2026-03-09T18:00:00.000Z",
    "updatedAt": "2026-03-09T18:05:00.000Z"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_usage"` | — |
| `sessionId` | `string` | Session identifier |
| `usage` | `SessionUsageSnapshot \| null` | Cumulative usage snapshot (see [SessionUsageSnapshot](#sessionusagesnapshot)), or `null` when tracking is unavailable |

---

### budget_warning

Structured soft-budget alert emitted when cumulative tracked cost first reaches the configured warning threshold for the current budget configuration.

```json
{
  "type": "budget_warning",
  "sessionId": "...",
  "currentCostUsd": 4.2,
  "thresholdUsd": 4.0,
  "message": "⚠️  Budget warning: session cost $4.20 has reached the warning threshold of $4.00."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"budget_warning"` | — |
| `sessionId` | `string` | Session identifier |
| `currentCostUsd` | `number` | Current cumulative tracked cost in USD when the warning fired |
| `thresholdUsd` | `number` | Warning threshold that was crossed |
| `message` | `string` | Human-readable alert message |

---

### budget_exceeded

Structured hard-budget alert emitted when cumulative tracked cost first reaches or exceeds the configured stop threshold for the current budget configuration.

```json
{
  "type": "budget_exceeded",
  "sessionId": "...",
  "currentCostUsd": 4.2,
  "thresholdUsd": 4.0,
  "message": "🛑 Budget exceeded: session cost $4.20 has exceeded the hard cap of $4.00. No further turns will be processed."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"budget_exceeded"` | — |
| `sessionId` | `string` | Session identifier |
| `currentCostUsd` | `number` | Current cumulative tracked cost in USD when the hard stop fired |
| `thresholdUsd` | `number` | Hard-stop threshold that was crossed |
| `message` | `string` | Human-readable alert message |


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
| `messages` | `unknown[]` | Slice of runtime `ModelMessage` objects |
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
      "model": "gpt-5.4",
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
| `titleSource` | `"default" \| "model" \| "heuristic" \| "manual"` | Session title provenance |
| `titleModel` | `string \| null` | Model recorded when the title came from a model-generated title path |
| `provider` | `ProviderName` | Provider |
| `model` | `string` | Model |
| `createdAt` | `string` | ISO 8601 creation timestamp |
| `updatedAt` | `string` | ISO 8601 last update timestamp |
| `messageCount` | `number` | Number of messages in history |
| `lastEventSeq` | `number` | Latest persisted server-event sequence number when the session store is SQLite-backed. Summaries produced from legacy per-session JSON files only (no session DB) use `0` here—there is no event log; use `messageCount` / `updatedAt` for ordering and staleness. |
| `hasPendingAsk` | `boolean` | Whether the session is currently waiting on an ask prompt |
| `hasPendingApproval` | `boolean` | Whether the session is currently waiting on an approval prompt |

---

### session_snapshot

Materialized harness-owned snapshot response to `get_session_snapshot`.

```json
{
  "type": "session_snapshot",
  "sessionId": "control-session",
  "targetSessionId": "root-session-id",
  "snapshot": {
    "sessionId": "root-session-id",
    "title": "Fix login bug",
    "titleSource": "manual",
    "titleModel": null,
    "provider": "openai",
    "model": "gpt-5.4",
    "sessionKind": "root",
    "parentSessionId": null,
    "role": null,
    "mode": null,
    "depth": null,
    "nickname": null,
    "requestedModel": null,
    "effectiveModel": null,
    "requestedReasoningEffort": null,
    "effectiveReasoningEffort": null,
    "executionState": null,
    "lastMessagePreview": "Latest assistant preview",
    "createdAt": "2026-03-19T18:00:00.000Z",
    "updatedAt": "2026-03-19T18:30:00.000Z",
    "messageCount": 24,
    "lastEventSeq": 83,
    "feed": [
      {
        "id": "item-1",
        "kind": "message",
        "role": "user",
        "ts": "2026-03-19T18:00:00.000Z",
        "text": "Please investigate the login bug."
      }
    ],
    "agents": [],
    "todos": [],
    "sessionUsage": null,
    "lastTurnUsage": null,
    "hasPendingAsk": false,
    "hasPendingApproval": false
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_snapshot"` | — |
| `sessionId` | `string` | Requester/control session identifier |
| `targetSessionId` | `string` | Hydrated persisted root session |
| `snapshot` | `SessionSnapshot` | Canonical materialized session snapshot |

**SessionSnapshot:**

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Persisted session identifier |
| `title` | `string` | Session title |
| `titleSource` | `"default" \| "model" \| "heuristic" \| "manual"` | Session title provenance |
| `titleModel` | `string \| null` | Model recorded when the title came from the model-title path |
| `provider` | `ProviderName` | Provider |
| `model` | `string` | Model |
| `sessionKind` | `"root" \| "agent"` | Session kind |
| `parentSessionId` | `string \| null` | Parent session for agent sessions |
| `role` | `string \| null` | Agent role when `sessionKind` is `"agent"` |
| `mode` | `string \| null` | Agent mode when present |
| `depth` | `number \| null` | Agent depth when present |
| `nickname` | `string \| null` | Optional agent nickname |
| `requestedModel` | `string \| null` | Requested model, if recorded |
| `effectiveModel` | `string \| null` | Effective model, if recorded |
| `requestedReasoningEffort` | `string \| null` | Requested reasoning effort, if recorded |
| `effectiveReasoningEffort` | `string \| null` | Effective reasoning effort, if recorded |
| `executionState` | `string \| null` | Agent execution state, when present |
| `lastMessagePreview` | `string \| null` | Latest assistant preview |
| `createdAt` | `string` | ISO 8601 creation timestamp |
| `updatedAt` | `string` | ISO 8601 last update timestamp |
| `messageCount` | `number` | Number of persisted model/user messages |
| `lastEventSeq` | `number` | Latest persisted server-event sequence number |
| `feed` | `SessionFeedItem[]` | Materialized feed ready for thin-client rendering |
| `agents` | `PersistentAgentSummary[]` | Child-agent summaries for root sessions |
| `todos` | `TodoItem[]` | Latest todo state |
| `sessionUsage` | `SessionUsageSnapshot \| null` | Full session usage snapshot |
| `lastTurnUsage` | `{ turnId: string; usage: TurnUsage } \| null` | Latest turn usage shortcut |
| `hasPendingAsk` | `boolean` | Whether the session is awaiting ask input |
| `hasPendingApproval` | `boolean` | Whether the session is awaiting approval input |

---

### agent_spawned

Confirmation that a persistent child session was created.

```json
{
  "type": "agent_spawned",
  "sessionId": "root-123",
  "agent": {
    "agentId": "child-456",
    "parentSessionId": "root-123",
    "role": "worker",
    "mode": "collaborative",
    "depth": 1,
    "effectiveModel": "gpt-5.4-mini",
    "title": "New session",
    "provider": "openai",
    "createdAt": "2026-03-08T12:00:00.000Z",
    "updatedAt": "2026-03-08T12:00:00.000Z",
    "lifecycleState": "active",
    "executionState": "running",
    "busy": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"agent_spawned"` | — |
| `sessionId` | `string` | Parent session identifier |
| `agent` | `PersistentAgentSummary` | Newly created child session |

---

### agent_list

Persistent child-session list response to `agent_list_get`.

```json
{
  "type": "agent_list",
  "sessionId": "root-123",
  "agents": [
    {
      "agentId": "child-456",
      "parentSessionId": "root-123",
      "role": "research",
      "mode": "collaborative",
      "depth": 1,
      "effectiveModel": "gpt-5.4",
      "title": "Research queue",
      "provider": "openai",
      "createdAt": "2026-03-08T12:00:00.000Z",
      "updatedAt": "2026-03-08T12:05:00.000Z",
      "lifecycleState": "active",
      "executionState": "completed",
      "busy": false
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"agent_list"` | — |
| `sessionId` | `string` | Parent session identifier |
| `agents` | `PersistentAgentSummary[]` | Child sessions sorted by `updatedAt` descending |

**PersistentAgentSummary:**

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `string` | Child session identifier |
| `parentSessionId` | `string` | Parent/root session identifier |
| `role` | `"default" \| "explorer" \| "research" \| "worker" \| "reviewer"` | Child-agent role |
| `mode` | `"collaborative" \| "delegate"` | Agent mode |
| `depth` | `number` | Child-agent nesting depth |
| `requestedModel` | `string?` | Requested child model override |
| `effectiveModel` | `string` | Effective child model |
| `requestedReasoningEffort` | `string?` | Requested reasoning override |
| `effectiveReasoningEffort` | `string?` | Effective reasoning setting |
| `title` | `string` | Current child-session title |
| `provider` | `ProviderName` | Current provider |
| `createdAt` | `string` | ISO 8601 creation timestamp |
| `updatedAt` | `string` | ISO 8601 last update timestamp |
| `lifecycleState` | `"active" \| "closed"` | Persisted child-session state |
| `executionState` | `"pending_init" \| "running" \| "completed" \| "errored" \| "closed"` | Current execution state |
| `busy` | `boolean` | Whether the child session is mid-turn in memory |
| `lastMessagePreview` | `string?` | Latest assistant preview text |

---

### agent_status

Live child-agent status update emitted on spawn, resume, close, and state transitions.

```json
{
  "type": "agent_status",
  "sessionId": "root-123",
  "agent": {
    "agentId": "child-456",
    "parentSessionId": "root-123",
    "role": "worker",
    "mode": "collaborative",
    "depth": 1,
    "effectiveModel": "gpt-5.4-mini",
    "title": "New session",
    "provider": "openai",
    "createdAt": "2026-03-08T12:00:00.000Z",
    "updatedAt": "2026-03-08T12:05:00.000Z",
    "lifecycleState": "active",
    "executionState": "completed",
    "busy": false
  }
}
```

---

### agent_wait_result

Result event emitted after an `agent_wait` request resolves or times out.

```json
{
  "type": "agent_wait_result",
  "sessionId": "root-123",
  "agentIds": ["child-456"],
  "timedOut": false,
  "mode": "any",
  "agents": [
    {
      "agentId": "child-456",
      "parentSessionId": "root-123",
      "role": "worker",
      "mode": "collaborative",
      "depth": 1,
      "effectiveModel": "gpt-5.4-mini",
      "title": "Child task",
      "provider": "openai",
      "createdAt": "2026-03-08T12:00:00.000Z",
      "updatedAt": "2026-03-08T12:05:00.000Z",
      "lifecycleState": "active",
      "executionState": "completed",
      "busy": false
    }
  ],
  "readyAgentIds": ["child-456"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"agent_wait_result"` | — |
| `sessionId` | `string` | Root session identifier |
| `agentIds` | `string[]` | Requested child-agent identifiers from the matching `agent_wait` call |
| `timedOut` | `boolean` | `true` when the wait window elapsed before the requested wait condition was satisfied |
| `mode` | `"any" \| "all"` | Wait mode used for this request |
| `agents` | `PersistentAgentSummary[]` | Latest known child summaries for the requested ids, returned in request order even on timeout |
| `readyAgentIds` | `string[]` | Requested child ids currently in a terminal state (`completed`, `errored`, or `closed`) |

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
    "backupsEnabled": true,
    "defaultBackupsEnabled": true,
    "enableA2ui": true,
    "toolOutputOverflowChars": 25000,
    "defaultToolOutputOverflowChars": 25000,
    "preferredChildModel": "gpt-5.4",
    "childModelRoutingMode": "cross-provider-allowlist",
    "preferredChildModelRef": "opencode-zen:glm-5",
    "allowedChildModelRefs": ["opencode-zen:glm-5", "opencode-go:glm-5"],
    "maxSteps": 100,
    "providerOptions": {
      "openai": {
        "reasoningEffort": "high",
        "reasoningSummary": "detailed",
        "textVerbosity": "medium"
      },
      "codex-cli": {
        "reasoningEffort": "high",
        "reasoningSummary": "detailed",
        "textVerbosity": "medium",
        "webSearchBackend": "native",
        "webSearchMode": "live",
        "webSearch": {
          "contextSize": "medium",
          "allowedDomains": ["openai.com"],
          "location": {
            "country": "US",
            "timezone": "America/New_York"
          }
        }
      },
      "google": {
        "nativeWebSearch": true,
        "thinkingConfig": {
          "thinkingLevel": "low"
        }
      },
      "lmstudio": {
        "baseUrl": "http://127.0.0.1:1234",
        "contextLength": 16384,
        "autoLoad": true,
        "reloadOnContextMismatch": true
      }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_config"` | — |
| `sessionId` | `string` | Session identifier |
| `config.yolo` | `boolean` | Whether all commands are auto-approved |
| `config.observabilityEnabled` | `boolean` | Whether observability is enabled |
| `config.backupsEnabled` | `boolean` | Whether backups are enabled for the live session after applying any session-scoped override |
| `config.defaultBackupsEnabled` | `boolean` | The persisted workspace backup default from the harness/core config, before any live session override is applied |
| `config.enableA2ui` | `boolean` | Whether A2UI generative UI is enabled for the session/workspace default and therefore exposed in the model prompt/tool contract |
| `config.toolOutputOverflowChars` | `number \| null` | Effective character threshold for when oversized tool outputs start spilling into `.ModelScratchpad`; `null` disables spill files. Spill results still keep a fixed inline preview (currently the first 5,000 characters). |
| `config.defaultToolOutputOverflowChars` | `number \| null` | Persisted workspace overflow default when explicitly configured; omitted when the session is inheriting the built-in or user-level default |
| `config.preferredChildModel` | `string` | Normalized same-provider fallback model identifier used for legacy/default suggestion state |
| `config.childModelRoutingMode` | `"same-provider" \| "cross-provider-allowlist"` | Workspace child-routing policy |
| `config.preferredChildModelRef` | `string` | Canonical preferred child target ref shown in workspace/UI suggestions |
| `config.allowedChildModelRefs` | `string[]` | Exact cross-provider child target refs allowed for this workspace |
| `config.maxSteps` | `number` | Maximum steps per turn |
| `config.providerOptions` | `object?` | Editable provider options when configured |
| `config.userName` | `string` | Effective user name |
| `config.userProfile` | `object` | Effective user profile metadata used for prompt injection |
| `config.userProfile.instructions` | `string` | Effective profile instructions |
| `config.userProfile.work` | `string` | Effective profile work/job context |
| `config.userProfile.details` | `string` | Effective profile details |
| `config.featureFlags` | `object` | Effective workspace-scoped feature-flag state |
| `config.featureFlags.workspace` | `object` | Effective workspace feature flags |
| `config.featureFlags.workspace.a2ui` | `boolean` | Effective A2UI feature-flag state for this workspace |
| `config.providerOptions.openai.reasoningEffort` | `"none" \| "low" \| "medium" \| "high" \| "xhigh"` | Current editable OpenAI reasoning effort |
| `config.providerOptions.openai.reasoningSummary` | `"auto" \| "concise" \| "detailed"` | Current editable OpenAI reasoning summary |
| `config.providerOptions.openai.textVerbosity` | `"low" \| "medium" \| "high"` | Current editable OpenAI verbosity |
| `config.providerOptions.codex-cli.reasoningEffort` | `"none" \| "low" \| "medium" \| "high" \| "xhigh"` | Current editable Codex CLI reasoning effort |
| `config.providerOptions.codex-cli.reasoningSummary` | `"auto" \| "concise" \| "detailed"` | Current editable Codex CLI reasoning summary |
| `config.providerOptions.codex-cli.textVerbosity` | `"low" \| "medium" \| "high"` | Current editable Codex CLI verbosity |
| `config.providerOptions.codex-cli.webSearchBackend` | `"native" \| "exa"` | Current Codex web search backend. Omitted means the workspace is using the default `"native"` backend |
| `config.providerOptions.codex-cli.webSearchMode` | `"disabled" \| "cached" \| "live"` | Current editable Codex native web-search mode |
| `config.providerOptions.codex-cli.webSearch.contextSize` | `"low" \| "medium" \| "high"` | Current editable Codex native web-search context size |
| `config.providerOptions.codex-cli.webSearch.allowedDomains` | `string[]` | Current editable Codex native web-search domain allowlist |
| `config.providerOptions.codex-cli.webSearch.location.country` | `string` | Current editable Codex native web-search country |
| `config.providerOptions.codex-cli.webSearch.location.region` | `string` | Current editable Codex native web-search region/state |
| `config.providerOptions.codex-cli.webSearch.location.city` | `string` | Current editable Codex native web-search city |
| `config.providerOptions.codex-cli.webSearch.location.timezone` | `string` | Current editable Codex native web-search timezone |
| `config.providerOptions.google.nativeWebSearch` | `boolean` | Current Gemini built-in Search + URL Context toggle |
| `config.providerOptions.google.thinkingConfig.thinkingLevel` | `"minimal" \| "low" \| "medium" \| "high"` | Current explicit Gemini `thinking_level` override when set. Omitted means the workspace is using Gemini's dynamic default |
| `config.providerOptions.lmstudio.baseUrl` | `string` | Current LM Studio base URL override |
| `config.providerOptions.lmstudio.contextLength` | `number` | Current requested LM Studio context length override |
| `config.providerOptions.lmstudio.autoLoad` | `boolean` | Current LM Studio eager-load toggle |
| `config.providerOptions.lmstudio.reloadOnContextMismatch` | `boolean` | Current LM Studio reload-on-context-mismatch toggle |

---

### memory_list

Current memory entries for workspace/user scopes.

```json
{
  "type": "memory_list",
  "sessionId": "...",
  "memories": [
    {
      "id": "coding-style",
      "scope": "workspace",
      "content": "Prefer explicit types at module boundaries.",
      "createdAt": "2026-03-13T00:00:00.000Z",
      "updatedAt": "2026-03-13T00:00:00.000Z"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"memory_list"` | — |
| `sessionId` | `string` | Session identifier |
| `memories` | `Array<object>` | Current memory entries |
| `memories[].id` | `string` | Memory identifier |
| `memories[].scope` | `"workspace" \| "user"` | Memory scope |
| `memories[].content` | `string` | Memory text |
| `memories[].createdAt` | `string` | ISO timestamp |
| `memories[].updatedAt` | `string` | ISO timestamp |

---

### file_uploaded

File upload confirmation response to `upload_file` or `cowork/session/file/upload`.

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
