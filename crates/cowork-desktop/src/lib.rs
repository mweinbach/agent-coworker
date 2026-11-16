//! Native Cowork desktop application built on Rune.
//!
//! Shared core modules (`theme`, `router`, `actions`, `state`, `ws`, `lib`) are owned by
//! `architect`. Feature modules (`views/chat`, `views/shell`, `views/settings`, `native`) are
//! owned exclusively by their respective swarm authors.

pub mod actions;
pub mod native;
pub mod router;
pub mod shortcuts;
pub mod state;
pub mod theme;
pub mod views;
pub mod ws;

pub use native::menu::{
    ApplicationMenu, ApplicationMenuEntry, ApplicationMenuItem, MenuPlatform, MenuRole,
    build_application_menu, build_application_menu_for_platform, dispatch_menu_command_with_tx,
};
pub use shortcuts::{is_apple_platform, shortcut_label, shortcut_label_for_platform};

use std::cell::RefCell;

use rune::{App, AppHandle, AppSpec, Cx, El, KeyEvent, Titlebar, Tx, Waker, WindowSpec};
use tokio::sync::mpsc;

use crate::actions::{Action, NavAction, ShellAction};
use crate::router::{SettingsPageId, ViewId};
use crate::state::{AppState, WINDOW_QUICK_CHAT, WINDOW_UTILITY, WindowCommand, WindowMode};
use crate::theme::ThemePreference;

#[derive(Default)]
struct SharedWindowHub {
    shared: Option<AppState>,
    main_handle: Option<AppHandle<AppState>>,
    quick_chat_handle: Option<AppHandle<AppState>>,
    utility_handle: Option<AppHandle<AppState>>,
    window_rx: Option<mpsc::UnboundedReceiver<WindowCommand>>,
    wakers: Vec<(WindowMode, Waker)>,
    pending_sync_repaint: [bool; 3],
}

thread_local! {
    static WINDOW_HUB: RefCell<SharedWindowHub> = RefCell::new(SharedWindowHub::default());
}

fn mode_index(mode: WindowMode) -> usize {
    match mode {
        WindowMode::Main => 0,
        WindowMode::QuickChat => 1,
        WindowMode::Utility => 2,
    }
}

fn enter_shared_turn(state: &mut AppState) {
    if state.scene_mode {
        return;
    }
    WINDOW_HUB.with(|cell| {
        let mut hub = cell.borrow_mut();
        if let Some(ref mut shared) = hub.shared {
            state.swap_shared_core(shared);
        }
    });
    if state.reconcile_rekeyed_thread_ids() {
        state.shared_dirty = true;
    }
}

fn leave_shared_turn(state: &mut AppState) {
    if state.scene_mode {
        return;
    }
    let current_mode = state.window_mode;
    let dirty = std::mem::take(&mut state.shared_dirty);
    let mut wake_list: Vec<Waker> = Vec::new();
    WINDOW_HUB.with(|cell| {
        let mut hub = cell.borrow_mut();
        if let Some(ref mut shared) = hub.shared {
            state.swap_shared_core(shared);
        } else if current_mode == WindowMode::Main {
            let mut shared = AppState::default();
            state.swap_shared_core(&mut shared);
            hub.shared = Some(shared);
        } else {
            // Do not seed shared state from a secondary window before Main completes a turn.
            return;
        }
        if dirty {
            let mut dirty_modes = Vec::new();
            for (mode, waker) in &hub.wakers {
                if *mode != current_mode {
                    dirty_modes.push(*mode);
                    wake_list.push(waker.clone());
                }
            }
            for mode in dirty_modes {
                hub.pending_sync_repaint[mode_index(mode)] = true;
            }
        }
    });
    for waker in wake_list {
        (waker)();
    }
}

