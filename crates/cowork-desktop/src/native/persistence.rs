//! Desktop state, transcript, and legacy user-data migration persistence.
//!
//! Replaces `apps/desktop/electron/services/{persistence.ts, userDataOverride.ts}` while
//! keeping disk compatibility with `cowork-server`'s `<userData>/state.json` normalization.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger};
use super::security::{WorkspaceRootsController, is_temporarily_unavailable_fs_error};
use super::validation::{assert_direction, assert_safe_id, assert_within_transcripts_dir};
use crate::actions::SidebarSectionKey;
use crate::state::{
    DesktopSettings, OnboardingState, PersistedDesktopState, PrivacyTelemetrySettings,
    WorkspaceRecord,
};
use crate::theme::ThemePreference;

pub const DESKTOP_USER_DATA_DIR_ENV: &str = "COWORK_DESKTOP_USER_DATA_DIR";
pub const LEGACY_ELECTRON_USER_DATA_DIR_ENV: &str = "COWORK_ELECTRON_USER_DATA_DIR";
pub const STATE_FILENAME: &str = "state.json";
pub const TRANSCRIPTS_DIR_NAME: &str = "transcripts";

const DEFAULT_WORKFLOW_CONCURRENCY_MIN: i64 = 1;
const DEFAULT_WORKFLOW_CONCURRENCY_MAX: i64 = 16;

#[derive(Debug, thiserror::Error)]
pub enum PersistenceError {
    #[error("{0}")]
    InvalidConfig(String),
    #[error("{0}")]
    Validation(String),
    #[error("Failed persistence config operation ({context}): {source}")]
    Config {
        context: &'static str,
        #[source]
        source: cowork_config::ConfigError,
    },
    #[error("Failed persistence I/O operation ({context}): {source}")]
    Io {
        context: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to serialize state JSON: {0}")]
    Json(#[from] serde_json::Error),
}

impl From<anyhow::Error> for PersistenceError {
    fn from(value: anyhow::Error) -> Self {
        Self::Validation(value.to_string())
    }
}

/// Direction tag for persisted transcript JSONL entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptDirection {
    Server,
    Client,
}

/// One persisted JSONL event stored under `<userData>/transcripts/<threadId>.jsonl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEvent {
    pub ts: String,
    pub thread_id: String,
    pub direction: TranscriptDirection,
    #[serde(default)]
    pub payload: Value,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Resolves the OS application data directory (`app.getPath("appData")` equivalent).
pub fn resolve_app_data_dir_from_env(env: &HashMap<String, String>) -> PathBuf {
    let platform = cowork_config::host_platform();
    if cfg!(target_os = "windows") {
        if let Some(app_data) = non_empty_env(env, "APPDATA") {
            return PathBuf::from(app_data);
        }
        if let Some(dir) = dirs::config_dir() {
            return dir;
        }
        if let Some(profile) = non_empty_env(env, "USERPROFILE") {
            return PathBuf::from(profile).join("AppData").join("Roaming");
        }
        return cowork_config::resolve_home_dir(env, platform)
            .join("AppData")
            .join("Roaming");
    }

    if cfg!(target_os = "macos") {
        if let Some(home) = non_empty_env(env, "HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support");
        }
        return cowork_config::resolve_home_dir(env, platform)
            .join("Library")
            .join("Application Support");
    }

    if let Some(xdg) = non_empty_env(env, "XDG_CONFIG_HOME") {
        return PathBuf::from(xdg);
    }
    if let Some(home) = non_empty_env(env, "HOME") {
        return PathBuf::from(home).join(".config");
    }
    dirs::config_dir()
        .unwrap_or_else(|| cowork_config::resolve_home_dir(env, platform).join(".config"))
}

/// Returns whether a dev/test user-data directory override env var is set.
pub fn read_user_data_override_env(env: &HashMap<String, String>) -> Option<String> {
    non_empty_env(env, DESKTOP_USER_DATA_DIR_ENV)
        .or_else(|| non_empty_env(env, LEGACY_ELECTRON_USER_DATA_DIR_ENV))
}

/// Resolves desktop `userData` directory while rejecting overrides in packaged builds.
pub fn resolve_user_data_dir(
    is_packaged: bool,
    env: &HashMap<String, String>,
) -> Result<PathBuf, PersistenceError> {
    if let Some(override_dir) = read_user_data_override_env(env) {
        if is_packaged {
            return Err(PersistenceError::InvalidConfig(format!(
                "{DESKTOP_USER_DATA_DIR_ENV} is not allowed in packaged builds."
            )));
        }
        let candidate = PathBuf::from(override_dir);
        if candidate.is_absolute() {
            return Ok(candidate);
        }
        let cwd = std::env::current_dir().map_err(|source| PersistenceError::Io {
            context: "resolve current working directory for userData override",
            source,
        })?;
        return Ok(cwd.join(candidate));
    }

    Ok(resolve_app_data_dir_from_env(env).join("Cowork"))
}

/// Resolves the legacy Electron `desktop` user-data directory for one-time migration.
pub fn resolve_legacy_user_data_dir(env: &HashMap<String, String>) -> PathBuf {
    resolve_app_data_dir_from_env(env).join("desktop")
}

/// Serialized desktop state & transcript persistence store rooted at `<userData>`.
pub struct PersistenceService {
    user_data_dir: PathBuf,
    legacy_user_data_dir: Option<PathBuf>,
    has_explicit_override: bool,
    one_off_chats_root: Option<PathBuf>,
    logger: Option<std::sync::Arc<LocalLogger>>,
    lock: Mutex<()>,
    migrated: Mutex<bool>,
}

impl PersistenceService {
    /// Creates a persistence store with standard legacy migration and `~/.cowork/chats` root.
    pub fn new(
        user_data_dir: PathBuf,
        legacy_user_data_dir: Option<PathBuf>,
        has_explicit_override: bool,
        logger: Option<std::sync::Arc<LocalLogger>>,
    ) -> Self {
        Self {
            user_data_dir,
            legacy_user_data_dir,
            has_explicit_override,
            one_off_chats_root: None,
            logger,
            lock: Mutex::new(()),
            migrated: Mutex::new(false),
        }
    }

    /// Creates a persistence store pinned to an explicit test `~/.cowork/chats` root.
    pub fn with_one_off_chats_root(mut self, root: PathBuf) -> Self {
        self.one_off_chats_root = Some(root);
        self
    }

    pub fn user_data_dir(&self) -> &Path {
        &self.user_data_dir
    }

    pub fn state_file_path(&self) -> PathBuf {
        self.user_data_dir.join(STATE_FILENAME)
    }

    pub fn transcripts_dir(&self) -> PathBuf {
        self.user_data_dir.join(TRANSCRIPTS_DIR_NAME)
    }

