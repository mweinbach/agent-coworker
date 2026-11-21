//! Per-workspace `cowork-server` sidecar process lifecycle manager.
//!
//! Replaces `apps/desktop/electron/services/{serverManager.ts, publicTelemetryEnv.ts}`:
//! spawns `cowork-server --dir <path> --port 0 --json`, parses NDJSON readiness/bootstrap
//! stdout, holds child stdin open for cooperative EOF shutdown, enforces timeouts, scrubs
//! unconsented telemetry env vars, and tracks diagnostics without leaking `?coworkBrowserToken=`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Notify;
use url::Url;
use uuid::Uuid;

use super::crash_reporting::build_server_crash_reporting_env;
use super::local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger, strip_url_secrets};
use super::product_analytics::{
    PersistedProductAnalyticsState, build_server_product_analytics_env,
};
use super::server_platform::{configure_sidecar_command, terminate_process_tree};
use super::sidecar::{find_sidecar_launch_command, resolve_builtin_dir_for_sidecar};
use super::telemetry_status::resolve_telemetry_consent;
use super::validation::{assert_safe_id, assert_workspace_directory};
use crate::actions::StoreEvent;
use crate::state::PrivacyTelemetrySettings;

pub const DEFAULT_SERVER_STARTUP_TIMEOUT_MS: u64 = 120_000;
pub const PACKAGED_SERVER_STARTUP_TIMEOUT_MS: u64 = 300_000;
pub const MIN_SERVER_STARTUP_TIMEOUT_MS: u64 = 5_000;
pub const MAX_SERVER_STARTUP_TIMEOUT_MS: u64 = 300_000;
pub const GRACEFUL_SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(12);
pub const FORCED_SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
pub const SERVER_HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
const STDERR_TAIL_LIMIT_BYTES: usize = 16_384;
const RECENT_STDOUT_LINES_LIMIT: usize = 5;

