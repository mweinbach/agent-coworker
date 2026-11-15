//! Native cross-platform desktop auto-updater backed by `cargo-packager` signed feeds (`latest.json`).
//!
//! Mirrors Electron's `apps/desktop/electron/services/updater.ts` lifecycle:
//! - Gates automatic/manual update checks behind packaged builds with a valid Minisign pubkey
//!   (and `APPIMAGE` presence on packaged Linux).
//! - Polls `{feed_url}` (`latest.json`) 10 seconds after launch and every 6 hours thereafter.
//! - Maps missing feeds (HTTP 404 or missing target platform entry) to `"disabled"` so local or
//!   pre-release packaged builds stay quiet instead of surfacing transient errors.
//! - Streams release payloads to a staging file with real byte/speed progress updates, verifies
//!   Minisign signatures before staging any executable bundle, and notifies the OS on readiness.
//! - Defers platform installation/relaunch until [`DesktopUpdaterService::execute_pending_install_on_shutdown`]
//!   runs after `ShutdownCoordinator` stops sidecar servers and flushes logs/window state.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use flate2::read::GzDecoder;
use minisign_verify::{PublicKey, Signature};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;
use tar::Archive;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use url::{Host, Url};
use uuid::Uuid;

use crate::actions::StoreEvent;
use crate::state::UpdaterState;

use super::local_logs::{LocalLogger, strip_url_secrets};
use super::notifications::DesktopNotificationService;
use super::product_analytics::ProductAnalyticsService;
use super::resolve_desktop_app_version;
use super::shell_ops::open_external_url_os;

/// Official GitHub releases landing page opened by "View release notes".
pub const RELEASE_NOTES_URL: &str = "https://github.com/mweinbach/agent-coworker/releases/latest";

/// Default signed feed manifest published by release CI (`cargo-packager` `latest.json` format).
pub const DEFAULT_UPDATE_FEED_URL: &str =
    "https://github.com/mweinbach/agent-coworker/releases/latest/download/latest.json";

const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(10);
const AUTOMATIC_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const FEED_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PROGRESS_EMIT_MIN_INTERVAL: Duration = Duration::from_millis(120);
const MAX_FEED_BYTES: usize = 1024 * 1024;
const MAX_UPDATE_PAYLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_EXTRACTED_BUNDLE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_RELEASE_NOTES_CHARS: usize = 8 * 1024;

const DISABLED_UNPACKAGED_REASON: &str = "Updates are only available in packaged builds.";
const DISABLED_NO_PUBKEY_REASON: &str =
    "Auto-updates are unavailable because no signing public key is configured.";
const DISABLED_LINUX_NO_APPIMAGE_REASON: &str =
    "Updates are only available in AppImage builds on Linux.";
const DISABLED_MISSING_FEED_REASON: &str =
    "Updates are unavailable for this platform because no update feed is published.";

/// Target platform characteristics used to select feed entries and install strategy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdaterTarget {
    /// Target OS identifier (`"macos"`, `"windows"`, `"linux"`).
    pub os: String,
    /// Target CPU architecture (`"aarch64"`, `"x86_64"`).
    pub arch: String,
    /// Running AppImage file path on Linux when `$APPIMAGE` is populated.
    pub appimage_path: Option<PathBuf>,
    /// Current executable path used to locate `.app` bundle on macOS or binary on Windows.
    pub current_exe: Option<PathBuf>,
    /// Optional target install path override used in hermetic tests.
    pub install_root_override: Option<PathBuf>,
}

impl UpdaterTarget {
    /// Captures host target metadata from compile-time OS/arch and process environment.
    pub fn host() -> Self {
        let os = match std::env::consts::OS {
            "macos" => "macos",
            "windows" => "windows",
            other => other,
        }
        .to_string();
        let arch = match std::env::consts::ARCH {
            "x86_64" | "amd64" => "x86_64",
            "aarch64" | "arm64" => "aarch64",
            other => other,
        }
        .to_string();
        let appimage_path = std::env::var_os("APPIMAGE")
            .filter(|raw| !raw.is_empty())
            .map(PathBuf::from);
        Self {
            os,
            arch,
            appimage_path,
            current_exe: std::env::current_exe().ok(),
            install_root_override: None,
        }
    }

    /// Ordered candidate keys checked inside `latest.json`'s `platforms` map.
    pub fn candidate_platform_keys(&self) -> Vec<String> {
        let primary = format!("{}-{}", self.os, self.arch);
        let mut keys = vec![primary];
        if self.os == "macos" {
            keys.push(format!("darwin-{}", self.arch));
        }
        keys
    }
}

/// Verified update payload staged on disk awaiting shutdown installation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedInstall {
    pub version: String,
    pub format: String,
    pub staged_path: PathBuf,
    pub target: UpdaterTarget,
}

pub type QuitTrigger = Arc<dyn Fn() + Send + Sync>;
pub type InstallHandler = Arc<dyn Fn(&PreparedInstall) -> Result<()> + Send + Sync>;

/// Runtime configuration controlling [`DesktopUpdaterService`] feed, trust root, and scheduling.
#[derive(Clone)]
pub struct UpdaterConfig {
    pub is_packaged: bool,
    pub current_version: String,
    pub feed_url: String,
    pub pubkey: Option<String>,
    pub startup_delay: Duration,
    pub poll_interval: Duration,
    pub staging_dir: Option<PathBuf>,
    pub target: UpdaterTarget,
    pub request_quit: Option<QuitTrigger>,
    pub install_handler: Option<InstallHandler>,
    pub relaunch_after_install: bool,
}

impl Default for UpdaterConfig {
    fn default() -> Self {
        Self::from_build_env(false)
    }
}

