//! Desktop state, transcript, and legacy user-data migration persistence.
//!
//! Replaces `apps/desktop/electron/services/{persistence.ts, userDataOverride.ts}` while
//! keeping disk compatibility with `cowork-server`'s `<userData>/state.json` normalization.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger};
use super::security::{WorkspaceRootsController, is_temporarily_unavailable_fs_error};
use super::validation::{assert_direction, assert_safe_id, assert_within_transcripts_dir};
use crate::actions::SidebarSectionKey;
use crate::state::{
    ComposerDraft, DesktopSettings, OnboardingState, PersistedDesktopState,
    PrivacyTelemetrySettings, ReasoningEffortValue, TaskCreationDraftState, ThreadBusyPolicy,
    ThreadRecord, ThreadStatus, WorkspaceRecord,
};
use crate::theme::{AccentPalette, ThemePreference};
use cowork_protocol::{TurnAttachmentInputPart, TurnReference};

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

pub const TRANSCRIPT_BATCH_DEBOUNCE: Duration = Duration::from_millis(200);

#[derive(Default)]
struct TranscriptWriteBufferInner {
    pending: Vec<TranscriptEvent>,
    flush_scheduled: bool,
}

/// Debounced 200ms batch writer for local JSONL compatibility transcripts.
#[derive(Clone)]
pub struct TranscriptWriteBuffer {
    persistence: Arc<PersistenceService>,
    logger: Option<Arc<LocalLogger>>,
    inner: Arc<Mutex<TranscriptWriteBufferInner>>,
}

impl TranscriptWriteBuffer {
    pub fn new(persistence: Arc<PersistenceService>, logger: Option<Arc<LocalLogger>>) -> Self {
        Self {
            persistence,
            logger,
            inner: Arc::new(Mutex::new(TranscriptWriteBufferInner::default())),
        }
    }

    /// Queues `event` and schedules a debounced 200ms flush on the active Tokio runtime, if any.
    /// Contiguous streaming delta events for the same `(thread_id, method, itemId)` are coalesced
    /// in place so high-rate token streams do not flood disk with one JSONL line per token.
    pub fn enqueue(&self, event: TranscriptEvent) {
        let should_schedule = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let coalesced = guard
                .pending
                .last_mut()
                .is_some_and(|prev| try_coalesce_transcript_delta(prev, &event));
            if !coalesced {
                guard.pending.push(event);
            }
            if guard.flush_scheduled {
                false
            } else if tokio::runtime::Handle::try_current().is_ok() {
                guard.flush_scheduled = true;
                true
            } else {
                false
            }
        };

        if should_schedule {
            let buffer = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(TRANSCRIPT_BATCH_DEBOUNCE).await;
                let _ = tokio::task::spawn_blocking(move || {
                    let _ = buffer.flush();
                })
                .await;
            });
        }
    }

    pub fn pending_len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .len()
    }

    /// Drops any queued (unflushed) transcript events belonging to `thread_ids` so a pending
    /// debounced flush cannot recreate a transcript file after deletion.
    pub fn discard_threads(&self, thread_ids: &[String]) {
        if thread_ids.is_empty() {
            return;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .pending
            .retain(|ev| !thread_ids.iter().any(|id| id == &ev.thread_id));
    }

    /// Flushes all currently queued transcript events to `<userData>/transcripts/<threadId>.jsonl`.
    pub fn flush(&self) -> Result<usize, PersistenceError> {
        let batch = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.flush_scheduled = false;
            std::mem::take(&mut guard.pending)
        };
        let count = batch.len();
        if count == 0 {
            return Ok(0);
        }
        if let Err(err) = self.persistence.append_transcript_batch(batch) {
            if let Some(logger) = &self.logger {
                let meta = json!({
                    "count": count,
                    "error": err.to_string(),
                });
                logger.write(
                    LocalLogFileName::DesktopMain,
                    LocalLogLevel::Warn,
                    "persistence",
                    "failed to flush buffered transcript events",
                    Some(&meta),
                );
            }
            return Err(err);
        }
        Ok(count)
    }
}