type SceneEntry = (&'static str, fn(&mut AppState));

static SCENES: &[SceneEntry] = &[
    ("default", scene_default),
    ("light", scene_light),
    ("dark", scene_dark),
    ("settings", scene_settings),
    ("chat", scene_chat),
    ("chat-demo", scene_chat_demo),
    ("quick-chat", scene_quick_chat),
    ("utility", scene_utility),
];

fn apply_scene_env_overrides(state: &mut AppState) {
    state.scene_mode = true;
    if let Ok(raw) = std::env::var("COWORK_ACCENT_PALETTE")
        && let Some(palette) = theme::AccentPalette::parse(&raw)
    {
        state.desktop_settings.accent_palette = palette;
    }
    if let Ok(raw) = std::env::var("COWORK_MENU_BAR_PLATFORM")
        && let Some(platform) = state::DesktopPlatformOverride::parse(&raw)
    {
        state.menu_platform_override = Some(platform);
    }
    if let Ok(raw) = std::env::var("COWORK_SHOW_MENU_BAR") {
        match raw.trim().to_ascii_lowercase().as_str() {
            "0" | "false" | "off" => state.desktop_settings.show_menu_bar = false,
            "1" | "true" | "on" => state.desktop_settings.show_menu_bar = true,
            _ => {}
        }
    }
}

fn scene_default(state: &mut AppState) {
    apply_scene_env_overrides(state);
}

fn scene_light(state: &mut AppState) {
    apply_scene_env_overrides(state);
    state.desktop_settings.theme = ThemePreference::Light;
    state.system_dark_override = Some(false);
}

fn scene_dark(state: &mut AppState) {
    apply_scene_env_overrides(state);
    state.desktop_settings.theme = ThemePreference::Dark;
    state.system_dark_override = Some(true);
}

fn scene_settings(state: &mut AppState) {
    apply_scene_env_overrides(state);
    state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Models,
    ))));
}

fn scene_chat(state: &mut AppState) {
    apply_scene_env_overrides(state);
    state.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Chat)));
}

