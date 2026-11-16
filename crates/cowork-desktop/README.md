# Cowork Native Desktop (`crates/cowork-desktop`)

Native Rust desktop client for Cowork built on [Rune](https://github.com/anomalyco/rune). Like the Electron app (`apps/desktop/`), it is a thin UI client that spawns and communicates with a per-workspace `cowork-server` sidecar over typed JSON-RPC WebSockets (`crates/cowork-protocol`).

## Running

From the repository root:

```bash
bun run desktop:rune
```

`bun run desktop:rune` builds `cowork-server` and launches `cowork-desktop`, forwarding any extra arguments after `--`:

```bash
bun run desktop:rune -- --scene chat-demo --theme dark
```

Or run directly with Cargo:

```bash
cargo build -p cowork-server --bin cowork-server
cargo run -p cowork-desktop --bin cowork-desktop
```

Relevant environment overrides:

- `COWORK_DESKTOP_SIDECAR_PATH` — explicit path to a prebuilt `cowork-server` binary (by default, dev builds resolve `target/debug/cowork-server` or `target/release/cowork-server`)
- `COWORK_DESKTOP_USER_DATA_DIR` — isolated user-data directory for dev/test runs (`state.json`, `logs/`, `diagnostics/`)
- `COWORK_DISABLE_RUNTIME=1` / `COWORK_RUNTIME_ALLOW_NETWORK=0` — disable managed runtime downloads in offline or mock-provider runs

## Headless Scenes & Tooling

`crates/cowork-desktop` embeds named Rune scenes for offscreen rendering, element-tree inspection, and chrome checks without opening a window.

List registered scenes:

```bash
cargo run --quiet -p cowork-desktop --bin cowork-desktop -- --list-scenes
```

Registered scenes (`crates/cowork-desktop/src/lib.rs`):

- `default` — default desktop landing state
- `light` — forced light theme
- `dark` — forced dark theme
- `settings` — full-window settings route (`models`)
- `chat` — chat route
- `chat-demo` — populated thread with markdown, tool runs, diffs, subagents, citations, and pending approval
- `quick-chat` — compact Quick Chat shell (`WindowMode::QuickChat`)
- `utility` — compact Menu Bar Utility shell (`WindowMode::Utility`)

Common headless checks:

```bash
cargo run --quiet -p cowork-desktop --bin cowork-desktop -- --scene chat-demo --theme dark --chrome --snap /tmp/cowork-chat.png
cargo run --quiet -p cowork-desktop --bin cowork-desktop -- --scene settings --size 1280x820 --tree /tmp/cowork-settings.json
```

Run crate tests and the live `cowork-server` end-to-end roundtrip test:

```bash
cargo test -p cowork-desktop
cargo build -p cowork-server --bin cowork-server && cargo test -p cowork-desktop --test e2e_roundtrip -- --ignored
```

### UI performance harness

`benches/ui_perf.rs` drives the Main window's real `view` and `poll` in a headless Rune runtime over a long-thread fixture (60 threads, two with 400 feed items each, 40 skills). It reports per-step CPU frame time: the input or state change, `poll`, and the commit/layout/paint-instance build. It does not measure GPU upload or presentation. Scenarios: `open_thread`, `switch_thread`, `streaming`, `typing`, `scroll`, `settings`, `resize`, `idle`.

```bash
cargo bench -p cowork-desktop --bench ui_perf                         # optimized, all scenarios
cargo bench -p cowork-desktop --bench ui_perf -- typing scroll        # a subset
cargo bench -p cowork-desktop --bench ui_perf -- --items 600 --json /tmp/ui-perf.json
cargo bench --profile dev -p cowork-desktop --bench ui_perf           # the `cargo run` profile
```

`idle` should report zero commits. If it reports more, something in `poll` claims a change that no view reads. `settle` and `frames` are the median CPU time and frame count from the end of a navigation step until the runtime rests; a pane swap should rest within a frame or two. For a per-commit view/layout/text/apply breakdown, set `RUNE_COMMIT_BUDGET_MS=1`. Compare builds with paired, alternating runs on a quiet machine, using the median.

## Module Ownership Layout

All product/session/tool logic lives in `crates/cowork-server` and `crates/cowork-harness`. Within `crates/cowork-desktop/`:

| Area | Owner | Modules |
| --- | --- | --- |
| Shared core & integration | `architect` | `Cargo.toml`, `src/main.rs`, `src/lib.rs`, `src/actions.rs`, `src/router.rs`, `src/shortcuts.rs`, `src/state.rs`, `src/theme.rs`, `src/ws.rs`, `tests/e2e_roundtrip.rs` |
| Chat views | `chat` | `src/views/chat/` — landing, virtualized feed, markdown, activity/tool cards, approvals/questions, composer, attachments, agent run viewer |
| App shell & overlays | `shell` | `src/views/shell/` — main/quick-chat/utility shells, top bar, sidebar, command palette, search, onboarding, toasts, task views, context inspector, inline preview |
| Settings | `settings` | `src/views/settings/` — settings shell and pages (`models`, `subagents`, `toolAccess`, `defaults`, `profileMemory`, `remoteAccess`, `backup`, `chats`, `usage`, `privacyTelemetry`, `desktop`, `updates`, `experiments`, `diagnostics`) |
| Native host integration | `native` | `src/native/` — sidecar lifecycle, state persistence, path/root security, redacting local logs, file explorer/watcher/preview, OS dialogs, menus, tray/global shortcut, notifications, diagnostics, remote access, Minisign auto-updater |

## Packaging & releases

Native desktop installers, signed archives, and updater feeds are built with `cargo-packager` (`0.11.8`), replacing `electron-builder` without putting packaging metadata in `crates/cowork-desktop/Cargo.toml`.

- **Local unsigned macOS build** (creates `.app`, `.dmg`, `-mac.zip`, and `.app.tar.gz` under `target/rune-package/<platformKey>/out/`):
  ```bash
  bun run desktop:rune:package -- --unsigned
  ```
- **Packaging inputs**: [`crates/cowork-desktop/packaging/Packager.toml`](packaging/Packager.toml) (shared identity `com.cowork.desktop`, product `Cowork`, min macOS `12.0`), `entitlements.mac.plist`, and icons under `packaging/icons/`. Runtime staging pulls `dist/{prompts,config,skills,workflows}`, the target `cowork-server` sidecar + `cowork-server-manifest.json`, `tray/icon.{png,ico}`, and (on Windows) `windows-sandbox/` helpers with refreshed `cowork-win-sandbox.sha256.json` hashes.
- **Release pipeline**: [`.github/workflows/desktop-rune-release.yml`](../../.github/workflows/desktop-rune-release.yml) builds all 6 targets (`macos-{aarch64,x86_64}`, `windows-{x86_64,aarch64}`, `linux-{x86_64,aarch64}`) on `desktop-rune-v*` tags or `workflow_dispatch`, Minisign-signs updater payloads, and aggregates `updater-fragment-*.json` into `latest.json` via [`scripts/desktop_rune_release_manifest.ts`](../../scripts/desktop_rune_release_manifest.ts).

### CI Secrets & Variables

- **Updater feed (Minisign)**:
  - `vars.COWORK_UPDATER_PUBKEY`: Minisign public key compiled into `cowork-desktop` (`COWORK_UPDATER_PUBKEY` / `CARGO_PACKAGER_SIGN_PUBLIC_KEY`).
  - `secrets.CARGO_PACKAGER_SIGN_PRIVATE_KEY`: Minisign private key used to sign `.app.tar.gz`, `*-setup.exe`, and `*.AppImage` updater payloads.
  - `secrets.CARGO_PACKAGER_SIGN_PRIVATE_KEY_PASSWORD`: Password for encrypted Minisign private keys (optional).
- **macOS signing & Apple notarization**:
  - `secrets.APPLE_CERTIFICATE` (or `CSC_LINK`) + `secrets.APPLE_CERTIFICATE_PASSWORD` (or `CSC_KEY_PASSWORD`), and optional `secrets.APPLE_SIGNING_IDENTITY`.
  - App Store Connect API key: `secrets.APPLE_API_KEY` (Key ID, or PEM key content when paired with `secrets.APPLE_API_KEY_ID`) + `secrets.APPLE_API_ISSUER` (or `APPLE_API_KEY_ISSUER`) + `APPLE_API_KEY_PATH` when passed via path; or Apple ID fallback (`secrets.APPLE_ID`, `secrets.APPLE_PASSWORD` / `APPLE_APP_SPECIFIC_PASSWORD`, `secrets.APPLE_TEAM_ID`).
- **Windows Authenticode**:
  - `secrets.WIN_CSC_LINK` + `secrets.WIN_CSC_KEY_PASSWORD` (PFX base64/path + password), or `secrets.WINDOWS_CERTIFICATE_THUMBPRINT`, or `secrets.WINDOWS_SIGN_COMMAND` (`CARGO_PACKAGER_WINDOWS_SIGN_COMMAND`).
- **Optional build-time telemetry (`vars`)**:
  - `COWORK_SENTRY_DSN`, `COWORK_SENTRY_ENVIRONMENT`, `COWORK_POSTHOG_KEY`, `COWORK_POSTHOG_HOST`, `COWORK_POSTHOG_ENVIRONMENT`.
