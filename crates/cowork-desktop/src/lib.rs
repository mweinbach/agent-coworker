//! Native Cowork desktop application built on Rune.
//!
//! Shared core modules (`theme`, `router`, `actions`, `state`, `ws`, `lib`) are owned by
//! `architect`. Feature modules (`views/chat`, `views/shell`, `views/settings`, `native`) are
//! owned exclusively by their respective swarm authors.

pub mod actions;
pub mod native;
pub mod router;
pub mod state;
pub mod theme;
pub mod views;
pub mod ws;

use rune::{App, AppSpec, Cx, El, KeyEvent, Titlebar, Tx, Waker};

use crate::actions::{Action, NavAction, ShellAction};
use crate::router::{SettingsPageId, ViewId};
use crate::state::AppState;
use crate::theme::ThemePreference;

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

fn scene_default(state: &mut AppState) {
    state.scene_mode = true;
}

fn scene_light(state: &mut AppState) {
    state.scene_mode = true;
    state.desktop_settings.theme = ThemePreference::Light;
    state.system_dark_override = Some(false);
}

fn scene_dark(state: &mut AppState) {
    state.scene_mode = true;
    state.desktop_settings.theme = ThemePreference::Dark;
    state.system_dark_override = Some(true);
}

fn scene_settings(state: &mut AppState) {
    state.scene_mode = true;
    state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
        SettingsPageId::Models,
    ))));
}

fn scene_chat(state: &mut AppState) {
    state.scene_mode = true;
    state.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Chat)));
}

fn scene_chat_demo(state: &mut AppState) {
    state.scene_mode = true;
    state.workspaces.push(state::WorkspaceRecord::new(
        "ws-demo",
        "Demo Project",
        "/tmp/cowork-demo",
        1_700_000_000_000,
    ));
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
            content: "**Checking theme tokens** Aligning `ButtonVariant::Submit` to olive accent."
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
                "--- a/crates/cowork-desktop/src/theme.rs\n\
                 +++ b/crates/cowork-desktop/src/theme.rs\n\
                 @@ -282,4 +282,6 @@\n\
                      kit.c.bg_accent = tok.accent;\n\
                 +    kit.c.bg_contrast = tok.accent;\n\
                 +    kit.c.bg_icon_button_contrast = tok.accent;\n\
                      kit.c.submit_fg = tok.primary_fg;\n"
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
            content: "### Theme Summary\n\nUpdated primary controls to use `tok.accent`:\n\n- `bg_contrast` now uses olive in light/dark\n- `bg_icon_button_contrast` matches composer send\n\n```rust\nkit.c.bg_contrast = tok.accent;\n```\n\nReview the pending command approval below to run tests."
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
            content: "Verified `tok.primary_fg` contrast on `#66763d` and `#a8b963`.".to_string(),
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
    state.scene_mode = true;
    state.dispatch(Action::Shell(ShellAction::SetWindowMode(
        state::WindowMode::QuickChat,
    )));
}

fn scene_utility(state: &mut AppState) {
    state.scene_mode = true;
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
    state.services.waker = Some(waker.clone());
    if state.scene_mode {
        return;
    }
    let ws_tx = ws::spawn_ws_manager(state.services.event_tx.clone(), Some(waker.clone()));
    let native_tx = native::spawn_native_worker(state.services.event_tx.clone(), Some(waker));
    state.services.ws_tx = Some(ws_tx);
    state.services.native_tx = Some(native_tx);
}

fn poll_app(state: &mut AppState, now: f64, _tx: &mut Tx) -> bool {
    state.now_secs = now;
    state.drain_events()
}

fn handle_key(state: &mut AppState, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if rune_kit::shell::is_sidebar_toggle(ev) {
        state.dispatch(Action::Shell(ShellAction::ToggleSidebar));
        return true;
    }
    views::shell::handle_key(state, ev, tx)
}

fn root_view(state: &AppState, cx: &mut Cx<AppState>) -> El {
    let dark = state.effective_dark(cx.system_dark());
    let (kit, tokens) = theme::build_kit(
        dark,
        state.desktop_settings.reduced_transparency,
        state.desktop_settings.high_contrast,
    );
    cx.foreground(tokens.text_base);
    cx.focus_ring(2.0, 2.5, tokens.focus_ring);
    cx.web_focus();
    views::shell::view(state, cx, &kit, &tokens)
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

    let app = App::new(app_spec())
        .titlebar(Titlebar::new(theme::layout::TITLEBAR_HEIGHT).traffic_lights(14.0, 11.0));
    native::configure_app(app).run();
}