fn scene_chat_demo(state: &mut AppState) {
    apply_scene_env_overrides(state);
    state.provider_catalog = vec![
        state::ProviderSummary {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            configured: true,
            models: vec![
                state::ProviderModelSummary {
                    id: "claude-sonnet-4-5".to_string(),
                    name: "Claude Sonnet 4.5".to_string(),
                    enabled: true,
                    custom: false,
                    supports_reasoning: true,
                    reasoning_efforts: vec![
                        "low".to_string(),
                        "medium".to_string(),
                        "high".to_string(),
                    ],
                },
                state::ProviderModelSummary {
                    id: "claude-haiku-4-5".to_string(),
                    name: "Claude Haiku 4.5".to_string(),
                    enabled: true,
                    custom: false,
                    supports_reasoning: false,
                    reasoning_efforts: Vec::new(),
                },
            ],
            ..Default::default()
        },
        state::ProviderSummary {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            configured: true,
            models: vec![state::ProviderModelSummary {
                id: "gpt-4.1".to_string(),
                name: "GPT-4.1".to_string(),
                enabled: true,
                custom: false,
                supports_reasoning: false,
                reasoning_efforts: Vec::new(),
            }],
            ..Default::default()
        },
    ];
    let ws_rt = state
        .workspace_runtime_by_id
        .entry("ws-demo".to_string())
        .or_default();
    ws_rt.server_state = state::ServerLifecycleState::Running {
        ws_url: "ws://127.0.0.1:7337/ws".to_string(),
        port: 7337,
    };
    ws_rt.provider_statuses = vec![
        state::ProviderStatusSummary {
            provider: "anthropic".to_string(),
            healthy: true,
            connected: true,
            auth_method: Some("api_key".to_string()),
            ..Default::default()
        },
        state::ProviderStatusSummary {
            provider: "openai".to_string(),
            healthy: true,
            connected: true,
            auth_method: Some("api_key".to_string()),
            ..Default::default()
        },
    ];
    let mut demo_ws = state::WorkspaceRecord::new(
        "ws-demo",
        "Demo Project",
        "/tmp/cowork-demo",
        1_700_000_000_000,
    );
    demo_ws.default_provider = Some("anthropic".to_string());
    demo_ws.default_model = Some("claude-sonnet-4-5".to_string());
    state.workspaces.push(demo_ws);
    state.workspace_order.push("ws-demo".to_string());
    state.active_workspace_id = Some("ws-demo".to_string());
    state.threads.push(state::ThreadRecord {
        id: "th-demo".to_string(),
        workspace_id: "ws-demo".to_string(),
        title: "Rune UI parity audit".to_string(),
        status: state::ThreadStatus::Active,
        session_id: Some("th-demo".to_string()),
        provider: Some("anthropic".to_string()),
        model: Some("claude-sonnet-4-5".to_string()),
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_060_000,
        ..Default::default()
    });
    let rt = state
        .thread_runtime_by_id
        .entry("th-demo".to_string())
        .or_default();
    rt.hydrated = true;
    rt.feed = vec![
        state::FeedItem::Message {
            id: "msg-user-1".to_string(),
            role: state::FeedMessageRole::User,
            content: "Review `theme.rs` and verify the patch diff.".to_string(),
            client_message_id: Some("cm-1".to_string()),
            attachments: Vec::new(),
            references: Vec::new(),
            citations: Vec::new(),
            streaming: false,
            timestamp_ms: 1_700_000_005_000,
        },
        state::FeedItem::Reasoning {
            id: "reason-1".to_string(),
            content: "**Checking theme tokens** Aligning `ButtonVariant::Submit` to warm accent tokens."
                .to_string(),
            mode: "summary".to_string(),
            streaming: false,
            timestamp_ms: 1_700_000_010_000,
        },
        state::FeedItem::Tool {
            id: "tool-read-1".to_string(),
            tool_name: "read_file".to_string(),
            title: Some("Read theme.rs".to_string()),
            call_id: Some("call-1".to_string()),
            status: state::ToolRunStatus::Completed,
            input: serde_json::json!({ "path": "crates/cowork-desktop/src/theme.rs" }),
            output: Some(serde_json::json!({ "lines": 341 })),
            error: None,
            diff: None,
            streaming: false,
            timestamp_ms: 1_700_000_012_000,
            completed_at_ms: Some(1_700_000_013_000),
            output_truncated: false,
        },
        state::FeedItem::Tool {
            id: "tool-agent-1".to_string(),
            tool_name: "spawn_agent".to_string(),
            title: Some("Run reviewer subagent".to_string()),
            call_id: Some("call-agent-1".to_string()),
            status: state::ToolRunStatus::Completed,
            input: serde_json::json!({ "agentId": "sub-rev-1", "name": "reviewer" }),
            output: Some(serde_json::json!({ "agentId": "sub-rev-1", "summary": "Tokens look consistent." })),
            error: None,
            diff: None,
            streaming: false,
            timestamp_ms: 1_700_000_014_000,
            completed_at_ms: Some(1_700_000_016_000),
            output_truncated: false,
        },
        state::FeedItem::Tool {
            id: "tool-diff-1".to_string(),
            tool_name: "apply_patch".to_string(),
            title: Some("Update primary CTA color".to_string()),
            call_id: Some("call-2".to_string()),
            status: state::ToolRunStatus::Completed,
            input: serde_json::json!({ "path": "crates/cowork-desktop/src/theme.rs" }),
            output: None,
            error: None,
            diff: Some(
                concat!(
                    "--- a/crates/cowork-desktop/src/theme.rs\n",
                    "+++ b/crates/cowork-desktop/src/theme.rs\n",
                    "@@ -282,2 +282,4 @@\n",
                    "     kit.c.bg_accent = tok.accent;\n",
                    "+    kit.c.bg_contrast = tok.cta_bg;\n",
                    "+    kit.c.bg_icon_button_contrast = tok.send_bg;\n",
                    "     kit.c.submit_fg = tok.send_on;\n",
                )
                .to_string(),
            ),
            streaming: false,
            timestamp_ms: 1_700_000_018_000,
            completed_at_ms: Some(1_700_000_019_000),
            output_truncated: false,
        },
        state::FeedItem::Message {
            id: "msg-asst-1".to_string(),
            role: state::FeedMessageRole::Assistant,
            content: "### Theme Summary\n\nUpdated primary controls to use warm semantic accent tokens:\n\n- `bg_contrast` now uses `tok.cta_bg` across light, dark, and high-contrast\n- `bg_icon_button_contrast` uses `tok.send_bg` for composer send\n\n```rust\nkit.c.bg_contrast = tok.cta_bg;\n```\n\nReview the pending command approval below to run tests."
                .to_string(),
            client_message_id: None,
            attachments: Vec::new(),
            references: Vec::new(),
            citations: vec![state::CitationSource {
                label: Some("Rune Palette".to_string()),
                title: Some("Cowork Design Tokens".to_string()),
                url: "https://example.invalid/tokens".to_string(),
                domain: Some("example.invalid".to_string()),
                snippet: None,
                reference_id: None,
            }],
            streaming: false,
            timestamp_ms: 1_700_000_025_000,
        },
    ];
    rt.pending_interactions
        .push(state::ChatInteraction::CommandApproval {
            request_id: cowork_protocol::JsonRpcLiteId::Number(42),
            item_id: "cmd-approval-1".to_string(),
            command: Some("cargo test -p cowork-desktop".to_string()),
            cwd: Some("/tmp/cowork-demo".to_string()),
            reason: Some("Verify updated theme and reducer tests".to_string()),
            risk_code: Some("low".to_string()),
        });
    rt.agents.push(state::ThreadAgentSummary {
        agent_id: "sub-rev-1".to_string(),
        name: "reviewer".to_string(),
        nickname: Some("Reviewer".to_string()),
        title: Some("Inspect contrast tokens".to_string()),
        role: Some("verifier".to_string()),
        depth: 1,
        status: "completed".to_string(),
        model: Some("claude-sonnet-4-5".to_string()),
        usage_label: Some("1.2k tok".to_string()),
        started_at: Some(1_700_000_014_000),
        completed_at: Some(1_700_000_016_000),
        error: None,
    });
    rt.agent_run_feeds.insert(
        "sub-rev-1".to_string(),
        vec![state::FeedItem::Message {
            id: "sub-msg-1".to_string(),
            role: state::FeedMessageRole::Assistant,
            content: "Verified WCAG AA contrast for `tok.cta_on` and `tok.send_on` across light, dark, and high-contrast variants."
                .to_string(),
            client_message_id: None,
            attachments: Vec::new(),
            references: Vec::new(),
            citations: Vec::new(),
            streaming: false,
            timestamp_ms: 1_700_000_015_500,
        }],
    );
    state.dispatch(Action::Navigate(NavAction::OpenThread(
        "th-demo".to_string(),
    )));
}