impl UpdaterConfig {
    /// Builds default desktop configuration using build-time env fallbacks.
    pub fn from_build_env(is_packaged: bool) -> Self {
        let feed_url = option_env!("COWORK_UPDATER_FEED_URL")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_UPDATE_FEED_URL)
            .to_string();
        let pubkey = option_env!("COWORK_UPDATER_PUBKEY")
            .or(option_env!("CARGO_PACKAGER_SIGN_PUBLIC_KEY"))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);

        Self {
            is_packaged,
            current_version: resolve_desktop_app_version().to_string(),
            feed_url,
            pubkey,
            startup_delay: STARTUP_CHECK_DELAY,
            poll_interval: AUTOMATIC_CHECK_INTERVAL,
            staging_dir: None,
            target: UpdaterTarget::host(),
            request_quit: None,
            install_handler: None,
            relaunch_after_install: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseManifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub_date: Option<String>,
    #[serde(default)]
    platforms: BTreeMap<String, PlatformAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct PlatformAsset {
    url: String,
    signature: String,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingDownload {
    version: String,
    notes: Option<String>,
    url: String,
    signature: String,
    format: String,
}

#[derive(Debug, Clone)]
struct RuntimeInner {
    state: UpdaterState,
    pending_download: Option<PendingDownload>,
    prepared_install: Option<PreparedInstall>,
    notified_version: Option<String>,
    staging_root: Option<PathBuf>,
    disposed: bool,
}

/// Cross-platform desktop auto-updater service integrated with Rune's worker runtime.
#[derive(Clone)]
pub struct DesktopUpdaterService {
    config: Arc<Mutex<UpdaterConfig>>,
    inner: Arc<Mutex<RuntimeInner>>,
    operation_lock: Arc<AsyncMutex<()>>,
    scheduler_task: Arc<Mutex<Option<JoinHandle<()>>>>,
    scheduler_stop: Arc<Notify>,
    quit_requested: Arc<AtomicBool>,
    logger: Option<Arc<LocalLogger>>,
    emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
    notifications: Option<DesktopNotificationService>,
    analytics: Option<ProductAnalyticsService>,
}

impl DesktopUpdaterService {
    /// Creates an updater service using default build-time configuration for unpackaged dev runs.
    pub fn new(
        logger: Option<Arc<LocalLogger>>,
        emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
    ) -> Self {
        Self::with_config(UpdaterConfig::from_build_env(false), logger, emit)
    }

    /// Creates an updater service configured with explicit runtime/test settings.
    pub fn with_config(
        config: UpdaterConfig,
        logger: Option<Arc<LocalLogger>>,
        emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
    ) -> Self {
        let initial = compute_initial_state(&config);
        Self {
            config: Arc::new(Mutex::new(config)),
            inner: Arc::new(Mutex::new(RuntimeInner {
                state: initial,
                pending_download: None,
                prepared_install: None,
                notified_version: None,
                staging_root: None,
                disposed: false,
            })),
            operation_lock: Arc::new(AsyncMutex::new(())),
            scheduler_task: Arc::new(Mutex::new(None)),
            scheduler_stop: Arc::new(Notify::new()),
            quit_requested: Arc::new(AtomicBool::new(false)),
            logger,
            emit,
            notifications: None,
            analytics: None,
        }
    }

    /// Attaches OS desktop notifications for update-ready prompts.
    pub fn with_notifications(mut self, notifications: DesktopNotificationService) -> Self {
        self.notifications = Some(notifications);
        self
    }

    /// Attaches privacy-respecting product analytics for update funnel telemetry.
    pub fn with_analytics(mut self, analytics: ProductAnalyticsService) -> Self {
        self.analytics = Some(analytics);
        self
    }

    /// Updates runtime configuration (used during worker startup before `start()`).
    pub fn configure(&self, config: UpdaterConfig) {
        let initial = compute_initial_state(&config);
        *self.config.lock().unwrap_or_else(|e| e.into_inner()) = config;
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.state = initial;
        inner.pending_download = None;
        inner.prepared_install = None;
        inner.notified_version = None;
        let next = inner.state.clone();
        drop(inner);
        (self.emit)(StoreEvent::UpdaterChanged(next));
    }

    /// Returns the latest updater snapshot.
    pub fn get_state(&self) -> UpdaterState {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .state
            .clone()
    }

    /// Starts the startup (10s) and periodic (6h) background update checks when eligible.
    pub fn start(&self) {
        let cfg = self
            .config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Err(reason) = ensure_updatable_config(&cfg) {
            self.set_disabled_state(&cfg, reason);
            return;
        }

        let mut task_guard = self
            .scheduler_task
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if task_guard.is_some() {
            return;
        }

        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };

        let svc = self.clone();
        let startup_delay = cfg.startup_delay;
        let poll_interval = cfg.poll_interval.max(Duration::from_secs(1));
        let stop = self.scheduler_stop.clone();

        *task_guard = Some(handle.spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(startup_delay) => {}
                _ = stop.notified() => return,
            }
            loop {
                if svc.is_disposed() {
                    return;
                }
                let _ = svc.check_for_updates_async().await;
                tokio::select! {
                    _ = tokio::time::sleep(poll_interval) => {}
                    _ = stop.notified() => return,
                }
            }
        }));
    }

    /// Cancels scheduled checks and prevents new background installs during shutdown.
    pub fn dispose(&self) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.disposed = true;
        }
        self.scheduler_stop.notify_waiters();
        if let Some(handle) = self
            .scheduler_task
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            handle.abort();
        }
    }

    /// Triggers an asynchronous update check from the UI or menu.
    pub fn check_for_updates(&self) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let svc = self.clone();
            handle.spawn(async move {
                let _ = svc.check_for_updates_async().await;
            });
        } else {
            let cfg = self
                .config
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Err(reason) = ensure_updatable_config(&cfg) {
                self.set_disabled_state(&cfg, reason);
            }
        }
    }

    /// Triggers downloading the currently discovered update (or initiates a fresh check).
    pub fn download_update(&self) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let svc = self.clone();
            handle.spawn(async move {
                let _ = svc.download_update_async().await;
            });
        } else {
            let cfg = self
                .config
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Err(reason) = ensure_updatable_config(&cfg) {
                self.set_disabled_state(&cfg, reason);
            }
        }
    }

    /// Awaits an update check (and automatic verified download when newer) directly.
    pub async fn check_for_updates_async(&self) -> UpdaterState {
        let _op = self.operation_lock.lock().await;
        if self.is_disposed() {
            return self.get_state();
        }

        let cfg = self
            .config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Err(reason) = ensure_updatable_config(&cfg) {
            return self.set_disabled_state(&cfg, reason);
        }

        let pubkey = match cfg.pubkey.as_deref().map(decode_minisign_public_key) {
            Some(Ok(pk)) => pk,
            Some(Err(err)) => {
                return self.set_disabled_state(
                    &cfg,
                    &format!("Configured update signing key is invalid: {err}"),
                );
            }
            None => return self.set_disabled_state(&cfg, DISABLED_NO_PUBKEY_REASON),
        };

        let previously_downloaded = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .prepared_install
                .as_ref()
                .map(|p| p.version.clone())
                .filter(|_| inner.state.status == "downloaded")
        };

        self.set_state(UpdaterState {
            status: "checking".to_string(),
            version: None,
            notes: None,
            error: None,
            current_version: cfg.current_version.clone(),
            available_version: None,
            download_progress: None,
            downloaded_bytes: None,
            total_bytes: None,
            bytes_per_second: None,
            packaged: true,
        });

        match self.fetch_manifest(&cfg).await {
            Ok(FetchManifestOutcome::NotPublished) => {
                self.track_checked(false, "disabled");
                self.set_disabled_state(&cfg, DISABLED_MISSING_FEED_REASON)
            }
            Ok(FetchManifestOutcome::NoContent) => {
                self.track_checked(false, "up-to-date");
                self.finish_up_to_date(&cfg, previously_downloaded.as_deref())
            }
            Ok(FetchManifestOutcome::Manifest(manifest)) => {
                let Some(remote_ver_str) = normalize_version_string(&manifest.version) else {
                    self.track_checked(false, "error");
                    return self.set_error_state(
                        &cfg,
                        format!("Invalid version in update manifest: {:?}", manifest.version),
                        Some("manifest_invalid"),
                    );
                };

                let current_sem = match parse_semver(&cfg.current_version) {
                    Ok(v) => v,
                    Err(err) => {
                        self.track_checked(false, "error");
                        return self.set_error_state(
                            &cfg,
                            format!("Invalid current app version {}: {err}", cfg.current_version),
                            Some("version_invalid"),
                        );
                    }
                };
                let remote_sem = match parse_semver(&remote_ver_str) {
                    Ok(v) => v,
                    Err(err) => {
                        self.track_checked(false, "error");
                        return self.set_error_state(
                            &cfg,
                            format!("Invalid release version {remote_ver_str}: {err}"),
                            Some("version_invalid"),
                        );
                    }
                };

                if remote_sem <= current_sem {
                    self.track_checked(false, "up-to-date");
                    return self.finish_up_to_date(&cfg, previously_downloaded.as_deref());
                }

                if let Some(prev_ver) = previously_downloaded.as_deref()
                    && let Ok(prev_sem) = parse_semver(prev_ver)
                    && prev_sem >= remote_sem
                {
                    let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(prepared) = &inner.prepared_install {
                        let restored = downloaded_state(
                            &cfg,
                            &prepared.version,
                            manifest.notes,
                            inner.state.downloaded_bytes,
                            inner.state.total_bytes,
                        );
                        drop(inner);
                        return self.set_state(restored);
                    }
                }

                let Some(asset) = select_platform_asset(&manifest, &cfg.target) else {
                    self.track_checked(false, "disabled");
                    return self.set_disabled_state(&cfg, DISABLED_MISSING_FEED_REASON);
                };

                let feed_base = match assert_safe_updater_url(&cfg.feed_url) {
                    Ok(u) => u,
                    Err(err) => {
                        self.track_checked(false, "error");
                        return self.set_error_state(&cfg, err.to_string(), Some("config_invalid"));
                    }
                };
                let asset_url = match resolve_and_validate_asset_url(&feed_base, &asset.url) {
                    Ok(u) => u.to_string(),
                    Err(err) => {
                        self.track_checked(false, "error");
                        return self.set_error_state(
                            &cfg,
                            err.to_string(),
                            Some("manifest_invalid"),
                        );
                    }
                };

                let pending = PendingDownload {
                    version: remote_ver_str.clone(),
                    notes: sanitize_release_notes(manifest.notes.clone()),
                    url: asset_url,
                    signature: asset.signature.clone(),
                    format: asset
                        .format
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_ascii_lowercase())
                        .unwrap_or_else(|| default_format_for_os(&cfg.target.os).to_string()),
                };
                {
                    let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                    inner.pending_download = Some(pending.clone());
                }

                self.track_checked(true, "available");
                self.set_state(UpdaterState {
                    status: "available".to_string(),
                    version: Some(pending.version.clone()),
                    notes: pending.notes.clone(),
                    error: None,
                    current_version: cfg.current_version.clone(),
                    available_version: Some(pending.version.clone()),
                    download_progress: Some(0.0),
                    downloaded_bytes: None,
                    total_bytes: None,
                    bytes_per_second: None,
                    packaged: true,
                });

                self.perform_verified_download(&cfg, &pubkey, &pending)
                    .await
            }
            Err(err) => {
                self.track_checked(false, "error");
                self.set_error_state(
                    &cfg,
                    strip_url_secrets(&err.to_string()),
                    Some("network_or_feed"),
                )
            }
        }
    }

    /// Awaits a manual download (or delegates to check-and-download if no asset is staged yet).
    pub async fn download_update_async(&self) -> UpdaterState {
        let maybe_pending = {
            let _op = self.operation_lock.lock().await;
            if self.is_disposed() {
                return self.get_state();
            }
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if inner.state.status == "downloaded" && inner.prepared_install.is_some() {
                return inner.state.clone();
            }
            inner.pending_download.clone()
        };

        if let Some(pending) = maybe_pending {
            let _op = self.operation_lock.lock().await;
            let cfg = self
                .config
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Err(reason) = ensure_updatable_config(&cfg) {
                return self.set_disabled_state(&cfg, reason);
            }
            let pubkey = match cfg.pubkey.as_deref().map(decode_minisign_public_key) {
                Some(Ok(pk)) => pk,
                Some(Err(err)) => {
                    return self.set_disabled_state(
                        &cfg,
                        &format!("Configured update signing key is invalid: {err}"),
                    );
                }
                None => return self.set_disabled_state(&cfg, DISABLED_NO_PUBKEY_REASON),
            };
            self.perform_verified_download(&cfg, &pubkey, &pending)
                .await
        } else {
            self.check_for_updates_async().await
        }
    }

    /// Requests clean application shutdown so the staged verified update installs on exit.
    pub fn quit_and_install(&self) {
        let can_install = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.state.status == "downloaded" && inner.prepared_install.is_some()
        };
        if !can_install {
            return;
        }
        if self.quit_requested.swap(true, Ordering::AcqRel) {
            return;
        }

        if let Some(analytics) = &self.analytics {
            let mut props = BTreeMap::new();
            props.insert("status".to_string(), json!("started"));
            let _ = analytics.capture_event("update_install_started", &props);
        }
        if let Some(logger) = &self.logger {
            logger.info("updater", "quitting to install downloaded update", None);
        }

        let trigger = self
            .config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .request_quit
            .clone();
        if let Some(request_quit) = trigger {
            request_quit();
        }
    }

    /// Executes the pending staged install after `ShutdownCoordinator` has stopped sidecars.
    pub fn execute_pending_install_on_shutdown(&self) -> Result<()> {
        if !self.quit_requested.load(Ordering::Acquire) {
            return Ok(());
        }
        let prepared = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.prepared_install.take()
        };
        let Some(prepared) = prepared else {
            return Ok(());
        };

        let cfg = self
            .config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(custom_handler) = cfg.install_handler {
            return custom_handler(&prepared);
        }
        execute_platform_install(&prepared, cfg.relaunch_after_install)
    }

    /// Opens the latest GitHub releases notes page in the user's browser.
    pub fn open_release_notes(&self) -> Result<()> {
        open_external_url_os(RELEASE_NOTES_URL)
    }

    fn is_disposed(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .disposed
    }

    fn set_state(&self, next: UpdaterState) -> UpdaterState {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.state = next.clone();
        }
        (self.emit)(StoreEvent::UpdaterChanged(next.clone()));
        next
    }

    fn set_disabled_state(&self, cfg: &UpdaterConfig, reason: &str) -> UpdaterState {
        self.set_state(UpdaterState {
            status: "disabled".to_string(),
            version: None,
            notes: Some(reason.to_string()),
            error: None,
            current_version: cfg.current_version.clone(),
            available_version: None,
            download_progress: None,
            downloaded_bytes: None,
            total_bytes: None,
            bytes_per_second: None,
            packaged: cfg.is_packaged,
        })
    }

    fn set_error_state(
        &self,
        cfg: &UpdaterConfig,
        message: String,
        error_category: Option<&str>,
    ) -> UpdaterState {
        let clean = strip_url_secrets(&message);
        if let Some(logger) = &self.logger {
            let meta = json!({ "error": clean, "category": error_category });
            logger.warn("updater", "update operation failed", Some(&meta));
        }
        self.set_state(UpdaterState {
            status: "error".to_string(),
            version: None,
            notes: None,
            error: Some(clean),
            current_version: cfg.current_version.clone(),
            available_version: None,
            download_progress: None,
            downloaded_bytes: None,
            total_bytes: None,
            bytes_per_second: None,
            packaged: cfg.is_packaged,
        })
    }

    fn finish_up_to_date(
        &self,
        cfg: &UpdaterConfig,
        previously_downloaded: Option<&str>,
    ) -> UpdaterState {
        if let Some(_prev) = previously_downloaded {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(prepared) = &inner.prepared_install {
                let state = downloaded_state(
                    cfg,
                    &prepared.version,
                    inner.state.notes.clone(),
                    inner.state.downloaded_bytes,
                    inner.state.total_bytes,
                );
                drop(inner);
                return self.set_state(state);
            }
        }
        self.set_state(UpdaterState {
            status: "up-to-date".to_string(),
            version: Some(cfg.current_version.clone()),
            notes: None,
            error: None,
            current_version: cfg.current_version.clone(),
            available_version: None,
            download_progress: None,
            downloaded_bytes: None,
            total_bytes: None,
            bytes_per_second: None,
            packaged: cfg.is_packaged,
        })
    }

    async fn fetch_manifest(&self, cfg: &UpdaterConfig) -> Result<FetchManifestOutcome> {
        let feed_url = assert_safe_updater_url(&cfg.feed_url)?;
        let client = build_updater_http_client(FEED_REQUEST_TIMEOUT, feed_url.clone())?;
        let resp = client
            .get(feed_url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|err| anyhow!("Failed to check for updates: {err}"))?;

        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(FetchManifestOutcome::NotPublished);
        }
        if resp.status() == StatusCode::NO_CONTENT {
            return Ok(FetchManifestOutcome::NoContent);
        }
        if !resp.status().is_success() {
            bail!("Update feed returned HTTP {}", resp.status());
        }

        if let Some(len) = resp.content_length()
            && len > MAX_FEED_BYTES as u64
        {
            bail!("Update manifest exceeds maximum allowed size.");
        }

        let mut bytes = Vec::new();
        let mut response = resp;
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > MAX_FEED_BYTES {
                bail!("Update manifest exceeds maximum allowed size.");
            }
            bytes.extend_from_slice(&chunk);
        }

        let manifest: ReleaseManifest =
            serde_json::from_slice(&bytes).context("Invalid JSON in update manifest")?;
        Ok(FetchManifestOutcome::Manifest(manifest))
    }

    async fn perform_verified_download(
        &self,
        cfg: &UpdaterConfig,
        pubkey: &PublicKey,
        pending: &PendingDownload,
    ) -> UpdaterState {
        let sig = match decode_minisign_signature(&pending.signature) {
            Ok(s) => s,
            Err(err) => {
                self.track_downloaded("error", Some("signature_decode"));
                return self.set_error_state(
                    cfg,
                    format!("Update signature is malformed: {err}"),
                    Some("signature_decode"),
                );
            }
        };

        let download_url = match assert_safe_updater_url(&pending.url) {
            Ok(u) => u,
            Err(err) => {
                self.track_downloaded("error", Some("invalid_url"));
                return self.set_error_state(cfg, err.to_string(), Some("invalid_url"));
            }
        };

        let staging_root = match self.ensure_staging_dir(cfg) {
            Ok(dir) => dir,
            Err(err) => {
                self.track_downloaded("error", Some("staging_fs"));
                return self.set_error_state(
                    cfg,
                    format!("Failed to prepare update staging directory: {err}"),
                    Some("staging_fs"),
                );
            }
        };

        self.set_state(UpdaterState {
            status: "downloading".to_string(),
            version: Some(pending.version.clone()),
            notes: pending.notes.clone(),
            error: None,
            current_version: cfg.current_version.clone(),
            available_version: Some(pending.version.clone()),
            download_progress: Some(0.0),
            downloaded_bytes: Some(0),
            total_bytes: None,
            bytes_per_second: Some(0),
            packaged: true,
        });

        let part_path = staging_root.join(format!("download-{}.part", Uuid::new_v4()));
        let download_res = self
            .stream_to_staging_file(cfg, pending, &download_url, &part_path)
            .await;

        let total_downloaded = match download_res {
            Ok(bytes) => bytes,
            Err(err) => {
                let _ = fs::remove_file(&part_path);
                self.track_downloaded("error", Some("download_failed"));
                return self.set_error_state(
                    cfg,
                    format!("Failed to download update: {err}"),
                    Some("download_failed"),
                );
            }
        };

        let verify_part = part_path.clone();
        let verify_pk = pubkey.clone();
        let verify_sig = sig;
        let verify_res = tokio::task::spawn_blocking(move || {
            verify_file_minisign(&verify_part, &verify_pk, &verify_sig)
        })
        .await;

        match verify_res {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                let _ = fs::remove_file(&part_path);
                self.track_downloaded("error", Some("signature_verification"));
                return self.set_error_state(
                    cfg,
                    format!("Update signature verification failed: {err}"),
                    Some("signature_verification"),
                );
            }
            Err(join_err) => {
                let _ = fs::remove_file(&part_path);
                self.track_downloaded("error", Some("signature_verification"));
                return self.set_error_state(
                    cfg,
                    format!("Update verification task failed: {join_err}"),
                    Some("signature_verification"),
                );
            }
        }

        let staged_path = match stage_verified_artifact(
            &staging_root,
            &part_path,
            &pending.version,
            &pending.format,
        )
        .await
        {
            Ok(path) => path,
            Err(err) => {
                let _ = fs::remove_file(&part_path);
                self.track_downloaded("error", Some("staging_extract"));
                return self.set_error_state(
                    cfg,
                    format!("Failed to stage verified update: {err}"),
                    Some("staging_extract"),
                );
            }
        };

        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.prepared_install = Some(PreparedInstall {
                version: pending.version.clone(),
                format: pending.format.clone(),
                staged_path,
                target: cfg.target.clone(),
            });
            inner.pending_download = None;
        }

        self.track_downloaded("success", None);
        self.notify_update_ready_once(&pending.version);

        self.set_state(UpdaterState {
            status: "downloaded".to_string(),
            version: Some(pending.version.clone()),
            notes: pending.notes.clone(),
            error: None,
            current_version: cfg.current_version.clone(),
            available_version: Some(pending.version.clone()),
            download_progress: Some(100.0),
            downloaded_bytes: Some(total_downloaded),
            total_bytes: Some(total_downloaded),
            bytes_per_second: None,
            packaged: true,
        })
    }

    async fn stream_to_staging_file(
        &self,
        cfg: &UpdaterConfig,
        pending: &PendingDownload,
        download_url: &Url,
        part_path: &Path,
    ) -> Result<u64> {
        let client = build_updater_http_client(DOWNLOAD_REQUEST_TIMEOUT, download_url.clone())?;
        let mut resp = client
            .get(download_url.clone())
            .send()
            .await
            .map_err(|err| anyhow!("Download request failed: {err}"))?;

        if !resp.status().is_success() {
            bail!("Download server returned HTTP {}", resp.status());
        }

        let total_opt = resp.content_length().filter(|n| *n > 0);
        if let Some(total) = total_opt
            && total > MAX_UPDATE_PAYLOAD_BYTES
        {
            bail!("Update archive exceeds maximum allowed size.");
        }

        let mut file = std::io::BufWriter::new(File::create(part_path)?);
        let started_at = Instant::now();
        let mut last_emit = Instant::now() - PROGRESS_EMIT_MIN_INTERVAL;
        let mut last_pct: f32 = -1.0;
        let mut downloaded: u64 = 0;

        while let Some(chunk) = resp.chunk().await? {
            if self.is_disposed() {
                bail!("Update download aborted on shutdown.");
            }
            downloaded = downloaded
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| anyhow!("Update payload overflowed size limit."))?;
            if downloaded > MAX_UPDATE_PAYLOAD_BYTES {
                bail!("Update payload exceeded maximum allowed size.");
            }
            file.write_all(&chunk)?;

            let elapsed_secs = started_at.elapsed().as_secs_f64().max(0.05);
            let bps = ((downloaded as f64) / elapsed_secs).round() as u64;
            let pct_opt = total_opt
                .filter(|total| *total > 0)
                .map(|total| ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as f32);

            let pct_jumped = pct_opt.is_some_and(|pct| (pct - last_pct).abs() >= 2.0);
            if last_emit.elapsed() >= PROGRESS_EMIT_MIN_INTERVAL || pct_jumped {
                last_emit = Instant::now();
                if let Some(pct) = pct_opt {
                    last_pct = pct;
                }
                self.set_state(UpdaterState {
                    status: "downloading".to_string(),
                    version: Some(pending.version.clone()),
                    notes: pending.notes.clone(),
                    error: None,
                    current_version: cfg.current_version.clone(),
                    available_version: Some(pending.version.clone()),
                    download_progress: pct_opt,
                    downloaded_bytes: Some(downloaded),
                    total_bytes: total_opt,
                    bytes_per_second: Some(bps),
                    packaged: true,
                });
            }
        }
        file.flush()?;
        Ok(downloaded)
    }

    fn ensure_staging_dir(&self, cfg: &UpdaterConfig) -> Result<PathBuf> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = &inner.staging_root {
            fs::create_dir_all(existing)?;
            return Ok(existing.clone());
        }
        let dir = if let Some(explicit) = &cfg.staging_dir {
            explicit.clone()
        } else {
            std::env::temp_dir().join(format!("cowork-desktop-updates-{}", std::process::id()))
        };
        fs::create_dir_all(&dir)?;
        inner.staging_root = Some(dir.clone());
        Ok(dir)
    }

    fn notify_update_ready_once(&self, version: &str) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if inner.notified_version.as_deref() == Some(version) {
                return;
            }
            inner.notified_version = Some(version.to_string());
        }
        if let Some(notifications) = &self.notifications {
            let id = format!("cowork-update-ready-{version}");
            notifications.show(
                &id,
                &format!("Cowork {version} Ready to Install"),
                "Restart Cowork from Updates settings or the banner to apply this update.",
            );
        }
    }

    fn track_checked(&self, update_available: bool, status: &str) {
        if let Some(analytics) = &self.analytics {
            let mut props = BTreeMap::new();
            props.insert("updateAvailable".to_string(), json!(update_available));
            props.insert("status".to_string(), json!(status));
            let _ = analytics.capture_event("update_checked", &props);
        }
    }

    fn track_downloaded(&self, status: &str, error_category: Option<&str>) {
        if let Some(analytics) = &self.analytics {
            let mut props = BTreeMap::new();
            props.insert("status".to_string(), json!(status));
            if let Some(cat) = error_category {
                props.insert("errorCategory".to_string(), json!(cat));
            }
            let _ = analytics.capture_event("update_downloaded", &props);
        }
    }
}