fn try_coalesce_transcript_delta(prev: &mut TranscriptEvent, next: &TranscriptEvent) -> bool {
    if prev.thread_id != next.thread_id
        || prev.direction != TranscriptDirection::Server
        || next.direction != TranscriptDirection::Server
        || !prev.extra.is_empty()
        || !next.extra.is_empty()
    {
        return false;
    }
    let Some(method) = next.payload.get("method").and_then(Value::as_str) else {
        return false;
    };
    if !matches!(method, "item/agentMessage/delta" | "item/reasoning/delta") {
        return false;
    }
    if prev.payload.get("method").and_then(Value::as_str) != Some(method) {
        return false;
    }
    let Some(next_params) = next.payload.get("params").and_then(Value::as_object) else {
        return false;
    };
    let Some(next_item_id) = next_params.get("itemId").and_then(Value::as_str) else {
        return false;
    };
    let Some(next_delta) = next_params.get("delta").and_then(Value::as_str) else {
        return false;
    };
    let Some(prev_params) = prev
        .payload
        .get_mut("params")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    if prev_params.get("itemId").and_then(Value::as_str) != Some(next_item_id) {
        return false;
    }
    let Some(Value::String(prev_delta)) = prev_params.get_mut("delta") else {
        return false;
    };
    prev_delta.push_str(next_delta);
    if let Some(seq) = next_params.get("seq") {
        prev_params.insert("seq".to_string(), seq.clone());
    }
    prev.ts = next.ts.clone();
    true
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
    /// keeping task-scoped threads and server-owned fields (`providerState`, per-workspace
    /// routing, `creationDrafts`) intact while round-tripping `composerDrafts`, then writes
    /// atomically with `0o600`.
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

    /// Reads and chronologically merges local transcript JSONL events across `thread_id`
    /// and any fallback `candidate_ids` (such as `sessionId` or `legacyTranscriptId`).
    pub fn read_transcript_with_candidates(
        &self,
        thread_id: &str,
        candidate_ids: &[String],
    ) -> Result<Vec<TranscriptEvent>, PersistenceError> {
        let primary = thread_id.trim();
        assert_safe_id(primary, "threadId")?;

        let mut seen = HashSet::new();
        let mut ordered_ids = Vec::with_capacity(1 + candidate_ids.len());
        seen.insert(primary.to_string());
        ordered_ids.push(primary.to_string());

        for candidate in candidate_ids {
            let trimmed = candidate.trim();
            if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                ordered_ids.push(trimmed.to_string());
            }
        }

        let mut combined = Vec::new();
        let mut successful_reads = 0usize;
        let mut first_error: Option<PersistenceError> = None;

        for id in &ordered_ids {
            match self.read_transcript(id) {
                Ok(mut events) => {
                    successful_reads += 1;
                    combined.append(&mut events);
                }
                Err(err) => {
                    if first_error.is_none() {
                        first_error = Some(err);
                    }
                }
            }
        }

        if successful_reads == 0
            && let Some(err) = first_error
        {
            return Err(err);
        }

        combined.sort_by(|left, right| left.ts.cmp(&right.ts));
        Ok(combined)
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

    fn legacy_appearance_theme_fallback(&self) -> Option<ThemePreference> {
        let prefs = super::appearance::AppearancePreferences::new(&self.user_data_dir);
        prefs
            .file_path()
            .exists()
            .then(|| prefs.load_theme_preference())
    }

    fn read_state_value_locked(&self) -> Result<Value, PersistenceError> {
        let state_path = self.state_file_path();
        let raw = match fs::read_to_string(&state_path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                return Ok(default_state_document_with_theme(
                    self.legacy_appearance_theme_fallback(),
                ));
            }
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
                return Ok(default_state_document_with_theme(
                    self.legacy_appearance_theme_fallback(),
                ));
            }
        };

        if !parsed.is_object() {
            self.preserve_corrupt_state_file();
            return Ok(default_state_document_with_theme(
                self.legacy_appearance_theme_fallback(),
            ));
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

        let mut seen_sections = HashSet::new();
        let filtered_sections: Vec<Value> = obj
            .get("collapsedSidebarSections")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| serde_json::from_value::<SidebarSectionKey>(v.clone()).ok())
                    .filter(|section| seen_sections.insert(*section))
                    .filter_map(|section| serde_json::to_value(section).ok())
                    .collect()
            })
            .unwrap_or_default();
        obj.insert(
            "collapsedSidebarSections".to_string(),
            Value::Array(filtered_sections),
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

        let has_valid_theme = obj
            .get("desktopSettings")
            .and_then(Value::as_object)
            .and_then(|ds| ds.get("theme"))
            .and_then(|v| serde_json::from_value::<ThemePreference>(v.clone()).ok())
            .is_some();
        let fallback_theme = if has_valid_theme {
            None
        } else {
            self.legacy_appearance_theme_fallback()
        };
        let desktop_settings =
            sanitize_desktop_settings(obj.get("desktopSettings"), fallback_theme);
        obj.insert("desktopSettings".to_string(), desktop_settings);

        // One-time upgrade bridge: Electron stored cloud-sync consent in `cloudSync.enabled`.
        // Import it only when the newer privacy setting is absent; once the user has explicitly
        // saved `cloudSyncEnabled` (including `false`), that newer consent decision wins.
        let mut privacy_source = obj
            .get("privacyTelemetrySettings")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if !privacy_source.contains_key("cloudSyncEnabled")
            && obj
                .get("cloudSync")
                .and_then(|v| v.get("enabled"))
                .and_then(Value::as_bool)
                == Some(true)
        {
            privacy_source.insert("cloudSyncEnabled".to_string(), Value::Bool(true));
        }
        let privacy = sanitize_privacy_telemetry_settings(Some(&Value::Object(privacy_source)));
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

fn bounded_draft_string(value: Option<&Value>, max_chars: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .chars()
        .take(max_chars)
        .collect()
}

fn task_creation_draft_from_value(value: Option<&Value>) -> TaskCreationDraftState {
    TaskCreationDraftState {
        workspace_id: bounded_draft_string(value.and_then(|v| v.get("workspaceId")), 200),
        title: bounded_draft_string(value.and_then(|v| v.get("title")), 200),
        objective: bounded_draft_string(value.and_then(|v| v.get("objective")), 20_000),
        idempotency_key: bounded_draft_string(value.and_then(|v| v.get("idempotencyKey")), 200),
    }
}

fn task_creation_draft_to_value(draft: &TaskCreationDraftState) -> Value {
    json!({
        "workspaceId": draft.workspace_id,
        "title": draft.title,
        "objective": draft.objective,
        "idempotencyKey": draft.idempotency_key,
    })
}

/// Converts a normalized `state.json` document into `crate::state::PersistedDesktopState`.
pub fn core_state_from_document(doc: &Value) -> PersistedDesktopState {
    let mut out = PersistedDesktopState::default();
    let Some(obj) = doc.as_object() else {
        return out;
    };

    out.settings = core_desktop_settings_from_document(obj);
    out.task_creation_draft = task_creation_draft_from_value(
        obj.get("creationDrafts")
            .and_then(|drafts| drafts.get("task")),
    );

    if let Some(arr) = obj.get("workspaces").and_then(Value::as_array) {
        out.workspaces = arr.iter().filter_map(core_workspace_from_value).collect();
    }

    let workspace_ids: HashSet<&str> = out.workspaces.iter().map(|ws| ws.id.as_str()).collect();
    if let Some(arr) = obj.get("threads").and_then(Value::as_array) {
        let mut seen_threads = HashSet::new();
        out.threads = arr
            .iter()
            .filter_map(core_thread_from_value)
            .filter(|th| {
                !th.draft
                    && th.source_task_id.is_none()
                    && workspace_ids.contains(th.workspace_id.as_str())
                    && seen_threads.insert(th.id.clone())
            })
            .collect();
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

    if let Some(arr) = obj
        .get("collapsedSidebarSections")
        .and_then(Value::as_array)
    {
        let mut seen = HashSet::new();
        out.collapsed_sidebar_sections = arr
            .iter()
            .filter_map(|v| serde_json::from_value::<SidebarSectionKey>(v.clone()).ok())
            .filter(|section| seen.insert(*section))
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

    if let Some(onboarding_val) = obj.get("onboarding") {
        out.onboarding = core_onboarding_from_value(onboarding_val);
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

    out.product_analytics = obj
        .get("productAnalytics")
        .filter(|v| v.is_object())
        .cloned();

    out.composer_drafts = core_composer_drafts_from_document(
        obj,
        &out.threads,
        &out.workspaces,
        out.active_workspace_id.as_deref(),
    );

    out
}

/// Normalizes a workspace path into a comparison key so duplicate entries across trailing
/// slashes or symlinked temp roots (e.g. `/tmp` vs `/private/tmp`) are recognized cleanly.
pub(crate) fn normalize_workspace_path_key(raw: &str) -> String {
    let trimmed = raw.trim();
    let candidate = std::fs::canonicalize(trimmed)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| trimmed.to_owned());
    let mut normalized = candidate.replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if cfg!(windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
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

    let existing_workspaces_array = doc
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let existing_by_id: HashMap<String, Map<String, Value>> = existing_workspaces_array
        .iter()
        .filter_map(|item| {
            let map = item.as_object()?;
            let id = map.get("id").and_then(Value::as_str)?.to_string();
            Some((id, map.clone()))
        })
        .collect();

    let mut merged_workspaces: Vec<Value> = snapshot
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
            map.insert("yolo".to_string(), json!(ws.yolo));
            map.insert("defaultEnableMcp".to_string(), json!(ws.default_enable_mcp));
            map.insert(
                "defaultBackupsEnabled".to_string(),
                json!(ws.default_backups_enabled),
            );
            set_or_remove_trimmed_str(&mut map, "defaultProvider", ws.default_provider.as_deref());
            set_or_remove_trimmed_str(&mut map, "defaultModel", ws.default_model.as_deref());
            set_or_remove_trimmed_str(
                &mut map,
                "defaultPreferredChildModel",
                ws.default_preferred_child_model.as_deref(),
            );
            map.remove("defaultSubAgentModel");
            set_or_remove_trimmed_str(
                &mut map,
                "defaultChildModelRoutingMode",
                ws.default_child_model_routing_mode.as_deref(),
            );
            set_or_remove_trimmed_str(
                &mut map,
                "defaultPreferredChildModelRef",
                ws.default_preferred_child_model_ref.as_deref(),
            );
            let allowed_refs: Vec<Value> = ws
                .default_allowed_child_model_refs
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| Value::String(s.to_string()))
                .collect();
            if allowed_refs.is_empty() {
                map.remove("defaultAllowedChildModelRefs");
            } else {
                map.insert(
                    "defaultAllowedChildModelRefs".to_string(),
                    Value::Array(allowed_refs),
                );
            }
            set_or_remove_json_object(&mut map, "providerOptions", ws.provider_options.as_ref());
            if let Some(ref user_name) = ws.user_name {
                map.insert("userName".to_string(), Value::String(user_name.clone()));
            } else {
                map.remove("userName");
            }
            set_or_remove_json_object(&mut map, "userProfile", ws.user_profile.as_ref());
            sync_workspace_defaults_to_doc(&mut map, &ws.defaults);
            map.entry("wsProtocol".to_string())
                .or_insert_with(|| json!("jsonrpc"));
            Value::Object(map)
        })
        .collect();

    let mut merged_workspace_ids: HashSet<String> =
        snapshot.workspaces.iter().map(|ws| ws.id.clone()).collect();
    let mut merged_workspace_paths: HashSet<String> = snapshot
        .workspaces
        .iter()
        .map(|ws| normalize_workspace_path_key(&ws.path))
        .collect();
    let mut preserved_workspace_ids: HashSet<String> = HashSet::new();
    let mut preserved_workspace_order: Vec<String> = Vec::new();

    if snapshot.preserve_unlisted_workspaces {
        let removed_ids: HashSet<&str> = snapshot
            .removed_workspace_ids
            .iter()
            .map(String::as_str)
            .collect();
        for existing in existing_workspaces_array {
            let Some(map) = existing.as_object() else {
                continue;
            };
            let Some(id) = safe_id_from_value(map.get("id")) else {
                continue;
            };
            let Some(path) = map.get("path").and_then(Value::as_str).map(str::trim) else {
                continue;
            };
            if path.is_empty() || removed_ids.contains(id.as_str()) {
                continue;
            }
            let path_key = normalize_workspace_path_key(path);
            if merged_workspace_ids.contains(&id) || merged_workspace_paths.contains(&path_key) {
                continue;
            }
            merged_workspace_ids.insert(id.clone());
            merged_workspace_paths.insert(path_key);
            preserved_workspace_ids.insert(id.clone());
            preserved_workspace_order.push(id);
            merged_workspaces.push(Value::Object(map.clone()));
        }
    }

    doc.insert("workspaces".to_string(), Value::Array(merged_workspaces));

    let snapshot_workspace_ids: HashSet<&str> = snapshot
        .workspaces
        .iter()
        .map(|ws| ws.id.as_str())
        .collect();
    let existing_threads_array = doc
        .get("threads")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let existing_threads_by_id: HashMap<String, Map<String, Value>> = existing_threads_array
        .iter()
        .filter_map(|item| {
            let map = item.as_object()?;
            let id = safe_id_from_value(map.get("id"))?;
            Some((id, map.clone()))
        })
        .collect();

    let mut seen_thread_ids = HashSet::new();
    let mut merged_threads: Vec<Value> = snapshot
        .threads
        .iter()
        .filter(|th| !th.draft && th.source_task_id.is_none())
        .filter(|th| {
            assert_safe_id(&th.id, "threadId").is_ok()
                && assert_safe_id(&th.workspace_id, "workspaceId").is_ok()
                && snapshot_workspace_ids.contains(th.workspace_id.as_str())
                && seen_thread_ids.insert(th.id.clone())
        })
        .map(|th| {
            let mut map = existing_threads_by_id
                .get(&th.id)
                .cloned()
                .unwrap_or_default();
            let title = {
                let trimmed = th.title.trim();
                if trimmed.is_empty() {
                    "New Chat"
                } else {
                    trimmed
                }
            };
            map.insert("id".to_string(), json!(th.id));
            map.insert("workspaceId".to_string(), json!(th.workspace_id));
            map.insert("title".to_string(), json!(title));
            map.insert(
                "status".to_string(),
                serde_json::to_value(th.status).unwrap_or_else(|_| json!("active")),
            );
            map.insert(
                "sessionId".to_string(),
                th.session_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map_or(Value::Null, |s| json!(s)),
            );
            map.insert("pinned".to_string(), json!(th.pinned));
            map.insert("archived".to_string(), json!(th.archived));
            if th.archived {
                if let Some(archived_at) = th.archived_at {
                    map.insert(
                        "archivedAt".to_string(),
                        json!(epoch_ms_to_iso(archived_at)),
                    );
                } else {
                    map.entry("archivedAt".to_string())
                        .or_insert_with(|| json!(epoch_ms_to_iso(th.updated_at)));
                }
            } else {
                map.remove("archivedAt");
            }
            map.remove("draft");
            map.remove("updatedAt");
            map.insert(
                "createdAt".to_string(),
                json!(epoch_ms_to_iso(th.created_at)),
            );
            map.insert(
                "lastMessageAt".to_string(),
                json!(epoch_ms_to_iso(th.updated_at)),
            );
            map.insert("lastEventSeq".to_string(), json!(th.last_event_seq));
            map.entry("messageCount".to_string())
                .or_insert_with(|| json!(0));
            set_or_remove_trimmed_str(&mut map, "provider", th.provider.as_deref());
            if th.provider.is_none() {
                map.remove("modelProvider");
            }
            set_or_remove_trimmed_str(&mut map, "model", th.model.as_deref());
            set_or_remove_trimmed_str(&mut map, "reasoningEffort", th.reasoning_effort.as_deref());
            set_or_remove_trimmed_str(&mut map, "preview", th.preview.as_deref());
            set_or_remove_trimmed_str(
                &mut map,
                "legacyTranscriptId",
                th.legacy_transcript_id.as_deref(),
            );
            Value::Object(map)
        })
        .collect();

    // Preserve Electron/server-owned task threads still anchored to an existing workspace,
    // as well as threads belonging to server-added workspaces preserved above.
    for existing in existing_threads_array {
        let Some(map) = existing.as_object() else {
            continue;
        };
        let Some(id) = safe_id_from_value(map.get("id")) else {
            continue;
        };
        let Some(ws_id) = safe_id_from_value(map.get("workspaceId")) else {
            continue;
        };
        let is_task_thread =
            safe_id_from_value(map.get("taskId").or_else(|| map.get("sourceTaskId"))).is_some();
        let preserve_for_unlisted_workspace = preserved_workspace_ids.contains(&ws_id)
            && map.get("draft") != Some(&Value::Bool(true));
        if ((is_task_thread && merged_workspace_ids.contains(&ws_id))
            || preserve_for_unlisted_workspace)
            && seen_thread_ids.insert(id)
        {
            merged_threads.push(Value::Object(map.clone()));
        }
    }
    doc.insert("threads".to_string(), Value::Array(merged_threads));
    let mut merged_order: Vec<Value> = snapshot
        .workspace_order
        .iter()
        .map(|id| Value::String(id.clone()))
        .collect();
    for id in preserved_workspace_order {
        if !snapshot
            .workspace_order
            .iter()
            .any(|existing| existing == &id)
        {
            merged_order.push(Value::String(id));
        }
    }
    doc.insert("workspaceOrder".to_string(), Value::Array(merged_order));
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
    let mut seen_sections = HashSet::new();
    let collapsed_sections: Vec<Value> = snapshot
        .collapsed_sidebar_sections
        .iter()
        .filter(|section| seen_sections.insert(**section))
        .filter_map(|section| serde_json::to_value(section).ok())
        .collect();
    doc.insert(
        "collapsedSidebarSections".to_string(),
        Value::Array(collapsed_sections),
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
        "accentPalette".to_string(),
        Value::String(snapshot.settings.accent_palette.id().to_string()),
    );
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
        "showMenuBar".to_string(),
        json!(snapshot.settings.show_menu_bar),
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
    let onboarding_doc = onboarding_document_value(&snapshot.onboarding, doc.get("onboarding"));
    doc.insert("onboarding".to_string(), onboarding_doc);

    let flags: Map<String, Value> = snapshot
        .feature_flags
        .iter()
        .map(|(k, v)| (k.clone(), Value::Bool(*v)))
        .collect();
    doc.insert(
        "desktopFeatureFlagOverrides".to_string(),
        Value::Object(flags),
    );

    if let Some(pa) = snapshot
        .product_analytics
        .as_ref()
        .filter(|v| v.is_object())
    {
        doc.insert("productAnalytics".to_string(), pa.clone());
    }

    sync_composer_drafts_into_document(&mut doc, snapshot);

    let mut creation_drafts = doc
        .get("creationDrafts")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    creation_drafts.insert(
        "task".to_string(),
        task_creation_draft_to_value(&snapshot.task_creation_draft),
    );
    doc.insert("creationDrafts".to_string(), Value::Object(creation_drafts));

    Value::Object(doc)
}

fn is_empty_composer_draft(draft: &ComposerDraft) -> bool {
    draft.text.is_empty()
        && draft.attachments.is_empty()
        && draft.references.is_empty()
        && draft.provider.is_none()
        && draft.model.is_none()
        && draft.reasoning_effort.is_none()
}

fn parse_persisted_reasoning_effort(raw: Option<&str>) -> Option<ReasoningEffortValue> {
    match raw?.trim().to_ascii_lowercase().as_str() {
        "none" | "off" => Some(ReasoningEffortValue::None),
        "minimal" => Some(ReasoningEffortValue::Minimal),
        "low" => Some(ReasoningEffortValue::Low),
        "medium" => Some(ReasoningEffortValue::Medium),
        "high" => Some(ReasoningEffortValue::High),
        "xhigh" | "extra high" => Some(ReasoningEffortValue::Xhigh),
        "max" => Some(ReasoningEffortValue::Max),
        "dynamic" => Some(ReasoningEffortValue::Dynamic),
        _ => None,
    }
}

fn parse_persisted_composer_attachment(value: &Value) -> Option<TurnAttachmentInputPart> {
    if let Ok(parsed) = serde_json::from_value::<TurnAttachmentInputPart>(value.clone()) {
        return Some(parsed);
    }
    let map = value.as_object()?;
    let filename = non_empty_string(map.get("filename"))?;
    let mime_type = non_empty_string(map.get("mimeType"))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    if let Some(content_base64) = non_empty_string(map.get("contentBase64")) {
        return Some(TurnAttachmentInputPart::InlineFile {
            filename,
            content_base64,
            mime_type,
        });
    }
    if let Some(path) = non_empty_string(map.get("path")) {
        return Some(TurnAttachmentInputPart::UploadedFile {
            filename,
            path,
            mime_type,
        });
    }
    None
}

fn core_composer_draft_from_value(value: &Value) -> Option<(ComposerDraft, i64)> {
    let map = value.as_object()?;
    let text = map
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let provider = non_empty_string(map.get("provider"));
    let model = non_empty_string(map.get("model"));
    let reasoning_effort =
        parse_persisted_reasoning_effort(map.get("reasoningEffort").and_then(Value::as_str));
    let attachments: Vec<TurnAttachmentInputPart> = map
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_persisted_composer_attachment)
        .collect();
    let references: Vec<TurnReference> = map
        .get("references")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| serde_json::from_value::<TurnReference>(v.clone()).ok())
        .collect();
    let busy_policy = map
        .get("busyPolicy")
        .and_then(|v| serde_json::from_value::<ThreadBusyPolicy>(v.clone()).ok())
        .unwrap_or_default();
    let draft = ComposerDraft {
        text,
        provider,
        model,
        reasoning_effort,
        attachments,
        references,
        busy_policy,
        submission_error: None,
    };
    if is_empty_composer_draft(&draft) {
        return None;
    }
    let updated_ms = parse_timestamp_value(map.get("updatedAt"))
        .map(|(_, ms)| ms)
        .unwrap_or(0);
    Some((draft, updated_ms))
}

