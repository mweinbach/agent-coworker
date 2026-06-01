# Privacy & Telemetry

Cowork is local-first. Privacy and telemetry settings are explicit user consent toggles, not experiment flags. All toggles default to off.

## Toggles

| Setting | Default | Controls |
| --- | --- | --- |
| Crash reports | Off | Optional crash/error reports and basic technical metadata. |
| Anonymous product analytics | Off | Event counts like app opened, workspace added, and turn completed. |
| AI trace diagnostics | Off | High-level model, turn, and tool timing metadata used to debug AI behavior. |
| Include prompts and responses in AI traces | Off | Optional AI trace payload capture. This can only be enabled when AI trace diagnostics is enabled. |
| Diagnostic log uploads | Off | User-initiated upload of redacted diagnostic bundles. It must never upload automatically. |
| Cloud sync | Off | Sync for selected settings/data only when configured and explicitly enabled. It must not sync repository contents. |

## Never Collect

Later integrations must never collect prompts, model responses, file contents, shell commands, or file paths through crash reports or anonymous product analytics.

Repository contents must never be uploaded or synced through cloud sync. Diagnostic log upload flows must be user-initiated and must redact sensitive values before upload.

Prompts and responses may only be included in AI traces when both `aiTraceTelemetryEnabled` and `aiTracePayloadsEnabled` are true.

## Integration Contract

Integrations must read the normalized desktop setting from `privacyTelemetrySettings` before starting any network telemetry, reporting, upload, or sync work. Missing or malformed settings must be treated as false by calling `normalizePrivacyTelemetrySettings()`.

Disabling a toggle must prevent the corresponding network telemetry from starting. Disabling AI trace diagnostics must also force AI trace payload capture off.

This PR only defines the settings foundation. It must not initialize Sentry, PostHog, Langfuse, or any other cloud SDK.

## Feature Flags

Product feature flags in `src/shared/featureFlags.ts` control experimental product surfaces. Privacy and telemetry settings are user consent controls. Future code must not gate privacy consent through experimental feature flags, and it must not treat enabled feature flags as consent for telemetry or cloud sync.
