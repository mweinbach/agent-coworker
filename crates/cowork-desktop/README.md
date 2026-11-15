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

## Module Ownership Layout

All product/session/tool logic lives in `crates/cowork-server` and `crates/cowork-harness`. Within `crates/cowork-desktop/`:

| Area | Owner | Modules |
| --- | --- | --- |
| Shared core & integration | `architect` | `Cargo.toml`, `src/main.rs`, `src/lib.rs`, `src/actions.rs`, `src/router.rs`, `src/shortcuts.rs`, `src/state.rs`, `src/theme.rs`, `src/ws.rs`, `tests/e2e_roundtrip.rs` |
| Chat views | `chat` | `src/views/chat/` — landing, virtualized feed, markdown, activity/tool cards, approvals/questions, composer, attachments, agent run viewer |
| App shell & overlays | `shell` | `src/views/shell/` — main/quick-chat/utility shells, top bar, sidebar, command palette, search, onboarding, toasts, task views, context inspector, inline preview |
| Settings | `settings` | `src/views/settings/` — settings shell and pages (`models`, `subagents`, `toolAccess`, `defaults`, `profileMemory`, `remoteAccess`, `backup`, `chats`, `usage`, `privacyTelemetry`, `desktop`, `updates`, `experiments`, `diagnostics`) |
| Native host integration | `native` | `src/native/` — sidecar lifecycle, state persistence, path/root security, redacting local logs, file explorer/watcher/preview, OS dialogs, menus, tray/global shortcut, notifications, diagnostics, remote access, updater stub |