    pub fn transcript_file_path(&self, thread_id: &str) -> Result<PathBuf, PersistenceError> {
        assert_safe_id(thread_id, "threadId")?;
        let dir = self.transcripts_dir();
        let file = dir.join(format!("{thread_id}.jsonl"));
        assert_within_transcripts_dir(&dir, &file)?;
        Ok(file)
    }

    /// Ensures one-time migration has run, then loads and normalizes `state.json`.
    pub fn load_state_value(&self) -> Result<Value, PersistenceError> {
        let _guard = self.lock_state()?;
        self.ensure_storage_ready_locked()?;
        self.read_state_value_locked()
    }

    /// Loads `state.json` and converts it to the core `PersistedDesktopState` snapshot.
    pub fn load_core_state(&self) -> Result<PersistedDesktopState, PersistenceError> {
        let value = self.load_state_value()?;
        Ok(core_state_from_document(&value))
    }

    /// Merges the UI-owned `PersistedDesktopState` into preserved on-disk `state.json`,
    /// keeping server-owned fields (`threads`, `providerState`, per-workspace routing,
    /// `composerDrafts`, `creationDrafts`) intact, then writes atomically with `0o600`.
    pub fn merge_and_save_core_snapshot(
        &self,
        snapshot: &PersistedDesktopState,
    ) -> Result<Value, PersistenceError> {
        let _guard = self.lock_state()?;
        self.ensure_storage_ready_locked()?;

        let previous = self.read_raw_json_object_locked().unwrap_or(None);
        let base_doc = previous.clone().unwrap_or_else(default_state_document);
        let merged = merge_core_snapshot_into_document(base_doc, snapshot);
        self.write_state_document_locked(merged, previous.as_ref())
    }

    /// Sanitizes and atomically writes a full `state.json` document under lock.
    pub fn save_state_value(&self, value: Value) -> Result<Value, PersistenceError> {
        let _guard = self.lock_state()?;
        self.ensure_storage_ready_locked()?;
        let previous = self.read_raw_json_object_locked().unwrap_or(None);
        self.write_state_document_locked(value, previous.as_ref())
    }

    /// Reads, mutates, sanitizes, and atomically writes `state.json` under one lock acquisition.
    pub fn update_state_value<F>(&self, update: F) -> Result<Value, PersistenceError>
    where
        F: FnOnce(Value) -> Result<Value, PersistenceError>,
    {
        let _guard = self.lock_state()?;
        self.ensure_storage_ready_locked()?;
        let current = self.read_state_value_locked()?;
        let next = update(current)?;
        let previous = self.read_raw_json_object_locked().unwrap_or(None);
        self.write_state_document_locked(next, previous.as_ref())
    }

    /// Syncs `WorkspaceRootsController` with persisted workspace roots from a document.
    pub fn sync_workspace_roots(doc: &Value, roots: &mut WorkspaceRootsController) {
        let pairs = extract_workspace_id_path_pairs(doc);
        let refs: Vec<(&str, &Path)> = pairs
            .iter()
            .map(|(id, p)| (id.as_str(), p.as_path()))
            .collect();
        roots.set_persisted_workspaces(refs);
    }

    /// Reads all valid transcript events for `thread_id`. Missing files return empty `Vec`.
    pub fn read_transcript(
        &self,
        thread_id: &str,
    ) -> Result<Vec<TranscriptEvent>, PersistenceError> {
        self.ensure_storage_ready_only()?;
        let file = self.transcript_file_path(thread_id)?;
        let raw = match fs::read_to_string(&file) {
            Ok(content) => content,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(PersistenceError::Io {
                    context: "read transcript file",
                    source,
                });
            }
        };

