# Telemetry Release Checklist

Use this before publishing a packaged build.

- [ ] Verify no secrets in bundle. Search packaged renderer, preload, and public assets for `LANGFUSE_SECRET_KEY`, cloud sync tokens, API keys, bearer tokens, and private DSNs.
- [ ] Verify packaged defaults off. Fresh packaged state should show Crash reports, Product analytics, AI traces, Diagnostics upload, and Cloud sync as disabled or not configured.
- [ ] Verify kill switch. Launch with `COWORK_DISABLE_NETWORK_TELEMETRY=1` and confirm Sentry, PostHog, Langfuse, diagnostics upload, and cloud sync are disabled while local logs still write.
- [ ] Verify disabled mode produces no network calls. With every toggle off and with the kill switch active, inspect app/server logs and network tooling for Sentry, PostHog, Langfuse, diagnostics, and cloud sync requests.
- [ ] Verify diagnostics bundle redaction. Create a bundle with known prompts, paths, emails, tokens, and shell output in local logs; confirm the bundle redacts them and excludes transcripts/databases.
- [ ] Verify Sentry/PostHog/Langfuse status display. Privacy & Telemetry should show Crash reports, Product analytics, AI traces, Diagnostics upload, Cloud sync, and the global kill switch badge when active.
- [ ] Verify self-host endpoints. Test `COWORK_POSTHOG_HOST`, `LANGFUSE_BASE_URL`, `COWORK_DIAGNOSTICS_UPLOAD_URL`, and `COWORK_CLOUD_SYNC_ENDPOINT` in a self-hosted environment.
- [ ] Verify public env values only. `COWORK_SENTRY_DSN`, `COWORK_POSTHOG_KEY`, `COWORK_POSTHOG_HOST`, `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `COWORK_DIAGNOSTICS_UPLOAD_URL`, `COWORK_CLOUD_SYNC_ENDPOINT`, and `COWORK_DISABLE_NETWORK_TELEMETRY` may be present in public config; `LANGFUSE_SECRET_KEY` must not.
