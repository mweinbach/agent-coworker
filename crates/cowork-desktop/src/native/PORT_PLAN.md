# `crates/cowork-desktop/src/native/` Port Plan

Porting `apps/desktop/electron/{main.ts, ipc.ts, ipc/*, services/*}` to native Rust APIs inside `crates/cowork-desktop/src/native/`, preserving all security boundaries and business-logic separation (desktop as thin client over `cowork-server` JSON-RPC WebSocket).

---

## 1. Service -> Rust Module Mapping

### Slice 1 — Foundation: Server Lifecycle, Persistence, Security, Logging (Implement First)

| Electron / Renderer Source | Rust Module (`src/native/`) | Responsibility & Contracts |
| --- | --- | --- |
| `services/pathBoundary.ts` | `path_boundary.rs` | Canonical/lexical containment checks (`is_path_equal_or_inside`), Windows/macOS case-insensitive prefix matching, reusing `cowork_config::paths`. |
| `services/validation.ts` | `validation.rs` | `assert_safe_id` (`[A-Za-z0-9_-]{1,256}`), `assert_workspace_directory`, `assert_direction`, `assert_within_transcripts_dir`, `assert_no_unapproved_remote_path` (lexical Windows UNC/device rejection pre-stat to prevent NTLM leaks), `assert_path_within_roots`, `assert_directory_entry_within_roots` (`O_NOFOLLOW`-style parent realpath + leaf join). |
| `services/ipcSecurity.ts`, `ipc/workspaceRoots.ts` | `security.rs` | External URL allowlist (`http:`/`https:`/`mailto:`), `WorkspaceRootsController` (approved/persisted/unpersisted roots + transient fs error codes `EACCES`/`EIO`/`ENODEV`/`ENOENT`/`ENXIO`/`EPERM`/`ESTALE`), one-time authorized upload source token & `(dev, ino, size, mtime)` verification. |
| `services/localLogs.ts`, `src/diagnostics/redaction.ts` | `local_logs.rs` | Redacting logger for `logs/{desktop-main,server,renderer,updater}.log` (`0o700` dir, `0o600` files); 5 MiB cap rotating to 1 MiB line-aligned tail; 16 KiB per-record limit; serialized async appends + sync fatal fallback; scrubs workspace/home paths, username, URL query/hash tokens (`?coworkBrowserToken=`), secret keys, and long payloads. |
| `services/persistence.ts`, `services/userDataOverride.ts` | `persistence.rs` | `user_data` path resolution (`COWORK_DESKTOP_USER_DATA_DIR` / `COWORK_ELECTRON_USER_DATA_DIR` dev/test override); legacy `<appData>/desktop` migration; serialized `Mutex`-guarded `load_state`/`save_state`/`update_state`; atomic `0o600` writes; `.corrupt-<ms>` backup on parse failure; full `WorkspaceRecord`/`ThreadRecord` field sanitization preserving explicit settings/inheritance semantics (matching Electron `persistence.ts` + `cowork-server::desktop_state_normalize`); `transcripts/<threadId>.jsonl` read/hydrate/append/delete with safe-ID + root confinement. |
| `services/windowState.ts`, `services/deferredMaximize.ts` | `window_state.rs` | Persists `window-state.json` (`x`, `y`, `width`, `height`, `isMaximized`), debounced (300 ms) saves, flush on close/quit, visible display work-area clamping, minimum size enforcement, deferred maximize until initial live reveal. |
| `services/applyDesktopState.ts` | `apply_desktop_state.rs` | Applies `PersistedState` updates to native integrations (`quickChat` tray/shortcut, feature-flag overrides) and refreshes active window/tray state. |
| `services/sidecar.ts`, `services/desktopBuiltinPaths.ts` | `sidecar.rs` | Resolves `cowork-server` binary (`COWORK_DESKTOP_SIDECAR_PATH` -> `cowork-server-manifest.json` -> packaged target-triple sidecar -> Cargo `target/<triple>/{release,debug}/cowork-server` & `target/{release,debug}/cowork-server`) and `COWORK_BUILTIN_DIR` (`config/defaults.json` dev repo root or packaged `dist`). |
| `services/serverPlatform.ts` | `server_platform.rs` | Platform target-triple naming, detached process-group spawning on Unix, Windows tree termination (`taskkill` / job object / stdin EOF). |
| `services/serverManager.ts` | `server_manager.rs` | Per-workspace `cowork-server --dir <path> --port 0 --json [--mobile-h3] [--yolo]` manager: serialized per-workspace start/stop locks, startup cancellation, timeout (`[5s..300s]`, extended to 300s on `startup_progress` `waiting`/`installing`), JSON-line stdout parser (`startup_progress`, `server_listening`), appends `?coworkBrowserToken=` to WS URL (scrubbing URLs in all logs/diagnostics), `GET /cowork/health` (1500 ms), telemetry env isolation, feature-flag fingerprint reuse checks, multi-window popup/main workspace/thread merge helpers. |
| `services/shutdown.ts` | `shutdown.rs` | App shutdown coordinator: stops all `cowork-server` sidecars (close stdin EOF -> wait 12 s -> process-tree kill -> 1 s grace), flushes `window-state.json` and `local_logs`. |