        let mut events = Vec::new();
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<TranscriptEvent>(trimmed)
                && !event.ts.trim().is_empty()
                && !event.thread_id.trim().is_empty()
            {
                events.push(event);
            }
        }
        Ok(events)
    }

    /// Appends one transcript event to `<userData>/transcripts/<threadId>.jsonl`.
    pub fn append_transcript_event(&self, event: TranscriptEvent) -> Result<(), PersistenceError> {
        self.append_transcript_batch(vec![event])
    }

    /// Appends a batch of transcript events grouped by validated `threadId`.
    pub fn append_transcript_batch(
        &self,
        events: Vec<TranscriptEvent>,
    ) -> Result<(), PersistenceError> {
        if events.is_empty() {
            return Ok(());
        }
        self.ensure_storage_ready_only()?;

        let transcripts_dir = self.transcripts_dir();
        cowork_config::ensure_private_dir_sync(&transcripts_dir).map_err(|source| {
            PersistenceError::Config {
                context: "ensure transcripts directory",
                source,
            }
        })?;

        let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
        for event in events {
            assert_safe_id(&event.thread_id, "threadId")?;
            let dir_str = match event.direction {
                TranscriptDirection::Server => "server",
                TranscriptDirection::Client => "client",
            };
            assert_direction(dir_str)?;
            let serialized = serde_json::to_string(&event)?;
            grouped.entry(event.thread_id).or_default().push(serialized);
        }

        for (thread_id, lines) in grouped {
            let file_path = self.transcript_file_path(&thread_id)?;
            let mut payload = lines.join("\n");
            payload.push('\n');

            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file_path)
                .map_err(|source| PersistenceError::Io {
                    context: "open transcript file for append",
                    source,
                })?;
            file.write_all(payload.as_bytes())
                .map_err(|source| PersistenceError::Io {
                    context: "append transcript lines",
                    source,
                })?;
            drop(file);
            cowork_config::harden_private_file_sync(&file_path);
        }

        Ok(())
    }

    /// Deletes `<userData>/transcripts/<threadId>.jsonl`, ignoring missing files.
    pub fn delete_transcript(&self, thread_id: &str) -> Result<(), PersistenceError> {
        self.ensure_storage_ready_only()?;
        let file = self.transcript_file_path(thread_id)?;
        match fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
            Err(source) => Err(PersistenceError::Io {
                context: "delete transcript file",
                source,
            }),
        }
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, ()>, PersistenceError> {
        Ok(self.lock.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn ensure_storage_ready_only(&self) -> Result<(), PersistenceError> {
        let _guard = self.lock_state()?;
        self.ensure_storage_ready_locked()
    }

    fn ensure_storage_ready_locked(&self) -> Result<(), PersistenceError> {
        let mut migrated = self.migrated.lock().unwrap_or_else(|e| e.into_inner());
        if *migrated {
            return Ok(());
        }
        if !self.has_explicit_override
            && let Some(legacy_dir) = &self.legacy_user_data_dir
        {
            migrate_legacy_user_data_if_needed(&self.user_data_dir, legacy_dir)?;
        }
        *migrated = true;
        Ok(())
    }

    fn read_raw_json_object_locked(&self) -> Result<Option<Value>, PersistenceError> {
        match fs::read_to_string(self.state_file_path()) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(Value::Object(map)) => Ok(Some(Value::Object(map))),
                _ => Ok(None),
            },
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
            Err(source) => Err(PersistenceError::Io {
                context: "read raw state.json",
                source,
            }),
        }
    }

    fn read_state_value_locked(&self) -> Result<Value, PersistenceError> {
        let state_path = self.state_file_path();
        let raw = match fs::read_to_string(&state_path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(default_state_document()),
            Err(source) => {
                return Err(PersistenceError::Io {
                    context: "read state.json",
                    source,
                });
            }
        };

        let parsed: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => {
                self.preserve_corrupt_state_file();
                return Ok(default_state_document());
            }
        };

        if !parsed.is_object() {
            self.preserve_corrupt_state_file();
            return Ok(default_state_document());
        }

        Ok(self.sanitize_state_document(parsed))
    }

    fn preserve_corrupt_state_file(&self) {
        let state_path = self.state_file_path();
        let backup_name = format!("{STATE_FILENAME}.corrupt-{}", now_epoch_ms());
        let backup_path = self.user_data_dir.join(&backup_name);
        match fs::rename(&state_path, &backup_path) {
            Ok(()) => {
                if let Some(logger) = &self.logger {
                    let meta = json!({ "backupFile": backup_name });
                    logger.write(
                        LocalLogFileName::Server,
                        LocalLogLevel::Warn,
                        "persistence",
                        "state file was not valid JSON; preserved it and reset state",
                        Some(&meta),
                    );
                }
            }
            Err(err) => {
                if let Some(logger) = &self.logger {
                    let meta = json!({ "error": err.to_string() });
                    logger.write(
                        LocalLogFileName::Server,
                        LocalLogLevel::Warn,
                        "persistence",
                        "state file was not valid JSON and could not be preserved",
                        Some(&meta),
                    );
                }
            }
        }
    }

    fn write_state_document_locked(
        &self,
        value: Value,
        previous: Option<&Value>,
    ) -> Result<Value, PersistenceError> {
        cowork_config::ensure_private_dir_sync(&self.user_data_dir).map_err(|source| {
            PersistenceError::Config {
                context: "create userData directory",
                source,
            }
        })?;

        let mut sanitized = self.sanitize_state_document(value);
        preserve_pending_research_draft(&mut sanitized, previous);
        if let Some(obj) = sanitized.as_object_mut() {
            let current_ver = obj.get("version").and_then(Value::as_u64).unwrap_or(0);
            if current_ver < 2 {
                obj.insert("version".to_string(), json!(2));
            }
        }

        let formatted = serde_json::to_string_pretty(&sanitized)?;
        let state_path = self.state_file_path();
        cowork_config::write_text_file_atomic(&state_path, &formatted, Some(0o600)).map_err(
            |source| PersistenceError::Config {
                context: "write state.json atomically",
                source,
            },
        )?;
        cowork_config::harden_private_file_sync(&state_path);
        Ok(sanitized)
    }

    fn sanitize_state_document(&self, value: Value) -> Value {
        let mut obj = match value {
            Value::Object(map) => map,
            _ => return default_state_document(),
        };

        let one_off_root = self.one_off_chats_root.clone().unwrap_or_else(|| {
            let env = cowork_config::env_map_from_process();
            let home = cowork_config::resolve_home_dir(&env, cowork_config::host_platform());
            cowork_config::get_one_off_chats_root(&home)
        });

        let sanitized_workspaces = sanitize_workspaces(
            obj.get("workspaces").and_then(Value::as_array),
            &one_off_root,
        );
        let workspace_ids: HashSet<String> = sanitized_workspaces
            .iter()
            .filter_map(|ws| {
                ws.get("id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .collect();

        let sanitized_threads =
            sanitize_threads(obj.get("threads").and_then(Value::as_array), &workspace_ids);

        let version = obj
            .get("version")
            .and_then(Value::as_u64)
            .filter(|v| *v >= 2)
            .unwrap_or(2);
        obj.insert("version".to_string(), json!(version));
        obj.insert("workspaces".to_string(), Value::Array(sanitized_workspaces));
        obj.insert("threads".to_string(), Value::Array(sanitized_threads));

        let thread_ids: HashSet<String> = obj
            .get("threads")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|t| t.get("id").and_then(Value::as_str).map(ToString::to_string))
            .collect();

        let filtered_order: Vec<Value> = obj
            .get("workspaceOrder")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| workspace_ids.contains(*id))
            .map(|id| Value::String(id.to_string()))
            .collect();
        obj.insert("workspaceOrder".to_string(), Value::Array(filtered_order));

        let filtered_collapsed: Vec<Value> = obj
            .get("collapsedWorkspaceIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| workspace_ids.contains(*id))
            .map(|id| Value::String(id.to_string()))
            .collect();
        obj.insert(
            "collapsedWorkspaceIds".to_string(),
            Value::Array(filtered_collapsed),
        );

        let active_ws = obj
            .get("activeWorkspaceId")
            .and_then(Value::as_str)
            .filter(|id| workspace_ids.contains(*id))
            .map(|id| Value::String(id.to_string()))
            .unwrap_or(Value::Null);
        obj.insert("activeWorkspaceId".to_string(), active_ws);

        let active_thread = obj
            .get("activeThreadId")
            .and_then(Value::as_str)
            .filter(|id| thread_ids.contains(*id))
            .map(|id| Value::String(id.to_string()))
            .unwrap_or(Value::Null);
        obj.insert("activeThreadId".to_string(), active_thread);

        let dev_mode = obj
            .get("developerMode")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let show_hidden = obj
            .get("showHiddenFiles")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let per_ws = obj
            .get("perWorkspaceSettings")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        obj.insert("developerMode".to_string(), Value::Bool(dev_mode));
        obj.insert("showHiddenFiles".to_string(), Value::Bool(show_hidden));
        obj.insert("perWorkspaceSettings".to_string(), Value::Bool(per_ws));

        let desktop_settings = sanitize_desktop_settings(obj.get("desktopSettings"));
        obj.insert("desktopSettings".to_string(), desktop_settings);

        let privacy = sanitize_privacy_telemetry_settings(obj.get("privacyTelemetrySettings"));
        obj.insert("privacyTelemetrySettings".to_string(), privacy);

        let flags = sanitize_feature_flags(obj.get("desktopFeatureFlagOverrides"));
        obj.insert("desktopFeatureFlagOverrides".to_string(), flags);

        if let Some(onboarding) = obj.get("onboarding").and_then(sanitize_onboarding_value) {
            obj.insert("onboarding".to_string(), onboarding);
        } else {
            obj.remove("onboarding");
        }

        Value::Object(obj)
    }
}

/// Converts a normalized `state.json` document into `crate::state::PersistedDesktopState`.
pub fn core_state_from_document(doc: &Value) -> PersistedDesktopState {
    let mut out = PersistedDesktopState::default();
    let Some(obj) = doc.as_object() else {
        return out;
    };

    out.settings = core_desktop_settings_from_document(obj);

    if let Some(arr) = obj.get("workspaces").and_then(Value::as_array) {
        out.workspaces = arr.iter().filter_map(core_workspace_from_value).collect();
    }

    if let Some(arr) = obj.get("workspaceOrder").and_then(Value::as_array) {
        out.workspace_order = arr
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect();
    }

    if let Some(arr) = obj.get("collapsedWorkspaceIds").and_then(Value::as_array) {
        out.collapsed_workspace_ids = arr
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect();
    }

    out.active_workspace_id = obj
        .get("activeWorkspaceId")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    out.active_thread_id = obj
        .get("activeThreadId")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    if let Some(onboarding_val) = obj.get("onboarding")
        && let Ok(parsed) = serde_json::from_value::<OnboardingState>(onboarding_val.clone())
    {
        out.onboarding = parsed;
    }

    if let Some(flags) = obj
        .get("desktopFeatureFlagOverrides")
        .and_then(Value::as_object)
    {
        for (k, v) in flags {
            if let Some(b) = v.as_bool() {
                out.feature_flags.insert(k.clone(), b);
            }
        }
    }

    out
}

/// Merges a core `PersistedDesktopState` snapshot into an existing `state.json` document.
pub fn merge_core_snapshot_into_document(base: Value, snapshot: &PersistedDesktopState) -> Value {
    let mut doc = match base {
        Value::Object(map) => map,
        _ => match default_state_document() {
            Value::Object(map) => map,
            _ => unreachable!(),
        },
    };

    let existing_by_id: HashMap<String, Map<String, Value>> = doc
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let map = item.as_object()?;
            let id = map.get("id").and_then(Value::as_str)?.to_string();
            Some((id, map.clone()))
        })
        .collect();

    let merged_workspaces: Vec<Value> = snapshot
        .workspaces
        .iter()
        .map(|ws| {
            let mut map = existing_by_id.get(&ws.id).cloned().unwrap_or_default();
            map.insert("id".to_string(), json!(ws.id));
            map.insert("name".to_string(), json!(ws.name));
            map.insert("path".to_string(), json!(ws.path));
            map.insert(
                "workspaceKind".to_string(),
                json!(if ws.one_off_chat {
                    "oneOffChat"
                } else {
                    "project"
                }),
            );
            map.insert("archived".to_string(), json!(ws.archived));
            map.insert(
                "createdAt".to_string(),
                json!(epoch_ms_to_iso(ws.created_at)),
            );
            map.insert(
                "lastOpenedAt".to_string(),
                json!(epoch_ms_to_iso(ws.last_opened_at)),
            );
            map.entry("wsProtocol".to_string())
                .or_insert_with(|| json!("jsonrpc"));
            Value::Object(map)
        })
        .collect();

    doc.insert("workspaces".to_string(), Value::Array(merged_workspaces));
    doc.insert(
        "workspaceOrder".to_string(),
        Value::Array(
            snapshot
                .workspace_order
                .iter()
                .map(|id| Value::String(id.clone()))
                .collect(),
        ),
    );
    doc.insert(
        "collapsedWorkspaceIds".to_string(),
        Value::Array(
            snapshot
                .collapsed_workspace_ids
                .iter()
                .map(|id| Value::String(id.clone()))
                .collect(),
        ),
    );
    doc.insert(
        "activeWorkspaceId".to_string(),
        snapshot
            .active_workspace_id
            .as_ref()
            .map_or(Value::Null, |id| Value::String(id.clone())),
    );
    doc.insert(
        "activeThreadId".to_string(),
        snapshot
            .active_thread_id
            .as_ref()
            .map_or(Value::Null, |id| Value::String(id.clone())),
    );

    doc.insert(
        "developerMode".to_string(),
        json!(snapshot.settings.developer_mode),
    );
    doc.insert(
        "showHiddenFiles".to_string(),
        json!(snapshot.settings.show_hidden_files),
    );
    doc.insert(
        "perWorkspaceSettings".to_string(),
        json!(snapshot.settings.per_workspace_settings),
    );

    let mut ds = doc
        .get("desktopSettings")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Ok(theme_val) = serde_json::to_value(snapshot.settings.theme) {
        ds.insert("theme".to_string(), theme_val);
    }
    ds.insert(
        "reducedTransparency".to_string(),
        json!(snapshot.settings.reduced_transparency),
    );
    ds.insert(
        "highContrast".to_string(),
        json!(snapshot.settings.high_contrast),
    );
    ds.insert(
        "reduceMotion".to_string(),
        json!(snapshot.settings.reduce_motion),
    );
    ds.insert(
        "injectContext".to_string(),
        json!(snapshot.settings.inject_context),
    );
    ds.insert(
        "quickChat".to_string(),
        json!({
            "iconEnabled": snapshot.settings.quick_chat_icon_enabled,
            "shortcutEnabled": snapshot.settings.quick_chat_shortcut_enabled,
            "shortcutAccelerator": snapshot.settings.quick_chat_shortcut,
        }),
    );
    ds.insert(
        "archivedChatsAutoDeleteDays".to_string(),
        json!(snapshot.settings.archived_chats_auto_delete_days),
    );
    if let Ok(order_val) = serde_json::to_value(&snapshot.settings.sidebar_section_order) {
        ds.insert("sidebarSectionOrder".to_string(), order_val);
    }
    doc.insert("desktopSettings".to_string(), Value::Object(ds));

    if let Ok(privacy_val) = serde_json::to_value(&snapshot.settings.privacy_telemetry) {
        doc.insert("privacyTelemetrySettings".to_string(), privacy_val);
    }
    if let Ok(onboarding_val) = serde_json::to_value(&snapshot.onboarding) {
        doc.insert("onboarding".to_string(), onboarding_val);
    }

    let flags: Map<String, Value> = snapshot
        .feature_flags
        .iter()
        .map(|(k, v)| (k.clone(), Value::Bool(*v)))
        .collect();
    doc.insert(
        "desktopFeatureFlagOverrides".to_string(),
        Value::Object(flags),
    );

    Value::Object(doc)
}

