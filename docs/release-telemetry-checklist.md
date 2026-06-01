# Telemetry Release Checklist

Use this before publishing a packaged build.

- [ ] Verify no secrets in bundle. Search packaged renderer, preload, and public assets for `LANGFUSE_SECRET_KEY`, API keys, bearer tokens, and private DSNs.
- [ ] Verify the GitHub repository variables exist for release builds: `COWORK_SENTRY_DSN`, `COWORK_POSTHOG_KEY`, `COWORK_POSTHOG_HOST`, `LANGFUSE_BASE_URL`, and `LANGFUSE_PUBLIC_KEY`.
- [ ] Verify packaged defaults off. Fresh packaged state should show Crash reports, Product analytics, and AI traces as disabled or not configured.
- [ ] Verify kill switch. Launch with `COWORK_DISABLE_NETWORK_TELEMETRY=1` and confirm Sentry, PostHog, and Langfuse are disabled while local logs still write.
- [ ] Verify disabled mode produces no network calls. With every telemetry toggle off and with the kill switch active, inspect app/server logs and network tooling for Sentry, PostHog, and Langfuse requests.
- [ ] Verify Sentry/PostHog/Langfuse status display. Privacy & Telemetry should show Crash reports, Product analytics, AI traces, and the global kill switch badge when active.
- [ ] Verify self-host endpoints. Test `COWORK_POSTHOG_HOST` and `LANGFUSE_BASE_URL` in a self-hosted environment.
- [ ] Verify public env values only. `COWORK_SENTRY_DSN`, `COWORK_POSTHOG_KEY`, `COWORK_POSTHOG_HOST`, `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and `COWORK_DISABLE_NETWORK_TELEMETRY` may be present in public config; `LANGFUSE_SECRET_KEY`, `COWORK_DIAGNOSTICS_UPLOAD_URL`, and `COWORK_CLOUD_SYNC_ENDPOINT` must not.