fn scene_quick_chat(state: &mut AppState) {
    apply_scene_env_overrides(state);
    state.dispatch(Action::Shell(ShellAction::SetWindowMode(
        state::WindowMode::QuickChat,
    )));
}

fn scene_utility(state: &mut AppState) {
    apply_scene_env_overrides(state);
    state.dispatch(Action::Shell(ShellAction::SetWindowMode(
        state::WindowMode::Utility,
    )));
}

fn init_state() -> AppState {
    AppState::default()
}

fn init_quick_chat_state() -> AppState {
    AppState {
        window_mode: state::WindowMode::QuickChat,
        ..AppState::default()
    }
}

fn init_utility_state() -> AppState {
    AppState {
        window_mode: state::WindowMode::Utility,
        ..AppState::default()
    }
}

fn setup_app(state: &mut AppState, waker: Waker) {
    if state.scene_mode {
        return;
    }
    state.now_secs = state::wall_clock_epoch_secs();
    let mode = state.window_mode;
    WINDOW_HUB.with(|cell| {
        let mut hub = cell.borrow_mut();
        hub.wakers.retain(|(existing, _)| *existing != mode);
        hub.wakers.push((mode, waker.clone()));
    });
    if mode != WindowMode::Main || state.services.ws_tx.is_some() {
        return;
    }
    state.services.waker = Some(waker.clone());
    let ws_tx = ws::spawn_ws_manager(state.services.event_tx.clone(), Some(waker.clone()));
    let native_tx = native::spawn_native_worker(state.services.event_tx.clone(), Some(waker));
    let (window_tx, window_rx) = mpsc::unbounded_channel();
    state.services.ws_tx = Some(ws_tx);
    state.services.native_tx = Some(native_tx);
    state.services.window_tx = Some(window_tx);
    state.shared_dirty = true;
    WINDOW_HUB.with(|cell| {
        cell.borrow_mut().window_rx = Some(window_rx);
    });
}

fn apply_popup_window_command(
    target: Option<&rune::AppHandle<AppState>>,
    sibling: Option<&rune::AppHandle<AppState>>,
    toggle: bool,
) {
    let Some(target) = target else {
        return;
    };
    if toggle && target.is_visible() {
        target.hide();
        target.wake();
        return;
    }
    if let Some(other) = sibling
        && other.is_visible()
    {
        other.hide();
    }
    target.open();
    target.wake();
}

