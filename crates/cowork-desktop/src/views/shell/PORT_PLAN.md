# Desktop Shell Port Plan (`crates/cowork-desktop/src/views/shell/`)

Porting the Electron/React shell around chat from `apps/desktop/src/` to native Rust on Rune (`anomalyco/rune` `dev`) and `rune-kit`. All business logic, persistence, RPC calls, and runtime management remain in `crates/cowork-server` / shared `AppState` actions over WebSocket (`crates/cowork-protocol`).

---

## 1. Proposed Module Layout (`src/views/shell/`)

- `mod.rs` — Shell view entrypoints called by shared root router (`main_shell`, `quick_chat_shell`, `menu_bar_utility_shell`, global overlays host via `rune_kit::root`).
- `layout/`
  - `mod.rs` — Window frame (`ChatScreen` / `SettingsScreen` / `ScreenLoading` top-level switch), adaptive tier computation (`narrow < 720`, `compact < 1120`, `full >= 1120` via `El::on_layout` / `Cx::layout`).
  - `top_bar.rs` — `AppTopBar` (platform traffic-light / caption insets via `Cx::chrome_insets`, window drag region `.window_drag()`, thread title + workspace subtitle, usage/cost details `Popover`, `Busy` spinner, canvas mode/styling/popout/maximize controls, quick-chat & right-rail toggles).
  - `context_sidebar.rs` — Right rail host switching `ContextSidebar` (Plan checklist with stale-turn detection, `WorkflowRunsPanel`, Subagents list/self card, Workspace file explorer slot) vs `TaskContextSidebar` vs `Canvas` pane, plus inline file preview 38%/62% split when canvas is inactive.
  - `banners.rs` — `PrimaryContent` 4-state switch (`starting`, `workspace-startup` -> `WorkspaceRuntimeProgress`, `error` -> `StartupRecovery`, `content`), `ConnectionRecoveryBanner`, startup progress/error banner.
- `sidebar/`
  - `mod.rs` — `Sidebar` wrapper built on `rune_kit::shell::Sidebar`, `PaneState`, `PaneMotion`, `SidebarPeek`: header actions (New Chat, Search `Cmd/Ctrl+K`, Needs Input badge, New Task, Plugins), reorderable `Projects` / `Chats` sections, hidden `oneOffChat` collapse, footer Settings button.
  - `items.rs` — `SidebarWorkspaceItem` (colored project pill, expandable top-5 threads + "Show N more", tasks, `Alt/Meta+Arrow` + drag `Reorder`) & `SidebarThreadItem` (inline `TextEdit` rename, status dot/`!`/spinner/unsent dot, relative age, secondary-press `context_menu` / `ThreadOverflowMenu`).
  - `search.rs` — `SidebarSearchOverlay` dialog (`Cmd/Ctrl+F` / Search row): `TextInput` filter, keyboard Up/Down selection, `Cmd/Ctrl+1..9` direct workspace project filters.