enum FetchManifestOutcome {
    Manifest(ReleaseManifest),
    NotPublished,
    NoContent,
}

fn compute_initial_state(cfg: &UpdaterConfig) -> UpdaterState {
    match ensure_updatable_config(cfg) {
        Ok(()) => UpdaterState {
            status: "idle".to_string(),
            version: None,
            notes: None,
            error: None,
            current_version: cfg.current_version.clone(),
            available_version: None,
            download_progress: None,
            downloaded_bytes: None,
            total_bytes: None,
            bytes_per_second: None,
            packaged: cfg.is_packaged,
        },
        Err(reason) => UpdaterState {
            status: "disabled".to_string(),
            version: None,
            notes: Some(reason.to_string()),
            error: None,
            current_version: cfg.current_version.clone(),
            available_version: None,
            download_progress: None,
            downloaded_bytes: None,
            total_bytes: None,
            bytes_per_second: None,
            packaged: cfg.is_packaged,
        },
    }
}

fn downloaded_state(
    cfg: &UpdaterConfig,
    version: &str,
    notes: Option<String>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
) -> UpdaterState {
    UpdaterState {
        status: "downloaded".to_string(),
        version: Some(version.to_string()),
        notes,
        error: None,
        current_version: cfg.current_version.clone(),
        available_version: Some(version.to_string()),
        download_progress: Some(100.0),
        downloaded_bytes,
        total_bytes,
        bytes_per_second: None,
        packaged: cfg.is_packaged,
    }
}

fn ensure_updatable_config(cfg: &UpdaterConfig) -> std::result::Result<(), &'static str> {
    if !cfg.is_packaged {
        return Err(DISABLED_UNPACKAGED_REASON);
    }
    if cfg
        .pubkey
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        return Err(DISABLED_NO_PUBKEY_REASON);
    }
    if cfg.target.os == "linux"
        && cfg.target.appimage_path.is_none()
        && cfg.target.install_root_override.is_none()
    {
        return Err(DISABLED_LINUX_NO_APPIMAGE_REASON);
    }
    Ok(())
}

fn default_format_for_os(os: &str) -> &'static str {
    match os {
        "macos" => "app",
        "windows" => "nsis",
        _ => "appimage",
    }
}

fn select_platform_asset<'a>(
    manifest: &'a ReleaseManifest,
    target: &UpdaterTarget,
) -> Option<&'a PlatformAsset> {
    for key in target.candidate_platform_keys() {
        if let Some(asset) = manifest.platforms.get(&key) {
            return Some(asset);
        }
    }
    None
}

fn normalize_version_string(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

fn parse_semver(raw: &str) -> Result<semver::Version> {
    let normalized =
        normalize_version_string(raw).ok_or_else(|| anyhow!("Empty version string"))?;
    semver::Version::parse(&normalized).with_context(|| format!("Invalid semver `{raw}`"))
}

fn sanitize_release_notes(raw: Option<String>) -> Option<String> {
    let trimmed = raw?.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= MAX_RELEASE_NOTES_CHARS {
        return Some(trimmed);
    }
    let truncated: String = trimmed.chars().take(MAX_RELEASE_NOTES_CHARS).collect();
    Some(format!("{truncated}…"))
}

fn is_loopback_http_url(url: &Url) -> bool {
    if url.scheme() != "http" {
        return false;
    }
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

fn assert_safe_updater_url(raw: &str) -> Result<Url> {
    let parsed = Url::parse(raw.trim()).context("Invalid updater URL")?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        bail!("Updater URL must not include embedded credentials.");
    }
    if parsed.scheme() == "https" || is_loopback_http_url(&parsed) {
        return Ok(parsed);
    }
    bail!(
        "Blocked insecure updater URL scheme `{}` for host.",
        parsed.scheme()
    );
}

fn resolve_and_validate_asset_url(feed_base: &Url, raw_asset_url: &str) -> Result<Url> {
    let trimmed = raw_asset_url.trim();
    if trimmed.is_empty() {
        bail!("Update asset URL is empty.");
    }
    let resolved = feed_base
        .join(trimmed)
        .with_context(|| format!("Invalid update asset URL `{trimmed}`"))?;
    assert_safe_updater_url(resolved.as_str())
}

fn build_updater_http_client(timeout: Duration, initial_url: Url) -> Result<reqwest::Client> {
    let allow_loopback = is_loopback_http_url(&initial_url);
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("Too many HTTP redirects while fetching update.");
        }
        let next = attempt.url();
        let allowed = next.scheme() == "https" || (allow_loopback && is_loopback_http_url(next));
        if allowed {
            attempt.follow()
        } else {
            attempt.error("Blocked insecure HTTP redirect for update request.")
        }
    });
    Ok(reqwest::Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(timeout)
        .redirect(policy)
        .user_agent(format!(
            "cowork-desktop/{} ({} {})",
            resolve_desktop_app_version(),
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
        .build()?)
}

/// Decodes a Minisign public key from either `RW...`, multi-line `minisign.pub`, or base64-encoded box.
pub(crate) fn decode_minisign_public_key(raw: &str) -> Result<PublicKey> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("Empty public key");
    }
    if let Ok(pk) = PublicKey::from_base64(trimmed) {
        return Ok(pk);
    }
    if trimmed.starts_with("untrusted comment:") {
        return PublicKey::decode(trimmed).map_err(|e| anyhow!("{e}"));
    }
    let decoded_bytes = BASE64_STANDARD
        .decode(trimmed)
        .context("Failed to base64-decode Minisign public key")?;
    let decoded = String::from_utf8(decoded_bytes)
        .context("Decoded Minisign public key is not valid UTF-8")?;
    if decoded.trim_start().starts_with("untrusted comment:") {
        PublicKey::decode(decoded.trim()).map_err(|e| anyhow!("{e}"))
    } else {
        PublicKey::from_base64(decoded.trim()).map_err(|e| anyhow!("{e}"))
    }
}

