//! OS desktop notification integration via `rune_notify`.

use std::sync::Arc;

use serde_json::json;

use super::local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger};

const APP_NOTIFICATION_ID: &str = "ai.cowork.desktop";
const APP_NOTIFICATION_NAME: &str = "Cowork";

/// Posts silent OS notifications when permitted/supported, failing gracefully otherwise.
#[derive(Clone, Default)]
pub struct DesktopNotificationService {
    logger: Option<Arc<LocalLogger>>,
}

impl DesktopNotificationService {
    pub fn new(logger: Option<Arc<LocalLogger>>) -> Self {
        Self { logger }
    }

    pub fn initialize(&self, handle: Option<rune::AppHandle<crate::state::AppState>>) {
        let identity = rune_notify::Identity::new(APP_NOTIFICATION_ID, APP_NOTIFICATION_NAME);
        if let Err(err) = rune_notify::register(&identity)
            && let Some(logger) = &self.logger
        {
            let meta = json!({ "error": err });
            logger.write(
                LocalLogFileName::DesktopMain,
                LocalLogLevel::Warn,
                "notifications",
                "failed to register native notification identity",
                Some(&meta),
            );
        }

        rune_notify::on_click(move |_click| {
            rune_notify::bring_to_front();
            if let Some(ref h) = handle {
                h.focus();
            }
        });
    }

    /// Shows an OS notification when available. Returns false in headless/unbundled runs.
    pub fn show(&self, id: &str, title: &str, body: &str) -> bool {
        let trimmed_title = title.trim();
        if trimmed_title.is_empty() {
            return false;
        }
        if !rune_notify::available() {
            if let Some(logger) = &self.logger {
                let meta = json!({ "title": trimmed_title, "supported": false });
                logger.info(
                    "notifications",
                    "skipping native notification (unavailable in current launch mode)",
                    Some(&meta),
                );
            }
            return false;
        }

        let mut note = rune_notify::Notification::new(id, trimmed_title);
        let trimmed_body = body.trim();
        if !trimmed_body.is_empty() {
            note = note.body(trimmed_body);
        }
        let posted = rune_notify::post(&note);
        if !posted && let Some(logger) = &self.logger {
            let meta = json!({ "id": id, "title": trimmed_title });
            logger.warn(
                "notifications",
                "native notification was declined by OS",
                Some(&meta),
            );
        }
        posted
    }
}