- `palette.rs` — `CommandPalette` (`Cmd/Ctrl+K`) searching Actions, Recent chats (top 8), Tasks, Workspaces (excl. `oneOffChat`), Settings pages, and Enabled skills with arrow/Enter/Esc handling.
- `feedback.rs` — `InAppToasts` using `rune_kit::{ToastStack, ToastRegion, Toast}` + inline claim suppression (`OperationFeedback` parity: suppress duplicate toast while matching `operationKey` is mounted inline; max 3 visible, hover/focus pauses auto-dismiss, persistent errors), plus `OverlayStack` z-order / backdrop coordination.
- `onboarding.rs` — `DesktopOnboarding` 5-step modal wizard (`welcome`, `workspace`, `provider`, `defaults`, `firstThread`) with OAuth / API key / LM Studio setup, 4s provider readiness sync, auto-fix default provider, starter prompts, confirm-on-incomplete-dismiss subdialog, hidden during `runtimeSetupInProgress`.
- `creation.rs` — `CreationReadinessNotice` rendering `pending` spinner + 1s recheck state, `blocked` reasons + repair buttons (`connectProvider`, `openProviderSettings`, `startLmStudio`, `installCodexRuntime`), and error Retry.
- `recovery.rs` — `StartupRecovery` (compact & full-page variants) + `RecoveryDiagnosticsActions` (Retry, Copy diagnostics, Open diagnostics log folder).
- `tasks/`
  - `mod.rs` — `TaskView` switch (`NewTaskLanding` vs `TaskConversationSidebar` + chat slot) and shared `taskPresentation` badges/status mapping.
  - `landing.rs` — `NewTaskLanding` (Brief composer, collapsible Work graph steps, Definition of done, Review toggle, `CreationReadinessNotice`, Recent tasks).
  - `conversation.rs` — `TaskConversationSidebar` (`rune_kit::shell::TabStrip` top thread tabs, Add Task Thread `Dialog`, terminal read-only banner + chat slot).
  - `context.rs` — `TaskContextSidebar` (status/progress, input-resume alert, editable Title/Objective, Requirements checklist, `TaskQuestionsCard` + answer `Dialog`, Work plan DAG dependencies, Blockers, `ArtifactReviewCard`, Decisions, Activity, Review/Pause/Resume/Archive lifecycle actions).
  - `workflows.rs` — `WorkflowRunsPanel` & `WorkflowRunDetailDialog` (latest runs excl. legacy dry runs, phase badges, agent statuses, clickable `agentId` links -> `openAgentThread`, tail/full logs).
- `windows/`
  - `menu_bar.rs` — `MenuBarUtilityShell` (compact header, New Chat, Open Cowork, up to 8 recent chats opening Quick Chat).
  - `quick_chat.rs` — `QuickChatShell` (compact window header with Close, workspace subtitle, New Chat, Open Full App, Esc-to-close, embedded chat slot).

---

## 2. Electron React -> Rune / `rune-kit` Component Mapping