fn poll_app(state: &mut AppState, now: f64, tx: &mut Tx) -> bool {
    state.app_elapsed_secs = now;
    if !state.scene_mode {
        state.now_secs = state::wall_clock_epoch_secs();
    }
    let mut changed = state.reconcile_rekeyed_thread_ids();
    // Only the primary Main window owns background ws/native event draining in live multi-window mode
    // so secondary windows never steal WS responses or persist stale Main nav state.
    if state.scene_mode || state.window_mode == WindowMode::Main {
        changed |= state.drain_events();
        changed |= state.reconcile_rekeyed_thread_ids();
    }
    if let Some(cmd_id) = state.pending_menu_command.take() {
        changed |= native::menu::dispatch_menu_command_with_tx(state, tx, &cmd_id);
    }
    if !state.scene_mode {
        let mode = state.window_mode;
        let sync_repaint = WINDOW_HUB.with(|cell| {
            let idx = mode_index(mode);
            let mut hub = cell.borrow_mut();
            std::mem::take(&mut hub.pending_sync_repaint[idx])
        });
        if sync_repaint {
            changed = true;
        }
        if state.sync_pending_confirm_dialog_for_window() {
            changed = true;
        }
        if mode == WindowMode::Main {
            let (commands, main_handle, quick_chat_handle, utility_handle) =
                WINDOW_HUB.with(|cell| {
                    let mut hub = cell.borrow_mut();
                    let mut commands = Vec::new();
                    if let Some(ref mut rx) = hub.window_rx {
                        while let Ok(cmd) = rx.try_recv() {
                            commands.push(cmd);
                        }
                    }
                    (
                        commands,
                        hub.main_handle.clone(),
                        hub.quick_chat_handle.clone(),
                        hub.utility_handle.clone(),
                    )
                });
            for cmd in commands {
                match cmd {
                    WindowCommand::OpenQuickChat => {
                        apply_popup_window_command(
                            quick_chat_handle.as_ref(),
                            utility_handle.as_ref(),
                            false,
                        );
                    }
                    WindowCommand::ToggleQuickChat => {
                        apply_popup_window_command(
                            quick_chat_handle.as_ref(),
                            utility_handle.as_ref(),
                            true,
                        );
                    }
                    WindowCommand::OpenUtility => {
                        apply_popup_window_command(
                            utility_handle.as_ref(),
                            quick_chat_handle.as_ref(),
                            false,
                        );
                    }
                    WindowCommand::ToggleUtility => {
                        apply_popup_window_command(
                            utility_handle.as_ref(),
                            quick_chat_handle.as_ref(),
                            true,
                        );
                    }
                    WindowCommand::MinimizeMain => {
                        tx.minimize();
                    }
                    WindowCommand::ToggleMaximizeMain => {
                        tx.toggle_maximized();
                    }
                    WindowCommand::ToggleFullScreenMain => {
                        tx.toggle_full_screen();
                    }
                    WindowCommand::CloseMain => {
                        tx.close_window();
                    }
                    WindowCommand::QuitApp => {
                        tx.quit();
                    }
                    WindowCommand::FocusMain {
                        open_new_chat_workspace,
                        open_thread_id,
                    } => {
                        if open_new_chat_workspace.is_some() || open_thread_id.is_some() {
                            state.apply_main_focus_nav(open_new_chat_workspace, open_thread_id);
                            changed = true;
                        }
                        if let Some(ref handle) = main_handle {
                            native::window_lifecycle::reveal_and_activate_main_window(handle);
                            handle.wake();
                        }
                    }
                }
            }
            native::menu::sync_application_menu(state);
        }
        if let Some(delay) = state.next_canvas_wake_delay_secs() {
            tx.wake_at(state.app_elapsed_secs + delay);
        }
    }
    changed
}

fn handle_key(state: &mut AppState, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if rune_kit::shell::is_sidebar_toggle(ev) {
        state.dispatch(Action::Shell(ShellAction::ToggleSidebar));
        return true;
    }
    views::shell::handle_key(state, ev, tx) || handle_global_menu_shortcut(state, ev, tx)
}