/// Decodes a Minisign signature from raw 4-line `.sig` format or base64-encoded `.sig` payload.
pub(crate) fn decode_minisign_signature(raw: &str) -> Result<Signature> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("Empty signature");
    }
    if trimmed.starts_with("untrusted comment:") {
        return Signature::decode(trimmed).map_err(|e| anyhow!("{e}"));
    }
    let decoded_bytes = BASE64_STANDARD
        .decode(trimmed)
        .context("Failed to base64-decode Minisign signature")?;
    let decoded = String::from_utf8(decoded_bytes)
        .context("Decoded Minisign signature is not valid UTF-8")?;
    Signature::decode(decoded.trim()).map_err(|e| anyhow!("{e}"))
}

fn verify_file_minisign(path: &Path, pk: &PublicKey, sig: &Signature) -> Result<()> {
    match pk.verify_stream(sig) {
        Ok(mut stream) => {
            let mut reader = BufReader::new(File::open(path)?);
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = reader.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                stream.update(&buf[..n]);
            }
            stream.finalize().map_err(|e| anyhow!("{e}"))?;
            Ok(())
        }
        Err(minisign_verify::Error::UnsupportedLegacyMode) => {
            let bytes = fs::read(path)?;
            pk.verify(&bytes, sig, true).map_err(|e| anyhow!("{e}"))?;
            Ok(())
        }
        Err(err) => Err(anyhow!("{err}")),
    }
}

async fn stage_verified_artifact(
    staging_root: &Path,
    verified_file: &Path,
    version: &str,
    format: &str,
) -> Result<PathBuf> {
    let safe_version: String = version
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();

    if format == "app" {
        let src = verified_file.to_path_buf();
        let extract_dir = staging_root.join(format!("extracted-{safe_version}"));
        let staging_dir = staging_root.to_path_buf();
        let bundle_dir = tokio::task::spawn_blocking(move || {
            if extract_dir.exists() {
                fs::remove_dir_all(&extract_dir)?;
            }
            fs::create_dir_all(&extract_dir)?;
            let bundle = extract_macos_app_tar_gz(&src, &extract_dir)?;
            let _ = fs::remove_file(&src);
            cleanup_old_staging_entries(&staging_dir, &extract_dir);
            Ok::<PathBuf, anyhow::Error>(bundle)
        })
        .await??;
        return Ok(bundle_dir);
    }

    let ext = match format {
        "nsis" => "exe",
        "appimage" => "AppImage",
        _ => "bin",
    };
    let dest = staging_root.join(format!("cowork-update-{safe_version}.{ext}"));
    if dest.exists() {
        let _ = fs::remove_file(&dest);
    }
    fs::rename(verified_file, &dest)?;
    cleanup_old_staging_entries(staging_root, &dest);
    Ok(dest)
}

fn cleanup_old_staging_entries(staging_root: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(staging_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep {
            continue;
        }
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Safely extracts a verified `.app.tar.gz` update bundle and returns the extracted `<Name>.app` path.
pub(crate) fn extract_macos_app_tar_gz(tar_gz_path: &Path, dest_dir: &Path) -> Result<PathBuf> {
    let file = File::open(tar_gz_path)?;
    let gz = GzDecoder::new(file);
    let mut archive = Archive::new(gz);
    let mut top_bundle_name: Option<String> = None;
    let mut total_bytes: u64 = 0;
    let mut has_contents_macos = false;

    for entry_res in archive.entries()? {
        let mut entry = entry_res?;
        let raw_path = entry.path()?.into_owned();
        let rel_components = validate_archive_rel_components(&raw_path)?;
        if rel_components.is_empty() {
            continue;
        }
        let top = &rel_components[0];
        if !top.ends_with(".app") {
            bail!("Unexpected top-level entry in macOS bundle archive: `{top}`");
        }
        if let Some(expected) = &top_bundle_name {
            if expected != top {
                bail!("Archive contains multiple top-level bundles (`{expected}` and `{top}`).");
            }
        } else {
            top_bundle_name = Some(top.clone());
        }

        if rel_components.len() >= 3
            && rel_components[1] == "Contents"
            && rel_components[2] == "MacOS"
        {
            has_contents_macos = true;
        }

        let mut target_path = dest_dir.to_path_buf();
        for comp in &rel_components {
            target_path.push(comp);
        }
        let bundle_root = dest_dir.join(top);

        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            fs::create_dir_all(&target_path)?;
            continue;
        }
        if entry_type.is_symlink() {
            let link_target = entry
                .link_name()?
                .ok_or_else(|| anyhow!("Archive symlink missing target"))?
                .into_owned();
            validate_relative_symlink_within(&bundle_root, &target_path, &link_target)?;
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)?;
            }
            if target_path.exists() || target_path.symlink_metadata().is_ok() {
                let _ = fs::remove_file(&target_path);
            }
            create_symlink(&link_target, &target_path)?;
            continue;
        }
        if !entry_type.is_file() {
            bail!(
                "Refusing unsupported archive entry type for `{}`",
                raw_path.display()
            );
        }

        let entry_size = entry.header().size()?;
        total_bytes = total_bytes
            .checked_add(entry_size)
            .ok_or_else(|| anyhow!("Extracted bundle exceeded maximum allowed size."))?;
        if total_bytes > MAX_EXTRACTED_BUNDLE_BYTES {
            bail!("Extracted macOS bundle exceeded maximum allowed size.");
        }

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create(&target_path)?;
        let copied = std::io::copy(&mut entry, &mut out)?;
        if copied != entry_size {
            bail!(
                "Archive entry `{}` truncated ({copied}/{entry_size} bytes)",
                raw_path.display()
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = entry.header().mode().unwrap_or(0o644) & 0o777;
            if mode != 0 {
                let _ = fs::set_permissions(&target_path, fs::Permissions::from_mode(mode));
            }
        }
    }

    let Some(bundle_name) = top_bundle_name else {
        bail!("Update archive did not contain a macOS .app bundle.");
    };
    if !has_contents_macos {
        bail!("Extracted bundle `{bundle_name}` is missing `Contents/MacOS`.");
    }
    Ok(dest_dir.join(bundle_name))
}

fn validate_archive_rel_components(raw_path: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for comp in raw_path.components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(part) => {
                let s = part
                    .to_str()
                    .ok_or_else(|| anyhow!("Non-UTF-8 path in update archive"))?;
                if s.is_empty() {
                    continue;
                }
                out.push(s.to_string());
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!(
                    "Unsafe path traversal in update archive: `{}`",
                    raw_path.display()
                );
            }
        }
    }
    Ok(out)
}

fn validate_relative_symlink_within(
    bundle_root: &Path,
    link_path: &Path,
    link_target: &Path,
) -> Result<()> {
    if link_target.is_absolute() {
        bail!(
            "Refusing absolute symlink target in update bundle: `{}`",
            link_target.display()
        );
    }
    let parent = link_path.parent().unwrap_or(bundle_root);
    let rel_parent = parent.strip_prefix(bundle_root).unwrap_or(Path::new(""));
    let mut depth: Vec<&std::ffi::OsStr> = rel_parent
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s),
            _ => None,
        })
        .collect();

    for comp in link_target.components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(part) => depth.push(part),
            Component::ParentDir => {
                if depth.pop().is_none() {
                    bail!(
                        "Symlink `{}` -> `{}` escapes bundle root.",
                        link_path.display(),
                        link_target.display()
                    );
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                bail!(
                    "Symlink `{}` -> `{}` escapes bundle root.",
                    link_path.display(),
                    link_target.display()
                );
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_symlink(target: &Path, link_path: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link_path)?;
    Ok(())
}

#[cfg(not(unix))]
fn create_symlink(_target: &Path, _link_path: &Path) -> Result<()> {
    bail!("Extracting macOS .app symlinks is only supported on Unix hosts.")
}

fn execute_platform_install(prepared: &PreparedInstall, relaunch: bool) -> Result<()> {
    match prepared.format.as_str() {
        "app" => {
            let target_app = resolve_macos_target_app_bundle(&prepared.target)?;
            replace_macos_app_bundle(&prepared.staged_path, &target_app, relaunch)
        }
        "nsis" => install_windows_nsis(&prepared.staged_path),
        "appimage" => {
            let target = prepared
                .target
                .install_root_override
                .clone()
                .or_else(|| prepared.target.appimage_path.clone())
                .ok_or_else(|| anyhow!("Missing APPIMAGE target path for Linux update."))?;
            replace_linux_appimage(&prepared.staged_path, &target, relaunch)
        }
        other => bail!("Unsupported update package format `{other}`"),
    }
}

pub(crate) fn resolve_macos_target_app_bundle(target: &UpdaterTarget) -> Result<PathBuf> {
    if let Some(override_path) = &target.install_root_override {
        return Ok(override_path.clone());
    }
    let exe = target
        .current_exe
        .as_ref()
        .ok_or_else(|| anyhow!("Unable to resolve current executable path for macOS update."))?;
    for ancestor in exe.ancestors() {
        if ancestor.extension().and_then(|e| e.to_str()) == Some("app") {
            return Ok(ancestor.to_path_buf());
        }
    }
    bail!(
        "Current executable `{}` is not running inside a .app bundle.",
        exe.display()
    );
}

/// Atomically replaces `target_app` with `new_app` (backing up and rolling back on error), then
/// optionally launches the updated bundle detached via `open -n`.
pub(crate) fn replace_macos_app_bundle(
    new_app: &Path,
    target_app: &Path,
    relaunch: bool,
) -> Result<()> {
    if !new_app.join("Contents").join("MacOS").is_dir() {
        bail!(
            "Staged bundle `{}` is missing Contents/MacOS.",
            new_app.display()
        );
    }
    let parent = target_app
        .parent()
        .ok_or_else(|| anyhow!("Invalid macOS .app bundle path `{}`", target_app.display()))?;
    fs::create_dir_all(parent)?;

    let bundle_file_name = target_app
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Cowork.app");
    let backup = parent.join(format!(".{bundle_file_name}.bak.{}", Uuid::new_v4()));

    let move_result = swap_bundle_directories(new_app, target_app, &backup);
    match move_result {
        Ok(()) => {}
        Err(err) if is_permission_denied(&err) => {
            install_macos_app_privileged(new_app, target_app, &backup)?;
        }
        Err(err) => return Err(err),
    }

    let _ = Command::new("touch").arg(target_app).status();

    if relaunch {
        Command::new("open")
            .arg("-n")
            .arg(target_app)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("Failed to relaunch `{}`", target_app.display()))?;
    }
    Ok(())
}