fn active_new_chat_draft_doc_key(
    workspaces: &[WorkspaceRecord],
    active_workspace_id: Option<&str>,
) -> String {
    if let Some(ws_id) = active_workspace_id
        && let Some(ws) = workspaces.iter().find(|w| w.id == ws_id && !w.archived)
        && !ws.one_off_chat
    {
        return format!("new:project:{ws_id}");
    }
    "new:oneOff".to_string()
}

fn core_composer_drafts_from_document(
    doc: &Map<String, Value>,
    threads: &[ThreadRecord],
    workspaces: &[WorkspaceRecord],
    active_workspace_id: Option<&str>,
) -> HashMap<String, ComposerDraft> {
    let mut out = HashMap::new();
    let Some(raw_drafts) = doc.get("composerDrafts").and_then(Value::as_object) else {
        return out;
    };
    let valid_threads: HashSet<&str> = threads.iter().map(|t| t.id.as_str()).collect();
    let valid_project_workspaces: HashSet<&str> = workspaces
        .iter()
        .filter(|w| !w.one_off_chat && !w.archived)
        .map(|w| w.id.as_str())
        .collect();
    let mut legacy_unscoped_new: Option<ComposerDraft> = None;

    for (raw_key, val) in raw_drafts {
        let Some((draft, _updated_ms)) = core_composer_draft_from_value(val) else {
            continue;
        };
        if let Some(tid) = raw_key.strip_prefix("thread:") {
            if valid_threads.contains(tid) {
                out.insert(tid.to_string(), draft);
            }
        } else if let Some(ws_id) = raw_key.strip_prefix("new:project:") {
            if valid_project_workspaces.contains(ws_id) {
                out.insert(raw_key.clone(), draft);
            }
        } else if raw_key == "new:oneOff" {
            out.insert("new:oneOff".to_string(), draft);
        } else if raw_key == "__new__" {
            legacy_unscoped_new = Some(draft);
        } else if valid_threads.contains(raw_key.as_str()) {
            out.entry(raw_key.clone()).or_insert(draft);
        }
    }

    if let Some(draft) = legacy_unscoped_new {
        let fallback_key = active_new_chat_draft_doc_key(workspaces, active_workspace_id);
        out.entry(fallback_key).or_insert(draft);
    }

    out
}

fn serialize_composer_draft_value(draft: &ComposerDraft, existing: Option<&Value>) -> Value {
    let mut map = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    map.insert("text".to_string(), json!(draft.text));
    match draft.provider.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            map.insert("provider".to_string(), json!(p));
        }
        _ => {
            map.insert("provider".to_string(), Value::Null);
        }
    }
    match draft.model.as_deref() {
        Some(m) if !m.trim().is_empty() => {
            map.insert("model".to_string(), json!(m));
        }
        _ => {
            map.insert("model".to_string(), Value::Null);
        }
    }
    match draft.reasoning_effort {
        Some(effort) => {
            map.insert("reasoningEffort".to_string(), json!(effort.as_str()));
        }
        None => {
            map.insert("reasoningEffort".to_string(), Value::Null);
        }
    }
    map.insert(
        "attachments".to_string(),
        serde_json::to_value(&draft.attachments).unwrap_or_else(|_| json!([])),
    );
    map.insert(
        "references".to_string(),
        serde_json::to_value(&draft.references).unwrap_or_else(|_| json!([])),
    );
    map.insert(
        "busyPolicy".to_string(),
        serde_json::to_value(draft.busy_policy).unwrap_or_else(|_| json!("steer")),
    );
    map.entry("revision".to_string())
        .or_insert_with(|| json!(1));
    map.entry("generation".to_string())
        .or_insert_with(|| json!(0));
    Value::Object(map)
}

