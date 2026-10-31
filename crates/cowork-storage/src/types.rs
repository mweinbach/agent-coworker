use std::path::PathBuf;

use cowork_config::{ProviderName, SandboxConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDbOptions {
    pub root_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub db_path: Option<PathBuf>,
    pub busy_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    #[default]
    Root,
    #[serde(alias = "subagent")]
    Agent,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Root => "root",
            Self::Agent => "agent",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw.trim() {
            "agent" | "subagent" => Self::Agent,
            _ => Self::Root,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentExecutionState {
    PendingInit,
    Running,
    Completed,
    Errored,
    Interrupted,
    Closed,
}

impl AgentExecutionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PendingInit => "pending_init",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Errored => "errored",
            Self::Interrupted => "interrupted",
            Self::Closed => "closed",
        }
    }

    pub fn from_db(raw: &str) -> Option<Self> {
        match raw.trim() {
            "pending_init" => Some(Self::PendingInit),
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "errored" => Some(Self::Errored),
            "interrupted" => Some(Self::Interrupted),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }

    pub fn is_transient(self) -> bool {
        matches!(self, Self::PendingInit | Self::Running)
    }

    pub fn is_reconciled_terminal(self) -> bool {
        !self.is_transient()
    }
}

/// Resolves the effective execution state for a child agent loaded from SQLite (`src/agents/status.ts` parity).
///
/// Unowned rows left in `pending_init`, `running`, or `interrupted` after a crash or session reload
/// map to `errored` unless `status == Closed`.
pub fn resolve_restored_agent_execution_state(
    stored: Option<AgentExecutionState>,
    status: SessionPersistenceStatus,
    has_live_owner: bool,
) -> AgentExecutionState {
    if status == SessionPersistenceStatus::Closed || stored == Some(AgentExecutionState::Closed) {
        return AgentExecutionState::Closed;
    }
    match stored {
        Some(AgentExecutionState::Completed) => AgentExecutionState::Completed,
        Some(AgentExecutionState::Errored) => AgentExecutionState::Errored,
        Some(
            state @ (AgentExecutionState::PendingInit
            | AgentExecutionState::Running
            | AgentExecutionState::Interrupted),
        ) => {
            if has_live_owner {
                state
            } else {
                AgentExecutionState::Errored
            }
        }
        None => AgentExecutionState::Completed,
        Some(AgentExecutionState::Closed) => AgentExecutionState::Closed,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionPersistenceStatus {
    #[default]
    Active,
    Closed,
}

impl SessionPersistenceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Closed => "closed",
        }
    }

    pub fn from_db(raw: &str) -> Option<Self> {
        match raw.trim() {
            "active" => Some(Self::Active),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionTitleSource {
    #[default]
    Default,
    Model,
    Heuristic,
    Manual,
}

impl SessionTitleSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Model => "model",
            Self::Heuristic => "heuristic",
            Self::Manual => "manual",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw.trim() {
            "model" => Self::Model,
            "heuristic" => Self::Heuristic,
            "manual" => Self::Manual,
            _ => Self::Default,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionSummary {
    pub session_id: String,
    pub title: String,
    pub title_source: SessionTitleSource,
    pub title_model: Option<String>,
    pub provider: ProviderName,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
    pub last_event_seq: u64,
    pub has_pending_ask: bool,
    pub has_pending_approval: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionSnapshotData {
    pub session_kind: SessionKind,
    pub parent_session_id: Option<String>,
    pub role: Option<String>,
    pub mode: Option<String>,
    pub depth: Option<i64>,
    pub nickname: Option<String>,
    pub task_type: Option<String>,
    pub target_paths: Option<Vec<String>>,
    pub profile: Option<Value>,
    pub requested_model: Option<String>,
    pub effective_model: Option<String>,
    pub requested_reasoning_effort: Option<String>,
    pub effective_reasoning_effort: Option<String>,
    pub execution_state: Option<AgentExecutionState>,
    pub last_message_preview: Option<String>,
    pub title: String,
    pub title_source: SessionTitleSource,
    pub title_model: Option<String>,
    pub provider: ProviderName,
    pub model: String,
    pub working_directory: String,
    pub output_directory: Option<String>,
    pub uploads_directory: Option<String>,
    pub provider_options: Option<Value>,
    pub sandbox: Option<SandboxConfig>,
    pub enable_mcp: bool,
    pub backups_enabled_override: Option<bool>,
    pub created_at: String,
    pub updated_at: String,
    pub status: SessionPersistenceStatus,
    pub has_pending_ask: bool,
    pub has_pending_approval: bool,
    pub system_prompt: String,
    pub messages: Vec<Value>,
    pub last_memory_generated_index: Option<usize>,
    pub provider_state: Option<Value>,
    pub todos: Vec<Value>,
    pub harness_context: Option<Value>,
    pub cost_tracker: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionMutation {
    pub session_id: String,
    pub event_type: String,
    pub event_ts: Option<String>,
    pub direction: Option<String>,
    pub payload: Option<Value>,
    pub snapshot: PersistedSessionSnapshotData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionRecord {
    pub session_id: String,
    pub session_kind: SessionKind,
    pub parent_session_id: Option<String>,
    pub role: Option<String>,
    pub mode: Option<String>,
    pub depth: Option<i64>,
    pub nickname: Option<String>,
    pub task_type: Option<String>,
    pub target_paths: Option<Vec<String>>,
    pub profile: Option<Value>,
    pub requested_model: Option<String>,
    pub effective_model: Option<String>,
    pub requested_reasoning_effort: Option<String>,
    pub effective_reasoning_effort: Option<String>,
    pub execution_state: Option<AgentExecutionState>,
    pub last_message_preview: Option<String>,
    pub title: String,
    pub title_source: SessionTitleSource,
    pub title_model: Option<String>,
    pub provider: ProviderName,
    pub model: String,
    pub working_directory: String,
    pub output_directory: Option<String>,
    pub uploads_directory: Option<String>,
    pub provider_options: Option<Value>,
    pub sandbox: Option<SandboxConfig>,
    pub enable_mcp: bool,
    pub backups_enabled_override: Option<bool>,
    pub created_at: String,
    pub updated_at: String,
    pub status: SessionPersistenceStatus,
    pub has_pending_ask: bool,
    pub has_pending_approval: bool,
    pub message_count: usize,
    pub last_event_seq: u64,
    pub system_prompt: String,
    pub messages: Vec<Value>,
    pub last_memory_generated_index: Option<usize>,
    pub provider_state: Option<Value>,
    pub todos: Vec<Value>,
    pub harness_context: Option<Value>,
    pub cost_tracker: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedModelStreamChunk {
    pub session_id: String,
    pub turn_id: String,
    pub chunk_index: u64,
    pub ts: String,
    pub provider: ProviderName,
    pub model: String,
    pub raw_format: String,
    pub normalizer_version: u32,
    pub raw_event: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadJournalEventInput {
    pub thread_id: String,
    pub ts: String,
    pub event_type: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub request_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedThreadJournalEvent {
    pub thread_id: String,
    pub seq: u64,
    pub ts: String,
    pub event_type: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub request_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedThreadJournalFailure {
    pub thread_id: String,
    pub failed_write_count: u64,
    pub dropped_event_count: u64,
    pub last_failure_at: String,
    pub last_failure_message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedThreadMetadata {
    pub thread_id: String,
    pub pinned: bool,
    pub pinned_at: Option<String>,
    pub archived: bool,
    pub archived_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedThreadMetadataPatch {
    pub thread_id: String,
    pub pinned: Option<bool>,
    pub pinned_at: Option<Option<String>>,
    pub archived: Option<bool>,
    pub archived_at: Option<Option<String>>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedExternalConversationImport {
    pub source: String,
    pub fingerprint: String,
    pub imported_session_id: String,
    pub source_id: String,
    pub source_path: Option<String>,
    pub original_provider: Option<String>,
    pub original_model: Option<String>,
    pub imported_at: String,
    pub metadata: Value,
}

#[derive(Debug, Clone)]
pub struct PersistedExternalConversationImportMutation {
    pub mutation: PersistedSessionMutation,
    pub snapshot: Value,
    pub record: PersistedExternalConversationImport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationImportPersistResult {
    pub thread_id: String,
    pub snapshot_feed: Vec<Value>,
    pub model_messages: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskThreadInput {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemInput {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub position: i64,
    pub expected_outputs: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub id: String,
    pub workspace_path: String,
    pub title: String,
    pub objective: String,
    pub context: String,
    pub source_session_id: Option<String>,
    pub creation_origin: String,
    pub creation_idempotency_key: Option<String>,
    pub initial_status: String,
    pub review_required: bool,
    pub review_rounds: i64,
    pub thread: TaskThreadInput,
    pub work_items: Vec<WorkItemInput>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupReconciliationReport {
    pub sessions_reconciled: usize,
    pub turns_interrupted: usize,
    pub tasks_reconciled: usize,
}
