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

fn init_state() -> AppState {
    AppState::default()
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

fn handle_key(state: &mut AppState, ev: &KeyEvent, _tx: &mut Tx) -> bool {
    if rune_kit::shell::is_sidebar_toggle(ev) {
        state.dispatch(Action::Shell(ShellAction::ToggleSidebar));
        return true;
    }
    false
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
    AppSpec {
        scenes: SCENES,
        setup: Some(setup_app),
        poll: Some(poll_app),
        on_key: Some(handle_key),
        min_size: Some((840.0, 560.0)),
        ..AppSpec::new("Cowork", (1280.0, 820.0), init_state, root_view)
    }
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
