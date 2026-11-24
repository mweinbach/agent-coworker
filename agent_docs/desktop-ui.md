# Desktop UI (Native Rune)

Load this file when working in `crates/cowork-desktop/`.

## Key files

| Concern | Location |
|---|---|
| Entrypoint & scene registry | `crates/cowork-desktop/src/lib.rs`, `crates/cowork-desktop/src/main.rs` |
| Theme tokens & platform chrome | `crates/cowork-desktop/src/theme.rs`, `crates/cowork-desktop/src/native/window_chrome.rs` |
| App state & action dispatch | `crates/cowork-desktop/src/state.rs`, `crates/cowork-desktop/src/actions.rs` |
| Navigation & settings router | `crates/cowork-desktop/src/router.rs` |
| Reconnecting WS JSON-RPC client | `crates/cowork-desktop/src/ws.rs` |
| Sidecar & server lifecycle | `crates/cowork-desktop/src/native/sidecar.rs`, `crates/cowork-desktop/src/native/server_manager.rs` |
| Workspace/thread persistence & legacy import | `crates/cowork-desktop/src/native/persistence.rs` |
| Native host security & path confinement | `crates/cowork-desktop/src/native/security.rs`, `crates/cowork-desktop/src/native/path_boundary.rs` |
| Chat views & composer | `crates/cowork-desktop/src/views/chat/` |
| Shell, sidebar, top bar, overlays | `crates/cowork-desktop/src/views/shell/` |
| Settings pages & primitives | `crates/cowork-desktop/src/views/settings/` |
| Packaging & release bridge | `crates/cowork-desktop/packaging/Packager.toml`, `scripts/desktop_rune_package.ts` |

## Architecture & thin-client rule

- Keep `crates/cowork-desktop` thin. Product logic, session state, tools, approvals, and persistence of canonical session data belong in `crates/cowork-server` and `crates/cowork-harness`, exposed over typed JSON-RPC (`crates/cowork-protocol`).
- Desktop-only host concerns (window chrome, menus, tray/quick-chat surfaces, OS dialogs, local state persistence, file explorer/watcher/preview, Minisign updater) live in `crates/cowork-desktop/src/native/`.
- Preserve existing desktop data migration (`crates/cowork-desktop/src/native/persistence.rs`) so upgrades from legacy packaged installs keep workspaces, threads, onboarding completion, and local transcripts intact.

## Running & verifying Rune UI changes

- Launch directly with Cargo (no Bun/JS install required):
  ```bash
  cargo build -p cowork-server --bin cowork-server
  cargo run -p cowork-desktop --bin cowork-desktop
  ```
- Or via root Bun shortcut: `bun run start` (alias: `bun run desktop:rune`).
- Inspect headless scenes (`default`, `light`, `dark`, `settings`, `chat`, `chat-demo`, `quick-chat`, `utility`, `tasks`) using `--snap` and `--tree`. Always pair `--scene` with `--snap` or `--tree`; on its own it opens a real window. `COWORK_SCENE_SETTINGS_PAGE=<route segment>` shows another Settings page, and `COWORK_SCENE_POPUP=model|effort` opens the composer popovers in `chat-demo`:
  ```bash
  cargo run --quiet -p cowork-desktop --bin cowork-desktop -- --scene chat-demo --theme dark --chrome --snap /tmp/cowork-chat.png
  cargo run --quiet -p cowork-desktop --bin cowork-desktop -- --scene settings --size 1280x820 --tree /tmp/cowork-settings.json
  COWORK_SCENE_SETTINGS_PAGE=desktop cargo run --quiet -p cowork-desktop --bin cowork-desktop -- --scene settings --snap /tmp/cowork-settings-desktop.png
  ```
- Run crate unit tests, bridge profile continuity checks, and live sidecar roundtrip:
  ```bash
  cargo test -p cowork-desktop
  cargo build -p cowork-server --bin cowork-server && cargo test -p cowork-desktop --test e2e_roundtrip -- --ignored
  ```
- Run UI frame-time microbenchmarks (`crates/cowork-desktop/benches/ui_perf.rs`) on a quiet machine when changing view/layout hot paths.

## Desktop UI patterns

- Treat Settings as a full-window shell: its navigation replaces the chat sidebar and its page chrome replaces the thread top bar.
- When both a menu-bar/tray utility window and a quick chat window exist (`WindowMode::Utility` vs `WindowMode::QuickChat`), treat them as separate surfaces.
- For macOS menu bar and Windows tray features, verify the packaged app bundles and resolves the tray assets (`tray/icon.{png,ico}`) under unsigned host packaging (`bun run desktop:rune:package -- --unsigned`); dev-only checks are not enough.
- When both an installed app and a repo-local app bundle exist, verify the exact on-disk bundle path for the running process instead of trusting the shared app name or bundle ID.
- For sidebar project new-chat affordances, open the new-chat landing with the clicked project preselected; do not immediately create a project draft unless the user explicitly asks for instant draft creation.
- Make sure all platform-specific desktop behavior is handled and tested explicitly across macOS, Windows, and Linux.