fn sync_composer_drafts_into_document(
    doc: &mut Map<String, Value>,
    snapshot: &PersistedDesktopState,
) {
    let existing_map = doc
        .get("composerDrafts")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let valid_threads: HashSet<&str> = snapshot.threads.iter().map(|t| t.id.as_str()).collect();
    let valid_project_workspaces: HashSet<&str> = snapshot
        .workspaces
        .iter()
        .filter(|w| !w.one_off_chat && !w.archived)
        .map(|w| w.id.as_str())
        .collect();

    let mut next_map = Map::new();
    for (key, draft) in &snapshot.composer_drafts {
        if is_empty_composer_draft(draft) {
            continue;
        }
        if let Some(ws_id) = key.strip_prefix("new:project:") {
            if valid_project_workspaces.contains(ws_id) {
                let serialized = serialize_composer_draft_value(draft, existing_map.get(key));
                next_map.insert(key.clone(), serialized);
            }
        } else if key == "new:oneOff" {
            let serialized = serialize_composer_draft_value(draft, existing_map.get(key));
            next_map.insert(key.clone(), serialized);
        } else if key == "__new__" {
            let fallback_key = active_new_chat_draft_doc_key(
                &snapshot.workspaces,
                snapshot.active_workspace_id.as_deref(),
            );
            if !next_map.contains_key(&fallback_key) {
                let serialized = serialize_composer_draft_value(
                    draft,
                    existing_map
                        .get(&fallback_key)
                        .or_else(|| existing_map.get("__new__")),
                );
                next_map.insert(fallback_key, serialized);
            }
        } else if valid_threads.contains(key.as_str()) {
            let doc_key = format!("thread:{key}");
            let serialized = serialize_composer_draft_value(
                draft,
                existing_map.get(&doc_key).or_else(|| existing_map.get(key)),
            );
            next_map.insert(doc_key, serialized);
        }
    }

    if next_map.is_empty() {
        doc.remove("composerDrafts");
    } else {
        doc.insert("composerDrafts".to_string(), Value::Object(next_map));
    }
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
    default_state_document_with_theme(None)
}