fn swap_bundle_directories(new_app: &Path, target_app: &Path, backup: &Path) -> Result<()> {
    let had_existing = target_app.exists() || target_app.symlink_metadata().is_ok();
    if had_existing {
        fs::rename(target_app, backup)
            .with_context(|| format!("Failed to stage backup at `{}`", backup.display()))?;
    }

    let install_attempt = move_dir_across_volumes_if_needed(new_app, target_app);
    if let Err(err) = install_attempt {
        if had_existing && backup.exists() && !target_app.exists() {
            let _ = fs::rename(backup, target_app);
        }
        return Err(err);
    }

    if had_existing && backup.exists() {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn move_dir_across_volumes_if_needed(src: &Path, dst: &Path) -> Result<()> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(err) if is_cross_device(&err) => {
            let tmp_same_fs = dst.with_file_name(format!(".cowork-stage-{}", Uuid::new_v4()));
            if let Err(copy_err) = copy_dir_recursive(src, &tmp_same_fs) {
                let _ = fs::remove_dir_all(&tmp_same_fs);
                return Err(copy_err);
            }
            if let Err(rename_err) = fs::rename(&tmp_same_fs, dst) {
                let _ = fs::remove_dir_all(&tmp_same_fs);
                return Err(rename_err.into());
            }
            let _ = fs::remove_dir_all(src);
            Ok(())
        }
        Err(err) => Err(err.into()),
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_symlink() {
            let target = fs::read_link(&src_path)?;
            create_symlink(&target, &dst_path)?;
        } else if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
            #[cfg(unix)]
            {
                let perms = entry.metadata()?.permissions();
                let _ = fs::set_permissions(&dst_path, perms);
            }
        }
    }
    #[cfg(unix)]
    {
        if let Ok(meta) = fs::metadata(src) {
            let _ = fs::set_permissions(dst, meta.permissions());
        }
    }
    Ok(())
}

fn is_permission_denied(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io_err| io_err.kind() == std::io::ErrorKind::PermissionDenied)
    })
}

fn is_cross_device(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::CrossesDevices || err.raw_os_error() == Some(18)
}

fn install_macos_app_privileged(new_app: &Path, target_app: &Path, backup: &Path) -> Result<()> {
    let sh = |p: &Path| {
        let raw = p.to_string_lossy();
        format!("'{}'", raw.replace('\'', "'\"'\"'"))
    };
    let script = format!(
        "set -e; \
         if [ -e {target} ]; then /bin/mv -f {target} {backup}; fi; \
         if ! /bin/cp -pR {src} {target}; then \
           if [ -e {backup} ] && [ ! -e {target} ]; then /bin/mv -f {backup} {target}; fi; \
           exit 1; \
         fi; \
         /bin/rm -rf {backup} {src}",
        src = sh(new_app),
        target = sh(target_app),
        backup = sh(backup),
    );
    let applescript_escaped = script.replace('\\', "\\\\").replace('"', "\\\"");
    let status = Command::new("osascript")
        .arg("-e")
        .arg(format!(
            "do shell script \"{applescript_escaped}\" with administrator privileges"
        ))
        .status()
        .context("Failed to launch osascript for elevated update install")?;
    if !status.success() {
        bail!("Administrator update installation was cancelled or failed ({status}).");
    }
    Ok(())
}

/// Builds a detached PowerShell command that waits for `pid` to exit before running NSIS `/P /R`.
pub(crate) fn build_windows_relaunch_installer_command(
    installer_exe: &Path,
    pid: u32,
) -> (String, Vec<String>) {
    let escaped = installer_exe.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Wait-Process -Id {pid} -Timeout 30 -ErrorAction SilentlyContinue; \
         Start-Process -FilePath '{escaped}' -ArgumentList '/P','/R'"
    );
    let args = vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-WindowStyle".to_string(),
        "Hidden".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-Command".to_string(),
        script,
    ];
    ("powershell.exe".to_string(), args)
}

fn install_windows_nsis(installer_exe: &Path) -> Result<()> {
    let (program, args) =
        build_windows_relaunch_installer_command(installer_exe, std::process::id());
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .context("Failed to spawn detached Windows installer")?;
    Ok(())
}

