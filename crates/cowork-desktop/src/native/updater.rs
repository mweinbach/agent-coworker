//! Clean native updater stub matching `apps/desktop/electron/services/updater.ts`
//! until a signed native update feed/channel is wired for Rune builds.

use std::sync::{Arc, Mutex};

use crate::actions::StoreEvent;
use crate::state::UpdaterState;

use super::local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger};
use super::shell_ops::open_external_url_os;

pub const RELEASE_NOTES_URL: &str = "https://github.com/mweinbach/agent-coworker/releases/latest";
const UNAVAILABLE_MESSAGE: &str = "Automatic in-app updates are unavailable in native builds yet. Open the releases page for updates.";

/// Stubbed update coordinator that exposes deterministic [`UpdaterState`] transitions
/// and safe release-notes external opening.
#[derive(Clone)]
pub struct DesktopUpdaterService {
    state: Arc<Mutex<UpdaterState>>,
    logger: Option<Arc<LocalLogger>>,
    emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
}

impl DesktopUpdaterService {
    pub fn new(
        logger: Option<Arc<LocalLogger>>,
        emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(UpdaterState {
                status: "idle".to_string(),
                version: None,
                notes: None,
                error: None,
            })),
            logger,
            emit,
        }
    }

    pub fn get_state(&self) -> UpdaterState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn check_for_updates(&self) {
        let next = UpdaterState {
            status: "unavailable".to_string(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            notes: Some(UNAVAILABLE_MESSAGE.to_string()),
            error: None,
        };
        if let Some(logger) = &self.logger {
            logger.write(
                LocalLogFileName::Updater,
                LocalLogLevel::Info,
                "updater",
                "native update check requested (no signed native feed configured)",
                None,
            );
        }
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = next.clone();
        (self.emit)(StoreEvent::UpdaterChanged(next));
    }

    pub fn quit_and_install(&self) {
        let next = UpdaterState {
            status: "error".to_string(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            notes: None,
            error: Some(UNAVAILABLE_MESSAGE.to_string()),
        };
        if let Some(logger) = &self.logger {
            logger.write(
                LocalLogFileName::Updater,
                LocalLogLevel::Warn,
                "updater",
                "quitAndInstall requested without downloaded native update",
                None,
            );
        }
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = next.clone();
        (self.emit)(StoreEvent::UpdaterChanged(next));
    }

    pub fn open_release_notes(&self) -> anyhow::Result<()> {
        open_external_url_os(RELEASE_NOTES_URL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_and_quit_emit_clean_stub_states() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let service = DesktopUpdaterService::new(
            None,
            Arc::new(move |ev| {
                captured.lock().unwrap().push(ev);
            }),
        );

        assert_eq!(service.get_state().status, "idle");
        service.check_for_updates();
        assert_eq!(service.get_state().status, "unavailable");

        service.quit_and_install();
        assert_eq!(service.get_state().status, "error");
        assert_eq!(events.lock().unwrap().len(), 2);
    }
}
