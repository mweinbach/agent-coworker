# Privacy & Telemetry

Cowork is local-first. Network telemetry is off by default in packaged public builds and only starts when the user enables the relevant Privacy & Telemetry toggle and the matching integration is configured.

All network telemetry and cloud sync share the resolver in `src/telemetry/config.ts`. Set `COWORK_DISABLE_NETWORK_TELEMETRY=1` to disable Sentry, PostHog, Langfuse, diagnostics upload, and cloud sync in every process. Local logs and local diagnostics bundle creation still work.

## Toggles

| Setting | Default | Exact persisted key | Controls |
| --- | --- | --- | --- |
| Crash reports | Off | `crashReportsEnabled` | Optional Sentry crash/error reports. |
| Anonymous product analytics | Off | `productAnalyticsEnabled` | Optional PostHog product event counts. |
| AI trace diagnostics | Off | `aiTraceTelemetryEnabled` | Optional Langfuse model/turn/tool timing traces. |
| Include prompts and responses in AI traces | Off | `aiTracePayloadsEnabled` | Full Langfuse payload capture. Only works when AI trace diagnostics is enabled. |

## Status Labels

The desktop Privacy & Telemetry page shows resolver-backed network telemetry status labels:

| Integration | Labels |
| --- | --- |
| Crash reports | `Disabled`, `Not configured`, `Enabled` |
| Product analytics | `Disabled`, `Not configured`, `Enabled` |
| AI traces | `Disabled`, `Metadata only`, `Full payload`, `Not configured` |

When `COWORK_DISABLE_NETWORK_TELEMETRY=1`, the page also shows a global kill switch message.

The page does not expose diagnostic-upload or cloud-sync controls/status rows. Diagnostic bundles remain local unless initiated from diagnostics tooling, and cloud sync is managed by its own hidden/self-hosted configuration path.

## Packaging Modes

| Mode | Default behavior |
| --- | --- |
| `local-dev` | Env vars may opt in for local testing and harness development. Missing config remains a no-op. |
| `packaged-public` | All network telemetry defaults off. Public keys in the build are not enough; user consent is still required. |
| `self-hosted` | Sentry, PostHog, Langfuse, diagnostics upload, and cloud sync endpoints can come from runtime env or config. |
| `enterprise/offline` | `COWORK_DISABLE_NETWORK_TELEMETRY=1` disables every network telemetry and sync path. |

## Environment Variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `COWORK_DISABLE_NETWORK_TELEMETRY` | All network telemetry and cloud sync | Truthy values: `1`, `true`, `yes`, `on`. Forces everything networked off. |
| `COWORK_SENTRY_DSN` | Crash reports | Public DSN for Sentry. No secret DSN should be committed. |
| `COWORK_POSTHOG_KEY` | Product analytics | Public PostHog project key. |
| `COWORK_POSTHOG_HOST` | Product analytics | Optional self-hosted PostHog host. |
| `LANGFUSE_BASE_URL` | AI traces | Optional Langfuse Cloud or self-hosted base URL. |
| `LANGFUSE_PUBLIC_KEY` | AI traces | Public Langfuse key. Safe for server and build-time public config. |
| `LANGFUSE_SECRET_KEY` | AI traces | Secret key. Allowed only in local-dev, self-hosted, or harness/server runtime environments. It must never be embedded into public renderer, preload, or browser bundles. |
| `COWORK_DIAGNOSTICS_UPLOAD_URL` | Diagnostics upload | Optional support upload endpoint. Ignored under the kill switch. |
| `COWORK_CLOUD_SYNC_ENDPOINT` | Cloud sync | Optional custom/self-hosted sync endpoint. Ignored under the kill switch. |

Existing local-dev and sidecar envs are still honored when policy allows them: `COWORK_CRASH_REPORTS_ENABLED`, `COWORK_PRODUCT_ANALYTICS_ENABLED`, `AGENT_OBSERVABILITY_ENABLED`, `AGENT_OBSERVABILITY_RECORD_INPUTS`, `AGENT_OBSERVABILITY_RECORD_OUTPUTS`, `AGENT_OBSERVABILITY_RECORD_PAYLOADS`, `COWORK_CLOUD_SYNC_ENABLED`, and `COWORK_CLOUD_SYNC_TOKEN`.

## Data Never Collected

Crash reports and product analytics must never collect prompts, model responses, transcripts, file contents, shell commands, stdout/stderr, local filenames, repo names, workspace paths, provider auth, MCP credentials, API keys, tokens, cookies, email addresses, local usernames, or machine names.

Diagnostics bundles are local unless the user explicitly uploads them. The bundle redactor removes home/workspace paths, secret-like fields, emails, JSON bodies, prompts, completions, stdout/stderr, oversized strings, and local paths.

AI traces are metadata-only unless both `aiTraceTelemetryEnabled` and `aiTracePayloadsEnabled` are true. Full payload traces can include prompts, responses, commands, logs, file paths or names, and other content, so the full payload toggle stays off by default.

Cloud sync is not telemetry. V1 sync may only emit a sanitized settings snapshot and must not sync threads, transcripts, prompts, completions, shell output, files, auth, tokens, local paths, repo names, diagnostics bundles, or analytics identity.

## Event Schemas

Crash reports may include sanitized error names/messages, stack traces, component tags, release/app version, environment, platform, architecture, and packaged/dev mode. Sentry session replay, tracing, structured logs, user identification, and AI instrumentation are disabled for crash reporting.

Product analytics event names are fixed in `src/telemetry/productAnalytics.ts`:

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

Allowed product analytics properties are limited to short technical fields such as app version, platform, architecture, packaged mode, event source, provider/model identifiers, duration, status/error category, safe counts, and enabled feature/toggle booleans. Unknown property names, path-looking values, URL values, email addresses, and secret-looking values are rejected before sending.

## Disabling Everything

To disable every network telemetry and sync path:

```sh
COWORK_DISABLE_NETWORK_TELEMETRY=1 bun run start
```

In packaged or enterprise deployments, set `COWORK_DISABLE_NETWORK_TELEMETRY=1` in the launch environment. This disables Sentry, PostHog, Langfuse, diagnostics upload fetches, and cloud sync provider creation. Local logs and local diagnostics bundle creation remain available for offline support.