fn default_state_document_with_theme(fallback_theme: Option<ThemePreference>) -> Value {
    json!({
        "version": 2,
        "workspaces": [],
        "threads": [],
        "workspaceOrder": [],
        "collapsedWorkspaceIds": [],
        "collapsedSidebarSections": [],
        "activeWorkspaceId": null,
        "activeThreadId": null,
        "developerMode": false,
        "showHiddenFiles": false,
        "perWorkspaceSettings": false,
        "desktopSettings": sanitize_desktop_settings(None, fallback_theme),
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
        Path::new("appearance.json"),
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
        if let Some(preferred_child_model) = non_empty_string(map.get("defaultPreferredChildModel"))
            .or_else(|| non_empty_string(map.get("defaultSubAgentModel")))
        {
            map.insert(
                "defaultPreferredChildModel".to_string(),
                json!(preferred_child_model),
            );
        } else {
            map.remove("defaultPreferredChildModel");
        }
        map.remove("defaultSubAgentModel");

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
        let Some((last_msg_iso, _)) = parse_timestamp_value(
            map.get("lastMessageAt")
                .or_else(|| map.get("updatedAt"))
                .or_else(|| map.get("createdAt")),
        ) else {
            continue;
        };

        let status = match map.get("status").and_then(Value::as_str).map(str::trim) {
            Some("disconnected") => "disconnected",
            _ => "active",
        };
        let session_id = non_empty_string(map.get("sessionId"));

        map.insert("id".to_string(), json!(id));
        map.insert("workspaceId".to_string(), json!(workspace_id));
        map.insert("title".to_string(), json!(title));
        map.insert("createdAt".to_string(), json!(created_iso));
        map.insert("lastMessageAt".to_string(), json!(last_msg_iso));
        map.insert("status".to_string(), json!(status));
        map.insert(
            "sessionId".to_string(),
            session_id.map_or(Value::Null, Value::String),
        );
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

fn parse_accent_palette_value(raw: Option<&Value>) -> Option<AccentPalette> {
    raw.and_then(Value::as_str).and_then(AccentPalette::parse)
}

fn sanitize_desktop_settings(
    raw: Option<&Value>,
    fallback_theme: Option<ThemePreference>,
) -> Value {
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
    } else if let Ok(serialized) = serde_json::to_value(fallback_theme.unwrap_or(defaults.theme)) {
        map.insert("theme".to_string(), serialized);
    }

    let accent_palette =
        parse_accent_palette_value(map.get("accentPalette")).unwrap_or(defaults.accent_palette);
    map.insert(
        "accentPalette".to_string(),
        Value::String(accent_palette.id().to_string()),
    );

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
    map.insert(
        "showMenuBar".to_string(),
        json!(
            map.get("showMenuBar")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.show_menu_bar)
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

fn sanitize_onboarding_steps(raw: Option<&Value>) -> Vec<String> {
    let Some(arr) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut steps: Vec<String> = arr
        .iter()
        .filter_map(|v| non_empty_string(Some(v)))
        .collect();
    steps.sort();
    steps.dedup();
    steps
}

fn sanitize_onboarding_value(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let status = match map.get("status").and_then(Value::as_str) {
        Some("pending") => "pending",
        Some("dismissed") => "dismissed",
        Some("completed") => "completed",
        _ => {
            if map.get("dismissed").and_then(Value::as_bool) == Some(true) {
                "dismissed"
            } else if map.get("completed").and_then(Value::as_bool) == Some(true) {
                "completed"
            } else {
                "pending"
            }
        }
    };
    let completed_at = non_empty_string(map.get("completedAt"));
    let dismissed_at = non_empty_string(map.get("dismissedAt"));
    let mut out = json!({
        "status": status,
        "completedAt": completed_at,
        "dismissedAt": dismissed_at,
    });
    let steps = sanitize_onboarding_steps(map.get("completedSteps"));
    if !steps.is_empty()
        && let Some(obj) = out.as_object_mut()
    {
        obj.insert("completedSteps".to_string(), json!(steps));
    }
    Some(out)
}

fn core_onboarding_from_value(value: &Value) -> OnboardingState {
    let Some(map) = value.as_object() else {
        return OnboardingState::default();
    };
    let completed_steps: HashSet<String> = sanitize_onboarding_steps(map.get("completedSteps"))
        .into_iter()
        .collect();
    match map.get("status").and_then(Value::as_str) {
        Some("dismissed") => OnboardingState {
            completed: false,
            dismissed: true,
            completed_steps,
        },
        Some("completed") => OnboardingState {
            completed: true,
            dismissed: false,
            completed_steps,
        },
        Some("pending") => OnboardingState {
            completed: false,
            dismissed: false,
            completed_steps,
        },
        _ => OnboardingState {
            completed: map
                .get("completed")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            dismissed: map
                .get("dismissed")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            completed_steps,
        },
    }
}

fn onboarding_document_value(onboarding: &OnboardingState, existing: Option<&Value>) -> Value {
    let prev_obj = existing.and_then(Value::as_object);
    let prev_completed_at = prev_obj.and_then(|m| non_empty_string(m.get("completedAt")));
    let prev_dismissed_at = prev_obj.and_then(|m| non_empty_string(m.get("dismissedAt")));

    let status = if onboarding.dismissed {
        "dismissed"
    } else if onboarding.completed {
        "completed"
    } else {
        "pending"
    };

    let (completed_at, dismissed_at) = match status {
        "completed" => (
            prev_completed_at.or_else(|| Some(epoch_ms_to_iso(now_epoch_ms()))),
            None,
        ),
        "dismissed" => (
            None,
            prev_dismissed_at.or_else(|| Some(epoch_ms_to_iso(now_epoch_ms()))),
        ),
        _ => (None, None),
    };

    let mut out = json!({
        "status": status,
        "completedAt": completed_at,
        "dismissedAt": dismissed_at,
    });
    let mut steps: Vec<String> = onboarding
        .completed_steps
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .collect();
    steps.sort();
    steps.dedup();
    if !steps.is_empty()
        && let Some(obj) = out.as_object_mut()
    {
        obj.insert("completedSteps".to_string(), json!(steps));
    }
    out
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
        if let Some(palette) = parse_accent_palette_value(ds.get("accentPalette")) {
            settings.accent_palette = palette;
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
        if let Some(v) = ds.get("showMenuBar").and_then(Value::as_bool) {
            settings.show_menu_bar = v;
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

const WORKSPACE_DEFAULT_KEY_PAIRS: &[(&str, &str)] = &[
    ("defaultAdvancedMemory", "advancedMemory"),
    ("defaultMemoryGenerationModel", "memoryGenerationModel"),
    ("defaultSkillImprovementEnabled", "skillImprovementEnabled"),
    ("defaultSkillImprovementModel", "skillImprovementModel"),
    ("defaultSkillImprovementScope", "skillImprovementScope"),
    (
        "defaultSkillImprovementExcludedSkills",
        "skillImprovementExcludedSkills",
    ),
    ("defaultToolOutputOverflowChars", "toolOutputOverflowChars"),
    (
        "defaultWorkflowMaxConcurrentAgents",
        "workflowMaxConcurrentAgents",
    ),
    ("defaultToolCalling", "toolCalling"),
    ("lmStudioEnabled", "lmStudioEnabled"),
    ("reasoningEffort", "reasoningEffort"),
];

fn set_or_remove_trimmed_str(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(trimmed) = value.map(str::trim).filter(|s| !s.is_empty()) {
        map.insert(key.to_string(), Value::String(trimmed.to_string()));
    } else {
        map.remove(key);
    }
}

fn set_or_remove_json_object(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(obj) = value.filter(|v| v.is_object()) {
        map.insert(key.to_string(), obj.clone());
    } else {
        map.remove(key);
    }
}

fn allows_explicit_null_default(desktop_key: &str) -> bool {
    desktop_key == "defaultToolOutputOverflowChars"
}

fn find_workspace_default_value<'a>(
    map: &'a Map<String, Value>,
    desktop_key: &str,
    server_key: &str,
) -> Option<&'a Value> {
    let allow_null = allows_explicit_null_default(desktop_key);
    let pick = |key: &str| map.get(key).filter(|v| allow_null || !v.is_null());
    pick(desktop_key).or_else(|| pick(server_key)).or_else(|| {
        (desktop_key == "defaultAdvancedMemory")
            .then(|| pick("advancedMemoryEnabled"))
            .flatten()
    })
}

fn sync_workspace_defaults_to_doc(map: &mut Map<String, Value>, defaults: &Value) {
    let defaults_obj = defaults.as_object();
    for &(desktop_key, server_key) in WORKSPACE_DEFAULT_KEY_PAIRS {
        let val =
            defaults_obj.and_then(|d| find_workspace_default_value(d, desktop_key, server_key));
        if let Some(v) = val {
            map.insert(desktop_key.to_string(), v.clone());
        } else {
            map.remove(desktop_key);
        }
    }
    if let Some(obj) = defaults_obj.filter(|o| !o.is_empty()) {
        map.insert("defaults".to_string(), Value::Object(obj.clone()));
    } else {
        map.remove("defaults");
    }
}

pub(crate) fn core_workspace_from_value(value: &Value) -> Option<WorkspaceRecord> {
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
    ws.default_preferred_child_model = non_empty_string(map.get("defaultPreferredChildModel"))
        .or_else(|| non_empty_string(map.get("defaultSubAgentModel")));
    ws.default_child_model_routing_mode = non_empty_string(map.get("defaultChildModelRoutingMode"));
    ws.default_preferred_child_model_ref =
        non_empty_string(map.get("defaultPreferredChildModelRef"));
    ws.default_allowed_child_model_refs = map
        .get("defaultAllowedChildModelRefs")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| non_empty_string(Some(v)))
                .collect()
        })
        .unwrap_or_default();
    ws.provider_options = map
        .get("providerOptions")
        .filter(|v| v.is_object())
        .cloned();
    ws.user_name = map
        .get("userName")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    ws.user_profile = map.get("userProfile").filter(|v| v.is_object()).cloned();
    if let Some(mcp) = map.get("defaultEnableMcp").and_then(Value::as_bool) {
        ws.default_enable_mcp = mcp;
    }
    if let Some(backups) = map.get("defaultBackupsEnabled").and_then(Value::as_bool) {
        ws.default_backups_enabled = backups;
    }

    let mut defaults_map = map
        .get("defaults")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for &(desktop_key, server_key) in WORKSPACE_DEFAULT_KEY_PAIRS {
        if !defaults_map.contains_key(desktop_key)
            && !defaults_map.contains_key(server_key)
            && let Some(val) = find_workspace_default_value(map, desktop_key, server_key)
        {
            defaults_map.insert(desktop_key.to_string(), val.clone());
        } else if !defaults_map.contains_key(desktop_key)
            && let Some(val) = defaults_map
                .get(server_key)
                .filter(|v| allows_explicit_null_default(desktop_key) || !v.is_null())
                .cloned()
        {
            defaults_map.insert(desktop_key.to_string(), val);
        }
    }
    ws.defaults = Value::Object(defaults_map);
    Some(ws)
}

fn core_thread_from_value(value: &Value) -> Option<ThreadRecord> {
    let map = value.as_object()?;
    let id = safe_id_from_value(map.get("id"))?;
    let workspace_id = safe_id_from_value(map.get("workspaceId"))?;
    let title = non_empty_string(map.get("title"))?;
    let created_at = parse_timestamp_value(map.get("createdAt"))
        .map(|(_, ms)| ms)
        .unwrap_or(0);
    let updated_at = parse_timestamp_value(
        map.get("lastMessageAt")
            .or_else(|| map.get("updatedAt"))
            .or_else(|| map.get("createdAt")),
    )
    .map(|(_, ms)| ms)
    .unwrap_or(created_at);
    let status = match map.get("status").and_then(Value::as_str).map(str::trim) {
        Some("disconnected") => ThreadStatus::Disconnected,
        _ => ThreadStatus::Active,
    };

    let archived = map
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let archived_at = if archived {
        parse_timestamp_value(map.get("archivedAt")).map(|(_, ms)| ms)
    } else {
        None
    };

    Some(ThreadRecord {
        id,
        workspace_id,
        title,
        status,
        session_id: non_empty_string(map.get("sessionId")),
        legacy_transcript_id: safe_id_from_value(map.get("legacyTranscriptId")),
        pinned: map.get("pinned").and_then(Value::as_bool).unwrap_or(false),
        archived,
        archived_at,
        draft: map.get("draft").and_then(Value::as_bool).unwrap_or(false),
        provider: non_empty_string(map.get("provider").or_else(|| map.get("modelProvider"))),
        model: non_empty_string(map.get("model")),
        reasoning_effort: non_empty_string(map.get("reasoningEffort")),
        preview: non_empty_string(map.get("preview").or_else(|| map.get("lastMessagePreview"))),
        updated_at,
        created_at,
        source_task_id: safe_id_from_value(map.get("sourceTaskId").or_else(|| map.get("taskId"))),
        last_event_seq: map.get("lastEventSeq").and_then(Value::as_u64).unwrap_or(0),
    })
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
            "creationDrafts": {
                "research": { "prompt": "keep me" },
                "task": {
                    "workspaceId": "ws-valid",
                    "title": "Draft migration audit",
                    "objective": "Restore the unfinished brief",
                    "idempotencyKey": "draft-key-1"
                }
            }
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
        assert_eq!(core.task_creation_draft.title, "Draft migration audit");
        assert_eq!(core.task_creation_draft.workspace_id, "ws-valid");
        assert_eq!(
            after_core_save["creationDrafts"]["task"]["objective"],
            "Restore the unfinished brief"
        );
        assert_eq!(
            after_core_save["creationDrafts"]["task"]["idempotencyKey"],
            "draft-key-1"
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

    #[test]
    fn roundtrips_collapsed_sidebar_sections_and_workspace_defaults() {
        let tmp = tempdir().unwrap();
        let user_data = tmp.path().join("Cowork");
        let workspace_dir = tmp.path().join("proj");
        fs::create_dir_all(&workspace_dir).unwrap();

        let service = PersistenceService::new(user_data, None, true, None);
        let mut ws = WorkspaceRecord::new(
            "ws-1",
            "Project One",
            workspace_dir.to_string_lossy().into_owned(),
            1_700_000_000_000,
        );
        ws.yolo = true;
        ws.default_enable_mcp = false;
        ws.default_backups_enabled = true;
        ws.default_provider = Some("openai".to_string());
        ws.default_model = Some("gpt-5.4".to_string());

        let snapshot = PersistedDesktopState {
            workspaces: vec![ws.clone()],
            workspace_order: vec![ws.id.clone()],
            collapsed_sidebar_sections: vec![
                SidebarSectionKey::Tasks,
                SidebarSectionKey::Chats,
                SidebarSectionKey::Tasks,
            ],
            active_workspace_id: Some(ws.id.clone()),
            ..PersistedDesktopState::default()
        };

        service.merge_and_save_core_snapshot(&snapshot).unwrap();
        let loaded = service.load_core_state().unwrap();
        assert_eq!(
            loaded.collapsed_sidebar_sections,
            vec![SidebarSectionKey::Tasks, SidebarSectionKey::Chats]
        );
        assert_eq!(loaded.workspaces.len(), 1);
        let reloaded_ws = &loaded.workspaces[0];
        assert!(reloaded_ws.yolo);
        assert!(!reloaded_ws.default_enable_mcp);
        assert!(reloaded_ws.default_backups_enabled);
        assert_eq!(reloaded_ws.default_provider.as_deref(), Some("openai"));
        assert_eq!(reloaded_ws.default_model.as_deref(), Some("gpt-5.4"));

        // Ensure raw JSON normalization keeps only valid unique SidebarSectionKey entries.
        let mut doc = service.load_state_value().unwrap();
        doc["collapsedSidebarSections"] = json!(["pinned", "invalid", "workspaces", "pinned"]);
        let saved_doc = service.save_state_value(doc).unwrap();
        assert_eq!(
            saved_doc["collapsedSidebarSections"],
            json!(["pinned", "workspaces"])
        );
    }

    #[test]
    fn read_transcript_with_candidates_merges_chronologically_and_rejects_unsafe_primary() {
        let tmp = tempdir().unwrap();
        let service = PersistenceService::new(tmp.path().join("Cowork"), None, true, None);

        service
            .append_transcript_batch(vec![
                TranscriptEvent {
                    ts: "2026-01-01T00:00:03.000Z".into(),
                    thread_id: "thread-main".into(),
                    direction: TranscriptDirection::Server,
                    payload: json!({ "seq": 3 }),
                    extra: Map::new(),
                },
                TranscriptEvent {
                    ts: "2026-01-01T00:00:01.000Z".into(),
                    thread_id: "legacy-id".into(),
                    direction: TranscriptDirection::Client,
                    payload: json!({ "seq": 1 }),
                    extra: Map::new(),
                },
                TranscriptEvent {
                    ts: "2026-01-01T00:00:02.000Z".into(),
                    thread_id: "session-id".into(),
                    direction: TranscriptDirection::Server,
                    payload: json!({ "seq": 2 }),
                    extra: Map::new(),
                },
            ])
            .unwrap();

        let merged = service
            .read_transcript_with_candidates(
                "thread-main",
                &[
                    "session-id".into(),
                    "legacy-id".into(),
                    "missing-id".into(),
                    "session-id".into(),
                ],
            )
            .unwrap();
        let seqs: Vec<i64> = merged
            .iter()
            .filter_map(|e| e.payload.get("seq").and_then(Value::as_i64))
            .collect();
        assert_eq!(seqs, vec![1, 2, 3]);

        assert!(
            service
                .read_transcript_with_candidates("../escape", &["session-id".into()])
                .is_err()
        );
    }

    #[test]
    fn transcript_write_buffer_batches_with_debounce_and_manual_flush() {
        let tmp = tempdir().unwrap();
        let service = Arc::new(PersistenceService::new(
            tmp.path().join("Cowork"),
            None,
            true,
            None,
        ));
        let buffer = TranscriptWriteBuffer::new(Arc::clone(&service), None);

        // Without an active runtime, enqueue buffers until manual flush.
        buffer.enqueue(TranscriptEvent {
            ts: "2026-01-01T00:00:01.000Z".into(),
            thread_id: "t-sync".into(),
            direction: TranscriptDirection::Client,
            payload: json!({ "step": "sync" }),
            extra: Map::new(),
        });
        assert_eq!(buffer.pending_len(), 1);
        assert_eq!(buffer.flush().unwrap(), 1);
        assert_eq!(buffer.pending_len(), 0);
        assert_eq!(service.read_transcript("t-sync").unwrap().len(), 1);

        // Inside a Tokio runtime, events batch across the 200ms debounce timer.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            for idx in 1..=3 {
                buffer.enqueue(TranscriptEvent {
                    ts: format!("2026-01-01T00:00:0{idx}.000Z"),
                    thread_id: "t-async".into(),
                    direction: TranscriptDirection::Server,
                    payload: json!({ "idx": idx }),
                    extra: Map::new(),
                });
            }
            assert_eq!(buffer.pending_len(), 3);
            tokio::time::sleep(TRANSCRIPT_BATCH_DEBOUNCE).await;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while (buffer.pending_len() > 0
                || service.read_transcript("t-async").unwrap().len() < 3)
                && tokio::time::Instant::now() < deadline
            {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert_eq!(buffer.pending_len(), 0);
        });
        let events = service.read_transcript("t-async").unwrap();
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn roundtrips_and_preserves_product_analytics_state_on_core_save() {
        let tmp = tempdir().unwrap();
        let service = PersistenceService::new(tmp.path().join("Cowork"), None, true, None);
        let analytics = json!({
            "anonymousInstallationId": "anon_0123456789abcdef0123456789abcdef",
            "lastAppVersion": "0.9.0",
        });

        let snapshot = PersistedDesktopState {
            product_analytics: Some(analytics.clone()),
            ..PersistedDesktopState::default()
        };
        service.merge_and_save_core_snapshot(&snapshot).unwrap();

        let loaded = service.load_core_state().unwrap();
        assert_eq!(loaded.product_analytics, Some(analytics.clone()));

        // Saving a snapshot with `product_analytics: None` preserves the persisted ID on disk.
        service
            .merge_and_save_core_snapshot(&PersistedDesktopState::default())
            .unwrap();
        let preserved = service.load_core_state().unwrap();
        assert_eq!(preserved.product_analytics, Some(analytics));
    }

    #[test]
    fn roundtrips_workspace_profile_provider_options_child_models_and_defaults() {
        let tmp = tempdir().unwrap();
        let workspace_dir = tmp.path().join("proj");
        fs::create_dir_all(&workspace_dir).unwrap();
        let service = PersistenceService::new(tmp.path().join("Cowork"), None, true, None);

        let mut ws = WorkspaceRecord::new(
            "ws-profile",
            "Profile Project",
            workspace_dir.to_string_lossy().into_owned(),
            1_700_000_000_000,
        );
        ws.user_name = Some("E2E Parity Tester".to_string());
        ws.user_profile = Some(json!({
            "work": "Systems engineering",
            "instructions": "Be concise",
            "details": "Prefers Rust",
        }));
        ws.provider_options = Some(json!({
            "openai": { "serviceTier": "priority" },
            "google": { "googleSearch": true },
        }));
        ws.default_preferred_child_model = Some("claude-haiku-4-5".to_string());
        ws.default_child_model_routing_mode = Some("cross-provider-allowlist".to_string());
        ws.default_preferred_child_model_ref = Some("anthropic:claude-haiku-4-5".to_string());
        ws.default_allowed_child_model_refs = vec![
            "anthropic:claude-haiku-4-5".to_string(),
            "openai:gpt-4.1-mini".to_string(),
        ];
        ws.defaults = json!({
            "defaultAdvancedMemory": true,
            "advancedMemory": true,
            "defaultToolOutputOverflowChars": 32768,
            "toolOutputOverflowChars": 32768,
            "defaultWorkflowMaxConcurrentAgents": 6,
            "workflowMaxConcurrentAgents": 6,
            "lmStudioEnabled": true,
            "reasoningEffort": "high",
        });

        let snapshot = PersistedDesktopState {
            workspaces: vec![ws.clone()],
            ..PersistedDesktopState::default()
        };
        let saved_doc = service.merge_and_save_core_snapshot(&snapshot).unwrap();
        assert_eq!(saved_doc["workspaces"][0]["userName"], "E2E Parity Tester");
        assert_eq!(
            saved_doc["workspaces"][0]["userProfile"]["instructions"],
            "Be concise"
        );
        assert_eq!(
            saved_doc["workspaces"][0]["defaultPreferredChildModelRef"],
            "anthropic:claude-haiku-4-5"
        );
        assert_eq!(
            saved_doc["workspaces"][0]["defaultWorkflowMaxConcurrentAgents"],
            6
        );
        assert_eq!(saved_doc["workspaces"][0]["defaultAdvancedMemory"], true);

        let loaded = service.load_core_state().unwrap();
        let reloaded = &loaded.workspaces[0];
        assert_eq!(reloaded.user_name.as_deref(), Some("E2E Parity Tester"));
        assert_eq!(reloaded.user_profile, ws.user_profile);
        assert_eq!(reloaded.provider_options, ws.provider_options);
        assert_eq!(
            reloaded.default_preferred_child_model.as_deref(),
            Some("claude-haiku-4-5")
        );
        assert_eq!(
            reloaded.default_child_model_routing_mode.as_deref(),
            Some("cross-provider-allowlist")
        );
        assert_eq!(
            reloaded.default_preferred_child_model_ref.as_deref(),
            Some("anthropic:claude-haiku-4-5")
        );
        assert_eq!(
            reloaded.default_allowed_child_model_refs,
            ws.default_allowed_child_model_refs
        );
        assert_eq!(reloaded.defaults["defaultAdvancedMemory"], true);
        assert_eq!(reloaded.defaults["defaultToolOutputOverflowChars"], 32768);
        assert_eq!(reloaded.defaults["lmStudioEnabled"], true);
        assert_eq!(reloaded.defaults["reasoningEffort"], "high");

        // Clearing clearable defaults removes both top-level and nested defaults across restart.
        let mut cleared_snapshot = loaded;
        cleared_snapshot.workspaces[0].user_name = None;
        cleared_snapshot.workspaces[0].provider_options = None;
        cleared_snapshot.workspaces[0]
            .default_allowed_child_model_refs
            .clear();
        let obj = cleared_snapshot.workspaces[0]
            .defaults
            .as_object_mut()
            .unwrap();
        obj.remove("defaultToolOutputOverflowChars");
        obj.remove("toolOutputOverflowChars");

        let after_clear_doc = service
            .merge_and_save_core_snapshot(&cleared_snapshot)
            .unwrap();
        assert!(after_clear_doc["workspaces"][0].get("userName").is_none());
        assert!(
            after_clear_doc["workspaces"][0]
                .get("providerOptions")
                .is_none()
        );
        assert!(
            after_clear_doc["workspaces"][0]
                .get("defaultToolOutputOverflowChars")
                .is_none()
        );
        let after_clear = service.load_core_state().unwrap();
        assert_eq!(after_clear.workspaces[0].user_name, None);
        assert!(
            after_clear.workspaces[0]
                .defaults
                .get("defaultToolOutputOverflowChars")
                .is_none()
        );
    }

    #[test]
    fn migrates_legacy_default_sub_agent_model_to_canonical_preferred_child_model() {
        let tmp = tempdir().unwrap();
        let ws_legacy_only = tmp.path().join("proj-legacy");
        let ws_both = tmp.path().join("proj-both");
        fs::create_dir_all(&ws_legacy_only).unwrap();
        fs::create_dir_all(&ws_both).unwrap();
        let data_dir = tmp.path().join("Cowork");
        fs::create_dir_all(&data_dir).unwrap();
        let state_path = data_dir.join("state.json");
        fs::write(
            &state_path,
            serde_json::to_string_pretty(&json!({
                "version": 2,
                "workspaces": [
                    {
                        "id": "ws-legacy",
                        "name": "Legacy",
                        "path": ws_legacy_only.to_string_lossy(),
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "lastOpenedAt": "2026-01-01T00:00:00.000Z",
                        "defaultProvider": "openai",
                        "defaultModel": "gpt-5.2",
                        "defaultSubAgentModel": "gpt-5.2-mini",
                        "defaultEnableMcp": true,
                        "defaultBackupsEnabled": false,
                        "yolo": false
                    },
                    {
                        "id": "ws-both",
                        "name": "Canonical Wins",
                        "path": ws_both.to_string_lossy(),
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "lastOpenedAt": "2026-01-01T00:00:00.000Z",
                        "defaultProvider": "anthropic",
                        "defaultModel": "claude-sonnet-4-6",
                        "defaultPreferredChildModel": "claude-haiku-4-5",
                        "defaultSubAgentModel": "legacy-ignored-model",
                        "defaultEnableMcp": true,
                        "defaultBackupsEnabled": false,
                        "yolo": false
                    }
                ],
                "threads": [],
                "developerMode": false,
                "showHiddenFiles": false
            }))
            .unwrap(),
        )
        .unwrap();

        let service = PersistenceService::new(data_dir, None, true, None);
        let raw_loaded = service.load_state_value().unwrap();
        assert_eq!(
            raw_loaded["workspaces"][0]["defaultPreferredChildModel"],
            "gpt-5.2-mini"
        );
        assert!(
            raw_loaded["workspaces"][0]
                .get("defaultSubAgentModel")
                .is_none()
        );
        assert_eq!(
            raw_loaded["workspaces"][1]["defaultPreferredChildModel"],
            "claude-haiku-4-5"
        );
        assert!(
            raw_loaded["workspaces"][1]
                .get("defaultSubAgentModel")
                .is_none()
        );

        let core_loaded = service.load_core_state().unwrap();
        assert_eq!(
            core_loaded.workspaces[0]
                .default_preferred_child_model
                .as_deref(),
            Some("gpt-5.2-mini")
        );
        assert_eq!(
            core_loaded.workspaces[1]
                .default_preferred_child_model
                .as_deref(),
            Some("claude-haiku-4-5")
        );

        let saved = service.merge_and_save_core_snapshot(&core_loaded).unwrap();
        assert_eq!(
            saved["workspaces"][0]["defaultPreferredChildModel"],
            "gpt-5.2-mini"
        );
        assert!(saved["workspaces"][0].get("defaultSubAgentModel").is_none());
        let reloaded = service.load_core_state().unwrap();
        assert_eq!(
            reloaded.workspaces[0]
                .default_preferred_child_model
                .as_deref(),
            Some("gpt-5.2-mini")
        );
    }

    #[test]
    fn preserves_explicit_null_tool_output_overflow_override_across_migration_and_save() {
        let tmp = tempdir().unwrap();
        let ws_dir = tmp.path().join("legacy-ws");
        fs::create_dir_all(&ws_dir).unwrap();
        let data_dir = tmp.path().join("Cowork");
        fs::create_dir_all(&data_dir).unwrap();

        let legacy_state = json!({
            "version": 2,
            "workspaces": [{
                "id": "ws-legacy",
                "name": "Legacy",
                "path": ws_dir.to_string_lossy(),
                "workspaceKind": "project",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "lastOpenedAt": "2026-01-02T00:00:00.000Z",
                "defaultToolOutputOverflowChars": null
            }],
            "threads": []
        });
        fs::write(
            data_dir.join("state.json"),
            serde_json::to_string_pretty(&legacy_state).unwrap(),
        )
        .unwrap();

        let service = PersistenceService::new(data_dir, None, true, None);
        let loaded = service.load_core_state().unwrap();
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(
            loaded.workspaces[0]
                .defaults
                .get("defaultToolOutputOverflowChars"),
            Some(&Value::Null)
        );

        let saved_doc = service.merge_and_save_core_snapshot(&loaded).unwrap();
        assert_eq!(
            saved_doc["workspaces"][0].get("defaultToolOutputOverflowChars"),
            Some(&Value::Null)
        );
        assert_eq!(
            saved_doc["workspaces"][0]["defaults"].get("defaultToolOutputOverflowChars"),
            Some(&Value::Null)
        );

        let reloaded = service.load_core_state().unwrap();
        assert_eq!(
            reloaded.workspaces[0]
                .defaults
                .get("defaultToolOutputOverflowChars"),
            Some(&Value::Null)
        );
    }

    #[test]
    fn preserves_legacy_transcript_id_across_load_and_save() {
        let tmp = tempdir().unwrap();
        let ws_dir = tmp.path().join("ws");
        fs::create_dir_all(&ws_dir).unwrap();
        let data_dir = tmp.path().join("Cowork");
        fs::create_dir_all(&data_dir).unwrap();

        let state = json!({
            "version": 2,
            "workspaces": [{
                "id": "ws-1",
                "name": "Repo",
                "path": ws_dir.to_string_lossy(),
                "workspaceKind": "project",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "lastOpenedAt": "2026-01-02T00:00:00.000Z"
            }],
            "threads": [{
                "id": "srv-thread-1",
                "workspaceId": "ws-1",
                "title": "Migrated",
                "status": "active",
                "sessionId": "srv-thread-1",
                "legacyTranscriptId": "electron-local-42",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "lastMessageAt": "2026-01-02T00:00:00.000Z"
            }]
        });
        fs::write(
            data_dir.join("state.json"),
            serde_json::to_string_pretty(&state).unwrap(),
        )
        .unwrap();

        let service = PersistenceService::new(data_dir, None, true, None);
        let loaded = service.load_core_state().unwrap();
        assert_eq!(loaded.threads.len(), 1);
        assert_eq!(
            loaded.threads[0].legacy_transcript_id.as_deref(),
            Some("electron-local-42")
        );

        let saved_doc = service.merge_and_save_core_snapshot(&loaded).unwrap();
        assert_eq!(
            saved_doc["threads"][0]["legacyTranscriptId"],
            json!("electron-local-42")
        );

        let reloaded = service.load_core_state().unwrap();
        assert_eq!(
            reloaded.threads[0].legacy_transcript_id.as_deref(),
            Some("electron-local-42")
        );
    }

    #[test]
    fn onboarding_dismissed_completed_steps_and_electron_schema_roundtrip() {
        let tmp = tempdir().unwrap();
        let service = PersistenceService::new(tmp.path().join("Cowork"), None, true, None);

        // Skipping onboarding persists `status: "dismissed"` and stays dismissed across reload.
        let skipped = PersistedDesktopState {
            onboarding: OnboardingState {
                completed: true,
                dismissed: true,
                completed_steps: ["step-1".to_string()].into_iter().collect(),
            },
            ..PersistedDesktopState::default()
        };
        let saved = service.merge_and_save_core_snapshot(&skipped).unwrap();
        assert_eq!(saved["onboarding"]["status"], "dismissed");
        assert!(saved["onboarding"]["dismissedAt"].is_string());
        assert!(saved["onboarding"]["completedAt"].is_null());
        assert_eq!(saved["onboarding"]["completedSteps"], json!(["step-1"]));

        let reloaded = service.load_core_state().unwrap();
        assert!(reloaded.onboarding.dismissed);
        assert!(!reloaded.onboarding.completed);
        assert!(reloaded.onboarding.completed_steps.contains("step-1"));

        // Completing onboarding preserves `status: "completed"` and `completedAt`, and resetting clears it.
        let completed = PersistedDesktopState {
            onboarding: OnboardingState {
                completed: true,
                dismissed: false,
                completed_steps: ["step-1".to_string(), "step-4".to_string()]
                    .into_iter()
                    .collect(),
            },
            ..PersistedDesktopState::default()
        };
        let saved_done = service.merge_and_save_core_snapshot(&completed).unwrap();
        assert_eq!(saved_done["onboarding"]["status"], "completed");
        assert!(saved_done["onboarding"]["completedAt"].is_string());
        assert!(saved_done["onboarding"]["dismissedAt"].is_null());

        let reloaded_done = service.load_core_state().unwrap();
        assert!(reloaded_done.onboarding.completed);
        assert!(!reloaded_done.onboarding.dismissed);

        // Electron state.json written without `completedSteps` still hydrates `completed: true`.
        let mut electron_doc = service.load_state_value().unwrap();
        electron_doc["onboarding"] = json!({
            "status": "completed",
            "completedAt": "2026-03-10T00:00:00.000Z",
            "dismissedAt": null,
        });
        service.save_state_value(electron_doc).unwrap();
        let from_electron = service.load_core_state().unwrap();
        assert!(from_electron.onboarding.completed);
        assert!(!from_electron.onboarding.dismissed);

        // Restarting onboarding clears completed/dismissed back to pending.
        let reset_doc = service
            .merge_and_save_core_snapshot(&PersistedDesktopState::default())
            .unwrap();
        assert_eq!(reset_doc["onboarding"]["status"], "pending");
        assert!(reset_doc["onboarding"]["completedAt"].is_null());
        assert!(reset_doc["onboarding"]["dismissedAt"].is_null());
    }

    #[test]
    fn roundtrips_persisted_threads_with_electron_fields_and_filtering() {
        let tmp = tempdir().unwrap();
        let ws_a_dir = tmp.path().join("ws-a");
        let ws_b_dir = tmp.path().join("ws-b");
        fs::create_dir_all(&ws_a_dir).unwrap();
        fs::create_dir_all(&ws_b_dir).unwrap();
        let service = PersistenceService::new(tmp.path().join("Cowork"), None, true, None);

        // Seed Electron-style state.json with extra server/Electron metadata and a task thread.
        service
            .save_state_value(json!({
                "version": 2,
                "workspaces": [
                    {
                        "id": "ws-a",
                        "name": "Alpha",
                        "path": ws_a_dir,
                        "workspaceKind": "project",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "lastOpenedAt": "2026-01-01T00:00:00.000Z"
                    },
                    {
                        "id": "ws-b",
                        "name": "Beta",
                        "path": ws_b_dir,
                        "workspaceKind": "project",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "lastOpenedAt": "2026-01-01T00:00:00.000Z"
                    }
                ],
                "threads": [
                    {
                        "id": "th-existing",
                        "workspaceId": "ws-a",
                        "title": "Existing title",
                        "titleSource": "manual",
                        "sessionKind": "root",
                        "messageCount": 7,
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "lastMessageAt": "2026-01-02T00:00:00.000Z"
                    },
                    {
                        "id": "th-task",
                        "workspaceId": "ws-a",
                        "title": "Task execution",
                        "taskId": "task-1",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "lastMessageAt": "2026-01-02T00:00:00.000Z"
                    }
                ]
            }))
            .unwrap();

        let ws_a = WorkspaceRecord::new(
            "ws-a",
            "Alpha",
            ws_a_dir.to_string_lossy().into_owned(),
            1_700_000_000_000,
        );
        let ws_b = WorkspaceRecord::new(
            "ws-b",
            "Beta",
            ws_b_dir.to_string_lossy().into_owned(),
            1_700_000_000_000,
        );

        let th_existing_updated = ThreadRecord {
            id: "th-existing".to_string(),
            workspace_id: "ws-a".to_string(),
            title: "Renamed chat".to_string(),
            status: ThreadStatus::Disconnected,
            session_id: Some("sess-existing".to_string()),
            legacy_transcript_id: None,
            pinned: true,
            archived: false,
            archived_at: None,
            draft: false,
            provider: Some("anthropic".to_string()),
            model: Some("claude-sonnet-4-6".to_string()),
            reasoning_effort: Some("high".to_string()),
            preview: Some("Latest summary".to_string()),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_123_456,
            source_task_id: None,
            last_event_seq: 42,
        };
        let th_b = ThreadRecord {
            id: "th-b".to_string(),
            workspace_id: "ws-b".to_string(),
            title: "Beta archived".to_string(),
            status: ThreadStatus::Active,
            session_id: Some("th-b".to_string()),
            legacy_transcript_id: None,
            pinned: false,
            archived: true,
            archived_at: Some(1_700_000_050_000),
            draft: false,
            provider: None,
            model: None,
            reasoning_effort: None,
            preview: None,
            created_at: 1_700_000_010_000,
            updated_at: 1_700_000_050_000,
            source_task_id: None,
            last_event_seq: 9,
        };
        let th_draft = ThreadRecord {
            id: "draft-1".to_string(),
            workspace_id: "ws-a".to_string(),
            title: "Draft".to_string(),
            draft: true,
            ..ThreadRecord::default()
        };
        let th_orphan = ThreadRecord {
            id: "th-orphan".to_string(),
            workspace_id: "ws-missing".to_string(),
            title: "Orphan".to_string(),
            ..ThreadRecord::default()
        };

        let snapshot = PersistedDesktopState {
            workspaces: vec![ws_a.clone(), ws_b],
            threads: vec![
                th_existing_updated.clone(),
                th_b.clone(),
                th_draft,
                th_orphan,
            ],
            active_workspace_id: Some("ws-a".to_string()),
            active_thread_id: Some("th-existing".to_string()),
            ..PersistedDesktopState::default()
        };

        let saved_doc = service.merge_and_save_core_snapshot(&snapshot).unwrap();
        // 2 persisted chat threads + 1 preserved task thread; draft & orphan excluded.
        let threads_arr = saved_doc["threads"].as_array().unwrap();
        assert_eq!(threads_arr.len(), 3);
        assert_eq!(saved_doc["activeThreadId"], "th-existing");
        assert_eq!(threads_arr[0]["id"], "th-existing");
        assert_eq!(threads_arr[0]["titleSource"], "manual");
        assert_eq!(threads_arr[0]["sessionKind"], "root");
        assert_eq!(threads_arr[0]["messageCount"], 7);
        assert_eq!(threads_arr[0]["status"], "disconnected");
        assert_eq!(threads_arr[0]["pinned"], true);
        assert!(threads_arr[0]["lastMessageAt"].is_string());
        assert!(threads_arr[0].get("updatedAt").is_none());
        assert_eq!(threads_arr[2]["id"], "th-task");

        // Reloading via load_core_state populates non-task, non-draft chat threads losslessly.
        let reloaded = service.load_core_state().unwrap();
        assert_eq!(reloaded.active_thread_id.as_deref(), Some("th-existing"));
        assert_eq!(reloaded.threads, vec![th_existing_updated, th_b]);

        // Removing workspace B drops th-b, while clearing threads removes th-existing too.
        let pruned_snapshot = PersistedDesktopState {
            workspaces: vec![ws_a],
            threads: Vec::new(),
            active_workspace_id: Some("ws-a".to_string()),
            active_thread_id: Some("th-existing".to_string()),
            ..PersistedDesktopState::default()
        };
        let after_prune = service
            .merge_and_save_core_snapshot(&pruned_snapshot)
            .unwrap();
        let after_arr = after_prune["threads"].as_array().unwrap();
        assert_eq!(after_arr.len(), 1);
        assert_eq!(after_arr[0]["id"], "th-task");
        assert!(after_prune["activeThreadId"].is_null());
    }

    #[test]
    fn roundtrips_and_sanitizes_desktop_accent_palette() {
        let tmp = tempdir().unwrap();
        let service = PersistenceService::new(tmp.path().join("Cowork"), None, true, None);

        for palette in AccentPalette::ALL {
            let mut snapshot = PersistedDesktopState::default();
            snapshot.settings.accent_palette = palette;
            let saved = service.merge_and_save_core_snapshot(&snapshot).unwrap();
            assert_eq!(saved["desktopSettings"]["accentPalette"], palette.id());

            let reloaded = service.load_core_state().unwrap();
            assert_eq!(reloaded.settings.accent_palette, palette);
        }

        // Aliases / mixed case normalize to canonical kebab-case id.
        let mut alias_doc = service.load_state_value().unwrap();
        alias_doc["desktopSettings"]["accentPalette"] = json!(" AMBER ");
        let saved_alias = service.save_state_value(alias_doc).unwrap();
        assert_eq!(
            saved_alias["desktopSettings"]["accentPalette"],
            "ochre-amber"
        );
        assert_eq!(
            service.load_core_state().unwrap().settings.accent_palette,
            AccentPalette::OchreAmber
        );

        // Invalid strings fall back to the default accent palette.
        let mut invalid_doc = service.load_state_value().unwrap();
        invalid_doc["desktopSettings"]["accentPalette"] = json!("olive-green");
        let saved_invalid = service.save_state_value(invalid_doc).unwrap();
        assert_eq!(
            saved_invalid["desktopSettings"]["accentPalette"],
            AccentPalette::default().id()
        );
        assert_eq!(
            service.load_core_state().unwrap().settings.accent_palette,
            AccentPalette::default()
        );

        // Absent accentPalette (legacy document) resolves cleanly to default.
        let mut legacy_doc = service.load_state_value().unwrap();
        legacy_doc["desktopSettings"]
            .as_object_mut()
            .unwrap()
            .remove("accentPalette");
        let saved_legacy = service.save_state_value(legacy_doc).unwrap();
        assert_eq!(
            saved_legacy["desktopSettings"]["accentPalette"],
            AccentPalette::default().id()
        );
        assert_eq!(
            service.load_core_state().unwrap().settings.accent_palette,
            AccentPalette::default()
        );
    }

    #[test]
    fn desktop_show_menu_bar_persists_sanitizes_and_defaults_to_true() {
        let tmp = tempdir().unwrap();
        let service = PersistenceService::new(tmp.path().join("Cowork"), None, true, None);

        // Default / absent showMenuBar defaults to true.
        assert!(service.load_core_state().unwrap().settings.show_menu_bar);

        // Saving false persists through JSON and reloads as false.
        let mut snap = service.load_core_state().unwrap();
        snap.settings.show_menu_bar = false;
        service.merge_and_save_core_snapshot(&snap).unwrap();
        let stored = service.load_state_value().unwrap();
        assert_eq!(stored["desktopSettings"]["showMenuBar"], false);
        assert!(!service.load_core_state().unwrap().settings.show_menu_bar);

        // Non-boolean values fall back to default true during sanitization.
        let mut invalid_doc = service.load_state_value().unwrap();
        invalid_doc["desktopSettings"]["showMenuBar"] = json!("never");
        let sanitized = service.save_state_value(invalid_doc).unwrap();
        assert_eq!(sanitized["desktopSettings"]["showMenuBar"], true);
        assert!(service.load_core_state().unwrap().settings.show_menu_bar);

        // Absent showMenuBar (legacy document) resolves cleanly to true.
        let mut legacy_doc = service.load_state_value().unwrap();
        legacy_doc["desktopSettings"]
            .as_object_mut()
            .unwrap()
            .remove("showMenuBar");
        let saved_legacy = service.save_state_value(legacy_doc).unwrap();
        assert_eq!(saved_legacy["desktopSettings"]["showMenuBar"], true);
        assert!(service.load_core_state().unwrap().settings.show_menu_bar);
    }

    #[test]
    fn legacy_appearance_json_migrates_theme_when_state_json_lacks_theme() {
        let tmp = tempdir().unwrap();
        let legacy_dir = tmp.path().join("agent-coworker");
        let current_dir = tmp.path().join("Cowork");
        fs::create_dir_all(&legacy_dir).unwrap();

        // Upgraded Electron profile: theme lives in `appearance.json`, absent from `desktopSettings`.
        fs::write(
            legacy_dir.join("appearance.json"),
            r#"{"themeSource":"dark"}"#,
        )
        .unwrap();
        fs::write(
            legacy_dir.join("state.json"),
            serde_json::to_string_pretty(&json!({
                "version": 2,
                "workspaces": [],
                "threads": [],
                "desktopSettings": {
                    "archivedChatsAutoDeleteDays": 0
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let service = PersistenceService::new(current_dir.clone(), Some(legacy_dir), false, None);
        let loaded = service.load_core_state().unwrap();
        assert_eq!(loaded.settings.theme, ThemePreference::Dark);
        assert!(current_dir.join("appearance.json").exists());

        // An explicit `desktopSettings.theme` in `state.json` takes precedence over `appearance.json`.
        let mut snap = loaded;
        snap.settings.theme = ThemePreference::Light;
        service.merge_and_save_core_snapshot(&snap).unwrap();
        assert_eq!(
            service.load_core_state().unwrap().settings.theme,
            ThemePreference::Light
        );

        // Missing `state.json` with an existing `appearance.json` still imports the saved theme.
        let fresh_dir = tmp.path().join("FreshWithAppearance");
        fs::create_dir_all(&fresh_dir).unwrap();
        fs::write(
            fresh_dir.join("appearance.json"),
            r#"{"themeSource":"dark"}"#,
        )
        .unwrap();
        let fresh_service = PersistenceService::new(fresh_dir, None, true, None);
        assert_eq!(
            fresh_service.load_core_state().unwrap().settings.theme,
            ThemePreference::Dark
        );
    }
}
