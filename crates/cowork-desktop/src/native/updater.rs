//! Clean native updater stub matching `apps/desktop/electron/services/updater.ts`
//! until a signed native update feed/channel is wired for Rune builds.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::actions::StoreEvent;
use crate::state::UpdaterState;

use super::local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger};
use super::product_analytics::ProductAnalyticsService;
use super::shell_ops::open_external_url_os;

pub const RELEASE_NOTES_URL: &str = "https://github.com/mweinbach/agent-coworker/releases/latest";
const UNAVAILABLE_MESSAGE: &str = "Automatic in-app updates are unavailable in native builds yet. Open the releases page for updates.";

/// Stubbed update coordinator that exposes deterministic [`UpdaterState`] transitions
/// and safe release-notes external opening.
#[derive(Clone)]
pub struct DesktopUpdaterService {
    state: Arc<Mutex<UpdaterState>>,
    logger: Option<Arc<LocalLogger>>,
    analytics: Option<ProductAnalyticsService>,
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
                current_version: env!("CARGO_PKG_VERSION").to_string(),
                ..UpdaterState::default()
            })),
            logger,
            analytics: None,
            emit,
        }
    }

    pub fn with_analytics(mut self, analytics: ProductAnalyticsService) -> Self {
        self.analytics = Some(analytics);
        self
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
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            ..UpdaterState::default()
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
        if let Some(analytics) = &self.analytics {
            let mut props = BTreeMap::new();
            props.insert("durationMs".into(), json!(0));
            props.insert("status".into(), json!("unavailable"));
            props.insert("updateAvailable".into(), json!(false));
            analytics.capture_event("update_checked", &props);
        }
        (self.emit)(StoreEvent::UpdaterChanged(next));
    }

    pub fn download_update(&self) {
        let next = UpdaterState {
            status: "unavailable".to_string(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            notes: Some(UNAVAILABLE_MESSAGE.to_string()),
            error: None,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            ..UpdaterState::default()
        };
        if let Some(logger) = &self.logger {
            logger.write(
                LocalLogFileName::Updater,
                LocalLogLevel::Info,
                "updater",
                "native update download requested (no signed native feed configured)",
                None,
            );
        }
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = next.clone();
        if let Some(analytics) = &self.analytics {
            let mut props = BTreeMap::new();
            props.insert("durationMs".into(), json!(0));
            props.insert("status".into(), json!("unavailable"));
            analytics.capture_event("update_downloaded", &props);
        }
        (self.emit)(StoreEvent::UpdaterChanged(next));
    }

    pub fn quit_and_install(&self) {
        let next = UpdaterState {
            status: "error".to_string(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            notes: None,
            error: Some(UNAVAILABLE_MESSAGE.to_string()),
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            ..UpdaterState::default()
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
        if let Some(analytics) = &self.analytics {
            let mut props = BTreeMap::new();
            props.insert("status".into(), json!("error"));
            analytics.capture_event("update_install_started", &props);
        }
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

        service.download_update();
        assert_eq!(service.get_state().status, "unavailable");
        assert_eq!(
            service.get_state().current_version,
            env!("CARGO_PKG_VERSION")
        );

        service.quit_and_install();
        assert_eq!(service.get_state().status, "error");
        assert_eq!(events.lock().unwrap().len(), 3);
    }
}