| React Shell Component | Rune / `rune-kit` Target | Key Fidelity Notes |
| --- | --- | --- |
| `ChatScreen`, `SidebarResizer`, `ContextSidebarResizer`, `SidebarCollapseControl` | `rune_kit::shell::SplitView`, `PaneState`, `PaneMotion`, `SidebarToggle`, `SidebarPeek` | Preserve `[160..440]` left and `[200..600]` (task min `360`, canvas `320..900`) ranges; wire `Cx::chrome_insets()` (`leading`, `trailing`, `height`) for macOS traffic lights vs Windows caption reserve (`136px` / collapsed `84px`). |
| `AdaptiveRailSurface` | Custom modal drawer wrapper (`scrim` + animated `Edge::Left`/`Right` `Transition` + `.modal(true, ..)`) | Activated when root viewport width hits `compact` (`< 1120`) for opt-in right rail (canvas/task) or `narrow` (`< 720`) for left rail. |
| `AppTopBar`, `PlatformTopBarChrome` | `rune_kit::shell::Toolbar` + `.window_drag()` + `Popover` (usage/cost details) | Preserve parent/subagent estimated cost breakdown, token `More`/`Summary` toggle, budget hard-cap reset, and canvas Document/Source/Styling/Popout/Maximize controls. |
| `SettingsScreen` / `SettingsContent` | `rune_kit::shell::Page` (`toolbar_in_panel`) + settings slot | Full-window settings view replacing chat sidebar/topbar (`agent_docs/desktop-ui.md`); `Escape` closes when no top modal overlay is active. |
| `Sidebar`, `SidebarSectionFrame`, `SidebarWorkspaceItem`, `SidebarThreadItem` | `rune_kit::shell::Sidebar`, `SidebarSection`, `SidebarRow`, `Reorder` | Reuse `SidebarRow` built-in `.avatar()`, `.subtitle()`, `.status(RowStatus)`, `.renaming()`, `.reorder()`. Group hidden `oneOffChat` records under `Chats`. Use `Sidebar::virtual_rows` if thread lists scale large. |
| `ThreadOverflowMenu` & workspace context menu | `rune_kit::Menu`, `context_menu`, or `tx.popup_menu` (native NSMenu/Win32 when desired) | Prefer `context_menu` / `Menu` for deterministic headless `--tree` + cross-platform styled consistency, or `tx.popup_menu` where native OS context menus are desired (note: `tx.popup_menu` returns `None` on Linux/unsupported without fallback). |
| `SidebarSearchOverlay`, `CommandPalette` | `rune_kit::Dialog` + `TextInput` + `PopupList` / custom keyboard-roved list | Single Tab/arrow focus loop; instant filtering in Rust without JS bridge roundtrip; `Cmd+1..9` workspace filter badges in search. |
| `InAppToasts`, `OperationFeedback` | `rune_kit::{ToastStack, ToastRegion, Toast}` | Maps cleanly: `ToastStack` already implements 3 visible toasts, `PEEK=12`/`SHRINK=0.05` collapse stack, hover expand, and pause-on-hover/hidden timers. Add inline-claim counter map for `OperationFeedback` deduplication. |
| `ConnectionRecoveryBanner`, `WorkspaceRuntimeProgress`, `StartupRecovery` | `rune::col`/`row`, `rune_kit::{Badge, Button, Progress, Spinner, Loader}` | Match exact 3-step runtime setup hierarchy (Download / Verify / Start workspace, formatted bytes & percentage) and compact/full recovery diagnostics actions. |
| `DesktopOnboarding` | `Dialog` + custom animated step body + confirm-close `Dialog` | Preserve 5-step flow, conditional step visibility, starter prompts, and `runtimeSetupInProgress` suppression. |
| `CreationReadinessNotice`, `TaskQuestionsCard`, `ArtifactReviewCard`, `WorkflowRunsPanel` / `Dialog` | `Card`, `Badge`, `Collapsible`, `Button`, `Switch`, `Checkbox`, `RadioGroup`, `Dialog`, `Select` | Keep `Switch` for booleans, `Checkbox` for checklists, clickable `agentId` navigation (`openAgentThread`), artifact version diff/preview/restore/revision flows. |
| `TaskConversationSidebar` tabs | `rune_kit::shell::TabStrip` (`TabOrientation::Horizontal`, `TabOverflow::HORIZONTAL_DEFAULT`) + `Dialog` | Shrink-then-scroll tabs with live edge fades, status dots, and "Add thread" dialog. |
| `MenuBarUtilityShell`, `QuickChatShell` | Secondary `WindowSpec` roots (`rune::run_windows_with_args`) | Render compact shells on secondary `WindowSpec`s keyed `"utility"` and `"quick-chat"` when opened from tray / pop-out button. |

---

## 3. Native Improvements

- **Spring-driven Split Rails & Edge Peek**: Use `PaneMotion` springs + `SidebarPeek` so collapsed left sidebar reveals smoothly on pointer edge hover without re-laying out React DOM, automatically respecting `cx.is_reduced_motion()`.
- **Unified Keyboard Navigation & Instant Filtering**: `Sidebar`'s single-Tab-stop Up/Down/Home/End/type-ahead selection and `CommandPalette` / `SidebarSearchOverlay` sub-millisecond Rust substring filtering without IPC serialization lag.
- **Native Titlebar Integration**: Real `Cx::chrome_insets()` + `.window_drag()` regions + `App::titlebar` / `Chrome::traffic_lights` alignment, plus macOS system accent / increased-contrast (`Cx::system_increased_contrast()`) and font smoothing fidelity.
- **Odometer / Smooth Metric Updates & Status Loops**: `Cycle` / `RollingText` for cost/token counters and phased busy spinners (`rune-motion` synchronized phase across sidebar & top bar).
- **Virtualised Thread Lists**: Zero-lag scrolling (`Sidebar::virtual_rows`) if a workspace accumulates hundreds of threads.

---

## 4. Rune Gaps & Cross-Team Dependencies

1. **Responsive Inline -> Overlay Rail Fallback (`SplitView` gap)**: `rune_kit::shell::SplitView` always treats `sidebar` and `inspector` as inline panes and has no built-in width breakpoints (`< 720px` narrow, `< 1120px` compact).
   - *Mitigation*: Track root viewport width via `El::on_layout` (`[_, _, w, _]`) in shell UI state and swap `SplitView`'s inline `Pane`s to a scrim-backed animated overlay drawer layer when `AdaptiveLayout` resolves `left_overlay` / `right_overlay`.