const OBSERVABILITY_ENV_PREFIXES: &[&str] = &["AGENT_OBSERVABILITY_", "LANGFUSE_"];
const CRASH_REPORTING_ENV_PREFIXES: &[&str] = &["COWORK_SENTRY_", "SENTRY_"];
const PRODUCT_ANALYTICS_ENV_PREFIXES: &[&str] = &["COWORK_POSTHOG_", "POSTHOG_"];
const TELEMETRY_CONSENT_ENV_KEYS: &[&str] = &[
    "COWORK_CRASH_REPORTS_ENABLED",
    "COWORK_PRODUCT_ANALYTICS_ENABLED",
    "AGENT_OBSERVABILITY_ENABLED",
    "AGENT_OBSERVABILITY_RECORD_INPUTS",
    "AGENT_OBSERVABILITY_RECORD_OUTPUTS",
    "AGENT_OBSERVABILITY_RECORD_PAYLOADS",
    "COWORK_CLOUD_SYNC_ENABLED",
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceServerFeatureFlags {
    pub open_ai_native_connectors: bool,
    pub tasks: bool,
    pub workflows: bool,
}

impl WorkspaceServerFeatureFlags {
    /// Stable fingerprint of env flags baked into a sidecar at spawn time.
    pub fn fingerprint(&self) -> String {
        format!(
            "connectors={}|tasks={}|workflows={}",
            if self.open_ai_native_connectors {
                "1"
            } else {
                "0"
            },
            if self.tasks { "1" } else { "0" },
            if self.workflows { "1" } else { "0" },
        )
    }

    pub fn from_feature_flag_map(flags: &HashMap<String, bool>) -> Self {
        Self {
            open_ai_native_connectors: flags
                .get("openAiNativeConnectors")
                .copied()
                .unwrap_or(false),
            tasks: flags.get("tasks").copied().unwrap_or(false),
            workflows: flags.get("workflows").copied().unwrap_or(false),
        }
    }
}

#[derive(Debug, Clone)]
pub struct StartWorkspaceServerOptions {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    pub yolo: bool,
    pub force_restart: bool,
    pub mobile_h3: Option<bool>,
    pub rotate_mobile_h3_tls: bool,
    pub feature_flags: WorkspaceServerFeatureFlags,
    pub privacy_telemetry: Option<PrivacyTelemetrySettings>,
}

#[derive(Debug, Clone)]
pub struct StartedWorkspaceServer {
    pub workspace_id: String,
    pub ws_url: String,
    pub port: u16,
    pub browser_access_token: Option<String>,
    pub mobile_h3: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerStatusReason {
    Running,
    Starting,
    NotFound,
    Exited,
    HealthFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceServerStatus {
    pub workspace_id: String,
    pub running: bool,
    pub url: Option<String>,
    pub reason: ServerStatusReason,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastChildExitRecord {
    pub url: Option<String>,
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub exited_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceServerDiagnosticEntry {
    pub workspace_id: String,
    pub running: bool,
    pub starting: bool,
    pub current_server_url: Option<String>,
    pub restart_count: usize,
    pub last_child_exit: Option<LastChildExitRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerManagerDiagnostics {
    pub workspaces: Vec<WorkspaceServerDiagnosticEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerStdoutMessage {
    StartupProgress {
        phase: String,
        message: String,
    },
    Listening {
        url: String,
        port: u16,
        cwd: String,
        browser_access_token: Option<String>,
        mobile_h3: Option<Value>,
    },
    PlainText(String),
}

/// Parses one NDJSON line (or plain text log line) emitted on `cowork-server` stdout.
pub fn parse_server_stdout_line(line: &str) -> ServerStdoutMessage {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ServerStdoutMessage::PlainText(String::new());
    }

    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(trimmed) else {
        return ServerStdoutMessage::PlainText(trimmed.to_string());
    };

    let event_type = map.get("type").and_then(Value::as_str);
    match event_type {
        Some("server_startup_progress") | Some("startup_progress") => {
            if let Some(progress) = map.get("progress").and_then(Value::as_object) {
                let phase = progress
                    .get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or("starting")
                    .to_string();
                let message = progress
                    .get("message")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("Preparing Cowork runtime ({phase})"));
                return ServerStdoutMessage::StartupProgress { phase, message };
            }
            let phase = map
                .get("stage")
                .or_else(|| map.get("phase"))
                .and_then(Value::as_str)
                .unwrap_or("starting")
                .to_string();
            let message = map
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(&phase)
                .to_string();
            ServerStdoutMessage::StartupProgress { phase, message }
        }
        Some("server_listening") => {
            let url = map
                .get("wsUrl")
                .or_else(|| map.get("url"))
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let port = map
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok());
            if let (Some(url), Some(port)) = (url, port) {
                let cwd = map
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let token = map
                    .get("browserAccessToken")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let mobile_h3 = map.get("mobileH3").filter(|v| !v.is_null()).cloned();
                return ServerStdoutMessage::Listening {
                    url,
                    port,
                    cwd,
                    browser_access_token: token,
                    mobile_h3,
                };
            }
            ServerStdoutMessage::PlainText(trimmed.to_string())
        }
        _ => ServerStdoutMessage::PlainText(trimmed.to_string()),
    }
}

/// Appends `?coworkBrowserToken=<token>` onto a `ws://` / `wss://` server URL.
pub fn append_browser_access_token(ws_url: &str, token: Option<&str>) -> String {
    let Some(trimmed) = token.map(str::trim).filter(|s| !s.is_empty()) else {
        return ws_url.to_string();
    };
    let Ok(mut parsed) = Url::parse(ws_url) else {
        return ws_url.to_string();
    };
    parsed
        .query_pairs_mut()
        .append_pair("coworkBrowserToken", trimmed);
    parsed.to_string()
}

/// Converts a `ws://` / `wss://` workspace server URL into an HTTP request URL for `pathname`.
pub fn to_http_server_request_url(ws_url: &str, pathname: &str) -> Result<String, String> {
    let mut parsed = Url::parse(ws_url).map_err(|err| err.to_string())?;
    let scheme = if parsed.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    parsed
        .set_scheme(scheme)
        .map_err(|()| "failed to switch URL scheme".to_string())?;
    parsed.set_path(pathname);
    Ok(parsed.to_string())
}

/// Resolves the sidecar startup timeout clamped to `[5s, 300s]`.
pub fn get_server_startup_timeout_ms(env: &HashMap<String, String>, is_packaged: bool) -> u64 {
    if let Some(raw) = env.get("COWORK_DESKTOP_SERVER_STARTUP_TIMEOUT_MS")
        && let Ok(parsed) = raw.trim().parse::<u64>()
        && parsed > 0
    {
        return parsed.clamp(MIN_SERVER_STARTUP_TIMEOUT_MS, MAX_SERVER_STARTUP_TIMEOUT_MS);
    }
    if is_packaged {
        PACKAGED_SERVER_STARTUP_TIMEOUT_MS
    } else {
        DEFAULT_SERVER_STARTUP_TIMEOUT_MS
    }
}

/// Constructs CLI spawn args matching Electron's `--dir <path> --host 127.0.0.1 --port 0 --json`.
pub fn build_spawn_args(workspace_path: &Path, yolo: bool, mobile_h3: bool) -> Vec<String> {
    let mut args = vec![
        "--dir".to_string(),
        workspace_path.to_string_lossy().into_owned(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        "0".to_string(),
        "--json".to_string(),
    ];
    if mobile_h3 {
        args.push("--mobile-h3".to_string());
    }
    if yolo {
        args.push("--yolo".to_string());
    }
    args
}

/// Constructs the scrubbed environment passed to a child `cowork-server` process.
pub fn build_server_env(
    parent_env: &HashMap<String, String>,
    user_data_dir: &Path,
    builtin_dir: Option<&Path>,
    is_packaged: bool,
    feature_flags: &WorkspaceServerFeatureFlags,
    rotate_mobile_h3_tls: bool,
    privacy: Option<&PrivacyTelemetrySettings>,
) -> HashMap<String, String> {
    build_server_env_with_analytics(
        parent_env,
        user_data_dir,
        builtin_dir,
        is_packaged,
        feature_flags,
        rotate_mobile_h3_tls,
        privacy,
        None,
    )
}

/// Constructs the scrubbed environment passed to a child `cowork-server` process,
/// including desktop-resolved crash reporting and product analytics configuration.
#[allow(clippy::too_many_arguments)]
pub fn build_server_env_with_analytics(
    parent_env: &HashMap<String, String>,
    user_data_dir: &Path,
    builtin_dir: Option<&Path>,
    is_packaged: bool,
    feature_flags: &WorkspaceServerFeatureFlags,
    rotate_mobile_h3_tls: bool,
    privacy: Option<&PrivacyTelemetrySettings>,
    product_analytics_state: Option<&PersistedProductAnalyticsState>,
) -> HashMap<String, String> {
    let mut telemetry_consent_env = parent_env.clone();
    for key in TELEMETRY_CONSENT_ENV_KEYS {
        telemetry_consent_env.remove(*key);
    }

    let default_privacy = PrivacyTelemetrySettings::default();
    let base_privacy = privacy.unwrap_or(&default_privacy);
    let consent = resolve_telemetry_consent(base_privacy, &telemetry_consent_env, is_packaged);
    let effective_privacy = PrivacyTelemetrySettings {
        ai_trace_telemetry_enabled: consent.ai_trace_telemetry_enabled,
        ai_trace_payloads_enabled: consent.ai_trace_payloads_enabled,
        diagnostics_upload_enabled: consent.diagnostics_upload_enabled,
        crash_reports_enabled: consent.crash_reports_enabled,
        product_analytics_enabled: consent.product_analytics_enabled,
        cloud_sync_enabled: consent.cloud_sync_enabled,
    };

    // Determine effective telemetry toggles without letting inherited env vars override user opt-outs.
    let mut next: HashMap<String, String> = HashMap::new();
    let allow_ai_trace = consent.ai_trace_telemetry_enabled;
    let allow_ai_payloads = consent.ai_trace_payloads_enabled;

    for (key, value) in parent_env {
        if TELEMETRY_CONSENT_ENV_KEYS.contains(&key.as_str()) {
            continue;
        }
        if !allow_ai_trace
            && OBSERVABILITY_ENV_PREFIXES
                .iter()
                .any(|prefix| key.starts_with(prefix))
        {
            continue;
        }
        if key == "COWORK_CRASH_REPORTS_ENABLED"
            || CRASH_REPORTING_ENV_PREFIXES
                .iter()
                .any(|prefix| key.starts_with(prefix))
        {
            continue;
        }
        if key == "COWORK_PRODUCT_ANALYTICS_ENABLED"
            || key == "COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID"
            || PRODUCT_ANALYTICS_ENV_PREFIXES
                .iter()
                .any(|prefix| key.starts_with(prefix))
        {
            continue;
        }
        if matches!(
            key.as_str(),
            "COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP"
                | "COWORK_ENABLE_TASKS"
                | "COWORK_ENABLE_WORKFLOWS"
                | "COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS"
        ) {
            continue;
        }
        next.insert(key.clone(), value.clone());
    }

    let browser_token = parent_env
        .get("COWORK_BROWSER_ACCESS_TOKEN")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()));

    next.insert("COWORK_WEB_DESKTOP_SERVICE".into(), "1".into());
    next.insert("COWORK_DESKTOP_STARTUP_EVENTS".into(), "1".into());
    next.insert("COWORK_DESKTOP_PARENT_MANAGED".into(), "1".into());
    next.insert(
        "COWORK_DESKTOP_USER_DATA_DIR".into(),
        user_data_dir.to_string_lossy().into_owned(),
    );
    next.insert("COWORK_BROWSER_ACCESS_TOKEN".into(), browser_token);
    next.entry("COWORK_BOOTSTRAP_DEFAULT_SKILLS".into())
        .or_insert_with(|| "1".into());
    next.entry("COWORK_RUNTIME_ALLOW_NETWORK".into())
        .or_insert_with(|| "1".into());

    if let Some(dir) = builtin_dir {
        next.insert(
            "COWORK_BUILTIN_DIR".into(),
            dir.to_string_lossy().into_owned(),
        );
    }
    if is_packaged {
        next.insert("COWORK_DESKTOP_BUNDLE".into(), "1".into());
    }
    if feature_flags.open_ai_native_connectors {
        next.insert(
            "COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS".into(),
            "1".into(),
        );
    }
    if feature_flags.tasks {
        next.insert("COWORK_ENABLE_TASKS".into(), "1".into());
    }
    if feature_flags.workflows {
        next.insert("COWORK_ENABLE_WORKFLOWS".into(), "1".into());
    }
    if rotate_mobile_h3_tls {
        next.insert("COWORK_H3_ROTATE_TLS".into(), "1".into());
    }

    if allow_ai_trace {
        let payloads = if allow_ai_payloads { "true" } else { "false" };
        next.insert("AGENT_OBSERVABILITY_ENABLED".into(), "true".into());
        next.insert("AGENT_OBSERVABILITY_RECORD_INPUTS".into(), payloads.into());
        next.insert("AGENT_OBSERVABILITY_RECORD_OUTPUTS".into(), payloads.into());
        next.insert(
            "AGENT_OBSERVABILITY_RECORD_PAYLOADS".into(),
            payloads.into(),
        );
    } else {
        next.insert("AGENT_OBSERVABILITY_ENABLED".into(), "false".into());
        next.insert("AGENT_OBSERVABILITY_RECORD_INPUTS".into(), "false".into());
        next.insert("AGENT_OBSERVABILITY_RECORD_OUTPUTS".into(), "false".into());
        next.insert("AGENT_OBSERVABILITY_RECORD_PAYLOADS".into(), "false".into());
    }

    for (k, v) in build_server_crash_reporting_env(
        &effective_privacy,
        &telemetry_consent_env,
        is_packaged,
        None,
    ) {
        next.insert(k, v);
    }
    for (k, v) in build_server_product_analytics_env(
        &effective_privacy,
        product_analytics_state,
        &telemetry_consent_env,
        is_packaged,
        None,
    ) {
        next.insert(k, v);
    }

    next
}

/// Determines whether an already-live server handle can be reused for `opts`.
pub fn should_reuse_existing_workspace_server(
    force_restart: bool,
    requested_mobile_h3: Option<bool>,
    requested_yolo: bool,
    requested_flags: &WorkspaceServerFeatureFlags,
    existing_has_mobile_h3: bool,
    existing_yolo: bool,
    existing_fingerprint: &str,
) -> bool {
    if force_restart {
        return false;
    }
    if let Some(wants_h3) = requested_mobile_h3
        && wants_h3 != existing_has_mobile_h3
    {
        return false;
    }
    if requested_yolo != existing_yolo {
        return false;
    }
    requested_flags.fingerprint() == existing_fingerprint
}

struct RunningServerHandle {
    instance_id: u64,
    workspace_path: PathBuf,
    stdin: Mutex<Option<ChildStdin>>,
    kill_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    ws_url: String,
    port: u16,
    browser_access_token: Option<String>,
    yolo: bool,
    has_mobile_h3: bool,
    mobile_h3: Mutex<Option<Value>>,
    feature_flag_fingerprint: String,
    suppressed_exit: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    exited_notify: Arc<Notify>,
}

struct ManagerState {
    stopped: bool,
    next_instance_id: u64,
    servers: HashMap<String, Arc<RunningServerHandle>>,
    pending_cancels: HashMap<String, Vec<Arc<AtomicBool>>>,
    workspace_locks: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    start_counts: HashMap<String, usize>,
    last_exits: HashMap<String, LastChildExitRecord>,
    product_analytics_state: Option<PersistedProductAnalyticsState>,
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            stopped: false,
            next_instance_id: 1,
            servers: HashMap::new(),
            pending_cancels: HashMap::new(),
            workspace_locks: HashMap::new(),
            start_counts: HashMap::new(),
            last_exits: HashMap::new(),
            product_analytics_state: None,
        }
    }
}

pub type EventEmitter = Arc<dyn Fn(StoreEvent) + Send + Sync>;

/// Runtime environment paths and options needed to spawn `cowork-server`.
#[derive(Clone)]
pub struct ServerManagerRuntime {
    pub user_data_dir: PathBuf,
    pub resources_dir: Option<PathBuf>,
    pub current_exe_dir: Option<PathBuf>,
    pub repo_root: Option<PathBuf>,
    pub is_packaged: bool,
}

/// Manages one `cowork-server` sidecar child process per workspace ID.
#[derive(Clone)]
pub struct ServerManager {
    runtime: ServerManagerRuntime,
    logger: Option<Arc<LocalLogger>>,
    emit_event: Option<EventEmitter>,
    http_client: reqwest::Client,
    state: Arc<Mutex<ManagerState>>,
    stop_notify: Arc<Notify>,
}

impl ServerManager {
    pub fn new(
        runtime: ServerManagerRuntime,
        logger: Option<Arc<LocalLogger>>,
        emit_event: Option<EventEmitter>,
    ) -> Self {
        let http_client = reqwest::Client::builder()
            .timeout(SERVER_HEALTH_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            runtime,
            logger,
            emit_event,
            http_client,
            state: Arc::new(Mutex::new(ManagerState::default())),
            stop_notify: Arc::new(Notify::new()),
        }
    }

    /// Stores resolved desktop analytics metadata (`anonymousInstallationId`) for child server env propagation.
    pub fn set_product_analytics_state(&self, state: PersistedProductAnalyticsState) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.product_analytics_state = Some(state);
    }

    fn emit(&self, event: StoreEvent) {
        if let Some(emitter) = &self.emit_event {
            emitter(event);
        }
    }

    fn log_info(&self, message: &str, meta: Option<Value>) {
        if let Some(logger) = &self.logger {
            logger.write(
                LocalLogFileName::Server,
                LocalLogLevel::Info,
                "server-manager",
                message,
                meta.as_ref(),
            );
        }
    }

    fn workspace_lock(&self, workspace_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .workspace_locks
            .entry(workspace_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Starts (or reuses) the `cowork-server` child process for `opts.workspace_id`.
    pub async fn start_workspace_server(
        &self,
        opts: StartWorkspaceServerOptions,
    ) -> Result<StartedWorkspaceServer, String> {
        assert_safe_id(&opts.workspace_id, "workspaceId").map_err(|e| e.to_string())?;

        let cancel_flag = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.stopped {
                return Err("Workspace server manager is stopped.".into());
            }
            state
                .pending_cancels
                .entry(opts.workspace_id.clone())
                .or_default()
                .push(cancel_flag.clone());
        }

        let op_lock = self.workspace_lock(&opts.workspace_id);
        let _op_guard = op_lock.lock().await;
        let result = self.start_workspace_server_owned(&opts, &cancel_flag).await;

        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(list) = state.pending_cancels.get_mut(&opts.workspace_id) {
                list.retain(|f| !Arc::ptr_eq(f, &cancel_flag));
                if list.is_empty() {
                    state.pending_cancels.remove(&opts.workspace_id);
                }
            }
        }
        result
    }

    async fn start_workspace_server_owned(
        &self,
        opts: &StartWorkspaceServerOptions,
        cancel_flag: &AtomicBool,
    ) -> Result<StartedWorkspaceServer, String> {
        if cancel_flag.load(Ordering::Acquire) {
            return Err("Workspace server startup was cancelled.".into());
        }

        assert_workspace_directory(&opts.workspace_path).map_err(|e| e.to_string())?;
        let workspace_path = cowork_config::canonicalize_sync(&opts.workspace_path);

        // Check existing handle for reuse or replacement.
        let existing_opt = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.servers.get(&opts.workspace_id).cloned()
        };

        if let Some(existing) = existing_opt {
            if !existing.exited.load(Ordering::Acquire) {
                if !opts.rotate_mobile_h3_tls
                    && should_reuse_existing_workspace_server(
                        opts.force_restart,
                        opts.mobile_h3,
                        opts.yolo,
                        &opts.feature_flags,
                        existing.has_mobile_h3,
                        existing.yolo,
                        &existing.feature_flag_fingerprint,
                    )
                {
                    let mobile_h3 = existing
                        .mobile_h3
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    return Ok(StartedWorkspaceServer {
                        workspace_id: opts.workspace_id.clone(),
                        ws_url: existing.ws_url.clone(),
                        port: existing.port,
                        browser_access_token: existing.browser_access_token.clone(),
                        mobile_h3,
                    });
                }

                existing.suppressed_exit.store(true, Ordering::Release);
                {
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    if state
                        .servers
                        .get(&opts.workspace_id)
                        .is_some_and(|h| h.instance_id == existing.instance_id)
                    {
                        state.servers.remove(&opts.workspace_id);
                    }
                }
                Self::graceful_kill_handle(&existing).await;
                if cancel_flag.load(Ordering::Acquire) {
                    return Err("Workspace server startup was cancelled.".into());
                }
            } else {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if state
                    .servers
                    .get(&opts.workspace_id)
                    .is_some_and(|h| h.instance_id == existing.instance_id)
                {
                    state.servers.remove(&opts.workspace_id);
                }
            }
        }

        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.stopped {
                return Err("Workspace server manager is stopped.".into());
            }
            let next_count = state
                .start_counts
                .get(&opts.workspace_id)
                .copied()
                .unwrap_or(0)
                + 1;
            state
                .start_counts
                .insert(opts.workspace_id.clone(), next_count);
        }

        let parent_env = cowork_config::env_map_from_process();
        let sidecar = find_sidecar_launch_command(
            self.runtime.is_packaged,
            self.runtime.resources_dir.as_deref(),
            self.runtime.current_exe_dir.as_deref(),
            self.runtime.repo_root.as_deref(),
            &parent_env,
        )
        .map_err(|e| e.to_string())?;
        let builtin_dir = resolve_builtin_dir_for_sidecar(
            self.runtime.is_packaged,
            self.runtime.resources_dir.as_deref(),
            self.runtime.repo_root.as_deref(),
            &parent_env,
        )
        .map_err(|e| e.to_string())?;

        self.emit(StoreEvent::ServerStarting {
            workspace_id: opts.workspace_id.clone(),
            stage: "spawning".into(),
            message: format!("Starting cowork-server for {}", workspace_path.display()),
        });

        self.log_info(
            "workspace server start requested",
            Some(json!({
                "workspaceId": opts.workspace_id,
                "mode": if self.runtime.is_packaged { "packaged" } else { "dev" },
                "workspacePath": workspace_path,
                "yolo": opts.yolo,
            })),
        );

        let mobile_h3 = opts.mobile_h3.unwrap_or(false);
        let spawn_args = build_spawn_args(&workspace_path, opts.yolo, mobile_h3);
        let analytics_state = {
            let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.product_analytics_state.clone()
        };
        let env = build_server_env_with_analytics(
            &parent_env,
            &self.runtime.user_data_dir,
            builtin_dir.as_deref(),
            self.runtime.is_packaged,
            &opts.feature_flags,
            opts.rotate_mobile_h3_tls,
            opts.privacy_telemetry.as_ref(),
            analytics_state.as_ref(),
        );

        let spawn_cwd = if self.runtime.is_packaged {
            self.runtime
                .resources_dir
                .clone()
                .unwrap_or_else(|| self.runtime.user_data_dir.clone())
        } else {
            self.runtime
                .repo_root
                .clone()
                .or_else(|| sidecar.command.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| workspace_path.clone())
        };

        let mut cmd = Command::new(&sidecar.command);
        cmd.args(&sidecar.args)
            .args(&spawn_args)
            .current_dir(&spawn_cwd)
            .env_clear()
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_sidecar_command(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|err| format!("Failed to spawn cowork-server: {err}"))?;
        let pid = child.id();

        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "cowork-server child stdout handle unavailable".to_string())?;
        let stderr = child.stderr.take();

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(mut stderr_pipe) = stderr {
            let tail_ref = stderr_tail.clone();
            let ws_id = opts.workspace_id.clone();
            let logger = self.logger.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr_pipe.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    {
                        let mut guard = tail_ref.lock().unwrap_or_else(|e| e.into_inner());
                        guard.push_str(&chunk);
                        if guard.len() > STDERR_TAIL_LIMIT_BYTES {
                            let trim_from = guard.len() - STDERR_TAIL_LIMIT_BYTES;
                            let safe_start = guard
                                .char_indices()
                                .find(|(idx, _)| *idx >= trim_from)
                                .map_or(guard.len(), |(idx, _)| idx);
                            guard.drain(..safe_start);
                        }
                    }
                    if let Some(ref l) = logger {
                        let meta = json!({
                            "workspaceId": ws_id,
                            "bytes": n,
                            "preview": chunk.trim().chars().take(500).collect::<String>(),
                        });
                        l.write(
                            LocalLogFileName::Server,
                            LocalLogLevel::Info,
                            "server-manager",
                            "workspace server stderr emitted",
                            Some(&meta),
                        );
                    }
                }
            });
        }

        let base_timeout_ms = get_server_startup_timeout_ms(&parent_env, self.runtime.is_packaged);
        let bootstrap_timeout_ms = PACKAGED_SERVER_STARTUP_TIMEOUT_MS.max(base_timeout_ms);

        let wait_res = self
            .wait_for_server_listening(
                &opts.workspace_id,
                stdout,
                &mut child,
                Duration::from_millis(base_timeout_ms),
                Duration::from_millis(bootstrap_timeout_ms),
                cancel_flag,
            )
            .await;

        let (listening_url, port, token, mobile_h3_val) = match wait_res {
            Ok(ready) => ready,
            Err(err_msg) => {
                drop(stdin);
                Self::kill_unregistered_child(&mut child, pid).await;
                let tail = stderr_tail
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                let full_err = if tail.trim().is_empty() {
                    err_msg
                } else {
                    let collapsed: String = tail.split_whitespace().collect::<Vec<_>>().join(" ");
                    format!(
                        "{err_msg}; stderr={}",
                        collapsed.chars().take(1000).collect::<String>()
                    )
                };
                self.log_info(
                    "workspace server start failed",
                    Some(json!({
                        "workspaceId": opts.workspace_id,
                        "error": full_err,
                    })),
                );
                return Err(full_err);
            }
        };

        let authed_ws_url = append_browser_access_token(&listening_url, token.as_deref());
        let instance_id = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let id = state.next_instance_id;
            state.next_instance_id += 1;
            id
        };

        let (kill_tx, kill_rx) = tokio::sync::oneshot::channel();
        let handle = Arc::new(RunningServerHandle {
            instance_id,
            workspace_path: opts.workspace_path.clone(),
            stdin: Mutex::new(stdin),
            kill_tx: Mutex::new(Some(kill_tx)),
            ws_url: authed_ws_url.clone(),
            port,
            browser_access_token: token.clone(),
            yolo: opts.yolo,
            has_mobile_h3: mobile_h3_val.is_some(),
            mobile_h3: Mutex::new(mobile_h3_val.clone()),
            feature_flag_fingerprint: opts.feature_flags.fingerprint(),
            suppressed_exit: Arc::new(AtomicBool::new(false)),
            exited: Arc::new(AtomicBool::new(false)),
            exited_notify: Arc::new(Notify::new()),
        });

        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state
                .servers
                .insert(opts.workspace_id.clone(), handle.clone());
        }

        self.log_info(
            "workspace server listening",
            Some(json!({
                "workspaceId": opts.workspace_id,
                "url": strip_url_secrets(&listening_url),
                "port": port,
            })),
        );

        self.emit(StoreEvent::ServerListening {
            workspace_id: opts.workspace_id.clone(),
            ws_url: authed_ws_url.clone(),
            port,
            browser_access_token: token.clone(),
        });

        self.spawn_exit_watcher(opts.workspace_id.clone(), child, pid, kill_rx, handle);

        Ok(StartedWorkspaceServer {
            workspace_id: opts.workspace_id.clone(),
            ws_url: authed_ws_url,
            port,
            browser_access_token: token,
            mobile_h3: mobile_h3_val,
        })
    }

    async fn wait_for_server_listening(
        &self,
        workspace_id: &str,
        stdout: tokio::process::ChildStdout,
        child: &mut Child,
        base_timeout: Duration,
        bootstrap_timeout: Duration,
        cancel_flag: &AtomicBool,
    ) -> Result<(String, u16, Option<String>, Option<Value>), String> {
        let mut reader = BufReader::new(stdout).lines();
        let mut recent_lines: Vec<String> = Vec::new();
        let mut active_timeout = base_timeout;
        let mut deadline = Instant::now() + active_timeout;

        loop {
            if cancel_flag.load(Ordering::Acquire) {
                return Err("Workspace server startup was cancelled.".into());
            }

            let sleep = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline));
            tokio::select! {
                line_res = reader.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            match parse_server_stdout_line(&line) {
                                ServerStdoutMessage::StartupProgress { phase, message } => {
                                    self.emit(StoreEvent::ServerStarting {
                                        workspace_id: workspace_id.to_string(),
                                        stage: phase.clone(),
                                        message,
                                    });
                                    active_timeout = if phase == "waiting" || phase == "installing" {
                                        bootstrap_timeout
                                    } else {
                                        base_timeout
                                    };
                                    deadline = Instant::now() + active_timeout;
                                }
                                ServerStdoutMessage::Listening { url, port, browser_access_token, mobile_h3, .. } => {
                                    // Keep draining stdout asynchronously so the child never blocks on pipe writes.
                                    tokio::spawn(async move {
                                        while let Ok(Some(_)) = reader.next_line().await {}
                                    });
                                    if let Ok(Some(status)) = child.try_wait() {
                                        return Err(format!(
                                            "Workspace server exited immediately after startup JSON (status={status})"
                                        ));
                                    }
                                    return Ok((url, port, browser_access_token, mobile_h3));
                                }
                                ServerStdoutMessage::PlainText(text) => {
                                    if !text.is_empty() {
                                        recent_lines.push(text);
                                        if recent_lines.len() > RECENT_STDOUT_LINES_LIMIT {
                                            recent_lines.remove(0);
                                        }
                                    }
                                }
                            }
                        }
                        Ok(None) => {
                            let status = child.try_wait().ok().flatten();
                            return Err(with_recent_output(
                                format!("Server stdout closed before startup JSON (status={status:?})"),
                                &recent_lines,
                            ));
                        }
                        Err(err) => {
                            return Err(with_recent_output(
                                format!("Failed reading server stdout: {err}"),
                                &recent_lines,
                            ));
                        }
                    }
                }
                status_res = child.wait() => {
                    let msg = match status_res {
                        Ok(status) => format!(
                            "Server exited before startup JSON (code={:?})",
                            status.code()
                        ),
                        Err(err) => format!("Server wait error before startup JSON: {err}"),
                    };
                    return Err(with_recent_output(msg, &recent_lines));
                }
                _ = sleep => {
                    return Err(with_recent_output(
                        format!(
                            "Server startup timed out after {} seconds",
                            active_timeout.as_secs()
                        ),
                        &recent_lines,
                    ));
                }
                _ = self.stop_notify.notified() => {
                    return Err("Workspace server startup was cancelled.".into());
                }
            }
        }
    }

    fn spawn_exit_watcher(
        &self,
        workspace_id: String,
        mut child: Child,
        pid: Option<u32>,
        kill_rx: tokio::sync::oneshot::Receiver<()>,
        handle: Arc<RunningServerHandle>,
    ) {
        let state_arc = self.state.clone();
        let emit = self.emit_event.clone();
        let logger = self.logger.clone();

        tokio::spawn(async move {
            let status = tokio::select! {
                res = child.wait() => Some(res),
                _ = kill_rx => {
                    if let Some(p) = pid {
                        let _ = terminate_process_tree(p).await;
                    }
                    let _ = child.start_kill();
                    tokio::time::timeout(FORCED_SERVER_SHUTDOWN_TIMEOUT, child.wait())
                        .await
                        .ok()
                }
            };
            handle.exited.store(true, Ordering::Release);
            handle.exited_notify.notify_waiters();

            let (code, msg) = match &status {
                Some(Ok(exit)) => (
                    exit.code(),
                    if exit.success() {
                        None
                    } else {
                        Some(format!("cowork-server exited with status {exit}"))
                    },
                ),
                Some(Err(err)) => (None, Some(format!("cowork-server wait error: {err}"))),
                None => (
                    None,
                    Some("cowork-server did not exit after forced termination.".into()),
                ),
            };

            let suppressed = handle.suppressed_exit.load(Ordering::Acquire);
            {
                let mut state = state_arc.lock().unwrap_or_else(|e| e.into_inner());
                if state
                    .servers
                    .get(&workspace_id)
                    .is_some_and(|h| h.instance_id == handle.instance_id)
                {
                    state.servers.remove(&workspace_id);
                }
                if !suppressed {
                    state.last_exits.insert(
                        workspace_id.clone(),
                        LastChildExitRecord {
                            url: Some(strip_url_secrets(&handle.ws_url)),
                            code,
                            signal: None,
                            exited_at: Utc::now().to_rfc3339(),
                        },
                    );
                }
            }

            if !suppressed {
                if let Some(ref l) = logger {
                    let meta = json!({
                        "workspaceId": workspace_id,
                        "code": code,
                        "error": msg,
                    });
                    l.write(
                        LocalLogFileName::Server,
                        LocalLogLevel::Warn,
                        "server-manager",
                        "workspace server exited",
                        Some(&meta),
                    );
                }
                if let Some(emitter) = emit {
                    emitter(StoreEvent::ServerExited {
                        workspace_id,
                        code,
                        message: msg,
                    });
                }
            }
        });
    }

    /// Stops a workspace server gracefully (EOF on stdin -> 12s -> tree kill -> 1s).
    pub async fn stop_workspace_server(&self, workspace_id: &str) -> Result<(), String> {
        assert_safe_id(workspace_id, "workspaceId").map_err(|e| e.to_string())?;
        {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(flags) = state.pending_cancels.get(workspace_id) {
                for flag in flags {
                    flag.store(true, Ordering::Release);
                }
            }
        }
        self.stop_notify.notify_waiters();

        let op_lock = self.workspace_lock(workspace_id);
        let _op_guard = op_lock.lock().await;

        let handle = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.servers.remove(workspace_id)
        };
        if let Some(h) = handle {
            h.suppressed_exit.store(true, Ordering::Release);
            Self::graceful_kill_handle(&h).await;
        }
        Ok(())
    }

    /// Stops all active and pending workspace servers during application shutdown.
    pub async fn stop_all(&self) {
        let locks: Vec<Arc<tokio::sync::Mutex<()>>> = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.stopped = true;
            for flags in state.pending_cancels.values() {
                for flag in flags {
                    flag.store(true, Ordering::Release);
                }
            }
            state.workspace_locks.values().cloned().collect()
        };
        self.stop_notify.notify_waiters();

        // Wait for any in-flight start/stop workspace operation to finish cancelling first.
        for lock in locks {
            let _ = lock.lock().await;
        }

        let handles: Vec<Arc<RunningServerHandle>> = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.servers.drain().map(|(_, h)| h).collect()
        };

        let futs = handles.into_iter().map(|h| async move {
            h.suppressed_exit.store(true, Ordering::Release);
            Self::graceful_kill_handle(&h).await;
        });
        futures_util::future::join_all(futs).await;
    }

    /// Probes `/cowork/health` for an active workspace server with 1500 ms timeout.
    pub async fn get_workspace_server_status(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceServerStatus, String> {
        assert_safe_id(workspace_id, "workspaceId").map_err(|e| e.to_string())?;
        let (is_starting, handle) = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let starting = state
                .pending_cancels
                .get(workspace_id)
                .is_some_and(|v| v.iter().any(|f| !f.load(Ordering::Acquire)));
            (starting, state.servers.get(workspace_id).cloned())
        };

        if is_starting {
            return Ok(WorkspaceServerStatus {
                workspace_id: workspace_id.to_string(),
                running: false,
                url: None,
                reason: ServerStatusReason::Starting,
                error: None,
            });
        }

        let Some(handle) = handle else {
            return Ok(WorkspaceServerStatus {
                workspace_id: workspace_id.to_string(),
                running: false,
                url: None,
                reason: ServerStatusReason::NotFound,
                error: None,
            });
        };

        if handle.exited.load(Ordering::Acquire) {
            return Ok(WorkspaceServerStatus {
                workspace_id: workspace_id.to_string(),
                running: false,
                url: Some(strip_url_secrets(&handle.ws_url)),
                reason: ServerStatusReason::Exited,
                error: None,
            });
        }

        let health_url = to_http_server_request_url(&handle.ws_url, "/cowork/health")?;
        match self.http_client.get(health_url).send().await {
            Ok(resp) if resp.status().is_success() => Ok(WorkspaceServerStatus {
                workspace_id: workspace_id.to_string(),
                running: true,
                url: Some(strip_url_secrets(&handle.ws_url)),
                reason: ServerStatusReason::Running,
                error: None,
            }),
            Ok(resp) => Ok(WorkspaceServerStatus {
                workspace_id: workspace_id.to_string(),
                running: false,
                url: Some(strip_url_secrets(&handle.ws_url)),
                reason: ServerStatusReason::HealthFailed,
                error: Some(format!("HTTP {}", resp.status().as_u16())),
            }),
            Err(err) => Ok(WorkspaceServerStatus {
                workspace_id: workspace_id.to_string(),
                running: false,
                url: Some(strip_url_secrets(&handle.ws_url)),
                reason: ServerStatusReason::HealthFailed,
                error: Some(err.to_string()),
            }),
        }
    }

    /// Returns secret-stripped diagnostics across all known workspace servers.
    pub fn get_diagnostics(&self) -> ServerManagerDiagnostics {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: HashSet<String> = HashSet::new();
        ids.extend(state.servers.keys().cloned());
        ids.extend(state.pending_cancels.keys().cloned());
        ids.extend(state.start_counts.keys().cloned());
        ids.extend(state.last_exits.keys().cloned());

        let mut sorted: Vec<String> = ids.into_iter().collect();
        sorted.sort();

        let workspaces = sorted
            .into_iter()
            .map(|id| {
                let handle = state.servers.get(&id);
                let running = handle.is_some_and(|h| !h.exited.load(Ordering::Acquire));
                let starting = state
                    .pending_cancels
                    .get(&id)
                    .is_some_and(|v| v.iter().any(|f| !f.load(Ordering::Acquire)));
                let start_count = state.start_counts.get(&id).copied().unwrap_or(0);
                WorkspaceServerDiagnosticEntry {
                    workspace_id: id.clone(),
                    running,
                    starting,
                    current_server_url: handle.map(|h| strip_url_secrets(&h.ws_url)),
                    restart_count: start_count.saturating_sub(1),
                    last_child_exit: state.last_exits.get(&id).cloned(),
                }
            })
            .collect();

        ServerManagerDiagnostics { workspaces }
    }

    /// Returns a currently running workspace target `(workspace_id, workspace_path, yolo)`,
    /// preferring `preferred_workspace_id` when live, or falling back to the newest running server.
    pub fn preferred_workspace_target(
        &self,
        preferred_workspace_id: Option<&str>,
    ) -> Option<(String, PathBuf, bool)> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(preferred) = preferred_workspace_id
            && let Some(handle) = state.servers.get(preferred)
            && !handle.exited.load(Ordering::Acquire)
        {
            return Some((
                preferred.to_string(),
                handle.workspace_path.clone(),
                handle.yolo,
            ));
        }

        state
            .servers
            .iter()
            .filter(|(_, h)| !h.exited.load(Ordering::Acquire))
            .max_by_key(|(_, h)| h.instance_id)
            .map(|(id, h)| (id.clone(), h.workspace_path.clone(), h.yolo))
    }

    fn mobile_h3_admin_base(
        &self,
        workspace_id: &str,
    ) -> Result<(Arc<RunningServerHandle>, String, Url), String> {
        let handle = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.servers.get(workspace_id).cloned()
        }
        .ok_or_else(|| "Workspace server is not running.".to_string())?;

        if handle.exited.load(Ordering::Acquire) {
            return Err("Workspace server has exited.".to_string());
        }

        let admin_token = {
            let guard = handle.mobile_h3.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .as_ref()
                .and_then(|v| v.get("adminToken"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
        }
        .ok_or_else(|| {
            "Remote access admin token is unavailable; restart Remote Access and try again."
                .to_string()
        })?;

        let base_http = to_http_server_request_url(&handle.ws_url, "/")?;
        let mut list_url = Url::parse(&base_http).map_err(|err| err.to_string())?;
        list_url.set_query(None);
        list_url.set_path("/mobile-h3/trusted");

        Ok((handle, admin_token, list_url))
    }

    fn mobile_h3_admin_request_context(
        &self,
        workspace_id: &str,
        device_id: &str,
        action_suffix: Option<&str>,
    ) -> Result<(Arc<RunningServerHandle>, String, Url, Url), String> {
        let trimmed_id = device_id.trim();
        if trimmed_id.is_empty() {
            return Err("Trusted phone identifier is empty.".into());
        }

        let (handle, admin_token, list_url) = self.mobile_h3_admin_base(workspace_id)?;
        let mut device_url = list_url.clone();
        {
            let mut segs = device_url
                .path_segments_mut()
                .map_err(|()| "Invalid workspace HTTP URL".to_string())?;
            segs.clear();
            segs.push("mobile-h3");
            segs.push("trusted");
            segs.push(trimmed_id);
            if let Some(suffix) = action_suffix {
                segs.push(suffix);
            }
        }

        Ok((handle, admin_token, device_url, list_url))
    }

    fn parse_mobile_h3_error_detail(
        status: reqwest::StatusCode,
        resp_json: Option<&Value>,
    ) -> String {
        resp_json
            .and_then(|v| v.get("error"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()))
    }

    async fn fetch_mobile_h3_trusted_devices_list(
        &self,
        list_url: Url,
        admin_token: &str,
    ) -> Option<Vec<Value>> {
        match self
            .http_client
            .get(list_url)
            .bearer_auth(admin_token)
            .send()
            .await
        {
            Ok(list_resp) if list_resp.status().is_success() => list_resp
                .bytes()
                .await
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .and_then(|v| v.get("trustedDevices").and_then(Value::as_array).cloned()),
            _ => None,
        }
    }

    /// Fetches the current trusted device list via `GET /mobile-h3/trusted` and updates the
    /// cached `mobileH3` snapshot on the running workspace server.
    pub async fn refresh_mobile_h3_trusted_devices(
        &self,
        workspace_id: &str,
    ) -> Result<Option<Value>, String> {
        let (handle, admin_token, list_url) = self.mobile_h3_admin_base(workspace_id)?;
        let resp = self
            .http_client
            .get(list_url)
            .bearer_auth(&admin_token)
            .send()
            .await
            .map_err(|err| format!("Failed fetching trusted phones: {err}"))?;

        let status = resp.status();
        let resp_bytes = resp
            .bytes()
            .await
            .map_err(|err| format!("Failed reading trusted phones response: {err}"))?;
        let resp_json: Option<Value> = serde_json::from_slice(&resp_bytes).ok();

        if !status.is_success() {
            return Err(Self::parse_mobile_h3_error_detail(
                status,
                resp_json.as_ref(),
            ));
        }

        let devices = resp_json
            .as_ref()
            .and_then(|v| v.get("trustedDevices"))
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| "Trusted phones response missing trustedDevices array.".to_string())?;

        let mut h3_guard = handle.mobile_h3.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Value::Object(map)) = h3_guard.as_mut() {
            if let Some(first) = devices.first() {
                map.insert("trustedDevice".to_string(), first.clone());
            } else {
                map.remove("trustedDevice");
            }
            map.insert("trustedDevices".to_string(), Value::Array(devices));
        }
        Ok(h3_guard.clone())
    }

    /// Updates a paired phone's permissions via `PATCH /mobile-h3/trusted/<id>/permissions`
    /// and returns the refreshed `mobileH3` snapshot cached on the running workspace server.
    pub async fn update_mobile_h3_trusted_device_permissions(
        &self,
        workspace_id: &str,
        device_id: &str,
        permissions: Value,
    ) -> Result<Option<Value>, String> {
        let (handle, admin_token, patch_url, list_url) =
            self.mobile_h3_admin_request_context(workspace_id, device_id, Some("permissions"))?;

        let body_bytes = serde_json::to_vec(&json!({ "permissions": permissions }))
            .map_err(|e| e.to_string())?;
        let resp = self
            .http_client
            .patch(patch_url)
            .bearer_auth(&admin_token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body_bytes)
            .send()
            .await
            .map_err(|err| format!("Failed updating phone permissions: {err}"))?;

        let status = resp.status();
        let resp_bytes = resp
            .bytes()
            .await
            .map_err(|err| format!("Failed reading permissions response: {err}"))?;
        let resp_json: Option<Value> = serde_json::from_slice(&resp_bytes).ok();

        if !status.is_success() {
            return Err(Self::parse_mobile_h3_error_detail(
                status,
                resp_json.as_ref(),
            ));
        }

        // Refresh full trusted device list from GET /mobile-h3/trusted when available.
        let refreshed_list = self
            .fetch_mobile_h3_trusted_devices_list(list_url, &admin_token)
            .await;

        let updated_device = resp_json.and_then(|v| v.get("trustedDevice").cloned());
        let mut h3_guard = handle.mobile_h3.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Value::Object(map)) = h3_guard.as_mut() {
            if let Some(list) = refreshed_list {
                map.insert("trustedDevices".to_string(), Value::Array(list));
            } else if let Some(dev) = updated_device
                && let Some(dev_id) = dev.get("deviceId").and_then(Value::as_str)
            {
                let mut devices = map
                    .get("trustedDevices")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if let Some(slot) = devices
                    .iter_mut()
                    .find(|d| d.get("deviceId").and_then(Value::as_str) == Some(dev_id))
                {
                    *slot = dev.clone();
                } else {
                    devices.push(dev.clone());
                }
                map.insert("trustedDevices".to_string(), Value::Array(devices));
                map.insert("trustedDevice".to_string(), dev);
            }
        }
        Ok(h3_guard.clone())
    }

    async fn send_mobile_h3_admin_delete(
        &self,
        workspace_id: &str,
        device_id: Option<&str>,
        error_prefix: &str,
    ) -> Result<Option<Value>, String> {
        let (handle, admin_token, delete_url, list_url) = match device_id {
            Some(id) => self.mobile_h3_admin_request_context(workspace_id, id, None)?,
            None => {
                let (handle, admin_token, list_url) = self.mobile_h3_admin_base(workspace_id)?;
                (handle, admin_token, list_url.clone(), list_url)
            }
        };

        let resp = self
            .http_client
            .delete(delete_url)
            .bearer_auth(&admin_token)
            .send()
            .await
            .map_err(|err| format!("{error_prefix}: {err}"))?;

        let status = resp.status();
        let resp_bytes = resp
            .bytes()
            .await
            .map_err(|err| format!("{error_prefix} response: {err}"))?;
        let resp_json: Option<Value> = serde_json::from_slice(&resp_bytes).ok();

        if !status.is_success() {
            return Err(Self::parse_mobile_h3_error_detail(
                status,
                resp_json.as_ref(),
            ));
        }

        let refreshed_list = self
            .fetch_mobile_h3_trusted_devices_list(list_url, &admin_token)
            .await;

        let trimmed_id = device_id.map(str::trim);
        let mut h3_guard = handle.mobile_h3.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Value::Object(map)) = h3_guard.as_mut() {
            if let Some(list) = refreshed_list {
                map.insert("trustedDevices".to_string(), Value::Array(list));
            } else if let Some(target_id) = trimmed_id {
                if let Some(Value::Array(devices)) = map.get_mut("trustedDevices") {
                    devices
                        .retain(|d| d.get("deviceId").and_then(Value::as_str) != Some(target_id));
                }
            } else {
                map.insert("trustedDevices".to_string(), Value::Array(Vec::new()));
            }
            if trimmed_id.is_none()
                || map
                    .get("trustedDevice")
                    .and_then(|d| d.get("deviceId"))
                    .and_then(Value::as_str)
                    == trimmed_id
            {
                map.remove("trustedDevice");
            }
        }
        Ok(h3_guard.clone())
    }

    /// Revokes a paired phone via `DELETE /mobile-h3/trusted/<id>` and refreshes `trustedDevices`.
    pub async fn forget_mobile_h3_trusted_device(
        &self,
        workspace_id: &str,
        device_id: &str,
    ) -> Result<Option<Value>, String> {
        self.send_mobile_h3_admin_delete(
            workspace_id,
            Some(device_id),
            "Failed forgetting trusted phone",
        )
        .await
    }

    /// Revokes every paired phone via `DELETE /mobile-h3/trusted` and refreshes `trustedDevices`.
    pub async fn revoke_all_mobile_h3_trusted_devices(
        &self,
        workspace_id: &str,
    ) -> Result<Option<Value>, String> {
        self.send_mobile_h3_admin_delete(workspace_id, None, "Failed revoking trusted phones")
            .await
    }

    #[cfg(test)]
    pub(crate) fn insert_test_mobile_h3_handle(
        &self,
        workspace_id: &str,
        port: u16,
        mobile_h3: Value,
    ) {
        let (kill_tx, _kill_rx) = tokio::sync::oneshot::channel();
        let handle = Arc::new(RunningServerHandle {
            instance_id: 1,
            workspace_path: PathBuf::from("/tmp/ws-test"),
            stdin: Mutex::new(None),
            kill_tx: Mutex::new(Some(kill_tx)),
            ws_url: format!("ws://127.0.0.1:{port}/ws?coworkBrowserToken=tok-ws"),
            port,
            browser_access_token: Some("tok-ws".into()),
            yolo: false,
            has_mobile_h3: true,
            mobile_h3: Mutex::new(Some(mobile_h3)),
            feature_flag_fingerprint: WorkspaceServerFeatureFlags::default().fingerprint(),
            suppressed_exit: Arc::new(AtomicBool::new(false)),
            exited: Arc::new(AtomicBool::new(false)),
            exited_notify: Arc::new(Notify::new()),
        });
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.servers.insert(workspace_id.to_string(), handle);
    }

    async fn graceful_kill_handle(handle: &RunningServerHandle) {
        // Close private stdin pipe first so cowork-server shuts down cooperatively on EOF.
        {
            let _ = handle
                .stdin
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
        }
        if handle.exited.load(Ordering::Acquire) {
            return;
        }

        let deadline = tokio::time::Instant::now() + GRACEFUL_SERVER_SHUTDOWN_TIMEOUT;
        while !handle.exited.load(Ordering::Acquire) {
            let notified = handle.exited_notify.notified();
            if handle.exited.load(Ordering::Acquire) {
                return;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                break;
            }
        }
        if handle.exited.load(Ordering::Acquire) {
            return;
        }

        if let Some(tx) = handle
            .kill_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = tx.send(());
        }
        let force_deadline = tokio::time::Instant::now()
            + FORCED_SERVER_SHUTDOWN_TIMEOUT
            + Duration::from_millis(500);
        while !handle.exited.load(Ordering::Acquire) {
            let notified = handle.exited_notify.notified();
            if handle.exited.load(Ordering::Acquire) {
                return;
            }
            if tokio::time::timeout_at(force_deadline, notified)
                .await
                .is_err()
            {
                break;
            }
        }
    }

    async fn kill_unregistered_child(child: &mut Child, pid: Option<u32>) {
        // Ask gracefully first via POSIX SIGTERM if available, wait 12s, then SIGKILL process tree.
        #[cfg(unix)]
        if let Some(p) = pid {
            unsafe {
                libc::kill(p as libc::pid_t, libc::SIGTERM);
            }
        }
        if tokio::time::timeout(GRACEFUL_SERVER_SHUTDOWN_TIMEOUT, child.wait())
            .await
            .is_ok()
        {
            return;
        }
        if let Some(p) = pid {
            let _ = terminate_process_tree(p).await;
        }
        let _ = child.start_kill();
        let _ = tokio::time::timeout(FORCED_SERVER_SHUTDOWN_TIMEOUT, child.wait()).await;
    }
}

