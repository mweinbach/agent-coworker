# Cloud Sync

Cloud sync is a hidden v1 architecture layer. It is opt-in, disabled by default, and separate from Sentry, PostHog, Langfuse, diagnostics uploads, and product analytics.

Set `COWORK_DISABLE_NETWORK_TELEMETRY=1` to disable cloud sync in every process. The local queue remains non-fatal, but the network provider is not created and no sync fetch runs.

## V1 Scope

V1 may emit only one payload type: a sanitized settings snapshot.

Allowed fields:

| Area | Synced data |
| --- | --- |
| Privacy telemetry settings | Boolean toggle states only. Legacy `cloudSyncEnabled` is always serialized as false and is not effective sync consent. |
| Desktop settings | Quick chat icon/shortcut settings, archived chat auto-delete days, and sidebar section order. |
| Feature flags | Explicit desktop feature flag overrides from the known feature flag allowlist. |
| App preferences | `developerMode`, `showHiddenFiles`, and `perWorkspaceSettings`. |
| Provider UI preferences | Safe allowlisted LM Studio UI state, currently only the `enabled` boolean. |

V1 must not sync workspace records, threads, transcripts, session DB rows, prompts, completions, shell commands, shell output, repo contents, file contents, provider auth, MCP credentials, API keys, tokens, local filenames, repo names, product analytics identity, diagnostics bundles, or absolute local paths.

`syncWorkspaceMetadata` and `syncThreads` are disabled-by-default future settings. They must not cause payload emission in v1.

## Configuration

Persisted desktop state contains top-level cloud sync settings:

```json
{
  "cloudSync": {
    "enabled": false,
    "provider": "none",
    "syncSettings": true,
    "syncWorkspaceMetadata": false,
    "syncThreads": false
  }
}
```

Supported environment variables:

| Variable | Purpose |
| --- | --- |
| `COWORK_CLOUD_SYNC_ENABLED` | Enables the hidden sync layer when set to `1`, `true`, `yes`, or `on`. |
| `COWORK_CLOUD_SYNC_ENDPOINT` | Custom/self-hosted HTTP endpoint. Must be `http` or `https`. |
| `COWORK_CLOUD_SYNC_TOKEN` | Optional bearer token read from env only. It is never persisted to desktop state or exposed to the renderer. |
| `COWORK_DISABLE_NETWORK_TELEMETRY` | Disables cloud sync and ignores endpoint/token config when truthy. |

Effective sync is a no-op unless cloud sync is enabled and a custom endpoint is configured.

## Self-Hosted Backend Contract

The v1 custom HTTP provider uses these routes:

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | Returns provider health. |
| `GET /v1/state?scope=settings` | Reads the current remote state for a scope. |
| `POST /v1/patch` | Accepts a versioned patch. |
| `GET /v1/changes?scope=settings&cursor=...` | Returns changes since a cursor. |

All payloads are versioned with `version: 1`. Inbound payloads are schema-validated, unknown fields are ignored, and malformed or wrong-version payloads are ignored.

## Queue Behavior

Cloud sync writes a durable local outbox at `~/.cowork/sync/outbox.jsonl`.

The queue is best-effort and never blocks app usage or local state persistence. Settings sync entries share a dedupe key, so newer safe settings snapshots replace older pending settings snapshots. The outbox is capped at 1000 entries and 2 MiB. Failed pushes retry with exponential backoff capped at five minutes.

Queue and provider errors are logged locally only. They are not sent through product analytics, Sentry, PostHog, or Langfuse.

## Status Labels

The Privacy & Telemetry page reports cloud sync as:

- `Disabled` when sync is off, sync settings are disabled, or `COWORK_DISABLE_NETWORK_TELEMETRY=1`
- `Not configured` when sync is enabled without a custom endpoint
- `Connected` when a custom endpoint is configured and the last status is connected or queued
- `Error` when the last sync operation failed

## Future Thread Sync

Full thread/content sync is out of scope for v1. Future thread sync must be explicitly designed as end-to-end encrypted sync and must not reuse the current settings snapshot payload for prompts, completions, transcripts, shell output, file contents, or local paths.