2. **macOS System Tray (`MenuBarUtilityShell` gap in Rune)**: `rune::tray::Tray` implements Linux (`StatusNotifierItem`/D-Bus) and Windows (`Shell_NotifyIcon`) only — macOS status item & non-activating `NSPanel` positioning are explicitly unsupported in upstream Rune (`crates/rune/src/tray.rs`, `README.md` L1831).
   - *Dependency on `@native` / `@architect`*: `@native` owns macOS `NSStatusBar` / status-item click & anchor coordinates and window lifecycle triggers; `@shell` implements the `MenuBarUtilityShell` and `QuickChatShell` Rune views against `WindowSpec` / window mode in shared core.
3. **Variable-Height Wizard Modal (`Dialog` gap)**: `rune_kit::Dialog` defaults to fixed `h(368.0)` and `.fit()` has no max-height viewport clamp or smooth spring step height transition.
   - *Mitigation*: For `DesktopOnboarding` and `WorkflowRunDetailDialog`, compose on `scrim` + raised card surface (`k.elevation.overlay`, `max_h` constrained, internal `.shrink().min_h(0.0).scroll()`, `El::modal(true, ..)`) with keyed layout motion so step changes animate height smoothly without clipping smaller windows.
4. **File Preview / Canvas Content Rendering in Layout Slots**: `@shell` owns the split layout container (`38%/62%` inline file preview vs `Canvas` / `ContextSidebar`), while `@chat` owns `ChatView` and canvas/preview viewers.
   - *Dependency on `@architect`*: Skeleton `views::mod` / `AppState` should pass child view slots (`chat_view`, `settings_view`, `canvas_view`, `file_preview_view`, `file_explorer_view`) or stable view entrypoints into `views::shell`.
5. **Global Menu Commands & Shortcuts Wiring**: Actions like `Cmd/Ctrl+K` (command palette), `Cmd/Ctrl+.` (cancel busy turn), `Cmd/Ctrl+Shift+B` (`is_sidebar_toggle`), `Escape` dismissal, and native OS menu bar triggers need dispatch hooks in `AppSpec::on_key` / `@native` -> shared `AppState` actions.
6. **UI Testing Verification**: `rune::tooling::headless_run()` renders multi-window `--window KEY` snapshots, `--snap`, `--chrome` (traffic-light overlap check), `--tree`, and `--script` against debug builds (or release with `rune/tooling` enabled) so every shell state can be verified headlessly with no display server.

---

## 5. Headless Verification Plan

Once integrated into `@architect`'s `cowork-desktop` binary:
1. **Static Scene Snapshots (`--snap` + `--theme light|dark` + `--chrome`)** across viewports (`1440x900` full, `960x700` compact, `680x600` narrow, `360x480` utility/quick-chat):
   - Empty landing vs active workspace chat with open/collapsed left & right rails
   - Inline thread rename, workspace reorder, usage/cost popover open
   - `CommandPalette`, `SidebarSearchOverlay`, `DesktopOnboarding` steps 1..5
   - `ToastRegion` stack (1, 3, and inline-claimed suppression) & `ConnectionRecoveryBanner` / `WorkspaceRuntimeProgress` / `StartupRecovery`
   - `NewTaskLanding`, `TaskView` with tabs + `TaskContextSidebar` + `WorkflowRunDetailDialog`
   - `--window quick-chat` and `--window utility`
2. **Structural & Accessibility Assertions (`--tree`)**: Verify `key`, `role`, `label`, modal focus traps, bounds non-overlap (especially traffic lights & Windows caption reserve), and collapsed/expanded dimensions.
3. **Interactive Scripts (`--script`)**: Exercise `Escape` overlay precedence, sidebar drag resize + double-click reset, `Cmd+K` palette filtering/Enter selection, onboarding confirm-discard guard, and narrow-viewport resize -> overlay drawer transition. Compare rendered PNGs side-by-side against Electron (`bun run desktop:web`).