fn with_recent_output(message: String, recent_lines: &[String]) -> String {
    if recent_lines.is_empty() {
        message
    } else {
        format!("{message}; output={}", recent_lines.join(" | "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_listening_and_bootstrap_stdout_events() {
        let listening_line = r#"{"type":"server_listening","url":"ws://127.0.0.1:41234/ws","port":41234,"cwd":"/tmp/ws","browserAccessToken":"tok123"}"#;
        assert_eq!(
            parse_server_stdout_line(listening_line),
            ServerStdoutMessage::Listening {
                url: "ws://127.0.0.1:41234/ws".into(),
                port: 41234,
                cwd: "/tmp/ws".into(),
                browser_access_token: Some("tok123".into()),
                mobile_h3: None,
            }
        );

        let progress_line = r#"{"type":"server_startup_progress","component":"cowork_runtime","progress":{"phase":"installing","message":"Installing runtime"}}"#;
        assert_eq!(
            parse_server_stdout_line(progress_line),
            ServerStdoutMessage::StartupProgress {
                phase: "installing".into(),
                message: "Installing runtime".into(),
            }
        );
    }

    #[test]
    fn attaches_token_and_redacts_secrets_from_urls() {
        let with_tok = append_browser_access_token("ws://127.0.0.1:8080/ws", Some("secret-abc"));
        assert!(with_tok.contains("coworkBrowserToken=secret-abc"));
        assert_eq!(strip_url_secrets(&with_tok), "ws://127.0.0.1:8080/ws");
        assert_eq!(
            to_http_server_request_url(&with_tok, "/cowork/health").unwrap(),
            "http://127.0.0.1:8080/cowork/health?coworkBrowserToken=secret-abc"
        );
    }

    #[test]
    fn clamps_startup_timeout_env() {
        let mut env = HashMap::new();
        assert_eq!(
            get_server_startup_timeout_ms(&env, false),
            DEFAULT_SERVER_STARTUP_TIMEOUT_MS
        );
        assert_eq!(
            get_server_startup_timeout_ms(&env, true),
            PACKAGED_SERVER_STARTUP_TIMEOUT_MS
        );

        env.insert(
            "COWORK_DESKTOP_SERVER_STARTUP_TIMEOUT_MS".into(),
            "100".into(),
        );
        assert_eq!(
            get_server_startup_timeout_ms(&env, false),
            MIN_SERVER_STARTUP_TIMEOUT_MS
        );

        env.insert(
            "COWORK_DESKTOP_SERVER_STARTUP_TIMEOUT_MS".into(),
            "99999999".into(),
        );
        assert_eq!(
            get_server_startup_timeout_ms(&env, false),
            MAX_SERVER_STARTUP_TIMEOUT_MS
        );
    }

    #[test]
    fn server_env_scrubs_unconsented_telemetry_keys() {
        let mut parent = HashMap::new();
        parent.insert("PATH".into(), "/usr/bin".into());
        parent.insert("COWORK_SENTRY_DSN".into(), "https://dsn.example".into());
        parent.insert("LANGFUSE_PUBLIC_KEY".into(), "pk-123".into());
        parent.insert("COWORK_POSTHOG_KEY".into(), "ph-123".into());
        parent.insert("COWORK_ENABLE_WORKFLOWS".into(), "1".into());

        let flags = WorkspaceServerFeatureFlags {
            open_ai_native_connectors: false,
            tasks: true,
            workflows: false,
        };
        let built = build_server_env(
            &parent,
            Path::new("/tmp/userData"),
            Some(Path::new("/tmp/builtin")),
            false,
            &flags,
            false,
            None,
        );

        assert_eq!(built.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert!(!built.contains_key("COWORK_SENTRY_DSN"));
        assert!(!built.contains_key("LANGFUSE_PUBLIC_KEY"));
        assert!(!built.contains_key("COWORK_POSTHOG_KEY"));
        assert_eq!(
            built.get("AGENT_OBSERVABILITY_ENABLED").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            built
                .get("COWORK_CRASH_REPORTS_ENABLED")
                .map(String::as_str),
            Some("false")
        );
        assert_eq!(
            built.get("COWORK_ENABLE_TASKS").map(String::as_str),
            Some("1")
        );
        assert!(!built.contains_key("COWORK_ENABLE_WORKFLOWS"));
        assert!(!built.get("COWORK_BROWSER_ACCESS_TOKEN").unwrap().is_empty());
    }

    #[test]
    fn reuse_policy_checks_flags_yolo_h3_and_force_restart() {
        let f1 = WorkspaceServerFeatureFlags {
            open_ai_native_connectors: false,
            tasks: true,
            workflows: false,
        };
        let fp = f1.fingerprint();
        assert!(should_reuse_existing_workspace_server(
            false, None, false, &f1, false, false, &fp
        ));
        assert!(!should_reuse_existing_workspace_server(
            true, None, false, &f1, false, false, &fp
        ));
        assert!(!should_reuse_existing_workspace_server(
            false, None, true, &f1, false, false, &fp
        ));
        let f2 = WorkspaceServerFeatureFlags {
            workflows: true,
            ..f1
        };
        assert!(!should_reuse_existing_workspace_server(
            false, None, false, &f2, false, false, &fp
        ));
    }

    #[tokio::test]
    async fn patches_mobile_h3_permissions_with_bearer_admin_token() {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server_task = tokio::spawn(async move {
            for idx in 0..6 {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = tokio::io::AsyncReadExt::read(&mut sock, &mut buf)
                    .await
                    .unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let req_lower = req.to_ascii_lowercase();
                assert!(req_lower.contains("authorization: bearer adm-secret"));
                assert!(!req.contains("coworkBrowserToken"));

                let body = match idx {
                    0 => {
                        assert!(req.starts_with("PATCH /mobile-h3/trusted/dev%2F1+2/permissions "));
                        json!({
                            "trustedDevice": {
                                "deviceId": "dev/1+2",
                                "displayName": "iPhone",
                                "lastPairedAt": "2026-01-01T00:00:00Z",
                                "permissions": { "turns": true, "backups": false }
                            }
                        })
                        .to_string()
                    }
                    1 => {
                        assert!(req.starts_with("GET /mobile-h3/trusted "));
                        json!({
                            "trustedDevices": [{
                                "deviceId": "dev/1+2",
                                "displayName": "iPhone",
                                "lastPairedAt": "2026-01-01T00:00:00Z",
                                "permissions": { "turns": true, "backups": false }
                            }]
                        })
                        .to_string()
                    }
                    2 => {
                        assert!(req.starts_with("DELETE /mobile-h3/trusted/dev%2F1+2 "));
                        json!({ "ok": true, "removed": true }).to_string()
                    }
                    3 => {
                        assert!(req.starts_with("GET /mobile-h3/trusted "));
                        json!({
                            "trustedDevices": [{
                                "deviceId": "dev-2",
                                "displayName": "iPad",
                                "lastPairedAt": "2026-01-01T00:00:00Z",
                                "permissions": { "turns": true }
                            }]
                        })
                        .to_string()
                    }
                    4 => {
                        assert!(req.starts_with("DELETE /mobile-h3/trusted "));
                        json!({ "ok": true }).to_string()
                    }
                    _ => {
                        assert!(req.starts_with("GET /mobile-h3/trusted "));
                        json!({ "trustedDevices": [] }).to_string()
                    }
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            }
        });

        let tmp = tempfile::tempdir().unwrap();
        let manager = ServerManager::new(
            ServerManagerRuntime {
                user_data_dir: tmp.path().to_path_buf(),
                resources_dir: None,
                current_exe_dir: None,
                repo_root: None,
                is_packaged: false,
            },
            None,
            None,
        );

        let (kill_tx, _kill_rx) = tokio::sync::oneshot::channel();
        let handle = Arc::new(RunningServerHandle {
            instance_id: 1,
            workspace_path: tmp.path().to_path_buf(),
            stdin: Mutex::new(None),
            kill_tx: Mutex::new(Some(kill_tx)),
            ws_url: format!(
                "ws://127.0.0.1:{}/ws?coworkBrowserToken=tok-ws",
                addr.port()
            ),
            port: addr.port(),
            browser_access_token: Some("tok-ws".into()),
            yolo: false,
            has_mobile_h3: true,
            mobile_h3: Mutex::new(Some(json!({
                "url": "https://relay.example",
                "ticket": "cowork://pair/123",
                "adminToken": "adm-secret",
                "trustedDevices": []
            }))),
            feature_flag_fingerprint: WorkspaceServerFeatureFlags::default().fingerprint(),
            suppressed_exit: Arc::new(AtomicBool::new(false)),
            exited: Arc::new(AtomicBool::new(false)),
            exited_notify: Arc::new(Notify::new()),
        });
        {
            let mut state = manager.state.lock().unwrap();
            state.servers.insert("ws-1".to_string(), handle);
        }

        assert_eq!(
            manager
                .preferred_workspace_target(Some("ws-1"))
                .map(|(id, _, _)| id),
            Some("ws-1".to_string())
        );

        let updated = manager
            .update_mobile_h3_trusted_device_permissions(
                "ws-1",
                "dev/1+2",
                json!({ "turns": true, "backups": false }),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            updated["trustedDevices"][0]["permissions"]["turns"],
            json!(true)
        );
        let after_delete = manager
            .forget_mobile_h3_trusted_device("ws-1", "dev/1+2")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            after_delete["trustedDevices"][0]["deviceId"],
            json!("dev-2")
        );
        let after_revoke_all = manager
            .revoke_all_mobile_h3_trusted_devices("ws-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after_revoke_all["trustedDevices"], json!([]));
        server_task.await.unwrap();
    }

    #[test]
    fn build_server_env_with_analytics_propagates_and_suppresses_telemetry_cleanly() {
        let mut parent = HashMap::new();
        parent.insert(
            "COWORK_SENTRY_DSN".into(),
            "https://pubkey@sentry.example.com/12".into(),
        );
        parent.insert("COWORK_SENTRY_ENVIRONMENT".into(), "beta".into());
        parent.insert("COWORK_POSTHOG_KEY".into(), "phc_desktop_test".into());
        parent.insert(
            "COWORK_POSTHOG_HOST".into(),
            "https://posthog.example.com/".into(),
        );
        parent.insert("COWORK_POSTHOG_ENVIRONMENT".into(), "beta".into());
        parent.insert("COWORK_CRASH_REPORTS_ENABLED".into(), "true".into());
        parent.insert("COWORK_PRODUCT_ANALYTICS_ENABLED".into(), "true".into());

        let opted_in = PrivacyTelemetrySettings {
            crash_reports_enabled: true,
            product_analytics_enabled: true,
            ..Default::default()
        };
        let analytics_state = PersistedProductAnalyticsState {
            anonymous_installation_id: Some("anon_0123456789abcdef0123456789abcdef".into()),
            last_app_version: None,
        };
        let built = build_server_env_with_analytics(
            &parent,
            Path::new("/tmp/userData"),
            None,
            true,
            &WorkspaceServerFeatureFlags::default(),
            false,
            Some(&opted_in),
            Some(&analytics_state),
        );
        assert_eq!(
            built
                .get("COWORK_CRASH_REPORTS_ENABLED")
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            built.get("COWORK_SENTRY_DSN").map(String::as_str),
            Some("https://pubkey@sentry.example.com/12")
        );
        assert_eq!(
            built.get("COWORK_SENTRY_ENVIRONMENT").map(String::as_str),
            Some("beta")
        );
        assert_eq!(
            built
                .get("COWORK_PRODUCT_ANALYTICS_ENABLED")
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            built.get("COWORK_POSTHOG_KEY").map(String::as_str),
            Some("phc_desktop_test")
        );
        assert_eq!(
            built.get("COWORK_POSTHOG_HOST").map(String::as_str),
            Some("https://posthog.example.com")
        );
        assert_eq!(
            built
                .get("COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID")
                .map(String::as_str),
            Some("anon_0123456789abcdef0123456789abcdef")
        );

        let mut killed_parent = parent;
        killed_parent.insert("COWORK_DISABLE_NETWORK_TELEMETRY".into(), "1".into());
        let killed = build_server_env_with_analytics(
            &killed_parent,
            Path::new("/tmp/userData"),
            None,
            true,
            &WorkspaceServerFeatureFlags::default(),
            false,
            Some(&opted_in),
            Some(&analytics_state),
        );
        assert_eq!(
            killed
                .get("COWORK_CRASH_REPORTS_ENABLED")
                .map(String::as_str),
            Some("false")
        );
        assert_eq!(
            killed
                .get("COWORK_PRODUCT_ANALYTICS_ENABLED")
                .map(String::as_str),
            Some("false")
        );
        assert!(!killed.contains_key("COWORK_SENTRY_DSN"));
        assert!(!killed.contains_key("COWORK_POSTHOG_KEY"));
        assert!(!killed.contains_key("COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID"));
    }
}