/// Extracts sanitized `(workspace_id, path)` pairs from a persisted state document.
pub fn extract_workspace_id_path_pairs(doc: &Value) -> Vec<(String, PathBuf)> {
    doc.get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?;
            let path = item.get("path").and_then(Value::as_str)?;
            Some((id.to_string(), PathBuf::from(path)))
        })
        .collect()
}

pub fn default_state_document() -> Value {
    json!({
        "version": 2,
        "workspaces": [],
        "threads": [],
        "workspaceOrder": [],
        "collapsedWorkspaceIds": [],
        "activeWorkspaceId": null,
        "activeThreadId": null,
        "developerMode": false,
        "showHiddenFiles": false,
        "perWorkspaceSettings": false,
        "desktopSettings": sanitize_desktop_settings(None),
        "privacyTelemetrySettings": sanitize_privacy_telemetry_settings(None),
        "desktopFeatureFlagOverrides": {},
    })
}

fn migrate_legacy_user_data_if_needed(
    current_dir: &Path,
    legacy_dir: &Path,
) -> Result<(), PersistenceError> {
    if cowork_config::normalize_lexical_path(current_dir)
        == cowork_config::normalize_lexical_path(legacy_dir)
    {
        return Ok(());
    }

    let legacy_meta = match fs::metadata(legacy_dir) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(PersistenceError::Io {
                context: "inspect legacy desktop user data",
                source,
            });
        }
    };
    if !legacy_meta.is_dir() {
        return Ok(());
    }

    cowork_config::ensure_private_dir_sync(current_dir).map_err(|source| {
        PersistenceError::Config {
            context: "ensure destination userData directory for migration",
            source,
        }
    })?;

    for relative in [
        Path::new("state.json"),
        Path::new("transcripts"),
        Path::new("logs").join("server.log").as_path(),
    ] {
        migrate_entry(&legacy_dir.join(relative), &current_dir.join(relative))?;
    }

    Ok(())
}