/// Handles global menu bar accelerators that sit outside view-local handlers
/// (Skills `Cmd/Ctrl+Shift+K`, fullscreen `F11` / macOS `Ctrl+Cmd+F`, and non-macOS close/quit).
pub fn handle_global_menu_shortcut(state: &mut AppState, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let platform = state.effective_desktop_platform();
    let overlay_open = state.command_palette_open
        || state.shell_ui.search_overlay_open
        || state.pending_confirm_dialog.is_some()
        || state.pending_external_url.is_some()
        || state.lmstudio_start_modal.is_some()
        || state.agent_viewer.is_some();

    if !overlay_open && ev.is_command('k') && ev.mods.shift && !ev.mods.alt {
        return native::menu::dispatch_menu_command_with_tx(state, tx, "file.open_skills");
    }

    let is_fullscreen = if platform.is_macos() {
        ev.is_command('f') && ev.mods.ctrl && ev.mods.cmd && !ev.mods.alt && !ev.mods.shift
    } else {
        matches!(ev.key, rune::Key::Function(11))
            && !ev.mods.cmd
            && !ev.mods.ctrl
            && !ev.mods.alt
            && !ev.mods.shift
    };
    if is_fullscreen {
        return native::menu::dispatch_menu_command_with_tx(state, tx, "view.toggle_fullscreen");
    }

    if !platform.is_macos() && !overlay_open && !ev.mods.shift && !ev.mods.alt {
        if ev.is_command('w') {
            return native::menu::dispatch_menu_command_with_tx(state, tx, "file.close_window");
        }
        if platform.is_linux() && ev.is_command('q') {
            return native::menu::dispatch_menu_command_with_tx(state, tx, "app.quit");
        }
    }

    false
}

fn root_view(state: &AppState, cx: &mut Cx<AppState>) -> El {
    cx.zoom(state.ui_scale);
    let dark = state.effective_dark(cx.system_dark());
    let (kit, tokens) = theme::build_kit_with_accent(
        dark,
        state.desktop_settings.reduced_transparency,
        state.desktop_settings.high_contrast,
        state.desktop_settings.accent_palette,
    );
    cx.foreground(tokens.text_base);
    cx.focus_ring(2.0, 2.5, tokens.focus_ring);
    cx.web_focus();
    views::shell::view(state, cx, &kit, &tokens)
}

/// Entry points for the headless UI perf harness (`benches/ui_perf.rs`). Not a stable API.
#[doc(hidden)]
pub mod perf_hooks {
    use rune::{Cx, El, Tx};

    use crate::state::AppState;

    /// The Main window's real `view`, as the native loop runs it.
    pub fn root_view(state: &AppState, cx: &mut Cx<AppState>) -> El {
        super::root_view(state, cx)
    }

    /// The Main window's real `poll`, as the native loop runs it before each frame.
    pub fn poll(state: &mut AppState, now: f64, tx: &mut Tx) -> bool {
        super::poll_app(state, now, tx)
    }
}

/// Builds the Rune `AppSpec<AppState>` (also reusable for headless tests).
pub fn app_spec() -> AppSpec<AppState> {
    app_spec_for_mode(state::WindowMode::Main)
}

/// Builds an `AppSpec` tailored to a primary or secondary desktop window mode.
pub fn app_spec_for_mode(mode: state::WindowMode) -> AppSpec<AppState> {
    let (base, min_size) = match mode {
        state::WindowMode::Main => (
            AppSpec::new("Cowork", (1280.0, 820.0), init_state, root_view),
            Some((840.0, 560.0)),
        ),
        state::WindowMode::QuickChat => (
            AppSpec::new(
                "Cowork Quick Chat",
                (440.0, 560.0),
                init_quick_chat_state,
                root_view,
            ),
            Some((360.0, 420.0)),
        ),
        state::WindowMode::Utility => (
            AppSpec::new(
                "Cowork Utility",
                (360.0, 480.0),
                init_utility_state,
                root_view,
            ),
            Some((320.0, 380.0)),
        ),
    };
    AppSpec {
        scenes: SCENES,
        setup: Some(setup_app),
        poll: Some(poll_app),
        on_key: Some(handle_key),
        min_size,
        ..base
    }
}

/// Builds a Rune `WindowSpec` keyed for main, quick-chat, or utility windows.
pub fn window_spec_for_mode(mode: state::WindowMode) -> rune::WindowSpec<AppState> {
    let key = match mode {
        state::WindowMode::Main => "main",
        state::WindowMode::QuickChat => "quick-chat",
        state::WindowMode::Utility => "utility",
    };
    rune::WindowSpec::new(key, app_spec_for_mode(mode))
}