### Slice 2 — Filesystem Explorer, Watcher, Preview, Native Desktop Integrations

| Electron / Renderer Source | Rust Module (`src/native/`) | Responsibility & Contracts |
| --- | --- | --- |
| `ipc/files.ts` (explorer ops), `services/explorerVisibility.ts` | `explorer.rs` | Workspace root listing, hidden entry filter (`.*`, `~$*`, `node_modules`), mkdir, trash, authorized file upload copy (`O_NOFOLLOW`, 100 MiB cap), plus view-model/actions for `WorkspaceFileExplorer` (tree expansion, 30 s revalidation, 5 s fallback polling when watcher fails, 320 ms folder double-click open). |
| `services/fileEntryRename.ts` | `file_entry_rename.rs` | Per-path serialized non-clobbering rename (`hard_link` / symlink recreate + identity verification + unlink source with rollback), preserving case-only renames on case-insensitive FS. |
| `services/filePreviewRead.ts`, `src/utils/filePreviewRead.ts`, `src/lib/filePreviewKind.ts`, `FilePreviewModal.tsx`, `CodeFilePreview.tsx` | `file_preview_read.rs` + `preview.rs` | Canonical-path + `O_NOFOLLOW` descriptor identity verification (`read_capped_file_preview`, 15 MiB limit, `FileChangeVersion`), binary vs UTF-8 text detection, language/kind classification, native preview helpers/views (`FilePreviewModal` / `CodeFilePreview`). Rich web-only Univer spreadsheets (`.xlsx`) & slides (`.pptx`) return a structured "Open in default app" fallback card. |
| `services/launchableFiles.ts` | `launchable_files.rs` | Detects executables, app bundles, scripts, and POSIX execute bits (`mode & 0o111`); fails closed (`true`) on stat errors; requires explicit user confirmation before `open_path`. |
| `services/workspaceDirectoryWatcher.ts` | `watcher.rs` | `notify` recursive watcher per `(workspaceId, rootPath)` with 40 ms coalescing debounce, normalized `add`/`remove`/`modify`/`rename` events, and exponential backoff restarts (`2s`, `10s`, `30s`; resets after `60s` healthy). |
| `ipc/files.ts` (`openPath`, `revealPath`, `trashPath`, `getPreferredFileApp`), `ipc/system.ts::openExternalUrl` | `shell_ops.rs` | Validated `http`/`https`/`mailto` external opening (`Tx::open_url`), `open_path` with launchable confirmation, `reveal_path` (`open -R` / `explorer /select,` / Linux file manager), `trash_path`, and preferred app lookup (`LaunchServices`/`mdfind` on macOS, registry/`AssocQueryStringW` on Windows, `xdg-mime` on Linux). |
| `services/menu.ts`, `menuTemplate.ts`, `menuCommandDispatcher.ts` | `menu.rs` | `DesktopMenuCommand` buffered queue + dispatcher; macOS app/File/Edit/View/Window/Help + Dock menus via `rune::native_menu`; Windows/Linux accelerator dispatch via window `on_key` / `Shortcut`; context menu adapter via `rune::popup_menu` (macOS/Win) and in-window popup fallback (Linux). |
| `services/quickChatController.ts`, `trayIcon.ts`, `trayImage.ts` | `tray.rs` | Global shortcut via `rune::global_shortcut` (`CmdOrCtrl+Shift+Space`); tray icon via `rune::tray` (Windows/Linux) + macOS status item mitigation; popup/utility window anchoring, blur-hide, and keep-alive rules. |
| `services/windowActivation.ts`, `windowCloseCoordinator.ts`, `windowEnhancements.ts`, `windowChrome/*`, `rendererCrashRecovery.ts` | `window_chrome.rs` & `window_lifecycle.rs` | `PlatformChromeContract` constants (titlebar height, macOS traffic light reserves, Windows caption reserves), Rune `Titlebar`/`ChromeInsets`/`SystemMaterial` mapping, single-window creation lock, reveal & focus, and multi-window close approval coordinator before quit. |
| `services/dialogs.ts`, `ipc/files.ts` (pickers), `ipc/system.ts::confirmAction` | `dialogs.rs` | Wrappers around `rune::file_dialog` (`open_folder`, `open_file`, `save_file`) + structured in-window `ConfirmDialog` requests (confirm action, external-file preview approval, launchable-file warning, unresponsive close). |
| `services/appearance.ts`, `appearancePreferences.ts`, `windowAppearancePaint.ts` | `appearance.rs` | `appearance.json` (`0o600`) persistence for `ThemeSource` (`system`/`light`/`dark`), `SystemAppearance` snapshot from Rune preferences + platform glass/transparency checks. |
| `services/diagnostics.ts`, `telemetryStatus.ts`, `windowsSandboxReadiness.ts` | `diagnostics.rs` | Redacted diagnostics JSON + summary bundle creation under `<userData>/diagnostics/`, reveal/open logs folder, gated upload client, and Windows sandbox `readiness.json` inspection. |
| `services/updateReadyNotification.ts`, `ipc/system.ts::showNotification` | `notifications.rs` | Native notifications via `rune_notify` (macOS bundled `.app` / Windows toast) with graceful fallback to in-app foreground toast notifications on Linux or unbundled dev runs. |
| `services/updater.ts`, `updaterPlatform.ts` | `updater.rs` | Clean stub maintaining `UpdaterState` (`phase: "unavailable"`, current version, platform/arch metadata, release-notes link `https://github.com/mweinbach/agent-coworker/releases/latest`) until a native Rust self-update mechanism is added. |

