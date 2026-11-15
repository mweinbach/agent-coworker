//! Redacted desktop support diagnostics bundle exporter matching
//! `apps/desktop/electron/services/diagnostics.ts`.
//!
//! Exports sanitized metadata, anonymized counts, redacted `ServerManagerDiagnostics`, and
//! redacted log tails to `<userData>/diagnostics/cowork-diagnostics-<timestamp>.json` (`0o600`),
//! with explicit confirmation + `COWORK_DISABLE_NETWORK_TELEMETRY` checks before optional upload.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
use cowork_config::{
    canonicalize_sync, ensure_private_dir_sync, env_map_from_process, host_platform,
    is_network_telemetry_globally_disabled, resolve_home_dir, write_text_file_atomic,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::local_logs::{
    DiagnosticsRedactionContext, LocalLogFileName, LocalLogger, redact_diagnostic_text,
    sanitize_log_meta, tail_log,
};
use super::path_boundary::is_path_equal_or_inside;
use super::persistence::{PersistenceService, core_state_from_document};
use super::server_manager::ServerManagerDiagnostics;
use super::shell_ops::{open_in_default_app, reveal_in_os};
use super::updater::DesktopUpdaterService;

const DIAGNOSTICS_DIR_NAME: &str = "diagnostics";
const DIAGNOSTICS_FILE_PREFIX: &str = "cowork-diagnostics-";
const LOG_TAIL_BYTES: usize = 64 * 1024;
const MAX_BUNDLE_BYTES: usize = 5 * 1024 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const PRIVATE_FILE_MODE: u32 = 0o600;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDiagnosticsBundle {
    pub path: PathBuf,
    pub created_at: String,
    pub summary: String,
    pub upload_configured: bool,
    pub upload_enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedDiagnosticsBundle {
    pub uploaded: bool,
    pub path: PathBuf,
    pub diagnostic_id: Option<String>,
    pub url: Option<String>,
    pub message: String,
}

#[derive(Clone)]
pub struct DiagnosticsService {
    user_data_dir: PathBuf,
    is_packaged: bool,
    persistence: Arc<PersistenceService>,
    logger: Arc<LocalLogger>,
    updater: Option<DesktopUpdaterService>,
    server_diagnostics: Arc<dyn Fn() -> ServerManagerDiagnostics + Send + Sync>,
    recent_report_ids: Option<Arc<dyn Fn() -> Vec<String> + Send + Sync>>,
}

impl DiagnosticsService {
    pub fn new(
        user_data_dir: PathBuf,
        is_packaged: bool,
        persistence: Arc<PersistenceService>,
        logger: Arc<LocalLogger>,
        updater: Option<DesktopUpdaterService>,
        server_diagnostics: Arc<dyn Fn() -> ServerManagerDiagnostics + Send + Sync>,
    ) -> Self {
        Self {
            user_data_dir,
            is_packaged,
            persistence,
            logger,
            updater,
            server_diagnostics,
            recent_report_ids: None,
        }
    }

    /// Attaches a provider supplying recent desktop crash report IDs for diagnostics bundles.
    pub fn with_recent_report_ids_provider(
        mut self,
        provider: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    ) -> Self {
        self.recent_report_ids = Some(provider);
        self
    }

    pub fn diagnostics_dir(&self) -> PathBuf {
        self.user_data_dir.join(DIAGNOSTICS_DIR_NAME)
    }

    /// Creates a redacted diagnostics JSON bundle on disk with `0o600` permissions.
    pub fn create_bundle(&self) -> Result<CreatedDiagnosticsBundle> {
        let env = env_map_from_process();
        let doc = self
            .persistence
            .load_state_value()
            .unwrap_or_else(|_| json!({}));
        let core = core_state_from_document(&doc);

        let home_dir = resolve_home_dir(&env, host_platform());
        let workspace_paths: Vec<PathBuf> = core
            .workspaces
            .iter()
            .map(|w| PathBuf::from(&w.path))
            .collect();
        let context = DiagnosticsRedactionContext {
            home_dir: Some(home_dir),
            workspace_paths,
            max_string_length: Some(64 * 1024),
        };

        let mut logs = serde_json::Map::new();
        let mut included_logs = Vec::new();
        for file_name in [
            LocalLogFileName::Server,
            LocalLogFileName::DesktopMain,
            LocalLogFileName::Updater,
            LocalLogFileName::Renderer,
        ] {
            let tail = tail_log(&self.logger.log_path(file_name), LOG_TAIL_BYTES);
            if tail.trim().is_empty() {
                continue;
            }
            let redacted = redact_diagnostic_text(&tail, &context);
            logs.insert(file_name.file_name().to_string(), Value::String(redacted));
            included_logs.push(file_name.file_name().to_string());
        }
        included_logs.sort();

        let thread_count = doc
            .get("threads")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let upload_url = read_upload_url(&env);
        let upload_configured = upload_url.is_some();
        let network_disabled = is_network_telemetry_globally_disabled(&env);
        let upload_enabled =
            !network_disabled && core.settings.privacy_telemetry.diagnostics_upload_enabled;

        let now = Utc::now();
        let created_at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        let file_stamp = now.format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string();

        let server_diag_json =
            serde_json::to_value((self.server_diagnostics)()).unwrap_or(Value::Null);
        let update_state_json = self
            .updater
            .as_ref()
            .and_then(|u| serde_json::to_value(u.get_state()).ok())
            .unwrap_or(Value::Null);
        let privacy_json =
            serde_json::to_value(&core.settings.privacy_telemetry).unwrap_or(Value::Null);
        let ff_json = serde_json::to_value(&core.feature_flags).unwrap_or_else(|_| json!({}));
        let recent_ids: Vec<String> = self
            .recent_report_ids
            .as_ref()
            .map(|provider| provider())
            .unwrap_or_default();

        let bundle = json!({
            "schemaVersion": 1,
            "createdAt": created_at,
            "app": {
                "version": super::resolve_desktop_app_version(),
                "platform": host_platform(),
                "arch": std::env::consts::ARCH,
                "packaged": self.is_packaged,
                "shell": "rune",
            },
            "toggles": sanitize_log_meta(&privacy_json, &context),
            "featureFlagOverrides": sanitize_log_meta(&ff_json, &context),
            "counts": {
                "workspaceCount": core.workspaces.len(),
                "threadCount": thread_count,
            },
            "crashReports": {
                "enabled": core.settings.privacy_telemetry.crash_reports_enabled,
                "recentReportIds": sanitize_log_meta(&json!(recent_ids), &context),
            },
            "updateState": sanitize_log_meta(&update_state_json, &context),
            "sidecarLifecycle": sanitize_log_meta(&server_diag_json, &context),
            "logs": Value::Object(logs),
        });

        let dir = self.diagnostics_dir();
        ensure_private_dir_sync(&dir)
            .map_err(|err| anyhow::anyhow!("Unable to create diagnostics dir: {err}"))?;
        let bundle_path = dir.join(format!("{DIAGNOSTICS_FILE_PREFIX}{file_stamp}.json"));
        let payload = serde_json::to_string_pretty(&bundle)?;
        write_text_file_atomic(&bundle_path, &payload, Some(PRIVATE_FILE_MODE))
            .map_err(|err| anyhow::anyhow!("Failed to write diagnostics bundle: {err}"))?;

        let summary = format!(
            "Created: {created_at}\nVersion: {} ({} {}, packaged: {})\nWorkspaces: {}, Threads: {}\nUpload configured: {}, Upload enabled: {}\nLogs: {}",
            super::resolve_desktop_app_version(),
            host_platform(),
            std::env::consts::ARCH,
            self.is_packaged,
            core.workspaces.len(),
            thread_count,
            upload_configured,
            upload_enabled,
            if included_logs.is_empty() {
                "none".to_string()
            } else {
                included_logs.join(", ")
            }
        );

        let log_meta = json!({
            "workspaceCount": core.workspaces.len(),
            "threadCount": thread_count,
            "includedLogs": included_logs,
        });
        self.logger
            .info("diagnostics", "created diagnostics bundle", Some(&log_meta));

        Ok(CreatedDiagnosticsBundle {
            path: bundle_path,
            created_at,
            summary,
            upload_configured,
            upload_enabled,
        })
    }

    pub fn reveal_bundle(&self, bundle_path: &Path) -> Result<()> {
        let safe = self.validate_bundle_path(bundle_path)?;
        reveal_in_os(&[self.diagnostics_dir()], &safe)
    }

    pub fn open_logs_folder(&self) -> Result<()> {
        let logs_dir = self.logger.logs_dir();
        ensure_private_dir_sync(&logs_dir)
            .map_err(|err| anyhow::anyhow!("Unable to prepare logs directory: {err}"))?;
        let _ = open_in_default_app(std::slice::from_ref(&self.user_data_dir), &logs_dir, false)?;
        Ok(())
    }

    pub async fn upload_bundle(
        &self,
        bundle_path: &Path,
        confirmed: bool,
    ) -> Result<UploadedDiagnosticsBundle> {
        let env = env_map_from_process();
        if is_network_telemetry_globally_disabled(&env) {
            bail!("Diagnostic log uploads are disabled by COWORK_DISABLE_NETWORK_TELEMETRY.");
        }
        let core = self.persistence.load_core_state().unwrap_or_default();
        if !core.settings.privacy_telemetry.diagnostics_upload_enabled {
            bail!("Diagnostic log uploads are disabled.");
        }
        if !confirmed {
            bail!("Diagnostic upload requires explicit confirmation.");
        }

        let safe_path = self.validate_bundle_path(bundle_path)?;
        let Some(endpoint) = read_upload_url(&env) else {
            return Ok(UploadedDiagnosticsBundle {
                uploaded: false,
                path: safe_path,
                diagnostic_id: None,
                url: None,
                message: "No diagnostics upload endpoint is configured. The local bundle is ready."
                    .to_string(),
            });
        };

        let mut opts = OpenOptions::new();
        opts.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.custom_flags(libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = opts.open(&safe_path)?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            bail!("Diagnostics bundle is not a regular file.");
        }
        if meta.len() as usize > MAX_BUNDLE_BYTES {
            bail!("Diagnostics bundle is too large to upload.");
        }

        let mut payload = String::new();
        file.take(MAX_BUNDLE_BYTES as u64 + 1)
            .read_to_string(&mut payload)?;

        let client = reqwest::Client::builder()
            .timeout(UPLOAD_TIMEOUT)
            .build()
            .context("Failed to initialize upload client")?;
        let resp = client
            .post(endpoint)
            .header("content-type", "application/json")
            .body(payload)
            .send()
            .await
            .context("Failed to upload diagnostics bundle")?;

        if !resp.status().is_success() {
            bail!(
                "Diagnostics upload failed with HTTP {}.",
                resp.status().as_u16()
            );
        }

        let parsed: Value = resp.json().await.unwrap_or(Value::Null);
        let diagnostic_id = parsed
            .get("diagnosticId")
            .or_else(|| parsed.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let url = parsed
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        Ok(UploadedDiagnosticsBundle {
            uploaded: true,
            path: safe_path,
            diagnostic_id: diagnostic_id.clone(),
            url: url.clone(),
            message: url
                .or(diagnostic_id)
                .unwrap_or_else(|| "Diagnostics bundle uploaded.".to_string()),
        })
    }

    fn validate_bundle_path(&self, bundle_path: &Path) -> Result<PathBuf> {
        let dir = canonicalize_sync(&self.diagnostics_dir());
        let lstat = fs::symlink_metadata(bundle_path)?;
        if lstat.file_type().is_symlink() || !lstat.is_file() {
            bail!("Diagnostics bundle must be a regular non-symlink file.");
        }
        let name = bundle_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if !name.starts_with(DIAGNOSTICS_FILE_PREFIX) || !name.ends_with(".json") {
            bail!("Invalid diagnostics bundle filename.");
        }
        let canonical = canonicalize_sync(bundle_path);
        if !is_path_equal_or_inside(&dir, &canonical) || canonical == dir {
            bail!("Diagnostics bundle must be inside the diagnostics folder.");
        }
        Ok(canonical)
    }
}

fn read_upload_url(env: &HashMap<String, String>) -> Option<url::Url> {
    let raw = env
        .get("COWORK_DIAGNOSTICS_UPLOAD_URL")
        .map(String::as_str)
        .map(str::trim)?;
    if raw.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    if matches!(parsed.scheme(), "http" | "https") {
        Some(parsed)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::server_manager::{ServerManager, ServerManagerRuntime};
    use tempfile::tempdir;

    #[test]
    fn exported_bundle_redacts_secrets_tokens_and_paths() {
        let tmp = tempdir().unwrap();
        let user_data = tmp.path().join("Cowork");
        let ws = tmp.path().join("secret-project-name");
        fs::create_dir_all(&ws).unwrap();

        let logger = Arc::new(LocalLogger::new(&user_data));
        logger.set_workspace_paths(vec![ws.clone()]);
        logger.info(
            "auth",
            &format!(
                "connecting to http://127.0.0.1:7337/ws?token=super_secret_tok in {}",
                ws.display()
            ),
            Some(&json!({
                "apiKey": "sk-test-secret-1234567890",
                "prompt": "do not include prompts in logs",
                "workspace": ws.to_string_lossy().into_owned(),
            })),
        );
        logger.flush_all();

        let persistence = Arc::new(PersistenceService::new(
            user_data.clone(),
            None,
            true,
            Some(logger.clone()),
        ));
        persistence
            .save_state_value(json!({
                "version": 2,
                "workspaces": [{
                    "id": "ws-1",
                    "name": "Project",
                    "path": ws,
                    "workspaceKind": "project",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastOpenedAt": "2026-01-02T00:00:00.000Z"
                }]
            }))
            .unwrap();

        let mgr = ServerManager::new(
            ServerManagerRuntime {
                user_data_dir: user_data.clone(),
                resources_dir: None,
                current_exe_dir: None,
                repo_root: None,
                is_packaged: false,
            },
            Some(logger.clone()),
            None,
        );

        let svc = DiagnosticsService::new(
            user_data,
            false,
            persistence,
            logger,
            None,
            Arc::new(move || mgr.get_diagnostics()),
        )
        .with_recent_report_ids_provider(Arc::new(|| vec!["evt-abc-123".to_string()]));
        let created = svc.create_bundle().unwrap();
        let contents = fs::read_to_string(&created.path).unwrap();

        assert!(!contents.contains("super_secret_tok"));
        assert!(!contents.contains("sk-test-secret-1234567890"));
        assert!(!contents.contains("secret-project-name"));
        assert!(!contents.contains("do not include prompts in logs"));
        assert!(contents.contains("[redacted]"));
        assert!(contents.contains("[workspace-path]"));

        let parsed: Value = serde_json::from_str(&contents).unwrap();
        assert_eq!(
            parsed["crashReports"]["recentReportIds"],
            json!(["evt-abc-123"])
        );
    }
}