fn migrate_entry(from: &Path, to: &Path) -> Result<(), PersistenceError> {
    match fs::metadata(from) {
        Ok(_) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(PersistenceError::Io {
                context: "stat legacy migration source",
                source,
            });
        }
    }

    if fs::metadata(to).is_ok() {
        return Ok(());
    }

    if let Some(parent) = to.parent() {
        cowork_config::ensure_private_dir_sync(parent).map_err(|source| {
            PersistenceError::Config {
                context: "ensure parent directory for legacy migration target",
                source,
            }
        })?;
    }

    if fs::rename(from, to).is_ok() {
        return Ok(());
    }

    copy_legacy_entry(from, to)
}

fn copy_legacy_entry(from: &Path, to: &Path) -> Result<(), PersistenceError> {
    let meta = fs::metadata(from).map_err(|source| PersistenceError::Io {
        context: "stat legacy entry for copy",
        source,
    })?;
    if meta.is_dir() {
        cowork_config::ensure_private_dir_sync(to).map_err(|source| PersistenceError::Config {
            context: "create directory during legacy migration copy",
            source,
        })?;
        for entry in fs::read_dir(from).map_err(|source| PersistenceError::Io {
            context: "read legacy directory",
            source,
        })? {
            let entry = entry.map_err(|source| PersistenceError::Io {
                context: "read legacy directory entry",
                source,
            })?;
            copy_legacy_entry(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }

    if let Some(parent) = to.parent() {
        cowork_config::ensure_private_dir_sync(parent).map_err(|source| {
            PersistenceError::Config {
                context: "create parent directory during legacy file copy",
                source,
            }
        })?;
    }
    fs::copy(from, to).map_err(|source| PersistenceError::Io {
        context: "copy legacy file",
        source,
    })?;
    cowork_config::harden_private_file_sync(to);
    Ok(())
}

fn sanitize_workspaces(raw: Option<&Vec<Value>>, one_off_root: &Path) -> Vec<Value> {
    let Some(items) = raw else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut seen_ids = HashSet::new();

    for item in items {
        let Some(mut map) = item.as_object().cloned() else {
            continue;
        };

        let Some(id) = safe_id_from_value(map.get("id")) else {
            continue;
        };
        if seen_ids.contains(&id) {
            continue;
        }
        let Some(name) = non_empty_string(map.get("name")) else {
            continue;
        };
        let Some((created_iso, _)) = parse_timestamp_value(map.get("createdAt")) else {
            continue;
        };
        let Some((last_opened_iso, _)) = parse_timestamp_value(map.get("lastOpenedAt")) else {
            continue;
        };
        let Some(raw_path) = non_empty_string(map.get("path")) else {
            continue;
        };

        let explicit_kind = map.get("workspaceKind").and_then(Value::as_str);
        let one_off_canonical = cowork_config::canonicalize_sync(one_off_root);
        let raw_lexical = cowork_config::normalize_lexical_path(Path::new(&raw_path));
        let is_one_off = if explicit_kind == Some("project") {
            false
        } else {
            explicit_kind == Some("oneOffChat")
                || map.get("oneOffChat").and_then(Value::as_bool) == Some(true)
                || (cowork_config::is_inside(one_off_root, Path::new(&raw_path))
                    && raw_lexical != cowork_config::normalize_lexical_path(one_off_root)
                    && cowork_config::canonicalize_sync(&raw_lexical) != one_off_canonical)
        };

        let Some(resolved_path) = resolve_workspace_path(&raw_path, is_one_off, one_off_root)
        else {
            continue;
        };

        map.insert("id".to_string(), json!(id));
        map.insert("name".to_string(), json!(name));
        map.insert(
            "path".to_string(),
            json!(resolved_path.to_string_lossy().into_owned()),
        );
        map.insert(
            "workspaceKind".to_string(),
            json!(if is_one_off { "oneOffChat" } else { "project" }),
        );
        map.insert("createdAt".to_string(), json!(created_iso));
        map.insert("lastOpenedAt".to_string(), json!(last_opened_iso));
        map.insert(
            "archived".to_string(),
            json!(
                map.get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            ),
        );
        map.insert("wsProtocol".to_string(), json!("jsonrpc"));

        if let Some(conc) = map
            .get("defaultWorkflowMaxConcurrentAgents")
            .and_then(Value::as_i64)
        {
            map.insert(
                "defaultWorkflowMaxConcurrentAgents".to_string(),
                json!(conc.clamp(
                    DEFAULT_WORKFLOW_CONCURRENCY_MIN,
                    DEFAULT_WORKFLOW_CONCURRENCY_MAX
                )),
            );
        } else if map.contains_key("defaultWorkflowMaxConcurrentAgents") {
            map.remove("defaultWorkflowMaxConcurrentAgents");
        }

        if let Some(enable_mcp) = map.get("defaultEnableMcp").and_then(Value::as_bool) {
            map.insert("defaultEnableMcp".to_string(), json!(enable_mcp));
        } else {
            map.insert("defaultEnableMcp".to_string(), json!(true));
        }
        if let Some(backups) = map.get("defaultBackupsEnabled").and_then(Value::as_bool) {
            map.insert("defaultBackupsEnabled".to_string(), json!(backups));
        } else {
            map.insert("defaultBackupsEnabled".to_string(), json!(false));
        }
        if let Some(yolo) = map.get("yolo").and_then(Value::as_bool) {
            map.insert("yolo".to_string(), json!(yolo));
        } else {
            map.insert("yolo".to_string(), json!(false));
        }

        seen_ids.insert(id);
        out.push(Value::Object(map));
    }

    out
}

fn resolve_workspace_path(
    raw_path: &str,
    is_one_off: bool,
    one_off_root: &Path,
) -> Option<PathBuf> {
    let lexical = cowork_config::normalize_lexical_path(Path::new(raw_path));
    if is_one_off {
        let canonical_one_off_root = cowork_config::canonicalize_sync(one_off_root);
        if !cowork_config::is_inside(one_off_root, &lexical)
            || lexical == cowork_config::normalize_lexical_path(one_off_root)
        {
            return None;
        }
        if cowork_config::ensure_private_dir_sync(&lexical).is_err() {
            return None;
        }
        let canonical = cowork_config::canonicalize_sync(&lexical);
        if !cowork_config::is_inside(&canonical_one_off_root, &canonical)
            || canonical == canonical_one_off_root
        {
            return None;
        }
        return Some(canonical);
    }

    match fs::metadata(&lexical) {
        Ok(meta) => {
            if !meta.is_dir() {
                return None;
            }
            Some(cowork_config::canonicalize_sync(&lexical))
        }
        Err(err) if is_temporarily_unavailable_fs_error(&err) => Some(lexical),
        Err(_) => None,
    }
}

fn sanitize_threads(raw: Option<&Vec<Value>>, workspace_ids: &HashSet<String>) -> Vec<Value> {
    let Some(items) = raw else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut seen_ids = HashSet::new();

    for item in items {
        let Some(mut map) = item.as_object().cloned() else {
            continue;
        };

        let Some(id) = safe_id_from_value(map.get("id")) else {
            continue;
        };
        if seen_ids.contains(&id) {
            continue;
        }
        let Some(workspace_id) = safe_id_from_value(map.get("workspaceId")) else {
            continue;
        };
        if !workspace_ids.contains(&workspace_id) {
            continue;
        }
        let Some(title) = non_empty_string(map.get("title")) else {
            continue;
        };
        let Some((created_iso, _)) = parse_timestamp_value(map.get("createdAt")) else {
            continue;
        };
        let Some((last_msg_iso, _)) = parse_timestamp_value(map.get("lastMessageAt")) else {
            continue;
        };

        map.insert("id".to_string(), json!(id));
        map.insert("workspaceId".to_string(), json!(workspace_id));
        map.insert("title".to_string(), json!(title));
        map.insert("createdAt".to_string(), json!(created_iso));
        map.insert("lastMessageAt".to_string(), json!(last_msg_iso));
        map.insert(
            "archived".to_string(),
            json!(
                map.get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            ),
        );
        let msg_count = map.get("messageCount").and_then(Value::as_u64).unwrap_or(0);
        let last_seq = map.get("lastEventSeq").and_then(Value::as_u64).unwrap_or(0);
        map.insert("messageCount".to_string(), json!(msg_count));
        map.insert("lastEventSeq".to_string(), json!(last_seq));

        seen_ids.insert(id);
        out.push(Value::Object(map));
    }

    out
}

fn sanitize_desktop_settings(raw: Option<&Value>) -> Value {
    let defaults = DesktopSettings::default();
    let mut map = raw.and_then(Value::as_object).cloned().unwrap_or_default();

    let quick_chat_obj = map.get("quickChat").and_then(Value::as_object);
    let icon_enabled = quick_chat_obj
        .and_then(|q| q.get("iconEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(defaults.quick_chat_icon_enabled);
    let shortcut_enabled = quick_chat_obj
        .and_then(|q| q.get("shortcutEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(defaults.quick_chat_shortcut_enabled);
    let shortcut_acc = quick_chat_obj
        .and_then(|q| non_empty_string(q.get("shortcutAccelerator")))
        .unwrap_or_else(|| defaults.quick_chat_shortcut.clone());
    map.insert(
        "quickChat".to_string(),
        json!({
            "iconEnabled": icon_enabled,
            "shortcutEnabled": shortcut_enabled,
            "shortcutAccelerator": shortcut_acc,
        }),
    );

    let auto_delete_days = map
        .get("archivedChatsAutoDeleteDays")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(defaults.archived_chats_auto_delete_days);
    map.insert(
        "archivedChatsAutoDeleteDays".to_string(),
        json!(auto_delete_days),
    );

    if let Some(theme_val) = map.get("theme")
        && let Ok(parsed) = serde_json::from_value::<ThemePreference>(theme_val.clone())
        && let Ok(serialized) = serde_json::to_value(parsed)
    {
        map.insert("theme".to_string(), serialized);
    } else if let Ok(serialized) = serde_json::to_value(defaults.theme) {
        map.insert("theme".to_string(), serialized);
    }

    map.insert(
        "reducedTransparency".to_string(),
        json!(
            map.get("reducedTransparency")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.reduced_transparency)
        ),
    );
    map.insert(
        "highContrast".to_string(),
        json!(
            map.get("highContrast")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.high_contrast)
        ),
    );
    map.insert(
        "reduceMotion".to_string(),
        json!(
            map.get("reduceMotion")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.reduce_motion)
        ),
    );
    map.insert(
        "injectContext".to_string(),
        json!(
            map.get("injectContext")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.inject_context)
        ),
    );

    if let Some(order_val) = map.get("sidebarSectionOrder")
        && let Ok(parsed) = serde_json::from_value::<Vec<SidebarSectionKey>>(order_val.clone())
        && !parsed.is_empty()
        && let Ok(serialized) = serde_json::to_value(parsed)
    {
        map.insert("sidebarSectionOrder".to_string(), serialized);
    } else if let Ok(serialized) = serde_json::to_value(&defaults.sidebar_section_order) {
        map.insert("sidebarSectionOrder".to_string(), serialized);
    }

    Value::Object(map)
}

fn sanitize_privacy_telemetry_settings(raw: Option<&Value>) -> Value {
    if let Some(val) = raw
        && let Ok(parsed) = serde_json::from_value::<PrivacyTelemetrySettings>(val.clone())
        && let Ok(serialized) = serde_json::to_value(parsed)
    {
        return serialized;
    }
    serde_json::to_value(PrivacyTelemetrySettings::default()).unwrap_or_else(|_| json!({}))
}

fn sanitize_feature_flags(raw: Option<&Value>) -> Value {
    let mut out = Map::new();
    if let Some(map) = raw.and_then(Value::as_object) {
        for (key, value) in map {
            if let Some(enabled) = value.as_bool() {
                out.insert(key.clone(), Value::Bool(enabled));
            }
        }
    }
    Value::Object(out)
}

fn sanitize_onboarding_value(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let status = match map.get("status").and_then(Value::as_str) {
        Some("pending") => "pending",
        Some("dismissed") => "dismissed",
        Some("completed") => "completed",
        _ => "pending",
    };
    let completed_at = non_empty_string(map.get("completedAt"));
    let dismissed_at = non_empty_string(map.get("dismissedAt"));
    Some(json!({
        "status": status,
        "completedAt": completed_at,
        "dismissedAt": dismissed_at,
    }))
}

fn preserve_pending_research_draft(sanitized: &mut Value, previous: Option<&Value>) {
    let has_research = sanitized
        .get("creationDrafts")
        .and_then(|v| v.get("research"))
        .is_some_and(|v| !v.is_null());
    if has_research {
        return;
    }
    let Some(prev_research) = previous
        .and_then(|v| v.get("creationDrafts"))
        .and_then(|v| v.get("research"))
        .filter(|v| !v.is_null())
        .cloned()
    else {
        return;
    };

    let Some(obj) = sanitized.as_object_mut() else {
        return;
    };
    let mut drafts = obj
        .get("creationDrafts")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    drafts.insert("research".to_string(), prev_research);
    obj.insert("creationDrafts".to_string(), Value::Object(drafts));
}

fn core_desktop_settings_from_document(obj: &Map<String, Value>) -> DesktopSettings {
    let mut settings = DesktopSettings::default();
    if let Some(v) = obj.get("developerMode").and_then(Value::as_bool) {
        settings.developer_mode = v;
    }
    if let Some(v) = obj.get("showHiddenFiles").and_then(Value::as_bool) {
        settings.show_hidden_files = v;
    }
    if let Some(v) = obj.get("perWorkspaceSettings").and_then(Value::as_bool) {
        settings.per_workspace_settings = v;
    }

    if let Some(ds) = obj.get("desktopSettings").and_then(Value::as_object) {
        if let Some(v) = ds.get("theme")
            && let Ok(theme) = serde_json::from_value::<ThemePreference>(v.clone())
        {
            settings.theme = theme;
        }
        if let Some(v) = ds.get("reducedTransparency").and_then(Value::as_bool) {
            settings.reduced_transparency = v;
        }
        if let Some(v) = ds.get("highContrast").and_then(Value::as_bool) {
            settings.high_contrast = v;
        }
        if let Some(v) = ds.get("reduceMotion").and_then(Value::as_bool) {
            settings.reduce_motion = v;
        }
        if let Some(v) = ds.get("injectContext").and_then(Value::as_bool) {
            settings.inject_context = v;
        }
        if let Some(qc) = ds.get("quickChat").and_then(Value::as_object) {
            if let Some(v) = qc.get("iconEnabled").and_then(Value::as_bool) {
                settings.quick_chat_icon_enabled = v;
            }
            if let Some(v) = qc.get("shortcutEnabled").and_then(Value::as_bool) {
                settings.quick_chat_shortcut_enabled = v;
            }
            if let Some(v) = non_empty_string(qc.get("shortcutAccelerator")) {
                settings.quick_chat_shortcut = v;
            }
        }
        if let Some(v) = ds
            .get("archivedChatsAutoDeleteDays")
            .and_then(Value::as_u64)
        {
            settings.archived_chats_auto_delete_days = v as u32;
        }
        if let Some(v) = ds.get("sidebarSectionOrder")
            && let Ok(order) = serde_json::from_value::<Vec<SidebarSectionKey>>(v.clone())
            && !order.is_empty()
        {
            settings.sidebar_section_order = order;
        }
    }

    if let Some(privacy) = obj.get("privacyTelemetrySettings")
        && let Ok(parsed) = serde_json::from_value::<PrivacyTelemetrySettings>(privacy.clone())
    {
        settings.privacy_telemetry = parsed;
    }

    settings
}

fn core_workspace_from_value(value: &Value) -> Option<WorkspaceRecord> {
    let map = value.as_object()?;
    let id = map.get("id").and_then(Value::as_str)?.to_string();
    let name = map.get("name").and_then(Value::as_str)?.to_string();
    let path = map.get("path").and_then(Value::as_str)?.to_string();
    let one_off_chat = map.get("workspaceKind").and_then(Value::as_str) == Some("oneOffChat")
        || map.get("oneOffChat").and_then(Value::as_bool) == Some(true);
    let archived = map
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let created_at = parse_timestamp_value(map.get("createdAt"))
        .map(|(_, ms)| ms)
        .unwrap_or_else(now_epoch_ms);
    let last_opened_at = parse_timestamp_value(map.get("lastOpenedAt"))
        .map(|(_, ms)| ms)
        .unwrap_or(created_at);

    let mut ws = WorkspaceRecord::new(id, name, path, created_at);
    ws.one_off_chat = one_off_chat;
    ws.archived = archived;
    ws.last_opened_at = last_opened_at;
    ws.yolo = map.get("yolo").and_then(Value::as_bool).unwrap_or(false);
    ws.default_provider = non_empty_string(map.get("defaultProvider"));
    ws.default_model = non_empty_string(map.get("defaultModel"));
    if let Some(mcp) = map.get("defaultEnableMcp").and_then(Value::as_bool) {
        ws.default_enable_mcp = mcp;
    }
    if let Some(backups) = map.get("defaultBackupsEnabled").and_then(Value::as_bool) {
        ws.default_backups_enabled = backups;
    }
    Some(ws)
}

fn non_empty_env(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn safe_id_from_value(value: Option<&Value>) -> Option<String> {
    let candidate = non_empty_string(value)?;
    assert_safe_id(&candidate, "id").ok()?;
    Some(candidate)
}

fn parse_timestamp_value(value: Option<&Value>) -> Option<(String, i64)> {
    match value {
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return None;
            }
            let dt = DateTime::parse_from_rfc3339(trimmed).ok()?;
            let ms = dt.timestamp_millis();
            Some((
                dt.with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
                ms,
            ))
        }
        Some(Value::Number(num)) => {
            let ms = num.as_i64().or_else(|| num.as_f64().map(|f| f as i64))?;
            Some((epoch_ms_to_iso(ms), ms))
        }
        _ => None,
    }
}

fn epoch_ms_to_iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn packaged_build_rejects_user_data_override() {
        let mut env = HashMap::new();
        env.insert(
            DESKTOP_USER_DATA_DIR_ENV.to_string(),
            "/tmp/custom-cowork".to_string(),
        );
        let err = resolve_user_data_dir(true, &env).unwrap_err();
        assert!(err.to_string().contains("packaged"));
    }

    #[test]
    fn dev_build_honors_user_data_override() {
        let mut env = HashMap::new();
        env.insert(
            DESKTOP_USER_DATA_DIR_ENV.to_string(),
            "/tmp/dev-cowork-profile".to_string(),
        );
        let resolved = resolve_user_data_dir(false, &env).unwrap();
        assert_eq!(resolved, PathBuf::from("/tmp/dev-cowork-profile"));
    }

    #[test]
    fn legacy_migration_copies_state_transcripts_and_server_log_once() {
        let tmp = tempdir().unwrap();
        let legacy = tmp.path().join("desktop");
        let current = tmp.path().join("Cowork");
        fs::create_dir_all(legacy.join("transcripts")).unwrap();
        fs::create_dir_all(legacy.join("logs")).unwrap();
        fs::write(legacy.join("state.json"), r#"{"version":2}"#).unwrap();
        fs::write(legacy.join("transcripts").join("t1.jsonl"), "{}\n").unwrap();
        fs::write(legacy.join("logs").join("server.log"), "ok\n").unwrap();

        let service = PersistenceService::new(current.clone(), Some(legacy), false, None);
        let state = service.load_state_value().unwrap();
        assert_eq!(state["version"], 2);
        assert!(current.join("state.json").exists());
        assert!(current.join("transcripts").join("t1.jsonl").exists());
        assert!(current.join("logs").join("server.log").exists());
    }

    #[test]
    fn corrupt_state_json_is_preserved_and_reset() {
        let tmp = tempdir().unwrap();
        let user_data = tmp.path().join("Cowork");
        fs::create_dir_all(&user_data).unwrap();
        fs::write(user_data.join("state.json"), "{corrupt-json").unwrap();

        let service = PersistenceService::new(user_data.clone(), None, true, None);
        let loaded = service.load_state_value().unwrap();
        assert_eq!(loaded["version"], 2);
        assert_eq!(loaded["workspaces"], json!([]));

        let backups: Vec<_> = fs::read_dir(&user_data)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("state.json.corrupt-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
    }

    #[test]
    fn sanitizes_workspaces_orphan_threads_and_preserves_server_fields_on_core_save() {
        let tmp = tempdir().unwrap();
        let user_data = tmp.path().join("Cowork");
        let proj = tmp.path().join("project-a");
        let missing_file = tmp.path().join("not-a-dir.txt");
        let chats_root = tmp.path().join("chats");
        fs::create_dir_all(&proj).unwrap();
        fs::write(&missing_file, "file").unwrap();
        fs::create_dir_all(&chats_root).unwrap();

        let initial = json!({
            "version": 2,
            "workspaces": [
                {
                    "id": "ws-valid",
                    "name": "Project A",
                    "path": proj,
                    "workspaceKind": "project",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastOpenedAt": "2026-01-02T00:00:00.000Z",
                    "defaultProvider": "openai",
                    "defaultModel": "gpt-5",
                    "defaultWorkflowMaxConcurrentAgents": 99,
                    "yolo": true
                },
                {
                    "id": "ws-file",
                    "name": "Bad File Root",
                    "path": missing_file,
                    "workspaceKind": "project",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastOpenedAt": "2026-01-02T00:00:00.000Z"
                },
                {
                    "id": "ws-bad-oneoff",
                    "name": "Escaped OneOff",
                    "path": tmp.path().join("outside-chats"),
                    "workspaceKind": "oneOffChat",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastOpenedAt": "2026-01-02T00:00:00.000Z"
                }
            ],
            "threads": [
                {
                    "id": "th-ok",
                    "workspaceId": "ws-valid",
                    "title": "Valid",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastMessageAt": "2026-01-02T00:00:00.000Z"
                },
                {
                    "id": "th-orphan",
                    "workspaceId": "ws-file",
                    "title": "Orphan",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastMessageAt": "2026-01-02T00:00:00.000Z"
                }
            ],
            "activeWorkspaceId": "ws-valid",
            "creationDrafts": { "research": { "prompt": "keep me" } }
        });

        let service = PersistenceService::new(user_data, None, true, None)
            .with_one_off_chats_root(chats_root);
        let saved = service.save_state_value(initial).unwrap();
        assert_eq!(saved["workspaces"].as_array().unwrap().len(), 1);
        assert_eq!(
            saved["workspaces"][0]["defaultWorkflowMaxConcurrentAgents"],
            16
        );
        assert_eq!(saved["threads"].as_array().unwrap().len(), 1);
        assert_eq!(saved["threads"][0]["id"], "th-ok");

        let mut core = core_state_from_document(&saved);
        core.workspaces[0].name = "Project A Renamed".to_string();
        let after_core_save = service.merge_and_save_core_snapshot(&core).unwrap();
        assert_eq!(
            after_core_save["workspaces"][0]["name"],
            "Project A Renamed"
        );
        // Server-owned workspace fields & threads & drafts survived core save.
        assert_eq!(
            after_core_save["workspaces"][0]["defaultProvider"],
            "openai"
        );
        assert_eq!(after_core_save["workspaces"][0]["yolo"], true);
        assert_eq!(after_core_save["threads"][0]["id"], "th-ok");
        assert_eq!(
            after_core_save["creationDrafts"]["research"]["prompt"],
            "keep me"
        );
    }

    #[test]
    fn transcript_roundtrip_and_traversal_rejection() {
        let tmp = tempdir().unwrap();
        let service = PersistenceService::new(tmp.path().join("Cowork"), None, true, None);
        assert!(
            service
                .read_transcript("missing-thread")
                .unwrap()
                .is_empty()
        );

        service
            .append_transcript_event(TranscriptEvent {
                ts: "2026-01-01T00:00:00.000Z".to_string(),
                thread_id: "thread_1".to_string(),
                direction: TranscriptDirection::Client,
                payload: json!({ "text": "hello" }),
                extra: Map::new(),
            })
            .unwrap();

        let events = service.read_transcript("thread_1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["text"], "hello");

        assert!(service.read_transcript("../escape").is_err());
        service.delete_transcript("thread_1").unwrap();
        assert!(service.read_transcript("thread_1").unwrap().is_empty());
    }

    #[test]
    fn accepts_valid_one_off_chat_and_does_not_misclassify_ancestor_workspace() {
        let tmp = tempdir().unwrap();
        let user_data = tmp.path().join("Cowork");
        let chats_root = tmp.path().join("chats");
        let one_off_dir = chats_root.join("chat-42");
        let ancestor_project = tmp.path().to_path_buf();

        let service = PersistenceService::new(user_data, None, true, None)
            .with_one_off_chats_root(chats_root.clone());

        let doc = json!({
            "version": 2,
            "workspaces": [
                {
                    "id": "ws-oneoff",
                    "name": "Quick Chat",
                    "path": one_off_dir,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastOpenedAt": "2026-01-02T00:00:00.000Z"
                },
                {
                    "id": "ws-ancestor",
                    "name": "Ancestor Dir",
                    "path": ancestor_project,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastOpenedAt": "2026-01-02T00:00:00.000Z"
                }
            ]
        });

        let saved = service.save_state_value(doc).unwrap();
        let workspaces = saved["workspaces"].as_array().unwrap();
        assert_eq!(workspaces.len(), 2);

        let oneoff = workspaces.iter().find(|w| w["id"] == "ws-oneoff").unwrap();
        assert_eq!(oneoff["workspaceKind"], "oneOffChat");

        let ancestor = workspaces
            .iter()
            .find(|w| w["id"] == "ws-ancestor")
            .unwrap();
        assert_eq!(ancestor["workspaceKind"], "project");
    }
}
