# Packaged Telemetry

Packaged releases must be safe by default. A public build may contain public project keys, but Cowork still must not initialize Sentry, PostHog, or Langfuse unless resolver policy allows it. Diagnostics upload and cloud sync are not part of this release setup.

## Modes

| Mode | Intended use | Default |
| --- | --- | --- |
| `local-dev` | Source checkout and harness development. | Env vars may opt in. Missing config remains no-op. |
| `packaged-public` | Public signed desktop release. | Network telemetry off until user toggle plus matching public config exists. |
| `self-hosted` | Internal or customer-controlled deployment. | Runtime env/config may point to self-hosted endpoints. |
| `enterprise/offline` | Locked-down or offline deployment. | `COWORK_DISABLE_NETWORK_TELEMETRY=1` forces all network telemetry off. |

## Build And Runtime Environment

Safe public values may be supplied at build time for Electron main/preload:

| Variable | Safe for public build? | Notes |
| --- | --- | --- |
| `COWORK_SENTRY_DSN` | Yes | Sentry public DSN. |
| `COWORK_POSTHOG_KEY` | Yes | PostHog public project key. |
| `COWORK_POSTHOG_HOST` | Yes | Optional PostHog host. |
| `LANGFUSE_BASE_URL` | Yes | Optional Langfuse base URL. |
| `LANGFUSE_PUBLIC_KEY` | Yes | Langfuse public key. |
| `COWORK_DISABLE_NETWORK_TELEMETRY` | Yes | Packaged/offline kill switch. |
| `LANGFUSE_SECRET_KEY` | No | Secret key. Use only in local-dev, self-hosted, or harness/server runtime env. Never embed in renderer/preload/browser bundles. |

The renderer and preload receive only safe resolver output. `LANGFUSE_SECRET_KEY`, diagnostics upload endpoints, cloud sync endpoints, and cloud sync tokens are stripped from public build config even when present in server or main-process runtime env.

The desktop release workflow expects these GitHub repository variables:

- `COWORK_SENTRY_DSN`
- `COWORK_POSTHOG_KEY`
- `COWORK_POSTHOG_HOST`
- `LANGFUSE_BASE_URL`
- `LANGFUSE_PUBLIC_KEY`

The workflow fails the public desktop package build if those variables are missing or if `LANGFUSE_SECRET_KEY`, `COWORK_DIAGNOSTICS_UPLOAD_URL`, or `COWORK_CLOUD_SYNC_ENDPOINT` are present in the build environment.

## Integration Defaults

| Integration | Packaged-public behavior |
| --- | --- |
| Sentry crash reports | Disabled unless Crash reports is on and `COWORK_SENTRY_DSN` exists. |
| PostHog product analytics | Disabled unless Anonymous product analytics is on, `COWORK_POSTHOG_KEY` exists, and an anonymous installation id exists. |
| Langfuse AI traces | Disabled unless AI trace diagnostics is on and `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and runtime-only `LANGFUSE_SECRET_KEY` exist. Metadata-only unless full payload toggle is on. |

SDKs must not initialize when disabled or not configured. Disabled/no-config paths must not throw. Langfuse runtime imports `@langfuse/otel` and `@opentelemetry/sdk-node` only after consent, credentials, and kill-switch checks pass.

## Release Notes

Telemetry release notes for packaged builds:

- Packaged public builds default all network telemetry off.
- User toggles are required before Sentry, PostHog, or Langfuse can start.
- `COWORK_DISABLE_NETWORK_TELEMETRY=1` disables Sentry, PostHog, and Langfuse globally.
- Local logs and local diagnostics bundle creation remain available while the kill switch is active.
- Self-hosted deployments can configure `COWORK_POSTHOG_HOST` and `LANGFUSE_BASE_URL`.
- `LANGFUSE_SECRET_KEY` is server/main/harness runtime-only and must not be present in public renderer, preload, or browser bundles.
