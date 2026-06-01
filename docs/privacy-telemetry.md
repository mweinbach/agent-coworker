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

## Integration Contract

Integrations must read the normalized desktop setting from `privacyTelemetrySettings` before starting any network telemetry, reporting, upload, or sync work. Missing or malformed settings must be treated as false by calling `normalizePrivacyTelemetrySettings()`.

Disabling a toggle must prevent the corresponding network telemetry from starting. Disabling AI trace diagnostics must also force AI trace payload capture off.

For spawned workspace servers, the desktop app maps normalized AI trace settings to harness env vars. When AI trace diagnostics is off or settings are missing, it forces `AGENT_OBSERVABILITY_ENABLED=false`, forces payload flags false, and strips inherited `LANGFUSE_*` env from the server process. When diagnostics is on, it sets metadata-only tracing by default. The full-payload toggle sets `AGENT_OBSERVABILITY_RECORD_INPUTS=true`, `AGENT_OBSERVABILITY_RECORD_OUTPUTS=true`, and `AGENT_OBSERVABILITY_RECORD_PAYLOADS=true`.

Packaged desktop builds must not start Langfuse tracing without user consent. Source/dev harnesses can still opt in with `AGENT_OBSERVABILITY_ENABLED=true` and Langfuse credentials.

## Feature Flags

Product feature flags in `src/shared/featureFlags.ts` control experimental product surfaces. Privacy and telemetry settings are user consent controls. Future code must not gate privacy consent through experimental feature flags, and it must not treat enabled feature flags as consent for telemetry or cloud sync.