/// Launches the native Cowork desktop app.
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init()
        .ok();

    let main_titlebar_h = crate::theme::layout::SHELL_TOOLBAR_HEIGHT;
    let main_tl_y = ((main_titlebar_h - 14.0) / 2.0).max(0.0).round();
    let mut app = App::new(app_spec())
        .modifier_keys()
        .titlebar(Titlebar::new(main_titlebar_h).traffic_lights(16.0, main_tl_y))
        .keep_running()
        .turn_scope(enter_shared_turn, leave_shared_turn);

    let main_handle = app.handle();

    let quick_chat_app = App::new(app_spec_for_mode(WindowMode::QuickChat))
        .titlebar(Titlebar::new(theme::layout::TITLEBAR_HEIGHT).traffic_lights(14.0, 11.0))
        .windowless()
        .turn_scope(enter_shared_turn, leave_shared_turn)
        .on_window(|window_handle| {
            native::on_window_opened(WINDOW_QUICK_CHAT, window_handle);
        })
        .on_close(|state, tx| {
            native::on_window_close(WINDOW_QUICK_CHAT, state, tx);
        });
    let (quick_chat_handle, _) =
        app.window(WindowSpec::from_app(WINDOW_QUICK_CHAT, quick_chat_app));

    let utility_app = App::new(app_spec_for_mode(WindowMode::Utility))
        .titlebar(Titlebar::new(theme::layout::TITLEBAR_HEIGHT).traffic_lights(14.0, 11.0))
        .windowless()
        .turn_scope(enter_shared_turn, leave_shared_turn)
        .on_window(|window_handle| {
            native::on_window_opened(WINDOW_UTILITY, window_handle);
        })
        .on_close(|state, tx| {
            native::on_window_close(WINDOW_UTILITY, state, tx);
        });
    let (utility_handle, _) = app.window(WindowSpec::from_app(WINDOW_UTILITY, utility_app));

    WINDOW_HUB.with(|cell| {
        let mut hub = cell.borrow_mut();
        hub.main_handle = Some(main_handle);
        hub.quick_chat_handle = Some(quick_chat_handle);
        hub.utility_handle = Some(utility_handle);
    });

    native::configure_app(app).run();
}

#[cfg(test)]
mod menu_shortcut_tests {
    use super::*;
    use rune::{Key, Mods};

    #[test]
    fn global_menu_shortcuts_route_skills_and_platform_fullscreen_cleanly() {
        let mut s = AppState::default();
        let mut tx = Tx::default();

        // Cmd+Shift+K opens Tool Access / Skills.
        let cmd_shift_k = KeyEvent {
            key: Key::Command('k'),
            mods: Mods {
                cmd: true,
                shift: true,
                ..Default::default()
            },
        };
        assert!(handle_global_menu_shortcut(&mut s, &cmd_shift_k, &mut tx));
        assert_eq!(s.route().view, ViewId::Settings);
        assert_eq!(s.route().settings_page, SettingsPageId::ToolAccess);

        // Plain Ctrl+F on Linux/Windows must not trigger macOS Ctrl+Cmd+F fullscreen.
        s.menu_platform_override = Some(state::DesktopPlatformOverride::Linux);
        let linux_ctrl_f = KeyEvent {
            key: Key::Command('f'),
            mods: Mods {
                cmd: true,
                ctrl: true,
                ..Default::default()
            },
        };
        assert!(!handle_global_menu_shortcut(&mut s, &linux_ctrl_f, &mut tx));

        // F11 toggles fullscreen on Linux/Windows.
        let f11 = KeyEvent::from(Key::Function(11));
        assert!(handle_global_menu_shortcut(&mut s, &f11, &mut tx));

        // Ctrl+Cmd+F toggles fullscreen on macOS.
        s.menu_platform_override = Some(state::DesktopPlatformOverride::MacOs);
        let mac_fullscreen = KeyEvent {
            key: Key::Command('f'),
            mods: Mods {
                cmd: true,
                ctrl: true,
                ..Default::default()
            },
        };
        assert!(handle_global_menu_shortcut(
            &mut s,
            &mac_fullscreen,
            &mut tx
        ));
        assert!(!handle_global_menu_shortcut(&mut s, &f11, &mut tx));
    }
}