---

## 2. Crates Used

- **Internal workspace crates**:
  - `cowork-config`: path normalization/canonicalization (`canonicalize_sync`, `normalize_lexical_path`, `is_inside`, `get_one_off_chats_root`), private dirs/files (`ensure_private_dir_sync`, `write_text_file_atomic`), case-sensitivity/platform helpers.
  - `cowork-protocol`: typed JSON-RPC & summary structs reused over WebSocket / workspace state.
  - Note: Keep `cowork-desktop` independent of `cowork-server` as a Rust library dependency so desktop remains a thin client spawning `cowork-server` out-of-process; mirror/align `state.json` schema with `cowork-server/src/desktop_state_normalize.rs` + Electron `persistence.ts`.
- **Rune crates** (core `Cargo.toml` managed by `@architect`):
  - `rune` (needs feature **`native-file-dialog`** enabled alongside defaults for `open_file`/`open_folder`/`save_file`; includes `native_menu`, `popup_menu`, `shortcuts`, `tray`, `open_url`, `dirs`, `quit`, `window`, `system_material`, `platform::preferences`).
  - `rune-kit` (`FileTree`, modal `Dialog`, popup menus).
  - `rune-notify` (native OS notifications where bundled/supported).
- **Existing root workspace dependencies (`Cargo.toml`)**:
  - `tokio` (async process management, timers, shutdown waits), `serde` / `serde_json`, `reqwest` (`/cowork/health` + gated diagnostics upload), `notify` (`"8"`, directory watcher), `chrono`, `uuid`, `url` (`"2"`), `dirs` (`"6"`), `thiserror`, `anyhow`, `parking_lot`, `tracing`, `libc` (Unix `killpg`/signal/permissions), `tempfile` (tests), `hex`.
- **Additional dependencies to request via `@architect` in `Cargo.toml`**:
  - `trash = "5"` (cross-platform OS Trash / Recycle Bin for `trash_path`).
  - Optional (only if `@coordinator`/`@architect` confirm macOS menu-bar tray is required in v1): `tray-icon` or a minimal `#[cfg(target_os = "macos")]` wrapper over `objc2-app-kit` (`NSStatusBar`, already linked transitively by `rune`).

---

