# Privacy & Telemetry

Cowork is local-first. Privacy and telemetry settings are explicit user consent toggles, not experiment flags. All toggles default to off.

## Toggles

| Setting | Default | Controls |
| --- | --- | --- |
| Crash reports | Off | Optional crash/error reports and basic technical metadata. |
| Anonymous product analytics | Off | Event counts like app opened, workspace added, and turn completed. |
| AI trace diagnostics | Off | Metadata-only Langfuse spans for model, turn, tool timing, and usage diagnostics. |
| Include prompts and responses in AI traces | Off | Full AI trace payload capture. This can only be enabled when AI trace diagnostics is enabled and may include prompts, responses, commands, logs, file paths/names, and other content. |
| Diagnostic log uploads | Off | User-initiated upload of redacted diagnostic bundles. It must never upload automatically. |
| Cloud sync | Off | Sync for selected settings/data only when configured and explicitly enabled. It must not sync repository contents. |

## Never Collect

Later integrations must never collect prompts, model responses, file contents, shell commands, or file paths through crash reports or anonymous product analytics.

Repository contents must never be uploaded or synced through cloud sync. Diagnostic log upload flows must be user-initiated and must redact sensitive values before upload.

Prompts, responses, shell commands, stdout/stderr, transcripts, file paths, and uploaded file names may only be included in AI traces when both `aiTraceTelemetryEnabled` and `aiTracePayloadsEnabled` are true.

## Local Diagnostics

Desktop diagnostics are local-first. The Electron app writes best-effort local logs under the Electron `userData/logs` directory, including `server.log`, `desktop-main.log`, optional `renderer.log`, and `updater.log`.

Local logs must not include prompts, completions, file contents, shell output, API keys, tokens, cookies, or unsanitized absolute paths. Main-process log helpers sanitize metadata before writing and redact home/workspace paths, secret-like fields, emails, JSON bodies, and oversized strings.

Users can create a diagnostics bundle from Settings -> Diagnostics. Bundle generation is local and explicit. The bundle is a redacted JSON file under `userData/diagnostics`; it includes technical metadata, toggle states, update state, counts, and sanitized recent log tails. It excludes transcripts, prompts, completions, shell output, workspace paths, filenames, API keys/tokens, and SQLite databases.

`diagnosticsUploadEnabled` only means the user is allowed to upload a generated diagnostics bundle after pressing an upload button and confirming. It never enables automatic upload. If `COWORK_DIAGNOSTICS_UPLOAD_URL` is not configured, Cowork creates and reveals the local bundle instead of uploading.

## Crash Reports

Crash reports are optional and only start when the Crash reports toggle is on and a Sentry DSN is configured. They cover Electron main, Electron renderer, and the Cowork server sidecar.

Crash reports may include sanitized error names/messages, stack traces, component tags, release/app version, environment, platform, architecture, and whether the desktop app is packaged. The renderer does not enable Sentry session replay, tracing, structured logs, user identification, or AI instrumentation.

Crash reports must never include prompts, completions, file contents, shell commands, stdout/stderr, API keys, auth tokens, cookies, local usernames, or absolute workspace paths. The Sentry wrapper runs `beforeSend` and `beforeBreadcrumb` scrubbing to redact local paths, known workspace/home paths, secret-like keys, request bodies, large payloads, console breadcrumbs, and unsafe automatic breadcrumbs.

Packaged or self-hosted builds can configure crash reports with:

| Variable | Purpose |
| --- | --- |
| `COWORK_SENTRY_DSN` | Preferred Sentry DSN. |
| `SENTRY_DSN` | Fallback DSN when already conventional in the deployment environment. |
| `COWORK_RELEASE` | Preferred release identifier. |
| `SENTRY_RELEASE` | Fallback release identifier. |
| `COWORK_SENTRY_ENVIRONMENT` | Optional environment: `development`, `packaged`, `beta`, or `production`. |

Desktop sidecars do not inherit arbitrary `SENTRY_*` or `COWORK_SENTRY_*` values. The desktop process strips them and passes only the safe crash-reporting env when the user toggle is enabled and a DSN is configured.

## Anonymous Product Analytics

Anonymous product analytics are optional and only start when the Anonymous product analytics toggle is on, a PostHog key is configured, and a random local installation id exists. The installation id is generated with randomness, stored in desktop state, and is not derived from name, email, GitHub username, local username, workspace path, repo name, or machine name. Deleting the persisted desktop state resets it.

Cowork uses the current PostHog Node SDK from main/server code. Renderer code sends allowed product events through the desktop bridge instead of loading a separate analytics SDK. Product analytics calls are fire-and-forget and must not block UI or turn execution.

Configured variables:

| Variable | Purpose |
| --- | --- |
| `COWORK_POSTHOG_KEY` | PostHog project key. If missing, product analytics are a no-op. |
| `COWORK_POSTHOG_HOST` | Optional PostHog host. Defaults to the PostHog US ingest host. |
| `COWORK_RELEASE` | Optional release/app version override. |
| `COWORK_POSTHOG_ENVIRONMENT` | Optional environment bucket: `development`, `packaged`, `beta`, `production`, or `test`. |

Exact event list:

| Event | Purpose |
| --- | --- |
| `app_started` | App startup counts and enabled feature/toggle states. |
| `app_updated` | Local app version changed since the previous analytics-enabled run. |
| `workspace_added` | Workspace was added. |
| `workspace_removed` | Workspace was removed. |
| `workspace_server_started` | Desktop workspace server started or was reused. |
| `workspace_server_failed` | Desktop workspace server failed to start. |
| `provider_connected` | Provider auth/config completed. |
| `provider_auth_failed` | Provider auth/config failed. |
| `turn_started` | A user turn started. |
| `turn_completed` | A user turn completed. |
| `turn_failed` | A user turn failed. |
| `tool_approval_requested` | A tool approval prompt was shown. |
| `mcp_server_added` | An MCP server config was added or updated. |
| `mcp_server_validation_failed` | MCP server validation failed. |
| `plugin_installed` | A plugin was installed or imported. |
| `skill_installed` | One or more skills were installed or imported. |
| `quick_chat_opened` | Quick chat window was opened. |
| `mobile_pairing_started` | Mobile pairing flow started. |
| `mobile_pairing_completed` | Mobile pairing connected. |
| `update_checked` | Update check completed or failed. |
| `update_downloaded` | Update was downloaded. |
| `update_install_started` | Update install/restart was requested. |

Allowed product analytics properties are limited in code to: `appVersion`, `platform`, `arch`, `packaged`, `eventSource`, `provider`, `model`, `durationMs`, `status`, `errorCategory`, `workspaceCount`, `threadCount`, `providerCount`, `mcpServerCount`, `pluginCount`, `skillCount`, `toolCount`, `attachmentCount`, `referenceCount`, `productAnalyticsEnabled`, `crashReportsEnabled`, `aiTraceTelemetryEnabled`, `aiTracePayloadsEnabled`, `diagnosticsUploadEnabled`, `cloudSyncEnabled`, `mcpEnabled`, `yoloEnabled`, `quickChatIconEnabled`, `quickChatShortcutEnabled`, `mobilePairingEnabled`, `hasAttachments`, `hasReferences`, `remoteAccessEnabled`, `openAiNativeConnectorsEnabled`, and `updateAvailable`.

Property values are capped by type and length. Counts and durations are bounded. String values are restricted to safe short slugs, versions, provider names, status/error categories, or hosted model ids. Local model paths are rejected.

Product analytics must never capture prompts, responses, transcripts, file contents, filenames, absolute paths, repo names, shell commands, stdout/stderr, API keys, auth tokens, cookies, email addresses, usernames, provider keys, local usernames, or machine names. The sanitizer rejects unknown property names, sensitive-looking property names, email/secret-looking values, URL values, and path-looking values before sending.

To disable product analytics, turn off Anonymous product analytics or omit `COWORK_POSTHOG_KEY`. Desktop sidecars strip inherited `POSTHOG_*` and `COWORK_POSTHOG_*` values and pass only the safe product analytics env when the user toggle is enabled and a key plus anonymous installation id are available.

PostHog remote feature flags must not override privacy settings. Events are sent with feature flag capture disabled and person-profile processing disabled.

## Integration Contract

Integrations must read the normalized desktop setting from `privacyTelemetrySettings` before starting any network telemetry, reporting, upload, or sync work. Missing or malformed settings must be treated as false by calling `normalizePrivacyTelemetrySettings()`.

Disabling a toggle must prevent the corresponding network telemetry from starting. Disabling AI trace diagnostics must also force AI trace payload capture off.

For spawned workspace servers, the desktop app maps normalized AI trace settings to harness env vars. When AI trace diagnostics is off or settings are missing, it forces `AGENT_OBSERVABILITY_ENABLED=false`, forces payload flags false, and strips inherited `LANGFUSE_*` env from the server process. When diagnostics is on, it sets metadata-only tracing by default. The full-payload toggle sets `AGENT_OBSERVABILITY_RECORD_INPUTS=true`, `AGENT_OBSERVABILITY_RECORD_OUTPUTS=true`, and `AGENT_OBSERVABILITY_RECORD_PAYLOADS=true`.

Packaged desktop builds must not start Langfuse tracing without user consent. Source/dev harnesses can still opt in with `AGENT_OBSERVABILITY_ENABLED=true` and Langfuse credentials.

## Feature Flags

Product feature flags in `src/shared/featureFlags.ts` control experimental product surfaces. Privacy and telemetry settings are user consent controls. Future code must not gate privacy consent through experimental feature flags, and it must not treat enabled feature flags as consent for telemetry or cloud sync.
