# Diagnostics

Cowork diagnostics are local-first. Local logs and local diagnostics bundles remain usable even when network telemetry is disabled.

Set `COWORK_DISABLE_NETWORK_TELEMETRY=1` to disable diagnostics uploads. Bundle creation still works, and the upload fetch is not attempted.

## Local Logs

Desktop logs live under Electron `userData/logs`:

| File | Purpose |
| --- | --- |
| `server.log` | Workspace server lifecycle and startup diagnostics. |
| `desktop-main.log` | Electron main-process lifecycle, crash-reporting, analytics, and diagnostics status. |
| `updater.log` | Auto-update checks, availability, download, and error status. |
| `renderer.log` | Reserved for future renderer diagnostics. |

Log writers sanitize metadata before appending. Logs must not contain prompts, completions, transcripts, file contents, shell output, API keys, tokens, cookies, or unsanitized absolute paths.

## Diagnostics Bundle

Users create a bundle from Settings -> Diagnostics -> Create Diagnostics Bundle. The bundle is written as `userData/diagnostics/cowork-diagnostics-<timestamp>.json` and revealed locally.

Included:

- app version, platform, architecture, and packaged/dev mode
- privacy and telemetry toggle states
- desktop feature flag override state
- update state
- recent crash report ids when available
- observability health placeholder when desktop cannot read live health
- workspace count and thread count
- sanitized recent tails from local log files

Excluded:

- transcripts, prompts, completions, and model responses
- shell output and file contents
- workspace absolute paths and filenames
- API keys, access tokens, cookies, and secret-like values
- SQLite databases and other local state files

## Redaction

The shared diagnostics redactor handles:

- home directory and known workspace paths
- access tokens, API keys, bearer tokens, cookies, passwords, and secret-like keys
- email addresses
- oversized strings
- JSON body, payload, transcript, prompt, completion, stdout/stderr, and message fields

Bundle generation only reads an allowlist of local log files and the normalized desktop state counts/settings needed for support.

## Uploads

`diagnosticsUploadEnabled` is consent to allow user-initiated uploads. It is not consent for automatic uploads.

Upload requires all of the following:

- a local diagnostics bundle already exists
- `diagnosticsUploadEnabled` is true in persisted privacy settings
- the user confirms the upload prompt
- `COWORK_DIAGNOSTICS_UPLOAD_URL` is configured
- `COWORK_DISABLE_NETWORK_TELEMETRY` is not truthy

If no upload endpoint is configured, Cowork keeps the bundle local and reveals it in Finder or Explorer. When upload succeeds and the endpoint returns an id or URL, Cowork copies that value for support handoff.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `COWORK_DIAGNOSTICS_UPLOAD_URL` | Optional support endpoint for user-confirmed diagnostics uploads. Must be `http` or `https`. |
| `COWORK_DISABLE_NETWORK_TELEMETRY` | When `1`, `true`, `yes`, or `on`, disables diagnostics upload while preserving local bundle creation. |

Diagnostics upload does not use Sentry, PostHog, Langfuse, or cloud sync credentials. `COWORK_SENTRY_DSN`, `COWORK_POSTHOG_KEY`, `COWORK_POSTHOG_HOST`, `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `COWORK_CLOUD_SYNC_ENDPOINT` do not affect bundle creation.
