//! Native platform integration module (owned by `native`).
//!
//! Replaces `apps/desktop/electron/`: `cowork-server` child process manager, desktop JSON
//! persistence, window state, menus/tray/shortcuts, native file/folder dialogs, path-bounded
//! workspace file explorer & preview backend, notifications, and updater stubs.

use rune::App;
use tokio::sync::mpsc;

use crate::actions::{NativeCommand, StoreEvent};
use crate::state::{AppState, PersistedDesktopState};

/// Configures OS-level window chrome, menus, tray, focus/close/quit handlers on `App`.
pub fn configure_app(app: App<AppState>) -> App<AppState> {
    app.standard_menus().on_quit(|state, _tx| {
        on_shutdown(state);
    })
}

/// Spawns the background native worker thread and returns its `NativeCommand` sender.
///
/// Step 1 stub: emits `StoreEvent::NativeReady` cleanly and exits on `NativeCommand::Shutdown`.
/// `native` implements real persistence, `cowork-server` process supervision, file explorer/preview
/// with path boundaries, dialogs, image byte fetcher, menus, and tray in `src/native/`.
pub fn spawn_native_worker(
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) -> mpsc::UnboundedSender<NativeCommand> {
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();
    let _ = event_tx.send(StoreEvent::NativeReady {
        persisted: Box::new(PersistedDesktopState::default()),
        is_packaged: false,
        system_dark: None,
    });
    if let Some(ref w) = waker {
        w();
    }

    std::thread::Builder::new()
        .name("cowork-native-worker".to_string())
        .spawn(move || {
            while let Some(cmd) = cmd_rx.blocking_recv() {
                match cmd {
                    NativeCommand::Shutdown => break,
                    _ => {
                        if let Some(ref w) = waker {
                            w();
                        }
                    }
                }
            }
        })
        .ok();

    cmd_tx
}

/// Cleanly shuts down background workers and child `cowork-server` processes before exit.
pub fn on_shutdown(state: &mut AppState) {
    state.send_native(NativeCommand::Shutdown);
    state.send_ws(crate::ws::WsCommand::Shutdown);
}