## 3. Verified Rune Gaps & Mitigations

Checked against `anomalyco/rune` (`dev` @ `2c4cf4d9`):

1. **No macOS system tray in `rune::tray`** (`crates/rune/src/tray.rs`):
   - Linux (SNI/D-Bus) and Windows (`Shell_NotifyIcon`) are supported; macOS explicitly returns `TrayError::Unsupported`.
   - *Mitigation*: Implement macOS `NSStatusBar` behind a `#[cfg(target_os = "macos")]` native tray adapter (via `tray-icon` or `objc2-app-kit`), or gate macOS menu-bar tray behind a clear feature/status log until Rune adds macOS tray support (flag `@coordinator` if scope changes).
2. **No Windows/Linux native menu bar in `rune::native_menu`** (`crates/rune/src/native_menu/mod.rs`):
   - `set_menu` returns `MenuError::Unsupported` on non-macOS native runs.
   - *Mitigation*: On macOS, install the full app/File/Edit/View/Window/Help + Dock menu via `rune::native_menu`. On Windows/Linux, keep the menu bar hidden (matching Electron) and bind all menu accelerators (`CmdOrCtrl+N`, `CmdOrCtrl+K`, `CmdOrCtrl+Shift+K`, `CmdOrCtrl+,`, `CmdOrCtrl+B`, zoom/fullscreen) in window key handling (`on_key` / `Shortcut`).
3. **No Linux native context menus in `rune::popup_menu`** (`crates/rune/src/popup_menu/mod.rs`):
   - `popup_menu_supported()` is `false` on Linux.
   - *Mitigation*: Use `Tx::popup_menu` on macOS/Windows and render an in-window `rune-kit` / Rune popup menu overlay when `popup_menu_supported()` is `false`.
4. **No native OS alert / confirm box (`dialog.showMessageBox`) in `rune::file_dialog`**:
   - `rune` exposes `open_file`, `open_folder`, and `save_file` (when `native-file-dialog` is enabled) but no multi-button alert dialog.
   - *Mitigation*: Drive confirmations (`confirmAction`, launchable-file warning, external-file preview authorization, unresponsive window close) through an in-window Rune modal queue (`ConfirmDialogRequest`) rendered via `rune-kit::dialog::Dialog`.
5. **No local shell / file-manager / trash / preferred-app APIs in `rune`**:
   - `rune::open_url` validates and opens `http`/`https`/`mailto` URLs only.
   - *Mitigation*: Implement `shell_ops.rs` in `src/native/` for `open_path`, `reveal_path`, `trash_path` (`trash` crate), and preferred app label queries (`LaunchServices`/`mdfind`, Windows `AssocQueryStringW`/registry, `xdg-mime`).
6. **Appearance preferences gaps** (`crates/rune/src/platform/preferences.rs`):
   - Rune provides system dark mode, `reduced_motion()`, `increased_contrast()`, and Windows `SystemContrast`, plus `SystemMaterial::{Glass, Popover}`. It does **not** expose `themeSource` overrides (`system`/`light`/`dark`), `prefersReducedTransparency`, `shouldUseInvertedColorScheme`, or macOS `.sidebar` `NSVisualEffectView`.
   - *Mitigation*: Store `themeSource` in `<userData>/appearance.json` and resolve dark/light inside desktop state; map macOS vibrancy surfaces to `SystemMaterial::Popover`/`Glass`; check OS reduced-transparency where needed.
7. **Notifications on Linux / unbundled macOS dev builds** (`rune-notify`):
   - `rune_notify::available()` is `false` on Linux and unbundled macOS `cargo run` binaries.
   - *Mitigation*: Route `show_notification` through `rune_notify` when available and fall back to the app's in-window toast queue otherwise.
8. **Auto-updater & Rich Web-Only File Previews**:
   - No native Rust auto-updater or Univer/PPTX renderer; stub `updater.rs` cleanly (`unavailable` + release-notes URL) and provide an `"Open in default app"` fallback for spreadsheets/slides.
9. **Cargo workspace `[patch.crates-io]` note for `@architect`**:
   - Rune's root `Cargo.toml` relies on `[patch.crates-io]` entries (`wgpu-hal`, `winit`, `parley_engine`, `accesskit_windows`, `accesskit_macos`) in the Rune repository; `cowork-desktop` must include the required `rune` patches and enable `native-file-dialog` on `rune`.