/// Atomically swaps a verified AppImage over `target_appimage` on the same mount and optionally relaunches it.
pub(crate) fn replace_linux_appimage(
    staged_appimage: &Path,
    target_appimage: &Path,
    relaunch: bool,
) -> Result<()> {
    let parent = target_appimage
        .parent()
        .ok_or_else(|| anyhow!("Invalid AppImage path `{}`", target_appimage.display()))?;
    fs::create_dir_all(parent)?;

    let file_name = target_appimage
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Cowork.AppImage");
    let same_fs_tmp = parent.join(format!(".{file_name}.update.{}", Uuid::new_v4()));

    if let Err(err) = fs::copy(staged_appimage, &same_fs_tmp) {
        let _ = fs::remove_file(&same_fs_tmp);
        return Err(err)
            .with_context(|| format!("Failed to stage AppImage into `{}`", parent.display()));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) = fs::set_permissions(&same_fs_tmp, fs::Permissions::from_mode(0o755)) {
            let _ = fs::remove_file(&same_fs_tmp);
            return Err(err.into());
        }
    }

    if let Err(err) = fs::rename(&same_fs_tmp, target_appimage) {
        let _ = fs::remove_file(&same_fs_tmp);
        return Err(err).with_context(|| {
            format!(
                "Failed to atomically replace AppImage at `{}`",
                target_appimage.display()
            )
        });
    }
    let _ = fs::remove_file(staged_appimage);

    if relaunch {
        Command::new(target_appimage)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| {
                format!(
                    "Failed to relaunch AppImage `{}`",
                    target_appimage.display()
                )
            })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Pure-Rust RFC 8032 Ed25519 + Blake2b-512 Minisign test signer so tests stay dependency-free
    /// and generate authentic `ED` (prehashed) & `Ed` Minisign signatures over dynamic payloads.
    mod test_minisign {
        use super::*;

        // --- SHA-512 ---
        const SHA512_K: [u64; 80] = [
            0x428a2f98d728ae22,
            0x7137449123ef65cd,
            0xb5c0fbcfec4d3b2f,
            0xe9b5dba58189dbbc,
            0x3956c25bf348b538,
            0x59f111f1b605d019,
            0x923f82a4af194f9b,
            0xab1c5ed5da6d8118,
            0xd807aa98a3030242,
            0x12835b0145706fbe,
            0x243185be4ee4b28c,
            0x550c7dc3d5ffb4e2,
            0x72be5d74f27b896f,
            0x80deb1fe3b1696b1,
            0x9bdc06a725c71235,
            0xc19bf174cf692694,
            0xe49b69c19ef14ad2,
            0xefbe4786384f25e3,
            0x0fc19dc68b8cd5b5,
            0x240ca1cc77ac9c65,
            0x2de92c6f592b0275,
            0x4a7484aa6ea6e483,
            0x5cb0a9dcbd41fbd4,
            0x76f988da831153b5,
            0x983e5152ee66dfab,
            0xa831c66d2db43210,
            0xb00327c898fb213f,
            0xbf597fc7beef0ee4,
            0xc6e00bf33da88fc2,
            0xd5a79147930aa725,
            0x06ca6351e003826f,
            0x142929670a0e6e70,
            0x27b70a8546d22ffc,
            0x2e1b21385c26c926,
            0x4d2c6dfc5ac42aed,
            0x53380d139d95b3df,
            0x650a73548baf63de,
            0x766a0abb3c77b2a8,
            0x81c2c92e47edaee6,
            0x92722c851482353b,
            0xa2bfe8a14cf10364,
            0xa81a664bbc423001,
            0xc24b8b70d0f89791,
            0xc76c51a30654be30,
            0xd192e819d6ef5218,
            0xd69906245565a910,
            0xf40e35855771202a,
            0x106aa07032bbd1b8,
            0x19a4c116b8d2d0c8,
            0x1e376c085141ab53,
            0x2748774cdf8eeb99,
            0x34b0bcb5e19b48a8,
            0x391c0cb3c5c95a63,
            0x4ed8aa4ae3418acb,
            0x5b9cca4f7763e373,
            0x682e6ff3d6b2b8a3,
            0x748f82ee5defb2fc,
            0x78a5636f43172f60,
            0x84c87814a1f0ab72,
            0x8cc702081a6439ec,
            0x90befffa23631e28,
            0xa4506cebde82bde9,
            0xbef9a3f7b2c67915,
            0xc67178f2e372532b,
            0xca273eceea26619c,
            0xd186b8c721c0c207,
            0xeada7dd6cde0eb1e,
            0xf57d4f7fee6ed178,
            0x06f067aa72176fba,
            0x0a637dc5a2c898a6,
            0x113f9804bef90dae,
            0x1b710b35131c471b,
            0x28db77f523047d84,
            0x32caab7b40c72493,
            0x3c9ebe0a15c9bebc,
            0x431d67c49c100d4c,
            0x4cc5d4becb3e42b6,
            0x597f299cfc657e2a,
            0x5fcb6fab3ad6faec,
            0x6c44198c4a475817,
        ];

        pub fn sha512(msg: &[u8]) -> [u8; 64] {
            let mut h: [u64; 8] = [
                0x6a09e667f3bcc908,
                0xbb67ae8584caa73b,
                0x3c6ef372fe94f82b,
                0xa54ff53a5f1d36f1,
                0x510e527fade682d1,
                0x9b05688c2b3e6c1f,
                0x1f83d9abfb41bd6b,
                0x5be0cd19137e2179,
            ];
            let mut buf = msg.to_vec();
            let bit_len = (msg.len() as u128) * 8;
            buf.push(0x80);
            while buf.len() % 128 != 112 {
                buf.push(0);
            }
            buf.extend_from_slice(&bit_len.to_be_bytes());

            for block in buf.chunks_exact(128) {
                let mut w = [0u64; 80];
                for i in 0..16 {
                    w[i] = u64::from_be_bytes(block[i * 8..(i + 1) * 8].try_into().unwrap());
                }
                for i in 16..80 {
                    let s0 =
                        w[i - 15].rotate_right(1) ^ w[i - 15].rotate_right(8) ^ (w[i - 15] >> 7);
                    let s1 =
                        w[i - 2].rotate_right(19) ^ w[i - 2].rotate_right(61) ^ (w[i - 2] >> 6);
                    w[i] = w[i - 16]
                        .wrapping_add(s0)
                        .wrapping_add(w[i - 7])
                        .wrapping_add(s1);
                }
                let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
                for i in 0..80 {
                    let s1 = e.rotate_right(14) ^ e.rotate_right(18) ^ e.rotate_right(41);
                    let ch = (e & f) ^ ((!e) & g);
                    let temp1 = hh
                        .wrapping_add(s1)
                        .wrapping_add(ch)
                        .wrapping_add(SHA512_K[i])
                        .wrapping_add(w[i]);
                    let s0 = a.rotate_right(28) ^ a.rotate_right(34) ^ a.rotate_right(39);
                    let maj = (a & b) ^ (a & c) ^ (b & c);
                    let temp2 = s0.wrapping_add(maj);
                    hh = g;
                    g = f;
                    f = e;
                    e = d.wrapping_add(temp1);
                    d = c;
                    c = b;
                    b = a;
                    a = temp1.wrapping_add(temp2);
                }
                for (slot, val) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
                    *slot = slot.wrapping_add(val);
                }
            }
            let mut out = [0u8; 64];
            for (i, word) in h.iter().enumerate() {
                out[i * 8..(i + 1) * 8].copy_from_slice(&word.to_be_bytes());
            }
            out
        }

        // --- Blake2b-512 ---
        const BLAKE2B_IV: [u64; 8] = [
            0x6a09e667f3bcc908,
            0xbb67ae8584caa73b,
            0x3c6ef372fe94f82b,
            0xa54ff53a5f1d36f1,
            0x510e527fade682d1,
            0x9b05688c2b3e6c1f,
            0x1f83d9abfb41bd6b,
            0x5be0cd19137e2179,
        ];
        const BLAKE2B_SIGMA: [[usize; 16]; 12] = [
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
            [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
            [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
            [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
            [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
            [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
            [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
            [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
            [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
        ];

        fn blake2b_g(v: &mut [u64; 16], a: usize, b: usize, c: usize, d: usize, x: u64, y: u64) {
            v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
            v[d] = (v[d] ^ v[a]).rotate_right(32);
            v[c] = v[c].wrapping_add(v[d]);
            v[b] = (v[b] ^ v[c]).rotate_right(24);
            v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
            v[d] = (v[d] ^ v[a]).rotate_right(16);
            v[c] = v[c].wrapping_add(v[d]);
            v[b] = (v[b] ^ v[c]).rotate_right(63);
        }

        pub fn blake2b512(msg: &[u8]) -> [u8; 64] {
            let mut h = BLAKE2B_IV;
            h[0] ^= 0x0101_0040; // fanout=1, depth=1, outlen=64
            let mut offset: u128 = 0;

            let compress = |h: &mut [u64; 8], block: &[u8; 128], t: u128, last: bool| {
                let mut m = [0u64; 16];
                for i in 0..16 {
                    m[i] = u64::from_le_bytes(block[i * 8..(i + 1) * 8].try_into().unwrap());
                }
                let mut v = [0u64; 16];
                v[..8].copy_from_slice(h);
                v[8..].copy_from_slice(&BLAKE2B_IV);
                v[12] ^= t as u64;
                v[13] ^= (t >> 64) as u64;
                if last {
                    v[14] = !v[14];
                }
                for row in BLAKE2B_SIGMA {
                    blake2b_g(&mut v, 0, 4, 8, 12, m[row[0]], m[row[1]]);
                    blake2b_g(&mut v, 1, 5, 9, 13, m[row[2]], m[row[3]]);
                    blake2b_g(&mut v, 2, 6, 10, 14, m[row[4]], m[row[5]]);
                    blake2b_g(&mut v, 3, 7, 11, 15, m[row[6]], m[row[7]]);
                    blake2b_g(&mut v, 0, 5, 10, 15, m[row[8]], m[row[9]]);
                    blake2b_g(&mut v, 1, 6, 11, 12, m[row[10]], m[row[11]]);
                    blake2b_g(&mut v, 2, 7, 8, 13, m[row[12]], m[row[13]]);
                    blake2b_g(&mut v, 3, 4, 9, 14, m[row[14]], m[row[15]]);
                }
                for i in 0..8 {
                    h[i] ^= v[i] ^ v[i + 8];
                }
            };

            let mut idx = 0;
            while idx + 128 < msg.len() {
                offset += 128;
                let block: &[u8; 128] = msg[idx..idx + 128].try_into().unwrap();
                compress(&mut h, block, offset, false);
                idx += 128;
            }
            let rem = &msg[idx..];
            offset += rem.len() as u128;
            let mut last_block = [0u8; 128];
            last_block[..rem.len()].copy_from_slice(rem);
            compress(&mut h, &last_block, offset, true);

            let mut out = [0u8; 64];
            for (i, w) in h.iter().enumerate() {
                out[i * 8..(i + 1) * 8].copy_from_slice(&w.to_le_bytes());
            }
            out
        }

        // --- TweetNaCl Ed25519 signing ---
        type Gf = [i64; 16];
        const GF0: Gf = [0; 16];
        const GF1: Gf = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const D2: Gf = [
            0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0, 0xd130, 0xeef3, 0x80f2,
            0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406,
        ];
        const BX: Gf = [
            0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c, 0xdc5c, 0xfdd6, 0xe231,
            0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169,
        ];
        const BY: Gf = [
            0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666,
            0x6666, 0x6666, 0x6666, 0x6666, 0x6666,
        ];
        const GROUP_ORDER: [u64; 32] = [
            0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9,
            0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
        ];

        fn car25519(o: &mut Gf) {
            for i in 0..16 {
                o[i] += 1 << 16;
                let c = o[i] >> 16;
                let next = if i == 15 { 0 } else { i + 1 };
                o[next] += c - 1 + if i == 15 { 37 * (c - 1) } else { 0 };
                o[i] -= c << 16;
            }
        }

        fn gf_add(a: &Gf, b: &Gf) -> Gf {
            let mut o = GF0;
            for i in 0..16 {
                o[i] = a[i] + b[i];
            }
            o
        }

        fn gf_sub(a: &Gf, b: &Gf) -> Gf {
            let mut o = GF0;
            for i in 0..16 {
                o[i] = a[i] - b[i];
            }
            o
        }

        fn gf_mul(a: &Gf, b: &Gf) -> Gf {
            let mut t = [0i64; 31];
            for i in 0..16 {
                for j in 0..16 {
                    t[i + j] += a[i] * b[j];
                }
            }
            for i in 0..15 {
                t[i] += 38 * t[i + 16];
            }
            let mut o = GF0;
            o.copy_from_slice(&t[..16]);
            car25519(&mut o);
            car25519(&mut o);
            o
        }

        fn gf_sq(a: &Gf) -> Gf {
            gf_mul(a, a)
        }

        fn gf_inv(i: &Gf) -> Gf {
            let mut c = *i;
            for a in (0..=253).rev() {
                c = gf_sq(&c);
                if a != 2 && a != 4 {
                    c = gf_mul(&c, i);
                }
            }
            c
        }

        fn gf_sel(p: &mut Gf, q: &mut Gf, b: i64) {
            let c = !(b - 1);
            for i in 0..16 {
                let t = c & (p[i] ^ q[i]);
                p[i] ^= t;
                q[i] ^= t;
            }
        }

        fn pack25519(n: &Gf) -> [u8; 32] {
            let mut t = *n;
            car25519(&mut t);
            car25519(&mut t);
            car25519(&mut t);
            let mut m = GF0;
            for _ in 0..2 {
                m[0] = t[0] - 0xffed;
                for i in 1..15 {
                    m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
                    m[i - 1] &= 0xffff;
                }
                m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
                let b = (m[15] >> 16) & 1;
                m[14] &= 0xffff;
                gf_sel(&mut t, &mut m, 1 - b);
            }
            let mut o = [0u8; 32];
            for i in 0..16 {
                o[2 * i] = (t[i] & 0xff) as u8;
                o[2 * i + 1] = ((t[i] >> 8) & 0xff) as u8;
            }
            o
        }

        fn par25519(a: &Gf) -> u8 {
            pack25519(a)[0] & 1
        }

        fn ge_add(p: &mut [Gf; 4], q: &[Gf; 4]) {
            let mut a = gf_sub(&p[1], &p[0]);
            let t = gf_sub(&q[1], &q[0]);
            a = gf_mul(&a, &t);
            let mut b = gf_add(&p[0], &p[1]);
            let t2 = gf_add(&q[0], &q[1]);
            b = gf_mul(&b, &t2);
            let c = gf_mul(&p[3], &q[3]);
            let c = gf_mul(&c, &D2);
            let mut d = gf_mul(&p[2], &q[2]);
            d = gf_add(&d, &d);
            let e = gf_sub(&b, &a);
            let f = gf_sub(&d, &c);
            let g = gf_add(&d, &c);
            let h = gf_add(&b, &a);
            p[0] = gf_mul(&e, &f);
            p[1] = gf_mul(&h, &g);
            p[2] = gf_mul(&g, &f);
            p[3] = gf_mul(&e, &h);
        }

        fn ge_cswap(p: &mut [Gf; 4], q: &mut [Gf; 4], b: u8) {
            for i in 0..4 {
                gf_sel(&mut p[i], &mut q[i], i64::from(b));
            }
        }

        fn scalarmult_base(s: &[u8; 32]) -> [u8; 32] {
            let mut q = [GF0, GF0, GF0, GF0];
            q[0] = BX;
            q[1] = BY;
            q[2] = GF1;
            q[3] = gf_mul(&BX, &BY);
            let mut p = [GF0, GF1, GF1, GF0];
            for i in (0..=255).rev() {
                let b = (s[i / 8] >> (i & 7)) & 1;
                ge_cswap(&mut p, &mut q, b);
                ge_add(&mut q, &p);
                let p_copy = p;
                ge_add(&mut p, &p_copy);
                ge_cswap(&mut p, &mut q, b);
            }
            let zi = gf_inv(&p[2]);
            let tx = gf_mul(&p[0], &zi);
            let ty = gf_mul(&p[1], &zi);
            let mut r = pack25519(&ty);
            r[31] ^= par25519(&tx) << 7;
            r
        }

        fn mod_l(r: &mut [u8; 32], x: &mut [i64; 64]) {
            for i in (32..=63).rev() {
                let mut carry = 0i64;
                for j in (i - 32)..(i - 12) {
                    x[j] += carry - 16 * x[i] * GROUP_ORDER[j - (i - 32)] as i64;
                    carry = (x[j] + 128) >> 8;
                    x[j] -= carry << 8;
                }
                let j = i - 12;
                x[j] += carry;
                x[i] = 0;
            }
            let mut carry = 0i64;
            for j in 0..32 {
                x[j] += carry - (x[31] >> 4) * GROUP_ORDER[j] as i64;
                carry = x[j] >> 8;
                x[j] &= 255;
            }
            for j in 0..32 {
                x[j] -= carry * GROUP_ORDER[j] as i64;
            }
            for i in 0..32 {
                x[i + 1] += x[i] >> 8;
                r[i] = (x[i] & 255) as u8;
            }
        }

        fn reduce(r: &mut [u8; 64]) {
            let mut x = [0i64; 64];
            for i in 0..64 {
                x[i] = i64::from(r[i]);
                r[i] = 0;
            }
            let mut out = [0u8; 32];
            mod_l(&mut out, &mut x);
            r[..32].copy_from_slice(&out);
        }

        pub fn ed25519_public_from_seed(seed: &[u8; 32]) -> [u8; 32] {
            let mut d = sha512(seed);
            d[0] &= 248;
            d[31] &= 127;
            d[31] |= 64;
            let s: [u8; 32] = d[..32].try_into().unwrap();
            scalarmult_base(&s)
        }

        pub fn ed25519_sign(seed: &[u8; 32], msg: &[u8]) -> [u8; 64] {
            let mut d = sha512(seed);
            d[0] &= 248;
            d[31] &= 127;
            d[31] |= 64;
            let s: [u8; 32] = d[..32].try_into().unwrap();
            let pk = scalarmult_base(&s);

            let mut r_in = Vec::with_capacity(32 + msg.len());
            r_in.extend_from_slice(&d[32..64]);
            r_in.extend_from_slice(msg);
            let mut r = sha512(&r_in);
            reduce(&mut r);
            let r_scalar: [u8; 32] = r[..32].try_into().unwrap();
            let r_point = scalarmult_base(&r_scalar);

            let mut h_in = Vec::with_capacity(64 + msg.len());
            h_in.extend_from_slice(&r_point);
            h_in.extend_from_slice(&pk);
            h_in.extend_from_slice(msg);
            let mut h = sha512(&h_in);
            reduce(&mut h);

            let mut x = [0i64; 64];
            for i in 0..32 {
                x[i] = i64::from(r[i]);
            }
            for i in 0..32 {
                for j in 0..32 {
                    x[i + j] += i64::from(h[i]) * i64::from(d[j]);
                }
            }
            let mut s_out = [0u8; 32];
            mod_l(&mut s_out, &mut x);

            let mut sig = [0u8; 64];
            sig[..32].copy_from_slice(&r_point);
            sig[32..].copy_from_slice(&s_out);
            sig
        }

        pub fn minisign_pubkey_box_b64(seed: &[u8; 32], key_id: [u8; 8]) -> String {
            let pk = ed25519_public_from_seed(seed);
            let mut raw = Vec::with_capacity(42);
            raw.extend_from_slice(b"Ed");
            raw.extend_from_slice(&key_id);
            raw.extend_from_slice(&pk);
            let box_str = format!(
                "untrusted comment: cowork test public key\n{}",
                BASE64_STANDARD.encode(&raw)
            );
            BASE64_STANDARD.encode(box_str.as_bytes())
        }

        pub fn minisign_sign_payload_b64(
            seed: &[u8; 32],
            key_id: [u8; 8],
            payload: &[u8],
            prehashed: bool,
        ) -> String {
            let (alg, signed_bytes) = if prehashed {
                (*b"ED", blake2b512(payload).to_vec())
            } else {
                (*b"Ed", payload.to_vec())
            };
            let sig = ed25519_sign(seed, &signed_bytes);
            let mut line1_raw = Vec::with_capacity(74);
            line1_raw.extend_from_slice(&alg);
            line1_raw.extend_from_slice(&key_id);
            line1_raw.extend_from_slice(&sig);

            let trusted_body = "timestamp:1763222400\tfile:update.bin\thashed";
            let mut global_msg = Vec::with_capacity(64 + trusted_body.len());
            global_msg.extend_from_slice(&sig);
            global_msg.extend_from_slice(trusted_body.as_bytes());
            let global_sig = ed25519_sign(seed, &global_msg);

            let sig_box = format!(
                "untrusted comment: signature from test secret key\n{}\ntrusted comment: {trusted_body}\n{}\n",
                BASE64_STANDARD.encode(&line1_raw),
                BASE64_STANDARD.encode(global_sig)
            );
            BASE64_STANDARD.encode(sig_box.as_bytes())
        }
    }

    fn build_test_macos_app_tar_gz(bundle_name: &str, binary_content: &[u8]) -> Vec<u8> {
        let mut tar_gz = Vec::new();
        {
            let gz = GzEncoder::new(&mut tar_gz, Compression::default());
            let mut builder = tar::Builder::new(gz);

            let mut bin_hdr = tar::Header::new_gnu();
            bin_hdr.set_size(binary_content.len() as u64);
            bin_hdr.set_mode(0o755);
            bin_hdr.set_cksum();
            builder
                .append_data(
                    &mut bin_hdr,
                    format!("{bundle_name}/Contents/MacOS/cowork-desktop"),
                    binary_content,
                )
                .unwrap();

            let plist =
                b"<plist><dict><key>CFBundleVersion</key><string>9.9.9</string></dict></plist>";
            let mut plist_hdr = tar::Header::new_gnu();
            plist_hdr.set_size(plist.len() as u64);
            plist_hdr.set_mode(0o644);
            plist_hdr.set_cksum();
            builder
                .append_data(
                    &mut plist_hdr,
                    format!("{bundle_name}/Contents/Info.plist"),
                    &plist[..],
                )
                .unwrap();

            builder.finish().unwrap();
        }
        tar_gz
    }

    async fn spawn_mock_feed_server(routes: BTreeMap<String, (u16, String, Vec<u8>)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let routes = Arc::new(routes);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let (status, ctype, body) = routes
                        .get(path)
                        .cloned()
                        .unwrap_or_else(|| (404, "text/plain".to_string(), b"Not Found".to_vec()));
                    let reason = match status {
                        200 => "OK",
                        204 => "No Content",
                        404 => "Not Found",
                        _ => "Error",
                    };
                    let head = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    if status != 204 {
                        let _ = stream.write_all(&body).await;
                    }
                });
            }
        });
        format!("http://{addr}")
    }

    #[test]
    fn test_signer_matches_rfc8032_and_minisign_verify() {
        // RFC 8032 test vector #1
        let seed: [u8; 32] =
            hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                .unwrap()
                .try_into()
                .unwrap();
        assert_eq!(
            hex::encode(test_minisign::ed25519_public_from_seed(&seed)),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        assert_eq!(
            hex::encode(test_minisign::ed25519_sign(&seed, b"")),
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155\
             5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        );

        let key_id = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
        let pk_b64 = test_minisign::minisign_pubkey_box_b64(&seed, key_id);
        let pk = decode_minisign_public_key(&pk_b64).unwrap();
        let sig_b64 =
            test_minisign::minisign_sign_payload_b64(&seed, key_id, b"hello update", true);
        let sig = decode_minisign_signature(&sig_b64).unwrap();
        pk.verify(b"hello update", &sig, false).unwrap();
    }

    #[tokio::test]
    async fn unpackaged_and_missing_pubkey_and_linux_non_appimage_stay_disabled() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let emit: Arc<dyn Fn(StoreEvent) + Send + Sync> = Arc::new(move |ev| {
            captured.lock().unwrap().push(ev);
        });

        let unpackaged = DesktopUpdaterService::with_config(
            UpdaterConfig {
                is_packaged: false,
                current_version: "1.2.3".into(),
                ..UpdaterConfig::default()
            },
            None,
            emit.clone(),
        );
        assert_eq!(unpackaged.get_state().status, "disabled");
        assert!(!unpackaged.get_state().packaged);
        assert_eq!(
            unpackaged.check_for_updates_async().await.status,
            "disabled"
        );

        let no_key = DesktopUpdaterService::with_config(
            UpdaterConfig {
                is_packaged: true,
                pubkey: None,
                target: UpdaterTarget {
                    os: "macos".into(),
                    arch: "aarch64".into(),
                    appimage_path: None,
                    current_exe: None,
                    install_root_override: None,
                },
                ..UpdaterConfig::default()
            },
            None,
            emit.clone(),
        );
        assert_eq!(no_key.get_state().status, "disabled");
        assert!(no_key.get_state().packaged);

        let linux_deb = DesktopUpdaterService::with_config(
            UpdaterConfig {
                is_packaged: true,
                pubkey: Some("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3".into()),
                target: UpdaterTarget {
                    os: "linux".into(),
                    arch: "x86_64".into(),
                    appimage_path: None,
                    current_exe: None,
                    install_root_override: None,
                },
                ..UpdaterConfig::default()
            },
            None,
            emit,
        );
        assert_eq!(linux_deb.get_state().status, "disabled");
        assert!(
            linux_deb
                .get_state()
                .notes
                .as_deref()
                .is_some_and(|n| n.contains("AppImage"))
        );
    }

    #[tokio::test]
    async fn feed_404_disables_cleanly_and_older_or_204_reports_up_to_date() {
        let seed = [7u8; 32];
        let key_id = [1, 2, 3, 4, 5, 6, 7, 8];
        let pk_b64 = test_minisign::minisign_pubkey_box_b64(&seed, key_id);

        let older_manifest = serde_json::to_vec(&json!({
            "version": "1.0.0",
            "platforms": {
                "macos-aarch64": { "url": "/bundle.tar.gz", "signature": "unused" }
            }
        }))
        .unwrap();

        let base = spawn_mock_feed_server(BTreeMap::from([
            (
                "/missing/latest.json".into(),
                (404, "text/plain".into(), b"not found".to_vec()),
            ),
            (
                "/empty/latest.json".into(),
                (204, "application/json".into(), Vec::new()),
            ),
            (
                "/same/latest.json".into(),
                (200, "application/json".into(), older_manifest),
            ),
            (
                "/boom/latest.json".into(),
                (500, "text/plain".into(), b"server err".to_vec()),
            ),
        ]))
        .await;

        let emit: Arc<dyn Fn(StoreEvent) + Send + Sync> = Arc::new(|_| {});
        let make_svc = |path: &str| {
            DesktopUpdaterService::with_config(
                UpdaterConfig {
                    is_packaged: true,
                    current_version: "1.0.0".into(),
                    feed_url: format!("{base}{path}"),
                    pubkey: Some(pk_b64.clone()),
                    target: UpdaterTarget {
                        os: "macos".into(),
                        arch: "aarch64".into(),
                        appimage_path: None,
                        current_exe: None,
                        install_root_override: None,
                    },
                    ..UpdaterConfig::default()
                },
                None,
                emit.clone(),
            )
        };

        let s404 = make_svc("/missing/latest.json")
            .check_for_updates_async()
            .await;
        assert_eq!(s404.status, "disabled");
        assert!(s404.error.is_none());
        assert_eq!(s404.notes.as_deref(), Some(DISABLED_MISSING_FEED_REASON));

        let s204 = make_svc("/empty/latest.json")
            .check_for_updates_async()
            .await;
        assert_eq!(s204.status, "up-to-date");

        let s_same = make_svc("/same/latest.json")
            .check_for_updates_async()
            .await;
        assert_eq!(s_same.status, "up-to-date");
        assert_eq!(s_same.version.as_deref(), Some("1.0.0"));

        let s500 = make_svc("/boom/latest.json")
            .check_for_updates_async()
            .await;
        assert_eq!(s500.status, "error");
        assert!(s500.error.as_deref().is_some_and(|e| e.contains("500")));
    }

    #[tokio::test]
    async fn signed_macos_update_downloads_emits_progress_and_installs_on_shutdown() {
        let tmp = tempfile::tempdir().unwrap();
        let target_app = tmp.path().join("Applications").join("Cowork.app");
        fs::create_dir_all(target_app.join("Contents/MacOS")).unwrap();
        fs::write(target_app.join("Contents/MacOS/cowork-desktop"), b"old-v1").unwrap();

        let seed = [42u8; 32];
        let key_id = [9, 8, 7, 6, 5, 4, 3, 2];
        let pk_b64 = test_minisign::minisign_pubkey_box_b64(&seed, key_id);
        let tar_gz = build_test_macos_app_tar_gz("Cowork.app", b"new-v2-binary");
        let sig_b64 = test_minisign::minisign_sign_payload_b64(&seed, key_id, &tar_gz, true);

        let manifest = serde_json::to_vec(&json!({
            "version": "v2.0.0",
            "notes": "Native updater release notes",
            "platforms": {
                "macos-aarch64": {
                    "url": "/downloads/Cowork.app.tar.gz",
                    "signature": sig_b64,
                    "format": "app"
                }
            }
        }))
        .unwrap();

        let base = spawn_mock_feed_server(BTreeMap::from([
            (
                "/latest.json".into(),
                (200, "application/json".into(), manifest),
            ),
            (
                "/downloads/Cowork.app.tar.gz".into(),
                (200, "application/gzip".into(), tar_gz.clone()),
            ),
        ]))
        .await;

        let states = Arc::new(Mutex::new(Vec::<UpdaterState>::new()));
        let captured = states.clone();
        let emit: Arc<dyn Fn(StoreEvent) + Send + Sync> = Arc::new(move |ev| {
            if let StoreEvent::UpdaterChanged(u) = ev {
                captured.lock().unwrap().push(u);
            }
        });
        let quit_called = Arc::new(AtomicBool::new(false));
        let quit_flag = quit_called.clone();

        let svc = DesktopUpdaterService::with_config(
            UpdaterConfig {
                is_packaged: true,
                current_version: "1.0.0".into(),
                feed_url: format!("{base}/latest.json"),
                pubkey: Some(pk_b64),
                staging_dir: Some(tmp.path().join("staging")),
                target: UpdaterTarget {
                    os: "macos".into(),
                    arch: "aarch64".into(),
                    appimage_path: None,
                    current_exe: None,
                    install_root_override: Some(target_app.clone()),
                },
                request_quit: Some(Arc::new(move || {
                    quit_flag.store(true, Ordering::Release);
                })),
                install_handler: None,
                relaunch_after_install: false,
                ..UpdaterConfig::default()
            },
            None,
            emit,
        );

        // quit_and_install is a no-op before an update has finished downloading.
        svc.quit_and_install();
        assert!(!quit_called.load(Ordering::Acquire));

        let final_state = svc.check_for_updates_async().await;
        assert_eq!(final_state.status, "downloaded");
        assert_eq!(final_state.available_version.as_deref(), Some("2.0.0"));
        assert_eq!(final_state.download_progress, Some(100.0));
        assert_eq!(final_state.downloaded_bytes, Some(tar_gz.len() as u64));
        assert_eq!(final_state.total_bytes, Some(tar_gz.len() as u64));
        assert_eq!(
            final_state.notes.as_deref(),
            Some("Native updater release notes")
        );

        let recorded: Vec<String> = states
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.status.clone())
            .collect();
        assert!(recorded.contains(&"checking".to_string()));
        assert!(recorded.contains(&"available".to_string()));
        assert!(recorded.contains(&"downloading".to_string()));
        assert_eq!(recorded.last().map(String::as_str), Some("downloaded"));

        svc.quit_and_install();
        assert!(quit_called.load(Ordering::Acquire));
        svc.execute_pending_install_on_shutdown().unwrap();

        assert_eq!(
            fs::read(target_app.join("Contents/MacOS/cowork-desktop")).unwrap(),
            b"new-v2-binary"
        );
    }

    #[tokio::test]
    async fn tampered_payload_or_bad_signature_fails_verification_without_overwriting() {
        let tmp = tempfile::tempdir().unwrap();
        let target_app = tmp.path().join("Cowork.app");
        fs::create_dir_all(target_app.join("Contents/MacOS")).unwrap();
        fs::write(
            target_app.join("Contents/MacOS/cowork-desktop"),
            b"trusted-v1",
        )
        .unwrap();

        let seed = [11u8; 32];
        let other_seed = [22u8; 32];
        let key_id = [4, 4, 4, 4, 4, 4, 4, 4];
        let trusted_pk_b64 = test_minisign::minisign_pubkey_box_b64(&seed, key_id);

        let good_tar = build_test_macos_app_tar_gz("Cowork.app", b"legit");
        let sig_for_good = test_minisign::minisign_sign_payload_b64(&seed, key_id, &good_tar, true);
        let tampered_tar = build_test_macos_app_tar_gz("Cowork.app", b"tampered-evil");
        let wrong_key_sig =
            test_minisign::minisign_sign_payload_b64(&other_seed, key_id, &good_tar, true);

        let manifest_tampered = serde_json::to_vec(&json!({
            "version": "2.0.0",
            "platforms": {
                "macos-aarch64": { "url": "/tampered.tar.gz", "signature": sig_for_good }
            }
        }))
        .unwrap();
        let manifest_wrong_key = serde_json::to_vec(&json!({
            "version": "2.0.0",
            "platforms": {
                "macos-aarch64": { "url": "/good.tar.gz", "signature": wrong_key_sig }
            }
        }))
        .unwrap();

        let base = spawn_mock_feed_server(BTreeMap::from([
            (
                "/tampered/latest.json".into(),
                (200, "application/json".into(), manifest_tampered),
            ),
            (
                "/wrong-key/latest.json".into(),
                (200, "application/json".into(), manifest_wrong_key),
            ),
            (
                "/tampered.tar.gz".into(),
                (200, "application/gzip".into(), tampered_tar),
            ),
            (
                "/good.tar.gz".into(),
                (200, "application/gzip".into(), good_tar),
            ),
        ]))
        .await;

        let staging = tmp.path().join("staging");
        let emit: Arc<dyn Fn(StoreEvent) + Send + Sync> = Arc::new(|_| {});

        for feed_path in ["/tampered/latest.json", "/wrong-key/latest.json"] {
            let svc = DesktopUpdaterService::with_config(
                UpdaterConfig {
                    is_packaged: true,
                    current_version: "1.0.0".into(),
                    feed_url: format!("{base}{feed_path}"),
                    pubkey: Some(trusted_pk_b64.clone()),
                    staging_dir: Some(staging.clone()),
                    target: UpdaterTarget {
                        os: "macos".into(),
                        arch: "aarch64".into(),
                        appimage_path: None,
                        current_exe: None,
                        install_root_override: Some(target_app.clone()),
                    },
                    relaunch_after_install: false,
                    ..UpdaterConfig::default()
                },
                None,
                emit.clone(),
            );
            let res = svc.check_for_updates_async().await;
            assert_eq!(res.status, "error", "expected error for {feed_path}");
            assert!(
                res.error
                    .as_deref()
                    .is_some_and(|e| e.contains("signature verification failed")),
                "unexpected error: {:?}",
                res.error
            );
            svc.quit_and_install();
            svc.execute_pending_install_on_shutdown().unwrap();
            assert_eq!(
                fs::read(target_app.join("Contents/MacOS/cowork-desktop")).unwrap(),
                b"trusted-v1"
            );
        }
    }

    #[test]
    fn extract_macos_tar_rejects_path_traversal_and_escaping_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let bad_tar = tmp.path().join("escape.tar.gz");
        {
            let f = File::create(&bad_tar).unwrap();
            let gz = GzEncoder::new(f, Compression::default());
            let mut builder = tar::Builder::new(gz);
            let mut hdr = tar::Header::new_gnu();
            let data = b"evil";
            hdr.set_size(data.len() as u64);
            hdr.set_mode(0o644);
            // Write raw `..` header component to bypass Builder's normalization check
            let header_bytes = hdr.as_mut_bytes();
            let name = b"Cowork.app/../../evil";
            header_bytes[..name.len()].copy_from_slice(name);
            hdr.set_cksum();
            builder.append(&hdr, &data[..]).unwrap();
            builder.finish().unwrap();
        }
        let err = extract_macos_app_tar_gz(&bad_tar, &tmp.path().join("out"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("traversal"), "unexpected error: {err}");

        #[cfg(unix)]
        {
            let link_tar = tmp.path().join("badlink.tar.gz");
            {
                let f = File::create(&link_tar).unwrap();
                let gz = GzEncoder::new(f, Compression::default());
                let mut builder = tar::Builder::new(gz);
                let mut hdr = tar::Header::new_gnu();
                hdr.set_entry_type(tar::EntryType::Symlink);
                hdr.set_size(0);
                hdr.set_mode(0o777);
                builder
                    .append_link(
                        &mut hdr,
                        "Cowork.app/Contents/MacOS/escape",
                        "../../../etc/passwd",
                    )
                    .unwrap();
                builder.finish().unwrap();
            }
            let err = extract_macos_app_tar_gz(&link_tar, &tmp.path().join("out2"))
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("escapes bundle root"),
                "unexpected error: {err}"
            );
        }
    }

    #[tokio::test]
    async fn linux_appimage_and_windows_command_builders_work_cleanly() {
        let tmp = tempfile::tempdir().unwrap();
        let target_appimage = tmp.path().join("Cowork.AppImage");
        fs::write(&target_appimage, b"old-appimage").unwrap();

        let seed = [33u8; 32];
        let key_id = [5, 5, 5, 5, 5, 5, 5, 5];
        let pk_b64 = test_minisign::minisign_pubkey_box_b64(&seed, key_id);
        let new_appimage = b"new-appimage-v2.1.0";
        let sig_b64 = test_minisign::minisign_sign_payload_b64(&seed, key_id, new_appimage, true);

        let manifest = serde_json::to_vec(&json!({
            "version": "2.1.0",
            "platforms": {
                "linux-x86_64": {
                    "url": "/Cowork.AppImage",
                    "signature": sig_b64,
                    "format": "appimage"
                }
            }
        }))
        .unwrap();

        let base = spawn_mock_feed_server(BTreeMap::from([
            (
                "/latest.json".into(),
                (200, "application/json".into(), manifest),
            ),
            (
                "/Cowork.AppImage".into(),
                (
                    200,
                    "application/octet-stream".into(),
                    new_appimage.to_vec(),
                ),
            ),
        ]))
        .await;

        let svc = DesktopUpdaterService::with_config(
            UpdaterConfig {
                is_packaged: true,
                current_version: "2.0.0".into(),
                feed_url: format!("{base}/latest.json"),
                pubkey: Some(pk_b64),
                staging_dir: Some(tmp.path().join("staging")),
                target: UpdaterTarget {
                    os: "linux".into(),
                    arch: "x86_64".into(),
                    appimage_path: Some(target_appimage.clone()),
                    current_exe: None,
                    install_root_override: None,
                },
                relaunch_after_install: false,
                ..UpdaterConfig::default()
            },
            None,
            Arc::new(|_| {}),
        );

        let state = svc.check_for_updates_async().await;
        assert_eq!(state.status, "downloaded");
        svc.quit_and_install();
        svc.execute_pending_install_on_shutdown().unwrap();
        assert_eq!(fs::read(&target_appimage).unwrap(), new_appimage);

        let (prog, args) = build_windows_relaunch_installer_command(
            Path::new(r"C:\Temp\Cowork's Setup.exe"),
            12345,
        );
        assert_eq!(prog, "powershell.exe");
        let cmdline = args.last().unwrap();
        assert!(cmdline.contains("Wait-Process -Id 12345"));
        assert!(cmdline.contains("Cowork''s Setup.exe"));
        assert!(cmdline.contains("'/P','/R'"));
    }

    #[tokio::test]
    async fn scheduled_startup_check_fires_and_dispose_cancels_cleanly() {
        let base = spawn_mock_feed_server(BTreeMap::from([(
            "/latest.json".into(),
            (204, "application/json".into(), Vec::new()),
        )]))
        .await;
        let seed = [8u8; 32];
        let pk_b64 = test_minisign::minisign_pubkey_box_b64(&seed, [1; 8]);

        let reached = Arc::new(AtomicBool::new(false));
        let reached_flag = reached.clone();
        let emit: Arc<dyn Fn(StoreEvent) + Send + Sync> = Arc::new(move |ev| {
            if let StoreEvent::UpdaterChanged(state) = ev
                && state.status == "up-to-date"
            {
                reached_flag.store(true, Ordering::Release);
            }
        });

        let svc = DesktopUpdaterService::with_config(
            UpdaterConfig {
                is_packaged: true,
                current_version: "1.0.0".into(),
                feed_url: format!("{base}/latest.json"),
                pubkey: Some(pk_b64),
                startup_delay: Duration::from_millis(20),
                poll_interval: Duration::from_secs(60),
                target: UpdaterTarget {
                    os: "macos".into(),
                    arch: "aarch64".into(),
                    appimage_path: None,
                    current_exe: None,
                    install_root_override: None,
                },
                ..UpdaterConfig::default()
            },
            None,
            emit,
        );
        svc.start();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !reached.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("expected startup check to transition to up-to-date");

        svc.dispose();
        assert!(svc.scheduler_task.lock().unwrap().is_none());
    }

    #[test]
    fn url_safety_and_intra_bundle_symlinks_are_handled_correctly() {
        assert!(
            assert_safe_updater_url(
                "https://github.com/mweinbach/agent-coworker/releases/latest/download/latest.json"
            )
            .is_ok()
        );
        assert!(assert_safe_updater_url("http://127.0.0.1:7337/latest.json").is_ok());
        assert!(assert_safe_updater_url("http://localhost:8080/latest.json").is_ok());
        assert!(assert_safe_updater_url("http://example.com/latest.json").is_err());
        assert!(assert_safe_updater_url("https://user:secret@github.com/latest.json").is_err());

        #[cfg(unix)]
        {
            let tmp = tempfile::tempdir().unwrap();
            let valid_tar = tmp.path().join("valid-symlink.tar.gz");
            {
                let f = File::create(&valid_tar).unwrap();
                let gz = GzEncoder::new(f, Compression::default());
                let mut builder = tar::Builder::new(gz);

                let bin = b"ok";
                let mut bin_hdr = tar::Header::new_gnu();
                bin_hdr.set_size(bin.len() as u64);
                bin_hdr.set_mode(0o755);
                bin_hdr.set_cksum();
                builder
                    .append_data(
                        &mut bin_hdr,
                        "Cowork.app/Contents/MacOS/cowork-desktop",
                        &bin[..],
                    )
                    .unwrap();

                let mut link_hdr = tar::Header::new_gnu();
                link_hdr.set_entry_type(tar::EntryType::Symlink);
                link_hdr.set_size(0);
                link_hdr.set_mode(0o777);
                builder
                    .append_link(
                        &mut link_hdr,
                        "Cowork.app/Contents/Frameworks/Sparkle.framework/Current",
                        "Versions/A",
                    )
                    .unwrap();
                builder.finish().unwrap();
            }
            let extracted = extract_macos_app_tar_gz(&valid_tar, &tmp.path().join("out")).unwrap();
            assert_eq!(
                fs::read_link(extracted.join("Contents/Frameworks/Sparkle.framework/Current"))
                    .unwrap(),
                PathBuf::from("Versions/A")
            );
        }
    }
}
