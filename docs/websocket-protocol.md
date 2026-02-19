# WebSocket Protocol Reference

Canonical protocol contract for `agent-coworker` WebSocket clients.

## Connection

- URL: `ws://127.0.0.1:{port}/ws`
- Session resume: `?resumeSessionId=<sessionId>`
- Current protocol version: `4.0`

## Protocol v4 Notes

Breaking changes in `4.0`:

- Removed client messages: `observability_query`, `harness_slo_evaluate`
- Removed server events: `observability_query_result`, `harness_slo_result`
- `observability_status` now reports Langfuse-oriented status/config only.

## Client -> Server Messages

### client_hello
Optional client identity handshake.

### user_message
Send a user prompt to the session.

### ask_response
Respond to an `ask` event.

### approval_response
Respond to an `approval` event.

### set_model
Update session model/provider. On success, server emits `config_updated` and persists this selection as the default for new sessions in the current project.

### refresh_provider_status
Request provider status refresh.

### provider_catalog_get
Request provider catalog metadata.

### provider_auth_methods_get
Request supported auth methods.

### provider_auth_authorize
Start provider auth challenge flow.

### provider_auth_callback
Complete provider OAuth callback flow.

### provider_auth_set_api_key
Set provider API key.

### list_tools
Request tool list.

### list_commands
Request command list.

### execute_command
Execute a configured slash command.

### list_skills
Request skill metadata list.

### read_skill
Read skill content.

### disable_skill
Disable a global skill.

### enable_skill
Enable a global skill.

### delete_skill
Delete a global skill.

### set_enable_mcp
Toggle MCP enablement for the session.

### cancel
Cancel current running turn.

### ping
Keepalive ping.

### session_backup_get
Request backup/checkpoint state.

### session_backup_checkpoint
Create a manual checkpoint.

### session_backup_restore
Restore original or checkpointed state.

### session_backup_delete_checkpoint
Delete a named checkpoint.

### harness_context_get
Get current harness context payload.

### harness_context_set
Set harness context payload.

### reset
Reset conversation/todo state.

## Server -> Client Events

### server_hello
Initial handshake event with `sessionId`, config, capabilities, and `protocolVersion`.

### session_settings
Current runtime session settings (for example `enableMcp`).

### provider_catalog
Provider catalog metadata.

### provider_auth_methods
Provider auth method registry.

### provider_auth_challenge
Auth challenge payload for OAuth-style flows.

### provider_auth_result
Auth completion result.

### provider_status
Current provider connection/auth status list.

### session_busy
Busy/idle state transitions for an agent turn.

### user_message
Echoed/accepted user message.

### model_stream_chunk
Incremental model stream chunk.

### assistant_message
Final assistant text for a turn.

### reasoning
Reasoning/summary text stream segment.

### log
Tool/runtime log line.

### todos
Current todo state list.

### reset_done
Confirmation that reset completed.

### ask
Prompt requiring a text/option response.

### approval
Prompt requiring dangerous-command approval.

### config_updated
Updated session public config after runtime changes.

### tools
Tool name list response.

### commands
Command metadata list response.

### skills_list
Skill metadata list response.

### skill_content
Skill content payload response.

### session_backup_state
Backup/checkpoint state updates.

### observability_status
Langfuse observability status.

Payload shape:

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

Notes:

- `config` can be `null` if no observability config is available.
- `health.status` is one of `disabled | ready | degraded`.
- `health.reason` is a stable machine-readable reason code.
- `health.message` is optional and present for degraded states with details.
- Secret values are never sent over this event.

### harness_context
Current harness context state for the session.

### error
Structured protocol/session/provider/runtime error.

### pong
Keepalive pong.
