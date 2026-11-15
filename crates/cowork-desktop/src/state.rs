//! Client-side desktop state store and synchronous action/event reducers.
//!
//! Ported from `apps/desktop/src/app/store.ts`, `apps/desktop/src/app/types.ts`, and
//! `apps/desktop/src/app/store.helpers/`.
//! Views read `&AppState` and dispatch `Action` values via `AppState::dispatch`; background
//! `ws/` and `native/` tasks push `StoreEvent` values and wake Rune's event loop so
//! `AppState::drain_events` reduces them on the UI thread.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use cowork_protocol::{
    CommandInfo, CommandListParams, ConnectorsOpenAiNativeListParams,
    ConnectorsOpenAiNativeRefreshParams, ConnectorsOpenAiNativeSetEnabledParams,
    CreationPreflightParams, CreationPreflightResult, CreationRepairAction, InitializeResult,
    JsonRpcLiteId, MemoryAdvancedDeleteParams, MemoryAdvancedListParams, MemoryDeleteParams,
    MemoryListParams, MemoryUpsertParams, ProviderAuthAuthorizeParams, ProviderAuthCallbackParams,
    ProviderAuthLogoutParams, ProviderAuthMethodsReadParams, ProviderAuthSetApiKeyParams,
    ProviderAuthSetConfigParams, ProviderCatalogReadParams, ProviderCodexAppServerStatusParams,
    ProviderCodexAppServerUpdateParams, ProviderCustomModelAddParams,
    ProviderCustomModelDeleteParams, ProviderLmStudioLocalStartParams,
    ProviderLmStudioLocalStatusParams, ProviderModelPreferencePatch,
    ProviderModelResetEnabledParams, ProviderModelSetEnabledParams, ProviderStatusRefreshParams,
    RuntimeDiagnosticsReadParams, RuntimeDiagnosticsReadResult, RuntimeLibreOfficeCheckParams,
    SessionConfigSetParams, SessionDefaultsApplyParams, SessionDeleteParams, SessionModelSetParams,
    SessionTitleSetParams, ThreadArchivedSetParams, ThreadForkParams, ThreadHydrateParams,
    ThreadListParams, ThreadPinnedSetParams, ThreadStartParams, TurnAttachmentInputPart, TurnInput,
    TurnInterruptParams, TurnReference, TurnStartParams, TurnSteerParams,
};
use rune::TextEdit;
use rune_kit::PaneState;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::actions::{
    Action, ChatAction, NativeAction, NativeCommand, NavAction, SettingsAction, ShellAction,
    SidebarSectionKey, StoreEvent,
};
use crate::router::{
    NavigationHistory, NavigationPatch, NavigationSnapshot, SettingsPageId, ViewId,
};
use crate::theme::{self, ThemePreference};
use crate::ws::{PendingRpcMeta, WsCommand, WsConnectionState, WsRpcError};

pub const WINDOW_MAIN: &str = "main";
pub const WINDOW_QUICK_CHAT: &str = "quick-chat";
pub const WINDOW_UTILITY: &str = "utility";

/// Active window surface mode (Electron multi-window equivalent).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowMode {
    #[default]
    Main,
    QuickChat,
    Utility,
}

/// In-window confirmation dialog request (replaces Electron `dialog.showMessageBox`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmDialogRequest {
    pub id: String,
    pub title: String,
    pub message: String,
    pub confirm_label: String,
    pub cancel_label: String,
    pub destructive: bool,
}

/// Workspace record shown in the sidebar and connected to a local `cowork-server`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub path: String,
    pub one_off_chat: bool,
    pub archived: bool,
    pub created_at: i64,
    pub last_opened_at: i64,
    #[serde(default)]
    pub yolo: bool,
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_preferred_child_model: Option<String>,
    #[serde(default)]
    pub default_child_model_routing_mode: Option<String>,
    #[serde(default)]
    pub default_preferred_child_model_ref: Option<String>,
    #[serde(default)]
    pub default_allowed_child_model_refs: Vec<String>,
    #[serde(default)]
    pub default_enable_mcp: bool,
    #[serde(default)]
    pub default_backups_enabled: bool,
    #[serde(default)]
    pub provider_options: Option<Value>,
    #[serde(default)]
    pub user_name: Option<String>,
    #[serde(default)]
    pub user_profile: Option<Value>,
    #[serde(default)]
    pub defaults: Value,
}

impl WorkspaceRecord {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        path: impl Into<String>,
        now_ms: i64,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            path: path.into(),
            created_at: now_ms,
            last_opened_at: now_ms,
            default_enable_mcp: true,
            default_backups_enabled: true,
            defaults: Value::Object(Map::new()),
            ..Self::default()
        }
    }
}

/// Server process startup stage for a workspace.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerLifecycleState {
    #[default]
    Stopped,
    Starting {
        stage: String,
        message: String,
    },
    Running {
        ws_url: String,
        port: u16,
    },
    Failed {
        message: String,
    },
}

/// Live runtime metadata for an active workspace.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRuntime {
    pub server_state: ServerLifecycleState,
    pub capabilities: Option<Value>,
    pub config: Option<Value>,
    pub control_session_config: Option<Value>,
    pub provider_statuses: Vec<ProviderStatusSummary>,
    pub reconnecting: bool,
    pub reconnect_attempt: u32,
    pub last_error: Option<String>,
}

/// Connection status of a thread's backing workspace session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadStatus {
    #[default]
    Active,
    Disconnected,
}

/// Sidebar thread metadata matching `apps/desktop/src/app/types.ts`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    #[serde(default)]
    pub status: ThreadStatus,
    #[serde(default)]
    pub session_id: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    #[serde(default)]
    pub draft: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub preview: Option<String>,
    pub updated_at: i64,
    pub created_at: i64,
    pub source_task_id: Option<String>,
    #[serde(default)]
    pub last_event_seq: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadBusyPolicy {
    #[default]
    Steer,
    Queue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReasoningEffortValue {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

impl ReasoningEffortValue {
    pub fn as_str(self) -> &'static str {
        match self {
            ReasoningEffortValue::None => "none",
            ReasoningEffortValue::Minimal => "minimal",
            ReasoningEffortValue::Low => "low",
            ReasoningEffortValue::Medium => "medium",
            ReasoningEffortValue::High => "high",
            ReasoningEffortValue::Xhigh => "xhigh",
        }
    }
}

/// Message author role inside a thread feed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedMessageRole {
    User,
    #[default]
    Assistant,
    System,
}

/// Tool call lifecycle state inside `FeedItem::Tool`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolRunStatus {
    #[default]
    Pending,
    Running,
    Completed,
    Failed,
    Declined,
}

impl ToolRunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ToolRunStatus::Completed | ToolRunStatus::Failed | ToolRunStatus::Declined
        )
    }
}

/// One Todo item inside `FeedItem::Todos`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItemView {
    pub id: String,
    pub content: String,
    pub status: String,
    pub priority: Option<String>,
}

fn default_reasoning_mode() -> String {
    "reasoning".to_string()
}

/// Resolved citation / external source entry attached to an assistant message.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationSource {
    pub label: Option<String>,
    pub title: Option<String>,
    pub url: String,
    pub domain: Option<String>,
    pub snippet: Option<String>,
    #[serde(default)]
    pub reference_id: Option<String>,
}

/// Decoded image preview metadata paired with composer attachments.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreviewMeta {
    pub filename: String,
    pub mime_type: String,
    pub data_url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// One item in a projected thread feed (matches `SessionFeedItem` in `src/shared/sessionSnapshot.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FeedItem {
    Message {
        id: String,
        role: FeedMessageRole,
        content: String,
        client_message_id: Option<String>,
        attachments: Vec<TurnAttachmentInputPart>,
        references: Vec<TurnReference>,
        #[serde(default)]
        citations: Vec<CitationSource>,
        streaming: bool,
        timestamp_ms: i64,
    },
    Reasoning {
        id: String,
        content: String,
        #[serde(default = "default_reasoning_mode")]
        mode: String,
        streaming: bool,
        timestamp_ms: i64,
    },
    Tool {
        id: String,
        tool_name: String,
        title: Option<String>,
        call_id: Option<String>,
        status: ToolRunStatus,
        input: Value,
        output: Option<Value>,
        error: Option<String>,
        diff: Option<String>,
        streaming: bool,
        timestamp_ms: i64,
        completed_at_ms: Option<i64>,
        #[serde(default)]
        output_truncated: bool,
    },
    Todos {
        id: String,
        items: Vec<TodoItemView>,
        timestamp_ms: i64,
    },
    Log {
        id: String,
        level: String,
        message: String,
        timestamp_ms: i64,
    },
    Error {
        id: String,
        message: String,
        code: Option<String>,
        timestamp_ms: i64,
    },
    System {
        id: String,
        message: String,
        timestamp_ms: i64,
    },
}

/// Pending interactive server request (`ask_user` / command or file approval) on a thread.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatInteraction {
    CommandApproval {
        request_id: JsonRpcLiteId,
        item_id: String,
        command: Option<String>,
        cwd: Option<String>,
        reason: Option<String>,
        risk_code: Option<String>,
    },
    FileChangeApproval {
        request_id: JsonRpcLiteId,
        item_id: String,
        path: Option<String>,
        reason: Option<String>,
    },
    UserInput {
        request_id: JsonRpcLiteId,
        item_id: String,
        questions: Value,
    },
}

/// Summary of a child subagent attached to a thread.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadAgentSummary {
    pub agent_id: String,
    pub name: String,
    pub nickname: Option<String>,
    pub title: Option<String>,
    pub role: Option<String>,
    #[serde(default)]
    pub depth: u32,
    pub status: String,
    pub model: Option<String>,
    pub usage_label: Option<String>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub error: Option<String>,
}

/// Submission & streaming recovery state for a thread.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDeliveryFailure {
    pub message: String,
    pub recoverable: bool,
}

/// Source-task lock banner metadata when a thread was spawned from a scheduled/background task.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTaskLock {
    pub task_id: String,
    pub task_title: String,
    pub read_only: bool,
}

/// Queued steer preview while a turn is active.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSteerState {
    pub text: String,
    pub client_message_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSubmissionRef {
    pub key: String,
    pub revision: u64,
    pub submission_id: String,
}

/// Queued user turn payload waiting for active turn completion or `thread/start`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingThreadMessage {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<TurnAttachmentInputPart>,
    #[serde(default)]
    pub references: Vec<TurnReference>,
    pub client_message_id: Option<String>,
    pub draft_submission: Option<DraftSubmissionRef>,
}

/// Pending in-flight `turn/start` state tracked on `ThreadRuntime`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPendingTurnStart {
    pub client_message_id: String,
    pub text: String,
    pub status: String,
}

/// Submission status shown by composer feedback banners.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSubmissionState {
    pub submission_id: String,
    pub client_message_id: String,
    pub phase: String,
    pub delivery: String,
    pub error: Option<String>,
}

/// Optional read-only notice banner shown inside task-owned or read-only threads.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatViewReadOnlyNotice {
    pub id: Option<String>,
    pub title: String,
    pub detail: String,
}

/// Live runtime state per thread.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRuntime {
    pub hydrated: bool,
    pub hydrating: bool,
    #[serde(default)]
    pub transcript_only: bool,
    pub streaming: bool,
    pub active_turn_id: Option<String>,
    pub pending_turn_count: usize,
    pub pending_turn_start: Option<ThreadPendingTurnStart>,
    pub pending_steer: Option<PendingSteerState>,
    pub composer_submission: Option<ComposerSubmissionState>,
    pub attachment_ingesting: bool,
    pub feed: Vec<FeedItem>,
    pub pending_interactions: Vec<ChatInteraction>,
    #[serde(default)]
    pub interaction_errors: HashMap<String, String>,
    pub agents: Vec<ThreadAgentSummary>,
    pub agent_run_feeds: HashMap<String, Vec<FeedItem>>,
    pub todos: Vec<TodoItemView>,
    pub unread: bool,
    pub usage: Option<UsageSummary>,
    pub usage_hard_cap: Option<f64>,
    pub usage_hard_cap_reached: bool,
    pub transcript_delivery_failure: Option<TranscriptDeliveryFailure>,
    pub source_task: Option<SourceTaskLock>,
    pub read_only_notice: Option<ChatViewReadOnlyNotice>,
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_event_seq: u64,
}

/// Draft state for a thread composer or new-chat composer.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerDraft {
    pub text: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffortValue>,
    pub attachments: Vec<TurnAttachmentInputPart>,
    pub references: Vec<TurnReference>,
    pub busy_policy: ThreadBusyPolicy,
    pub submission_error: Option<String>,
    pub submitting: bool,
}

/// LM Studio quick-start modal state used from model/chat flows.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LmStudioStartModalState {
    pub workspace_id: String,
    pub thread_id: Option<String>,
    pub base_url: Option<String>,
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub can_auto_start: bool,
    pub starting: bool,
    pub error: Option<String>,
}

/// Currently inspected child subagent in `AgentRunViewer`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentViewerState {
    pub thread_id: String,
    pub agent_id: String,
    pub title: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationTone {
    #[default]
    Info,
    Success,
    Warning,
    Error,
}

/// In-app toast notification record rendered by `views/shell`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub key: String,
    pub title: String,
    pub description: Option<String>,
    pub tone: NotificationTone,
    pub created_at_secs: u64,
}

/// Long-running operation indicator displayed by `views/shell` and `views/settings`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationState {
    pub key: String,
    pub label: String,
    pub busy: bool,
    pub error: Option<String>,
}

/// File explorer entry displayed in the context sidebar.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
    pub git_status: Option<String>,
}

/// File preview modal payload.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreviewState {
    pub workspace_id: String,
    pub path: String,
    pub title: String,
    pub content: Option<String>,
    pub is_binary: bool,
    pub is_markdown: bool,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSummary {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub custom: bool,
    pub supports_reasoning: bool,
    #[serde(default)]
    pub reasoning_efforts: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub id: String,
    pub name: String,
    pub configured: bool,
    pub models: Vec<ProviderModelSummary>,
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub capabilities: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatusSummary {
    pub provider: String,
    pub healthy: bool,
    #[serde(default)]
    pub connected: bool,
    pub auth_method: Option<String>,
    pub detail: Option<String>,
    #[serde(default)]
    pub saved_api_key_mask: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default)]
    pub rate_limits: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub name: String,
    pub enabled: bool,
    pub transport: String,
    pub status: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub auth_status: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    pub config: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    pub scope: String,
    pub enabled: bool,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub update_available: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub installation_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub version: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub update_available: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub skill_count: usize,
    #[serde(default)]
    pub mcp_count: usize,
    #[serde(default)]
    pub subagent_count: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub system_prompt: String,
    #[serde(default)]
    pub tool_preset: Option<String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub denied_tools: Vec<String>,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub key: String,
    pub content: String,
    pub updated_at: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummaryView {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub status: String,
    pub schedule: Option<String>,
    pub last_run_at: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactView {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecordView {
    pub summary: TaskSummaryView,
    pub prompt: String,
    pub questions: Value,
    pub artifacts: Vec<TaskArtifactView>,
    pub runs: Vec<WorkflowRunView>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunView {
    pub id: String,
    pub workflow_name: String,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedThreadSummary {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub archived_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedPhoneSummary {
    pub id: String,
    pub name: String,
    pub paired_at: i64,
    pub permissions: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessState {
    pub available: bool,
    pub running: bool,
    pub pairing_url: Option<String>,
    pub trusted_phones: Vec<TrustedPhoneSummary>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub relay_url: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterState {
    pub status: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub current_version: String,
    #[serde(default)]
    pub available_version: Option<String>,
    #[serde(default)]
    pub download_progress: Option<f32>,
    #[serde(default)]
    pub packaged: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    pub completed: bool,
    pub dismissed: bool,
    pub completed_steps: HashSet<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyTelemetrySettings {
    pub crash_reports_enabled: bool,
    pub product_analytics_enabled: bool,
    pub ai_trace_telemetry_enabled: bool,
    pub ai_trace_payloads_enabled: bool,
    pub diagnostics_upload_enabled: bool,
    pub cloud_sync_enabled: bool,
}

/// Persisted desktop preferences owned by `native/` persistence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub theme: ThemePreference,
    pub reduced_transparency: bool,
    pub high_contrast: bool,
    pub reduce_motion: bool,
    pub inject_context: bool,
    pub developer_mode: bool,
    pub show_hidden_files: bool,
    pub per_workspace_settings: bool,
    pub quick_chat_icon_enabled: bool,
    pub quick_chat_shortcut_enabled: bool,
    pub quick_chat_shortcut: String,
    pub archived_chats_auto_delete_days: u32,
    pub sidebar_section_order: Vec<SidebarSectionKey>,
    pub privacy_telemetry: PrivacyTelemetrySettings,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            reduced_transparency: false,
            high_contrast: false,
            reduce_motion: false,
            inject_context: true,
            developer_mode: false,
            show_hidden_files: false,
            per_workspace_settings: false,
            quick_chat_icon_enabled: true,
            quick_chat_shortcut_enabled: true,
            quick_chat_shortcut: "Option+Space".to_string(),
            archived_chats_auto_delete_days: 30,
            sidebar_section_order: vec![
                SidebarSectionKey::Pinned,
                SidebarSectionKey::Tasks,
                SidebarSectionKey::Chats,
                SidebarSectionKey::Workspaces,
            ],
            privacy_telemetry: PrivacyTelemetrySettings::default(),
        }
    }
}

/// Bundle read/written by `native/` persistence.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDesktopState {
    pub settings: DesktopSettings,
    pub workspaces: Vec<WorkspaceRecord>,
    pub workspace_order: Vec<String>,
    pub collapsed_workspace_ids: Vec<String>,
    pub active_workspace_id: Option<String>,
    pub active_thread_id: Option<String>,
    pub onboarding: OnboardingState,
    pub feature_flags: HashMap<String, bool>,
}

/// Non-serialized service handles for background workers and test capture.
pub struct AppServices {
    pub waker: Option<rune::Waker>,
    pub event_tx: mpsc::UnboundedSender<StoreEvent>,
    pub event_rx: mpsc::UnboundedReceiver<StoreEvent>,
    pub ws_tx: Option<mpsc::UnboundedSender<WsCommand>>,
    pub native_tx: Option<mpsc::UnboundedSender<NativeCommand>>,
    /// Test capture queues used when worker threads are not attached.
    pub emitted_ws_commands: Vec<WsCommand>,
    pub emitted_native_commands: Vec<NativeCommand>,
    next_rpc_id: u64,
    next_request_tag: u64,
}

impl Default for AppServices {
    fn default() -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Self {
            waker: None,
            event_tx,
            event_rx,
            ws_tx: None,
            native_tx: None,
            emitted_ws_commands: Vec::new(),
            emitted_native_commands: Vec::new(),
            next_rpc_id: 1,
            next_request_tag: 1,
        }
    }
}

/// Root reactive UI & client state rendered by Rune views.
pub struct AppState {
    pub services: AppServices,
    pub window_mode: WindowMode,
    pub nav: NavigationHistory,
    pub sidebar: PaneState,
    pub context_sidebar: PaneState,
    pub sidebar_search: String,
    pub sidebar_search_edit: TextEdit,
    pub command_palette_open: bool,
    pub command_palette_query: String,
    pub command_palette_edit: TextEdit,
    pub quick_chat_open: bool,
    pub onboarding: OnboardingState,
    pub desktop_settings: DesktopSettings,
    pub feature_flags: HashMap<String, bool>,
    pub workspaces: Vec<WorkspaceRecord>,
    pub workspace_order: Vec<String>,
    pub collapsed_workspace_ids: HashSet<String>,
    pub active_workspace_id: Option<String>,
    pub landing_workspace_id: Option<String>,
    pub workspace_runtime_by_id: HashMap<String, WorkspaceRuntime>,
    pub workspace_socket_by_id: HashMap<String, WsConnectionState>,
    pub workspace_creation_preflight: Option<CreationPreflightResult>,
    pub threads: Vec<ThreadRecord>,
    pub thread_runtime_by_id: HashMap<String, ThreadRuntime>,
    pub pending_thread_messages: HashMap<String, VecDeque<PendingThreadMessage>>,
    pub composer_drafts: HashMap<String, ComposerDraft>,
    pub composer_edit: TextEdit,
    pub agent_viewer: Option<AgentViewerState>,
    pub lmstudio_start_modal: Option<LmStudioStartModalState>,
    pub pending_external_url: Option<String>,
    pub pending_confirm_dialog: Option<ConfirmDialogRequest>,
    pub active_file_preview: Option<FilePreviewState>,
    pub toasts: Vec<NotificationRecord>,
    pub operations_by_key: HashMap<String, OperationState>,
    pub tasks: Vec<TaskSummaryView>,
    pub active_task: Option<TaskRecordView>,
    pub workflow_runs: Vec<WorkflowRunView>,
    pub explorer_entries_by_dir: HashMap<String, Vec<WorkspaceFileEntry>>,
    pub explorer_expanded_dirs: HashSet<String>,
    pub provider_catalog: Vec<ProviderSummary>,
    pub provider_auth_methods: HashMap<String, Vec<String>>,
    pub default_model_by_provider: HashMap<String, String>,
    pub last_auth_challenge: Option<Value>,
    pub codex_app_server_status: Option<Value>,
    pub mcp_servers: Vec<McpServerSummary>,
    pub marketplaces: Vec<Value>,
    pub openai_native_connectors: Vec<Value>,
    pub skills: Vec<SkillSummary>,
    pub plugins: Vec<PluginSummary>,
    pub skill_improvement_status: Option<Value>,
    pub subagents: Vec<SubagentProfile>,
    pub memory_entries: Vec<MemoryEntry>,
    pub advanced_memories: Vec<Value>,
    pub archived_threads: Vec<ArchivedThreadSummary>,
    pub backups: Vec<BackupSummary>,
    pub usage_summary: Option<UsageSummary>,
    pub usage_by_thread: HashMap<String, Value>,
    pub runtime_diagnostics: Option<RuntimeDiagnosticsReadResult>,
    pub libreoffice_status: Option<Value>,
    pub telemetry_status: Option<Value>,
    pub settings_mutation_error: Option<String>,
    pub quick_chat_shortcut_error: Option<String>,
    pub conversation_import_sources: Vec<Value>,
    pub conversation_import_preview: Option<Value>,
    pub commands_by_workspace: HashMap<String, Vec<CommandInfo>>,
    pub attachment_previews_by_key: HashMap<String, Vec<AttachmentPreviewMeta>>,
    pub image_bytes_by_request: HashMap<String, (Option<String>, Vec<u8>)>,
    pub remote_access: RemoteAccessState,
    pub updater: UpdaterState,
    pub pending_rpc_meta: HashMap<u64, PendingRpcMeta>,
    pending_draft_threads_by_rpc_id: HashMap<u64, String>,
    pending_picker_composer_by_request: HashMap<String, String>,
    pub native_ready: bool,
    pub is_packaged: bool,
    pub system_dark_override: Option<bool>,
    /// True when started under a static Rune `--scene`; prevents `NativeReady` from overwriting scene state.
    pub scene_mode: bool,
    pub now_secs: f64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            services: AppServices::default(),
            window_mode: WindowMode::Main,
            nav: NavigationHistory::default(),
            sidebar: PaneState::new(theme::layout::SIDEBAR_DEFAULT_WIDTH).range(
                theme::layout::SIDEBAR_MIN_WIDTH,
                theme::layout::SIDEBAR_MAX_WIDTH,
            ),
            context_sidebar: PaneState::new(theme::layout::CONTEXT_SIDEBAR_DEFAULT_WIDTH)
                .range(
                    theme::layout::CONTEXT_SIDEBAR_MIN_WIDTH,
                    theme::layout::CONTEXT_SIDEBAR_MAX_WIDTH,
                )
                .collapsed(),
            sidebar_search: String::new(),
            sidebar_search_edit: TextEdit::new(""),
            command_palette_open: false,
            command_palette_query: String::new(),
            command_palette_edit: TextEdit::new(""),
            quick_chat_open: false,
            onboarding: OnboardingState::default(),
            desktop_settings: DesktopSettings::default(),
            feature_flags: HashMap::new(),
            workspaces: Vec::new(),
            workspace_order: Vec::new(),
            collapsed_workspace_ids: HashSet::new(),
            active_workspace_id: None,
            landing_workspace_id: None,
            workspace_runtime_by_id: HashMap::new(),
            workspace_socket_by_id: HashMap::new(),
            workspace_creation_preflight: None,
            threads: Vec::new(),
            thread_runtime_by_id: HashMap::new(),
            pending_thread_messages: HashMap::new(),
            composer_drafts: HashMap::new(),
            composer_edit: TextEdit::new(""),
            agent_viewer: None,
            lmstudio_start_modal: None,
            pending_external_url: None,
            pending_confirm_dialog: None,
            active_file_preview: None,
            toasts: Vec::new(),
            operations_by_key: HashMap::new(),
            tasks: Vec::new(),
            active_task: None,
            workflow_runs: Vec::new(),
            explorer_entries_by_dir: HashMap::new(),
            explorer_expanded_dirs: HashSet::new(),
            provider_catalog: Vec::new(),
            provider_auth_methods: HashMap::new(),
            default_model_by_provider: HashMap::new(),
            last_auth_challenge: None,
            codex_app_server_status: None,
            mcp_servers: Vec::new(),
            marketplaces: Vec::new(),
            openai_native_connectors: Vec::new(),
            skills: Vec::new(),
            plugins: Vec::new(),
            skill_improvement_status: None,
            subagents: Vec::new(),
            memory_entries: Vec::new(),
            advanced_memories: Vec::new(),
            archived_threads: Vec::new(),
            backups: Vec::new(),
            usage_summary: None,
            usage_by_thread: HashMap::new(),
            runtime_diagnostics: None,
            libreoffice_status: None,
            telemetry_status: None,
            settings_mutation_error: None,
            quick_chat_shortcut_error: None,
            conversation_import_sources: Vec::new(),
            conversation_import_preview: None,
            commands_by_workspace: HashMap::new(),
            attachment_previews_by_key: HashMap::new(),
            image_bytes_by_request: HashMap::new(),
            remote_access: RemoteAccessState::default(),
            updater: UpdaterState::default(),
            pending_rpc_meta: HashMap::new(),
            pending_draft_threads_by_rpc_id: HashMap::new(),
            pending_picker_composer_by_request: HashMap::new(),
            native_ready: false,
            is_packaged: false,
            system_dark_override: None,
            scene_mode: false,
            now_secs: 0.0,
        }
    }
}

impl AppState {
    pub fn route(&self) -> &NavigationSnapshot {
        self.nav.current()
    }

    pub fn effective_dark(&self, system_dark: bool) -> bool {
        let os_dark = self.system_dark_override.unwrap_or(system_dark);
        self.desktop_settings.theme.is_dark(os_dark)
    }

    pub fn active_workspace(&self) -> Option<&WorkspaceRecord> {
        let id = self.active_workspace_id.as_deref()?;
        self.workspaces.iter().find(|w| w.id == id)
    }

    /// Returns workspaces ordered for display (non-archived, respecting `workspace_order`).
    pub fn resolve_workspace_display_targets(&self) -> Vec<&WorkspaceRecord> {
        let mut by_id: HashMap<&str, &WorkspaceRecord> = self
            .workspaces
            .iter()
            .filter(|w| !w.archived)
            .map(|w| (w.id.as_str(), w))
            .collect();
        let mut out = Vec::with_capacity(by_id.len());
        for id in &self.workspace_order {
            if let Some(ws) = by_id.remove(id.as_str()) {
                out.push(ws);
            }
        }
        for ws in &self.workspaces {
            if !ws.archived && by_id.remove(ws.id.as_str()).is_some() {
                out.push(ws);
            }
        }
        out
    }

    /// Resolves the workspace ID targeted by global/workspace management actions.
    pub fn resolve_management_workspace_id(&self) -> Option<&str> {
        if let Some(id) = self.active_workspace_id.as_deref()
            && self.workspaces.iter().any(|w| w.id == id && !w.archived)
        {
            return Some(id);
        }
        self.resolve_workspace_display_targets()
            .first()
            .map(|w| w.id.as_str())
    }

    pub fn active_thread(&self) -> Option<&ThreadRecord> {
        let id = self.nav.current().active_thread_id.as_deref()?;
        self.threads.iter().find(|t| t.id == id)
    }

    pub fn active_thread_runtime(&self) -> Option<&ThreadRuntime> {
        let id = self.nav.current().active_thread_id.as_deref()?;
        self.thread_runtime_by_id.get(id)
    }

    pub fn composer_key(&self) -> String {
        self.nav
            .current()
            .active_thread_id
            .clone()
            .unwrap_or_else(|| "__new__".to_string())
    }

    /// Emits a `NativeCommand` to the attached native worker (or test buffer).
    pub fn send_native(&mut self, cmd: NativeCommand) {
        if let Some(ref tx) = self.services.native_tx {
            let _ = tx.send(cmd);
        } else {
            self.services.emitted_native_commands.push(cmd);
        }
    }

    /// Emits a `WsCommand` to the attached WS manager (or test buffer).
    pub fn send_ws(&mut self, cmd: WsCommand) {
        if let Some(ref tx) = self.services.ws_tx {
            let _ = tx.send(cmd);
        } else {
            self.services.emitted_ws_commands.push(cmd);
        }
    }

    /// Sends a typed JSON-RPC request to `workspace_id` and records correlation metadata.
    pub fn send_ws_request(
        &mut self,
        workspace_id: &str,
        method: &str,
        params: Value,
        retry_on_disconnect: bool,
    ) -> u64 {
        let request_id = self.services.next_rpc_id;
        self.services.next_rpc_id += 1;
        self.pending_rpc_meta.insert(
            request_id,
            PendingRpcMeta {
                workspace_id: workspace_id.to_string(),
                method: method.to_string(),
            },
        );
        self.send_ws(WsCommand::SendRequest {
            workspace_id: workspace_id.to_string(),
            request_id,
            method: method.to_string(),
            params,
            timeout_ms: None,
            retry_on_disconnect,
        });
        request_id
    }

    /// Serializes typed `cowork-protocol` params and sends a JSON-RPC request.
    pub fn send_ws_typed<P: Serialize>(
        &mut self,
        workspace_id: &str,
        method: &str,
        params: &P,
        retry_on_disconnect: bool,
    ) -> Option<u64> {
        let value = serde_json::to_value(params).ok()?;
        Some(self.send_ws_request(workspace_id, method, value, retry_on_disconnect))
    }

    fn next_tag(&mut self, prefix: &str) -> String {
        let id = self.services.next_request_tag;
        self.services.next_request_tag += 1;
        format!("{prefix}-{id}")
    }

    /// Enqueues a pending user message (`runtimeState` parity), ignoring empty/reference-only items.
    pub fn queue_pending_thread_message(
        &mut self,
        thread_id: &str,
        mut msg: PendingThreadMessage,
        prepend: bool,
    ) {
        let trimmed = msg.text.trim().to_string();
        if trimmed.is_empty() && msg.attachments.is_empty() {
            return;
        }
        msg.text = trimmed;
        let queue = self
            .pending_thread_messages
            .entry(thread_id.to_string())
            .or_default();
        if prepend {
            queue.push_front(msg);
        } else {
            queue.push_back(msg);
        }
    }

    /// Pops the next queued message for `thread_id`, pruning the map entry once empty.
    pub fn shift_pending_thread_message(
        &mut self,
        thread_id: &str,
    ) -> Option<PendingThreadMessage> {
        let queue = self.pending_thread_messages.get_mut(thread_id)?;
        let item = queue.pop_front();
        if queue.is_empty() {
            self.pending_thread_messages.remove(thread_id);
        }
        item
    }

    /// Rekeys runtime maps, pending queue, drafts, and nav pointers from `old_id` to `new_id`.
    /// Existing destination queue entries stay intact rather than merging queues.
    pub fn rekey_thread_runtime_maps(&mut self, old_id: &str, new_id: &str) {
        if old_id == new_id {
            return;
        }
        if let Some(old_rt) = self.thread_runtime_by_id.remove(old_id) {
            self.thread_runtime_by_id
                .entry(new_id.to_string())
                .or_insert(old_rt);
        }
        if let Some(old_q) = self.pending_thread_messages.remove(old_id)
            && !self.pending_thread_messages.contains_key(new_id)
            && !old_q.is_empty()
        {
            self.pending_thread_messages
                .insert(new_id.to_string(), old_q);
        }
        if let Some(old_draft) = self.composer_drafts.remove(old_id) {
            self.composer_drafts
                .entry(new_id.to_string())
                .or_insert(old_draft);
        }
        if let Some(old_previews) = self.attachment_previews_by_key.remove(old_id) {
            self.attachment_previews_by_key
                .entry(new_id.to_string())
                .or_insert(old_previews);
        }
        if let Some(usage) = self.usage_by_thread.remove(old_id) {
            self.usage_by_thread
                .entry(new_id.to_string())
                .or_insert(usage);
        }
        if self.nav.current().active_thread_id.as_deref() == Some(old_id) {
            let mut cur = self.nav.current().clone();
            cur.active_thread_id = Some(new_id.to_string());
            self.nav.replace_current(cur);
        }
    }

    /// Persists the current `composer_edit` text under `old_key` and loads `new_key`'s draft text.
    fn sync_composer_edit_across_switch(&mut self, old_key: &str, new_key: &str) {
        if old_key == new_key {
            return;
        }
        let current_text = self.composer_edit.text.clone();
        if !current_text.is_empty() || self.composer_drafts.contains_key(old_key) {
            self.composer_drafts
                .entry(old_key.to_string())
                .or_default()
                .text = current_text;
        }
        let next_text = self
            .composer_drafts
            .get(new_key)
            .map(|d| d.text.as_str())
            .unwrap_or("");
        self.composer_edit = TextEdit::new(next_text);
    }

    fn attach_bytes_to_composer(
        &mut self,
        key: &str,
        filename: String,
        mime_type: String,
        bytes: &[u8],
    ) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        if mime_type.starts_with("image/") {
            let (width, height) = probe_image_dimensions(bytes)
                .map(|(w, h)| (Some(w), Some(h)))
                .unwrap_or((None, None));
            let data_url = Some(format!("data:{mime_type};base64,{encoded}"));
            self.attachment_previews_by_key
                .entry(key.to_string())
                .or_default()
                .push(AttachmentPreviewMeta {
                    filename: filename.clone(),
                    mime_type: mime_type.clone(),
                    data_url,
                    width,
                    height,
                });
        }
        self.composer_drafts
            .entry(key.to_string())
            .or_default()
            .attachments
            .push(TurnAttachmentInputPart::InlineFile {
                filename,
                content_base64: encoded,
                mime_type,
            });
    }

    fn ingest_composer_paths(&mut self, key: &str, paths: Vec<PathBuf>) {
        const MAX_INLINE_BYTES: u64 = 10 * 1024 * 1024;
        for path in paths {
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("attachment")
                .to_string();
            let mime_type = mime_type_for_path(&path).to_string();
            let meta = std::fs::metadata(&path).ok();
            if meta.is_some_and(|m| m.is_file() && m.len() <= MAX_INLINE_BYTES)
                && let Ok(bytes) = std::fs::read(&path)
            {
                self.attach_bytes_to_composer(key, filename, mime_type, &bytes);
                continue;
            }
            self.composer_drafts
                .entry(key.to_string())
                .or_default()
                .attachments
                .push(TurnAttachmentInputPart::UploadedFile {
                    filename,
                    path: path.to_string_lossy().to_string(),
                    mime_type,
                });
        }
    }

    /// Filters non-draft, non-task threads suitable for desktop persistence (`persistence.ts` parity).
    pub fn persistable_threads(&self) -> Vec<ThreadRecord> {
        self.threads
            .iter()
            .filter(|t| !t.draft && t.source_task_id.is_none())
            .cloned()
            .collect()
    }

    /// Drains all queued `StoreEvent` values pushed by background workers.
    /// Returns `true` if any state changed.
    pub fn drain_events(&mut self) -> bool {
        let mut changed = false;
        while let Ok(event) = self.services.event_rx.try_recv() {
            self.apply_store_event(event);
            changed = true;
        }
        changed
    }

    /// Applies an asynchronous `StoreEvent` onto `AppState`.
    pub fn apply_store_event(&mut self, event: StoreEvent) {
        match event {
            StoreEvent::NativeReady {
                persisted,
                is_packaged,
                system_dark,
            } => {
                self.native_ready = true;
                self.is_packaged = is_packaged;
                self.updater.packaged = is_packaged;
                if self.scene_mode {
                    return;
                }
                if let Some(dark) = system_dark {
                    self.system_dark_override = Some(dark);
                }
                self.desktop_settings = persisted.settings;
                self.onboarding = persisted.onboarding;
                self.feature_flags = persisted.feature_flags;
                self.workspaces = persisted.workspaces;
                self.workspace_order = persisted.workspace_order;
                self.collapsed_workspace_ids =
                    persisted.collapsed_workspace_ids.into_iter().collect();
                self.active_workspace_id = persisted.active_workspace_id;
                if let Some(thread_id) = persisted.active_thread_id {
                    self.nav.replace_current(NavigationSnapshot {
                        view: ViewId::Chat,
                        settings_page: self.nav.current().settings_page,
                        last_non_settings_view: ViewId::Chat,
                        active_thread_id: Some(thread_id),
                        ..NavigationSnapshot::default()
                    });
                }
                let start_ws = self
                    .active_workspace_id
                    .as_deref()
                    .and_then(|id| self.workspaces.iter().find(|w| w.id == id && !w.archived))
                    .or_else(|| self.workspaces.iter().find(|w| !w.archived))
                    .map(|w| (w.id.clone(), w.path.clone(), w.yolo));
                if let Some((workspace_id, path, yolo)) = start_ws {
                    self.active_workspace_id = Some(workspace_id.clone());
                    self.send_native(NativeCommand::StartWorkspaceServer {
                        workspace_id,
                        path,
                        yolo,
                    });
                }
            }
            StoreEvent::SystemAppearanceChanged { system_dark } => {
                self.system_dark_override = Some(system_dark);
            }
            StoreEvent::FolderPicked {
                path: Some(path), ..
            } => {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string());
                self.dispatch(Action::Native(NativeAction::AddWorkspace { path, name }));
            }
            StoreEvent::FolderPicked { path: None, .. } => {}
            StoreEvent::FilesPicked { request_id, paths } => {
                if let Some(key) = self.pending_picker_composer_by_request.remove(&request_id) {
                    self.ingest_composer_paths(&key, paths);
                }
            }
            StoreEvent::WorkspaceAdded(workspace) => {
                let workspace_id = workspace.id.clone();
                let path = workspace.path.clone();
                let yolo = workspace.yolo;
                if let Some(existing) = self.workspaces.iter_mut().find(|w| w.id == workspace_id) {
                    *existing = workspace;
                } else {
                    self.workspaces.push(workspace);
                    self.workspace_order.push(workspace_id.clone());
                }
                self.active_workspace_id = Some(workspace_id.clone());
                self.send_native(NativeCommand::StartWorkspaceServer {
                    workspace_id,
                    path,
                    yolo,
                });
            }
            StoreEvent::WorkspaceFilesListed { dir, entries, .. } => {
                self.explorer_entries_by_dir.insert(dir, entries);
            }
            StoreEvent::FilePreviewLoaded { path, result, .. } => match result {
                Ok(preview) => self.active_file_preview = Some(preview),
                Err(err) => {
                    if let Some(ref mut preview) = self.active_file_preview
                        && preview.path == path
                    {
                        preview.error = Some(err);
                    }
                }
            },
            StoreEvent::ImageBytesLoaded {
                request_id,
                mime_type,
                result,
            } => {
                if let Ok(bytes) = result {
                    self.image_bytes_by_request
                        .insert(request_id, (mime_type, bytes));
                }
            }
            StoreEvent::ServerStarting {
                workspace_id,
                stage,
                message,
            } => {
                let rt = self
                    .workspace_runtime_by_id
                    .entry(workspace_id)
                    .or_default();
                rt.server_state = ServerLifecycleState::Starting { stage, message };
            }
            StoreEvent::ServerListening {
                workspace_id,
                ws_url,
                port,
                browser_access_token,
            } => {
                let rt = self
                    .workspace_runtime_by_id
                    .entry(workspace_id.clone())
                    .or_default();
                rt.server_state = ServerLifecycleState::Running {
                    ws_url: ws_url.clone(),
                    port,
                };
                self.send_ws(WsCommand::ConnectWorkspace {
                    workspace_id,
                    ws_url,
                    browser_access_token,
                });
            }
            StoreEvent::ServerExited {
                workspace_id,
                code,
                message,
            } => {
                let rt = self
                    .workspace_runtime_by_id
                    .entry(workspace_id.clone())
                    .or_default();
                rt.server_state = ServerLifecycleState::Failed {
                    message: message.unwrap_or_else(|| format!("Server exited ({code:?})")),
                };
                self.send_ws(WsCommand::DisconnectWorkspace { workspace_id });
            }
            StoreEvent::WsStateChanged {
                workspace_id,
                state,
            } => {
                let reconnecting = matches!(state, WsConnectionState::Reconnecting { .. });
                let attempt = match &state {
                    WsConnectionState::Reconnecting { attempt, .. } => *attempt,
                    _ => 0,
                };
                self.workspace_socket_by_id
                    .insert(workspace_id.clone(), state);
                let rt = self
                    .workspace_runtime_by_id
                    .entry(workspace_id)
                    .or_default();
                rt.reconnecting = reconnecting;
                rt.reconnect_attempt = attempt;
            }
            StoreEvent::WsInitialized {
                workspace_id,
                result,
            } => {
                self.apply_ws_initialized(&workspace_id, *result);
            }
            StoreEvent::WsNotification {
                workspace_id,
                method,
                params,
            } => {
                self.apply_ws_notification(&workspace_id, &method, params);
            }
            StoreEvent::WsServerRequest {
                workspace_id,
                id,
                method,
                params,
            } => {
                self.apply_ws_server_request(&workspace_id, id, &method, params);
            }
            StoreEvent::WsResponse {
                workspace_id,
                request_id,
                method,
                result,
            } => {
                self.pending_rpc_meta.remove(&request_id);
                self.apply_ws_response(&workspace_id, request_id, &method, result);
            }
            StoreEvent::WsInvalidMessage {
                workspace_id,
                message,
            } => {
                let rt = self
                    .workspace_runtime_by_id
                    .entry(workspace_id)
                    .or_default();
                rt.last_error = Some(message);
            }
            StoreEvent::UpdaterChanged(updater) => {
                self.updater = updater;
            }
            StoreEvent::RemoteAccessChanged(remote) => {
                self.remote_access = remote;
            }
            StoreEvent::TelemetryStatusChanged(status) => {
                self.telemetry_status = Some(status);
            }
            StoreEvent::QuickChatShortcutStatus { error } => {
                self.quick_chat_shortcut_error = error;
            }
            StoreEvent::Toast {
                key,
                title,
                description,
                tone,
            } => {
                self.dispatch(Action::Shell(ShellAction::PushToast {
                    key,
                    title,
                    description,
                    tone,
                }));
            }
            StoreEvent::MenuInvoked(command_id) => match command_id.as_str() {
                "settings" => self.dispatch(Action::Navigate(NavAction::OpenSettings(None))),
                "open_skills" => self.dispatch(Action::Navigate(NavAction::OpenSettingsIntent {
                    page: SettingsPageId::ToolAccess,
                    tab: Some("skills".to_string()),
                    section: None,
                    new_provider: false,
                })),
                "open_updates" => self.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
                    SettingsPageId::Updates,
                )))),
                "new_chat" => {
                    let ws = self.active_workspace_id.clone();
                    self.dispatch(Action::Navigate(NavAction::OpenNewChat {
                        workspace_id: ws,
                    }));
                }
                "toggle_sidebar" => self.dispatch(Action::Shell(ShellAction::ToggleSidebar)),
                "command_palette" => {
                    self.dispatch(Action::Shell(ShellAction::ToggleCommandPalette));
                }
                _ => {}
            },
            StoreEvent::QuickChatToggled => {
                self.quick_chat_open = !self.quick_chat_open;
            }
            StoreEvent::DeepLink(_url) => {}
        }
    }

    /// Synchronous state transition entrypoint called by views, keyboard shortcuts, and tests.
    pub fn dispatch(&mut self, action: Action) {
        match action {
            Action::Navigate(nav) => self.reduce_nav(nav),
            Action::Shell(shell) => self.reduce_shell(shell),
            Action::Chat(chat) => self.reduce_chat(chat),
            Action::Settings(settings) => self.reduce_settings(settings),
            Action::Native(native) => self.reduce_native(native),
        }
    }

    fn reduce_nav(&mut self, action: NavAction) {
        match action {
            NavAction::OpenView(view) => {
                self.nav.update(NavigationPatch {
                    view: Some(view),
                    ..Default::default()
                });
            }
            NavAction::OpenThread(thread_id) => {
                let old_key = self.composer_key();
                if let Some(ws_id) = self
                    .threads
                    .iter()
                    .find(|t| t.id == thread_id)
                    .map(|t| t.workspace_id.clone())
                {
                    self.active_workspace_id = Some(ws_id);
                }
                if let Some(rt) = self.thread_runtime_by_id.get_mut(&thread_id) {
                    rt.unread = false;
                }
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Chat),
                    active_thread_id: Some(Some(thread_id.clone())),
                    ..Default::default()
                });
                let new_key = self.composer_key();
                self.sync_composer_edit_across_switch(&old_key, &new_key);
                let needs_hydrate = self
                    .thread_runtime_by_id
                    .get(&thread_id)
                    .is_none_or(|rt| !rt.hydrated && !rt.hydrating);
                if needs_hydrate
                    && self
                        .threads
                        .iter()
                        .find(|t| t.id == thread_id)
                        .is_some_and(|t| !t.draft)
                {
                    self.dispatch(Action::Chat(ChatAction::HydrateThread(thread_id)));
                }
            }
            NavAction::OpenNewChat { workspace_id } => {
                let old_key = self.composer_key();
                if let Some(ws_id) = workspace_id {
                    self.active_workspace_id = Some(ws_id.clone());
                    self.landing_workspace_id = Some(ws_id);
                }
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Chat),
                    active_thread_id: Some(None),
                    ..Default::default()
                });
                let new_key = self.composer_key();
                self.sync_composer_edit_across_switch(&old_key, &new_key);
            }
            NavAction::OpenTask(task_id) => {
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Task),
                    active_task_id: Some(Some(task_id)),
                    ..Default::default()
                });
            }
            NavAction::OpenSettings(page) => {
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Settings),
                    settings_page: page.map(SettingsPageId::canonical),
                    settings_tab: Some(None),
                    settings_section: Some(None),
                    new_provider_intent: Some(false),
                    ..Default::default()
                });
            }
            NavAction::OpenSettingsIntent {
                page,
                tab,
                section,
                new_provider,
            } => {
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Settings),
                    settings_page: Some(page.canonical()),
                    settings_tab: Some(tab),
                    settings_section: Some(section),
                    new_provider_intent: Some(new_provider),
                    ..Default::default()
                });
            }
            NavAction::SelectWorkspace(workspace_id) => {
                self.active_workspace_id = Some(workspace_id);
            }
            NavAction::GoBack => {
                self.nav.go_back();
            }
            NavAction::GoForward => {
                self.nav.go_forward();
            }
            NavAction::Replace(snapshot) => {
                self.nav.replace_current(snapshot);
            }
        }
    }

    fn reduce_shell(&mut self, action: ShellAction) {
        match action {
            ShellAction::SetWindowMode(mode) => self.window_mode = mode,
            ShellAction::ToggleSidebar => self.sidebar.toggle(),
            ShellAction::SetSidebarOpen(open) => self.sidebar.set_open(open),
            ShellAction::ToggleContextSidebar => self.context_sidebar.toggle(),
            ShellAction::SetContextSidebarOpen(open) => self.context_sidebar.set_open(open),
            ShellAction::SetSidebarSearch(query) => {
                self.sidebar_search = query;
            }
            ShellAction::SetSidebarSectionOrder(order) => {
                self.desktop_settings.sidebar_section_order = order;
                self.persist_state();
            }
            ShellAction::ToggleWorkspaceCollapsed(ws_id) => {
                if !self.collapsed_workspace_ids.remove(&ws_id) {
                    self.collapsed_workspace_ids.insert(ws_id);
                }
                self.persist_state();
            }
            ShellAction::ReorderWorkspaces(order) => {
                self.workspace_order = order;
                self.persist_state();
            }
            ShellAction::ToggleCommandPalette => {
                self.command_palette_open = !self.command_palette_open;
            }
            ShellAction::SetCommandPaletteOpen(open) => {
                self.command_palette_open = open;
            }
            ShellAction::SetCommandPaletteQuery(query) => {
                self.command_palette_query = query;
            }
            ShellAction::ToggleQuickChat => {
                self.quick_chat_open = !self.quick_chat_open;
            }
            ShellAction::SetQuickChatOpen(open) => {
                self.quick_chat_open = open;
            }
            ShellAction::SetTheme(theme) => {
                self.desktop_settings.theme = theme;
                self.persist_state();
            }
            ShellAction::PushToast {
                key,
                title,
                description,
                tone,
            } => {
                self.toasts.retain(|t| t.key != key);
                self.toasts.push(NotificationRecord {
                    key,
                    title,
                    description,
                    tone,
                    created_at_secs: self.now_secs.max(0.0) as u64,
                });
            }
            ShellAction::DismissToast(key) => {
                self.toasts.retain(|t| t.key != key);
            }
            ShellAction::CompleteOnboardingStep(step) => {
                self.onboarding.completed_steps.insert(step);
                self.persist_state();
            }
            ShellAction::SkipOnboarding => {
                self.onboarding.dismissed = true;
                self.onboarding.completed = true;
                self.persist_state();
            }
            ShellAction::OpenFilePreview(preview) => {
                self.active_file_preview = Some(preview);
            }
            ShellAction::CloseFilePreview => {
                self.active_file_preview = None;
            }
            ShellAction::SetLandingWorkspace(ws_id) => {
                self.landing_workspace_id = ws_id;
            }
            ShellAction::RequestExternalUrl(url) => {
                self.pending_external_url = Some(url);
            }
            ShellAction::ConfirmExternalUrl => {
                if let Some(url) = self.pending_external_url.take() {
                    self.send_native(NativeCommand::OpenExternalUrl(url));
                }
            }
            ShellAction::DismissExternalUrl => {
                self.pending_external_url = None;
            }
            ShellAction::OpenLmStudioStartModal(modal) => {
                self.lmstudio_start_modal = Some(modal);
            }
            ShellAction::DismissLmStudioStartModal => {
                self.lmstudio_start_modal = None;
            }
            ShellAction::RequestConfirmDialog(req) => {
                self.pending_confirm_dialog = Some(req);
            }
            ShellAction::ResolveConfirmDialog { .. } => {
                self.pending_confirm_dialog = None;
            }
            ShellAction::RepairCreationReadiness {
                action,
                workspace_id,
            } => {
                let ws_id = workspace_id
                    .or_else(|| self.resolve_management_workspace_id().map(str::to_string));
                let cwd = ws_id.as_deref().and_then(|id| self.workspace_path(id));
                match action {
                    CreationRepairAction::ConnectProvider { provider }
                    | CreationRepairAction::OpenProviderSettings { provider } => {
                        self.dispatch(Action::Navigate(NavAction::OpenSettingsIntent {
                            page: SettingsPageId::Models,
                            tab: None,
                            section: Some(provider),
                            new_provider: true,
                        }));
                    }
                    CreationRepairAction::StartLmStudio {
                        base_url,
                        can_auto_start,
                    } => {
                        if let Some(ws) = ws_id {
                            if can_auto_start {
                                let params = ProviderLmStudioLocalStartParams {
                                    cwd,
                                    base_url: Some(base_url),
                                    timeout_ms: None,
                                };
                                let _ = self.send_ws_typed(
                                    &ws,
                                    "cowork/provider/lmstudio/local/start",
                                    &params,
                                    false,
                                );
                            } else {
                                self.lmstudio_start_modal = Some(LmStudioStartModalState {
                                    workspace_id: ws,
                                    thread_id: self.nav.current().active_thread_id.clone(),
                                    base_url: Some(base_url),
                                    installed: true,
                                    can_auto_start,
                                    starting: false,
                                    error: None,
                                });
                            }
                        }
                    }
                    CreationRepairAction::InstallCodexRuntime => {
                        if let Some(ws) = ws_id {
                            let params = ProviderCodexAppServerUpdateParams {
                                cwd,
                                force: Some(false),
                            };
                            let _ = self.send_ws_typed(
                                &ws,
                                "cowork/provider/codexAppServer/update",
                                &params,
                                false,
                            );
                        }
                    }
                }
            }
        }
    }

    fn reduce_chat(&mut self, action: ChatAction) {
        match action {
            ChatAction::SelectThread(thread_id) => {
                self.dispatch(Action::Navigate(NavAction::OpenThread(thread_id)));
            }
            ChatAction::SetComposerDraftText { key, text } => {
                if key == self.composer_key() && self.composer_edit.text != text {
                    self.composer_edit = TextEdit::new(&text);
                }
                self.composer_drafts.entry(key).or_default().text = text;
            }
            ChatAction::SetComposerDraftModel {
                key,
                provider,
                model,
            } => {
                let draft = self.composer_drafts.entry(key).or_default();
                draft.provider = Some(provider);
                draft.model = Some(model);
            }
            ChatAction::SetComposerDraftEffort { key, effort } => {
                self.composer_drafts
                    .entry(key)
                    .or_default()
                    .reasoning_effort = effort;
            }
            ChatAction::AddComposerAttachment { key, attachment } => {
                self.composer_drafts
                    .entry(key)
                    .or_default()
                    .attachments
                    .push(attachment);
            }
            ChatAction::RemoveComposerAttachment { key, index } => {
                if let Some(draft) = self.composer_drafts.get_mut(&key)
                    && index < draft.attachments.len()
                {
                    draft.attachments.remove(index);
                }
                if let Some(previews) = self.attachment_previews_by_key.get_mut(&key)
                    && index < previews.len()
                {
                    previews.remove(index);
                }
            }
            ChatAction::ClearComposerDraft(key) => {
                self.composer_drafts.remove(&key);
                self.attachment_previews_by_key.remove(&key);
                if key == self.composer_key() {
                    self.composer_edit = TextEdit::new("");
                }
            }
            ChatAction::SendMessage {
                thread_id,
                text,
                busy_policy,
                attachments,
                references,
            } => {
                self.submit_chat_message(thread_id, text, busy_policy, attachments, references);
            }
            ChatAction::CancelTurn {
                thread_id,
                include_subagents,
            } => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = TurnInterruptParams {
                        thread_id,
                        include_subagents: Some(include_subagents),
                    };
                    let _ = self.send_ws_typed(&ws_id, "turn/interrupt", &params, false);
                }
            }
            ChatAction::ClearThreadUsageHardCap(thread_id) => {
                if let Some(rt) = self.thread_runtime_by_id.get_mut(&thread_id) {
                    rt.usage_hard_cap_reached = false;
                }
            }
            ChatAction::HydrateThread(thread_id) => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let after_seq = {
                        let rt = self
                            .thread_runtime_by_id
                            .entry(thread_id.clone())
                            .or_default();
                        rt.hydrating = true;
                        (rt.last_event_seq > 0).then_some(rt.last_event_seq)
                    };
                    let params = ThreadHydrateParams {
                        thread_id: thread_id.clone(),
                        after_seq,
                        include_turns: Some(true),
                    };
                    let _ = self.send_ws_typed(&ws_id, "thread/hydrate", &params, true);
                    let cmd_params = CommandListParams { thread_id };
                    let _ = self.send_ws_typed(&ws_id, "command/list", &cmd_params, true);
                }
            }
            ChatAction::CreateThread {
                workspace_id,
                title: _,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let client_thread_id = Some(self.next_tag("client-thread"));
                let (provider, model) = self
                    .workspaces
                    .iter()
                    .find(|w| w.id == workspace_id)
                    .map(|w| (w.default_provider.clone(), w.default_model.clone()))
                    .unwrap_or((None, None));
                let params = ThreadStartParams {
                    cwd,
                    client_thread_id,
                    provider,
                    model,
                };
                let _ = self.send_ws_typed(&workspace_id, "thread/start", &params, false);
            }
            ChatAction::RenameThread { thread_id, title } => {
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.title = title.clone();
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = SessionTitleSetParams { thread_id, title };
                    let _ = self.send_ws_typed(&ws_id, "cowork/session/title/set", &params, false);
                }
            }
            ChatAction::SetThreadPinned { thread_id, pinned } => {
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.pinned = pinned;
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = ThreadPinnedSetParams { thread_id, pinned };
                    let _ = self.send_ws_typed(&ws_id, "thread/pinned/set", &params, false);
                }
            }
            ChatAction::ArchiveThread(thread_id) => {
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.archived = true;
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = ThreadArchivedSetParams {
                        thread_id,
                        archived: true,
                    };
                    let _ = self.send_ws_typed(&ws_id, "thread/archived/set", &params, false);
                }
            }
            ChatAction::RestoreThread(thread_id) => {
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.archived = false;
                }
                self.archived_threads.retain(|t| t.id != thread_id);
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = ThreadArchivedSetParams {
                        thread_id,
                        archived: false,
                    };
                    let _ = self.send_ws_typed(&ws_id, "thread/archived/set", &params, false);
                }
            }
            ChatAction::DeleteThread(thread_id) => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let cwd = self.workspace_path(&ws_id);
                    let params = SessionDeleteParams {
                        cwd,
                        target_session_id: thread_id,
                    };
                    let _ = self.send_ws_typed(&ws_id, "cowork/session/delete", &params, false);
                }
            }
            ChatAction::ForkThread { thread_id, .. } => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = ThreadForkParams {
                        thread_id,
                        environment: None,
                        title: None,
                        prompt: None,
                        model: None,
                        thinking: None,
                    };
                    let _ = self.send_ws_typed(&ws_id, "thread/fork", &params, false);
                }
            }
            ChatAction::SetThreadModel {
                thread_id,
                provider,
                model,
            } => {
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.provider = Some(provider.clone());
                    t.model = Some(model.clone());
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = SessionModelSetParams {
                        thread_id,
                        provider: Some(provider),
                        model,
                    };
                    let _ = self.send_ws_typed(&ws_id, "cowork/session/model/set", &params, false);
                }
            }
            ChatAction::SetThreadReasoningEffort {
                thread_id,
                provider,
                effort,
            } => {
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.reasoning_effort = Some(effort.as_str().to_string());
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let mut config = Map::new();
                    config.insert(
                        "providerOptions".to_string(),
                        json!({
                            provider: {
                                "reasoningEffort": effort.as_str(),
                            }
                        }),
                    );
                    let params = SessionConfigSetParams { thread_id, config };
                    let _ = self.send_ws_typed(&ws_id, "cowork/session/config/set", &params, false);
                }
            }
            ChatAction::ResolveServerRequest {
                workspace_id,
                thread_id,
                id,
                response,
            } => {
                if let Some(rt) = self.thread_runtime_by_id.get_mut(&thread_id) {
                    rt.pending_interactions.retain(|item| match item {
                        ChatInteraction::CommandApproval { request_id, .. }
                        | ChatInteraction::FileChangeApproval { request_id, .. }
                        | ChatInteraction::UserInput { request_id, .. } => request_id != &id,
                    });
                }
                if let Ok(result) = serde_json::to_value(response) {
                    self.send_ws(WsCommand::SendServerResponse {
                        workspace_id,
                        id,
                        result,
                    });
                }
            }
            ChatAction::SubmitUserInput {
                workspace_id,
                thread_id,
                id,
                answers,
            } => {
                if let Some(rt) = self.thread_runtime_by_id.get_mut(&thread_id) {
                    rt.pending_interactions.retain(|item| match item {
                        ChatInteraction::UserInput { request_id, .. } => request_id != &id,
                        _ => true,
                    });
                }
                let result = json!({ "answers": answers });
                self.send_ws(WsCommand::SendServerResponse {
                    workspace_id,
                    id,
                    result,
                });
            }
            ChatAction::OpenAgentViewer { agent_id, title }
            | ChatAction::OpenAgentThread { agent_id, title } => {
                let thread_id = self
                    .nav
                    .current()
                    .active_thread_id
                    .clone()
                    .unwrap_or_default();
                self.agent_viewer = Some(AgentViewerState {
                    thread_id,
                    agent_id: agent_id.clone(),
                    title: title.unwrap_or(agent_id),
                });
            }
            ChatAction::CloseAgentViewer => {
                self.agent_viewer = None;
            }
            ChatAction::RetryTranscriptDelivery { thread_id } => {
                self.dispatch(Action::Chat(ChatAction::HydrateThread(thread_id)));
            }
            ChatAction::DismissTranscriptDeliveryFailure { thread_id } => {
                if let Some(rt) = self.thread_runtime_by_id.get_mut(&thread_id) {
                    rt.transcript_delivery_failure = None;
                }
            }
            ChatAction::RetryFailedTurn { thread_id } => {
                if let Some(pending) = self.shift_pending_thread_message(&thread_id) {
                    if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                        let input = build_turn_input(&pending.text, &pending.attachments);
                        let references = (!pending.references.is_empty()).then(|| {
                            pending
                                .references
                                .iter()
                                .filter_map(|r| serde_json::to_value(r).ok())
                                .collect()
                        });
                        let params = TurnStartParams {
                            thread_id,
                            client_message_id: pending.client_message_id,
                            input,
                            references,
                            retry: None,
                            tools: None,
                        };
                        let _ = self.send_ws_typed(&ws_id, "turn/start", &params, false);
                    }
                } else {
                    let last_user_text = self.thread_runtime_by_id.get(&thread_id).and_then(|rt| {
                        rt.feed.iter().rev().find_map(|item| match item {
                            FeedItem::Message {
                                role: FeedMessageRole::User,
                                content,
                                ..
                            } => Some(content.clone()),
                            _ => None,
                        })
                    });
                    if let (Some(ws_id), Some(text)) =
                        (self.workspace_for_thread(&thread_id), last_user_text)
                    {
                        let cid = self.next_tag("retry");
                        let params = TurnStartParams {
                            thread_id,
                            client_message_id: Some(cid),
                            input: TurnInput::Text(text),
                            references: None,
                            retry: None,
                            tools: None,
                        };
                        let _ = self.send_ws_typed(&ws_id, "turn/start", &params, false);
                    }
                }
            }
            ChatAction::StartLmStudioAndRetry {
                workspace_id,
                thread_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let base_url = self
                    .lmstudio_start_modal
                    .as_ref()
                    .and_then(|m| m.base_url.clone());
                if let Some(ref mut modal) = self.lmstudio_start_modal {
                    modal.starting = true;
                    modal.error = None;
                    modal.thread_id = Some(thread_id);
                }
                let params = ProviderLmStudioLocalStartParams {
                    cwd,
                    base_url,
                    timeout_ms: None,
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/lmstudio/local/start",
                    &params,
                    false,
                );
            }
        }
    }

    fn submit_chat_message(
        &mut self,
        thread_id: Option<String>,
        text: String,
        busy_policy: ThreadBusyPolicy,
        attachments: Vec<TurnAttachmentInputPart>,
        references: Vec<TurnReference>,
    ) {
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() && attachments.is_empty() {
            return;
        }
        let client_message_id = self.next_tag("msg");
        let timestamp_ms = (self.now_secs * 1000.0) as i64;

        match thread_id {
            Some(tid) => {
                let is_draft = self
                    .threads
                    .iter()
                    .find(|t| t.id == tid)
                    .is_some_and(|t| t.draft);
                let streaming = self
                    .thread_runtime_by_id
                    .get(&tid)
                    .is_some_and(|rt| rt.streaming);
                let active_turn_id = self
                    .thread_runtime_by_id
                    .get(&tid)
                    .and_then(|rt| rt.active_turn_id.clone());

                if is_draft {
                    self.queue_pending_thread_message(
                        &tid,
                        PendingThreadMessage {
                            text: trimmed.clone(),
                            attachments: attachments.clone(),
                            references: references.clone(),
                            client_message_id: Some(client_message_id.clone()),
                            draft_submission: None,
                        },
                        false,
                    );
                    let rt = self.thread_runtime_by_id.entry(tid.clone()).or_default();
                    rt.pending_turn_count += 1;
                    rt.feed.push(FeedItem::Message {
                        id: format!("optimistic-{client_message_id}"),
                        role: FeedMessageRole::User,
                        content: trimmed,
                        client_message_id: Some(client_message_id),
                        attachments,
                        references,
                        citations: Vec::new(),
                        streaming: false,
                        timestamp_ms,
                    });
                    if let Some(draft) = self.composer_drafts.get_mut(&tid) {
                        draft.text.clear();
                        draft.attachments.clear();
                        draft.references.clear();
                    }
                    self.attachment_previews_by_key.remove(&tid);
                    if self.composer_key() == tid {
                        self.composer_edit = TextEdit::new("");
                    }
                    return;
                }

                if streaming && busy_policy == ThreadBusyPolicy::Queue {
                    self.queue_pending_thread_message(
                        &tid,
                        PendingThreadMessage {
                            text: trimmed.clone(),
                            attachments,
                            references,
                            client_message_id: Some(client_message_id),
                            draft_submission: None,
                        },
                        false,
                    );
                    if let Some(draft) = self.composer_drafts.get_mut(&tid) {
                        draft.text.clear();
                        draft.attachments.clear();
                        draft.references.clear();
                    }
                    self.attachment_previews_by_key.remove(&tid);
                    if self.composer_key() == tid {
                        self.composer_edit = TextEdit::new("");
                    }
                    return;
                }

                if streaming
                    && busy_policy == ThreadBusyPolicy::Steer
                    && let Some(ws_id) = self.workspace_for_thread(&tid)
                {
                    let rt = self.thread_runtime_by_id.entry(tid.clone()).or_default();
                    rt.pending_steer = Some(PendingSteerState {
                        text: trimmed.clone(),
                        client_message_id: client_message_id.clone(),
                    });
                    if let Some(draft) = self.composer_drafts.get_mut(&tid) {
                        draft.text.clear();
                        draft.attachments.clear();
                        draft.references.clear();
                    }
                    self.attachment_previews_by_key.remove(&tid);
                    if self.composer_key() == tid {
                        self.composer_edit = TextEdit::new("");
                    }
                    let input = build_turn_input(&trimmed, &attachments);
                    let params = TurnSteerParams {
                        thread_id: tid,
                        turn_id: active_turn_id,
                        client_message_id: Some(client_message_id),
                        input,
                        references: (!references.is_empty()).then(|| {
                            references
                                .iter()
                                .filter_map(|r| serde_json::to_value(r).ok())
                                .collect()
                        }),
                    };
                    let _ = self.send_ws_typed(&ws_id, "turn/steer", &params, false);
                    return;
                }

                let optimistic_id = format!("optimistic-{client_message_id}");
                let rt = self.thread_runtime_by_id.entry(tid.clone()).or_default();
                rt.pending_turn_count += 1;
                rt.pending_turn_start = Some(ThreadPendingTurnStart {
                    client_message_id: client_message_id.clone(),
                    text: trimmed.clone(),
                    status: "sending".to_string(),
                });
                rt.feed.push(FeedItem::Message {
                    id: optimistic_id,
                    role: FeedMessageRole::User,
                    content: trimmed.clone(),
                    client_message_id: Some(client_message_id.clone()),
                    attachments: attachments.clone(),
                    references: references.clone(),
                    citations: Vec::new(),
                    streaming: false,
                    timestamp_ms,
                });
                if let Some(draft) = self.composer_drafts.get_mut(&tid) {
                    draft.text.clear();
                    draft.attachments.clear();
                    draft.references.clear();
                    draft.submitting = true;
                    draft.submission_error = None;
                }
                self.attachment_previews_by_key.remove(&tid);
                if self.composer_key() == tid {
                    self.composer_edit = TextEdit::new("");
                }

                if let Some(ws_id) = self.workspace_for_thread(&tid) {
                    let input = build_turn_input(&trimmed, &attachments);
                    let params = TurnStartParams {
                        thread_id: tid,
                        client_message_id: Some(client_message_id),
                        input,
                        references: (!references.is_empty()).then(|| {
                            references
                                .iter()
                                .filter_map(|r| serde_json::to_value(r).ok())
                                .collect()
                        }),
                        retry: None,
                        tools: None,
                    };
                    let _ = self.send_ws_typed(&ws_id, "turn/start", &params, false);
                }
            }
            None => {
                let Some(ws_id) = self
                    .landing_workspace_id
                    .clone()
                    .or_else(|| self.active_workspace_id.clone())
                    .or_else(|| self.resolve_management_workspace_id().map(str::to_string))
                else {
                    return;
                };
                let draft_thread_id = self.next_tag("__draft");
                let title = derive_thread_title(&trimmed);
                let new_draft_model = self
                    .composer_drafts
                    .get("__new__")
                    .map(|d| (d.provider.clone(), d.model.clone(), d.reasoning_effort))
                    .unwrap_or((None, None, None));
                let ws_defaults = self
                    .workspaces
                    .iter()
                    .find(|w| w.id == ws_id)
                    .map(|w| (w.default_provider.clone(), w.default_model.clone()))
                    .unwrap_or((None, None));
                let chosen_provider = new_draft_model.0.or(ws_defaults.0);
                let chosen_model = new_draft_model.1.or(ws_defaults.1);
                let draft_thread = ThreadRecord {
                    id: draft_thread_id.clone(),
                    workspace_id: ws_id.clone(),
                    title,
                    draft: true,
                    provider: chosen_provider.clone(),
                    model: chosen_model.clone(),
                    reasoning_effort: new_draft_model.2.map(|e| e.as_str().to_string()),
                    created_at: timestamp_ms,
                    updated_at: timestamp_ms,
                    ..ThreadRecord::default()
                };
                self.threads.insert(0, draft_thread);
                self.queue_pending_thread_message(
                    &draft_thread_id,
                    PendingThreadMessage {
                        text: trimmed.clone(),
                        attachments: attachments.clone(),
                        references: references.clone(),
                        client_message_id: Some(client_message_id.clone()),
                        draft_submission: None,
                    },
                    false,
                );
                let rt = self
                    .thread_runtime_by_id
                    .entry(draft_thread_id.clone())
                    .or_default();
                rt.pending_turn_count += 1;
                rt.pending_turn_start = Some(ThreadPendingTurnStart {
                    client_message_id: client_message_id.clone(),
                    text: trimmed.clone(),
                    status: "sending".to_string(),
                });
                rt.feed.push(FeedItem::Message {
                    id: format!("optimistic-{client_message_id}"),
                    role: FeedMessageRole::User,
                    content: trimmed,
                    client_message_id: Some(client_message_id),
                    attachments,
                    references,
                    citations: Vec::new(),
                    streaming: false,
                    timestamp_ms,
                });
                if let Some(draft) = self.composer_drafts.get_mut("__new__") {
                    draft.text.clear();
                    draft.attachments.clear();
                    draft.references.clear();
                    draft.submitting = true;
                    draft.submission_error = None;
                }
                self.attachment_previews_by_key.remove("__new__");
                self.composer_edit = TextEdit::new("");
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Chat),
                    active_thread_id: Some(Some(draft_thread_id.clone())),
                    ..Default::default()
                });
                let cwd = self.workspace_path(&ws_id);
                let params = ThreadStartParams {
                    cwd,
                    client_thread_id: Some(draft_thread_id.clone()),
                    provider: chosen_provider,
                    model: chosen_model,
                };
                if let Some(rpc_id) = self.send_ws_typed(&ws_id, "thread/start", &params, false) {
                    self.pending_draft_threads_by_rpc_id
                        .insert(rpc_id, draft_thread_id);
                }
            }
        }
    }

    fn flush_next_pending_message(&mut self, workspace_id: &str, thread_id: &str) {
        let Some(pending) = self.shift_pending_thread_message(thread_id) else {
            return;
        };
        let input = build_turn_input(&pending.text, &pending.attachments);
        let references = (!pending.references.is_empty()).then(|| {
            pending
                .references
                .iter()
                .filter_map(|r| serde_json::to_value(r).ok())
                .collect()
        });
        let params = TurnStartParams {
            thread_id: thread_id.to_string(),
            client_message_id: pending.client_message_id,
            input,
            references,
            retry: None,
            tools: None,
        };
        let _ = self.send_ws_typed(workspace_id, "turn/start", &params, false);
    }

    fn reduce_settings(&mut self, action: SettingsAction) {
        match action {
            SettingsAction::UpdateDesktopSettings(settings) => {
                self.desktop_settings = settings;
                self.persist_state();
            }
            SettingsAction::RefreshProviderCatalog { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderCatalogReadParams {
                    cwd: cwd.clone(),
                    refresh: Some(true),
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/catalog/read",
                    &params,
                    true,
                );
                let auth_params = ProviderAuthMethodsReadParams { cwd: cwd.clone() };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/authMethods/read",
                    &auth_params,
                    true,
                );
                let status_params = ProviderStatusRefreshParams {
                    cwd,
                    refresh_bedrock_discovery: Some(false),
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/status/refresh",
                    &status_params,
                    true,
                );
            }
            SettingsAction::SetProviderApiKey {
                workspace_id,
                provider,
                api_key,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderAuthSetApiKeyParams {
                    cwd,
                    provider,
                    method_id: None,
                    api_key,
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/auth/setApiKey",
                    &params,
                    false,
                );
            }
            SettingsAction::StartProviderAuth {
                workspace_id,
                provider,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let method_id = self
                    .provider_auth_methods
                    .get(&provider)
                    .and_then(|m| m.first())
                    .cloned()
                    .unwrap_or_else(|| "oauth".to_string());
                let params = ProviderAuthAuthorizeParams {
                    cwd,
                    provider,
                    method_id,
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/auth/authorize",
                    &params,
                    false,
                );
            }
            SettingsAction::CompleteProviderAuthCallback {
                workspace_id,
                provider,
                method_id,
                callback_input,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderAuthCallbackParams {
                    cwd,
                    provider,
                    method_id,
                    code: Some(callback_input),
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/auth/callback",
                    &params,
                    false,
                );
            }
            SettingsAction::SetProviderConfig {
                workspace_id,
                provider,
                config,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let values: HashMap<String, String> = config
                    .as_object()
                    .map(|obj| {
                        obj.iter()
                            .filter_map(|(k, v)| {
                                v.as_str()
                                    .map(|s| (k.clone(), s.to_string()))
                                    .or_else(|| (!v.is_null()).then(|| (k.clone(), v.to_string())))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let method_id = self
                    .provider_auth_methods
                    .get(&provider)
                    .and_then(|m| m.first())
                    .cloned()
                    .unwrap_or_else(|| "config".to_string());
                let params = ProviderAuthSetConfigParams {
                    cwd,
                    provider,
                    method_id,
                    values,
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/auth/setConfig",
                    &params,
                    false,
                );
            }
            SettingsAction::LogoutProvider {
                workspace_id,
                provider,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderAuthLogoutParams { cwd, provider };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/auth/logout",
                    &params,
                    false,
                );
            }
            SettingsAction::SetModelEnabled {
                workspace_id,
                provider,
                model,
                enabled,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderModelSetEnabledParams {
                    cwd,
                    provider,
                    models: vec![ProviderModelPreferencePatch { id: model, enabled }],
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/model/setEnabled",
                    &params,
                    false,
                );
            }
            SettingsAction::AddCustomModel {
                workspace_id,
                provider,
                model_id,
                ..
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderCustomModelAddParams {
                    cwd,
                    provider,
                    model_id,
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/customModel/add",
                    &params,
                    false,
                );
            }
            SettingsAction::DeleteCustomModel {
                workspace_id,
                provider,
                model_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderCustomModelDeleteParams {
                    cwd,
                    provider,
                    model_id,
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/customModel/delete",
                    &params,
                    false,
                );
            }
            SettingsAction::ResetProviderModelPreferences {
                workspace_id,
                provider,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderModelResetEnabledParams { cwd, provider };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/model/resetEnabled",
                    &params,
                    false,
                );
            }
            SettingsAction::CheckLmStudioStatus {
                workspace_id,
                base_url,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderLmStudioLocalStatusParams { cwd, base_url };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/lmstudio/local/status",
                    &params,
                    true,
                );
            }
            SettingsAction::StartLmStudio {
                workspace_id,
                base_url,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderLmStudioLocalStartParams {
                    cwd,
                    base_url,
                    timeout_ms: None,
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/lmstudio/local/start",
                    &params,
                    false,
                );
            }
            SettingsAction::SetLmStudioEnabled {
                workspace_id,
                enabled,
            } => {
                self.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id,
                    defaults: json!({ "lmStudioEnabled": enabled }),
                }));
            }
            SettingsAction::SetLmStudioModelVisible {
                workspace_id,
                model,
                visible,
            } => {
                self.dispatch(Action::Settings(SettingsAction::SetModelEnabled {
                    workspace_id,
                    provider: "lmstudio".to_string(),
                    model,
                    enabled: visible,
                }));
            }
            SettingsAction::CheckCodexAppServer { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderCodexAppServerStatusParams {
                    cwd,
                    check_latest: Some(true),
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/codexAppServer/status",
                    &params,
                    true,
                );
            }
            SettingsAction::UpdateCodexAppServer {
                workspace_id,
                force,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ProviderCodexAppServerUpdateParams {
                    cwd,
                    force: Some(force),
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/provider/codexAppServer/update",
                    &params,
                    false,
                );
            }
            SettingsAction::UpdateWorkspaceDefaults {
                workspace_id,
                defaults,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let mut restart_for_yolo = None;
                if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == workspace_id)
                    && let Some(obj) = defaults.as_object()
                {
                    if !ws.defaults.is_object() {
                        ws.defaults = json!({});
                    }
                    if let Some(dst) = ws.defaults.as_object_mut() {
                        for (k, v) in obj {
                            dst.insert(k.clone(), v.clone());
                        }
                    }
                    if let Some(yolo) = obj.get("yolo").and_then(Value::as_bool)
                        && ws.yolo != yolo
                    {
                        ws.yolo = yolo;
                        restart_for_yolo = Some((ws.path.clone(), yolo));
                    }
                    if let Some(p) = obj.get("defaultProvider").and_then(Value::as_str) {
                        ws.default_provider = Some(p.to_string());
                    }
                    if let Some(m) = obj.get("defaultModel").and_then(Value::as_str) {
                        ws.default_model = Some(m.to_string());
                    }
                    if let Some(mcp) = obj.get("defaultEnableMcp").and_then(Value::as_bool) {
                        ws.default_enable_mcp = mcp;
                    }
                    if let Some(b) = obj.get("defaultBackupsEnabled").and_then(Value::as_bool) {
                        ws.default_backups_enabled = b;
                    }
                    if let Some(un) = obj.get("userName").and_then(Value::as_str) {
                        ws.user_name = Some(un.to_string());
                    }
                    if let Some(up) = obj.get("userProfile") {
                        ws.user_profile = Some(up.clone());
                    }
                }
                self.persist_state();
                let params = SessionDefaultsApplyParams {
                    cwd,
                    thread_id: self.nav.current().active_thread_id.clone(),
                    provider: defaults
                        .get("defaultProvider")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    model: defaults
                        .get("defaultModel")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    enable_mcp: defaults.get("defaultEnableMcp").and_then(Value::as_bool),
                    config: defaults.as_object().cloned(),
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/session/defaults/apply",
                    &params,
                    false,
                );
                if let Some((path, yolo)) = restart_for_yolo {
                    self.send_native(NativeCommand::StopWorkspaceServer {
                        workspace_id: workspace_id.clone(),
                    });
                    self.send_native(NativeCommand::StartWorkspaceServer {
                        workspace_id,
                        path,
                        yolo,
                    });
                }
            }
            SettingsAction::UpsertMcpServer {
                workspace_id,
                name,
                config,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let mut server_obj = config.as_object().cloned().unwrap_or_default();
                server_obj
                    .entry("name".to_string())
                    .or_insert_with(|| Value::String(name));
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/upsert",
                    json!({ "cwd": cwd, "server": server_obj }),
                    false,
                );
            }
            SettingsAction::DeleteMcpServer { workspace_id, name } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/delete",
                    json!({ "cwd": cwd, "name": name }),
                    false,
                );
            }
            SettingsAction::SetMcpServerEnabled {
                workspace_id,
                name,
                source,
                enabled,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/setEnabled",
                    json!({ "cwd": cwd, "name": name, "source": source, "enabled": enabled }),
                    false,
                );
            }
            SettingsAction::SetMcpServerApiKey {
                workspace_id,
                name,
                source,
                api_key,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/auth/setApiKey",
                    json!({ "cwd": cwd, "name": name, "source": source, "apiKey": api_key }),
                    false,
                );
            }
            SettingsAction::ValidateMcpServer {
                workspace_id,
                name,
                source,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/validate",
                    json!({ "cwd": cwd, "name": name, "source": source }),
                    false,
                );
            }
            SettingsAction::AuthorizeMcpOAuth {
                workspace_id,
                name,
                source,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/auth/authorize",
                    json!({ "cwd": cwd, "name": name, "source": source }),
                    false,
                );
            }
            SettingsAction::CompleteMcpOAuthCallback {
                workspace_id,
                name,
                source,
                callback_url,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/auth/callback",
                    json!({ "cwd": cwd, "name": name, "source": source, "callbackUrl": callback_url }),
                    false,
                );
            }
            SettingsAction::UpsertSubagent {
                workspace_id,
                profile,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/upsert",
                    json!({ "cwd": cwd, "profile": profile }),
                    false,
                );
            }
            SettingsAction::DeleteSubagent { workspace_id, id } => {
                let cwd = self.workspace_path(&workspace_id);
                let scope = self
                    .subagents
                    .iter()
                    .find(|p| p.id == id)
                    .and_then(|p| p.scope.clone())
                    .unwrap_or_else(|| "workspace".to_string());
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/delete",
                    json!({ "cwd": cwd, "scope": scope, "id": id }),
                    false,
                );
            }
            SettingsAction::CopyAgentProfile {
                workspace_id,
                id,
                target_scope,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/copy",
                    json!({ "cwd": cwd, "id": id, "targetScope": target_scope }),
                    false,
                );
            }
            SettingsAction::UpsertMemory {
                workspace_id,
                key,
                content,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = MemoryUpsertParams {
                    cwd,
                    scope: "workspace".to_string(),
                    id: (!key.is_empty()).then_some(key),
                    content,
                    mode: Some("replace".to_string()),
                };
                let _ = self.send_ws_typed(&workspace_id, "cowork/memory/upsert", &params, false);
            }
            SettingsAction::DeleteMemory { workspace_id, key } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = MemoryDeleteParams {
                    cwd,
                    scope: "workspace".to_string(),
                    id: key,
                };
                let _ = self.send_ws_typed(&workspace_id, "cowork/memory/delete", &params, false);
            }
            SettingsAction::UpsertAdvancedMemory {
                workspace_id,
                entry,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let mut payload = entry.as_object().cloned().unwrap_or_default();
                if let Some(c) = cwd {
                    payload.entry("cwd".to_string()).or_insert(Value::String(c));
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/memory/advanced/upsert",
                    Value::Object(payload),
                    false,
                );
            }
            SettingsAction::DeleteAdvancedMemory { workspace_id, id } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = MemoryAdvancedDeleteParams { cwd, slug: id };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/memory/advanced/delete",
                    &params,
                    false,
                );
            }
            SettingsAction::RefreshSkillImprovementStatus { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/skills/improvement/status",
                    json!({ "cwd": cwd }),
                    true,
                );
            }
            SettingsAction::RunSkillImprovement { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/skills/improvement/run",
                    json!({ "cwd": cwd }),
                    false,
                );
            }
            SettingsAction::RestoreSkillImprovement {
                workspace_id,
                backup_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/skills/improvement/restore",
                    json!({ "cwd": cwd, "backupId": backup_id }),
                    false,
                );
            }
            SettingsAction::RefreshPluginsAndSkills { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let c = json!({ "cwd": cwd });
                let _ = self.send_ws_request(&workspace_id, "cowork/plugins/read", c.clone(), true);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/plugins/catalog/read",
                    c.clone(),
                    true,
                );
                let _ = self.send_ws_request(&workspace_id, "cowork/skills/list", c.clone(), true);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/skills/catalog/read",
                    c.clone(),
                    true,
                );
                let _ = self.send_ws_request(&workspace_id, "cowork/marketplaces/read", c, true);
            }
            SettingsAction::InstallPlugin {
                workspace_id,
                mut params,
            } => {
                inject_cwd(&mut params, self.workspace_path(&workspace_id));
                let _ =
                    self.send_ws_request(&workspace_id, "cowork/plugins/install", params, false);
            }
            SettingsAction::SetPluginEnabled {
                workspace_id,
                id,
                enabled,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let method = if enabled {
                    "cowork/plugins/enable"
                } else {
                    "cowork/plugins/disable"
                };
                let _ = self.send_ws_request(
                    &workspace_id,
                    method,
                    json!({ "cwd": cwd, "pluginId": id }),
                    false,
                );
            }
            SettingsAction::DeletePlugin { workspace_id, id } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/plugins/delete",
                    json!({ "cwd": cwd, "pluginId": id }),
                    false,
                );
            }
            SettingsAction::UpdatePlugin { workspace_id, id } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/plugins/update",
                    json!({ "cwd": cwd, "pluginId": id }),
                    false,
                );
            }
            SettingsAction::InstallSkill {
                workspace_id,
                mut params,
            } => {
                inject_cwd(&mut params, self.workspace_path(&workspace_id));
                let _ = self.send_ws_request(&workspace_id, "cowork/skills/install", params, false);
            }
            SettingsAction::SetSkillEnabled {
                workspace_id,
                name,
                enabled,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let method = if enabled {
                    "cowork/skills/enable"
                } else {
                    "cowork/skills/disable"
                };
                let _ = self.send_ws_request(
                    &workspace_id,
                    method,
                    json!({ "cwd": cwd, "name": name }),
                    false,
                );
            }
            SettingsAction::DeleteSkill { workspace_id, name } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/skills/delete",
                    json!({ "cwd": cwd, "name": name }),
                    false,
                );
            }
            SettingsAction::AddMarketplace { workspace_id, url } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/marketplaces/add",
                    json!({ "cwd": cwd, "source": url }),
                    false,
                );
            }
            SettingsAction::RemoveMarketplace { workspace_id, id } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/marketplaces/remove",
                    json!({ "cwd": cwd, "id": id }),
                    false,
                );
            }
            SettingsAction::RefreshOpenAiNativeConnectors { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ConnectorsOpenAiNativeRefreshParams { cwd };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/connectors/openai-native/refresh",
                    &params,
                    true,
                );
            }
            SettingsAction::SetOpenAiNativeConnectorEnabled {
                workspace_id,
                connector_id,
                enabled,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ConnectorsOpenAiNativeSetEnabledParams {
                    cwd,
                    connector_id,
                    enabled,
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/connectors/openai-native/setEnabled",
                    &params,
                    false,
                );
            }
            SettingsAction::DismissSettingsMutationError => {
                self.settings_mutation_error = None;
            }
            SettingsAction::SetFeatureFlag { flag_id, enabled } => {
                self.feature_flags.insert(flag_id, enabled);
                self.persist_state();
            }
            SettingsAction::RefreshDiagnostics { workspace_id } => {
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/runtime/diagnostics/read",
                    &RuntimeDiagnosticsReadParams {},
                    true,
                );
            }
            SettingsAction::CheckLibreOfficeRuntime { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = RuntimeLibreOfficeCheckParams {
                    cwd,
                    smoke: Some(false),
                };
                let _ = self.send_ws_typed(
                    &workspace_id,
                    "cowork/runtime/libreoffice/check",
                    &params,
                    true,
                );
            }
            SettingsAction::CheckUpdates => {
                self.send_native(NativeCommand::CheckForUpdates);
            }
            SettingsAction::DownloadUpdate => {
                self.send_native(NativeCommand::DownloadUpdate);
            }
            SettingsAction::QuitAndInstallUpdate => {
                self.send_native(NativeCommand::QuitAndInstallUpdate);
            }
            SettingsAction::ListArchivedThreads { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = ThreadListParams {
                    cwd,
                    limit: None,
                    offset: None,
                };
                let _ = self.send_ws_typed(&workspace_id, "thread/list", &params, true);
            }
            SettingsAction::ListBackups { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/backups/workspace/read",
                    json!({ "cwd": cwd }),
                    true,
                );
            }
            SettingsAction::CreateBackup {
                workspace_id,
                target_session_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/backups/workspace/checkpoint",
                    json!({ "cwd": cwd, "targetSessionId": target_session_id }),
                    false,
                );
            }
            SettingsAction::InspectBackup {
                workspace_id,
                target_session_id,
                checkpoint_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/backups/workspace/delta/read",
                    json!({ "cwd": cwd, "targetSessionId": target_session_id, "checkpointId": checkpoint_id }),
                    true,
                );
            }
            SettingsAction::DeleteBackup {
                workspace_id,
                target_session_id,
                checkpoint_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/backups/workspace/deleteCheckpoint",
                    json!({ "cwd": cwd, "targetSessionId": target_session_id, "checkpointId": checkpoint_id }),
                    false,
                );
            }
            SettingsAction::RestoreBackup {
                workspace_id,
                backup_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let (target_session_id, checkpoint_id) = match backup_id.split_once("::") {
                    Some((sid, cp)) => (sid.to_string(), Some(cp.to_string())),
                    None => (backup_id, None),
                };
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/backups/workspace/restore",
                    json!({ "cwd": cwd, "targetSessionId": target_session_id, "checkpointId": checkpoint_id }),
                    false,
                );
            }
            SettingsAction::PreviewConversationImport {
                workspace_id,
                mut params,
            } => {
                inject_cwd(&mut params, self.workspace_path(&workspace_id));
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/conversationImport/preview",
                    params,
                    false,
                );
            }
            SettingsAction::ExecuteConversationImport {
                workspace_id,
                mut params,
            } => {
                inject_cwd(&mut params, self.workspace_path(&workspace_id));
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/conversationImport/import",
                    params,
                    false,
                );
            }
            SettingsAction::SetRemoteAccessEnabled(enabled) => {
                self.send_native(NativeCommand::SetRemoteAccessEnabled(enabled));
            }
            SettingsAction::RotateRemoteAccessSession => {
                self.send_native(NativeCommand::RotateRemoteAccessSession);
            }
            SettingsAction::UpdateTrustedPhonePermissions {
                phone_id,
                permissions,
            } => {
                if let Some(p) = self
                    .remote_access
                    .trusted_phones
                    .iter_mut()
                    .find(|p| p.id == phone_id)
                {
                    p.permissions = permissions.clone();
                }
                self.send_native(NativeCommand::UpdateTrustedPhonePermissions {
                    phone_id,
                    permissions,
                });
            }
            SettingsAction::ForgetTrustedPhone { phone_id } => {
                self.remote_access
                    .trusted_phones
                    .retain(|p| p.id != phone_id);
            }
            SettingsAction::UpdatePrivacyTelemetry(privacy) => {
                self.desktop_settings.privacy_telemetry = privacy;
                self.persist_state();
            }
            SettingsAction::RefreshTelemetryStatus => {
                self.send_native(NativeCommand::RefreshTelemetryStatus);
            }
            SettingsAction::ExportDiagnosticsBundle => {
                self.send_native(NativeCommand::ExportDiagnosticsBundle);
            }
            SettingsAction::RestartOnboarding => {
                self.onboarding = OnboardingState::default();
                self.persist_state();
            }
        }
    }

    fn reduce_native(&mut self, action: NativeAction) {
        match action {
            NativeAction::PickWorkspaceFolder => {
                let request_id = self.next_tag("folder");
                self.send_native(NativeCommand::PickFolder { request_id });
            }
            NativeAction::PickFiles { allow_multiple } => {
                let request_id = self.next_tag("files");
                self.send_native(NativeCommand::PickFiles {
                    request_id,
                    allow_multiple,
                });
            }
            NativeAction::PickComposerAttachments { key } => {
                let request_id = self.next_tag("files");
                self.pending_picker_composer_by_request
                    .insert(request_id.clone(), key);
                self.send_native(NativeCommand::PickFiles {
                    request_id,
                    allow_multiple: true,
                });
            }
            NativeAction::IngestDroppedFiles { key, paths } => {
                self.ingest_composer_paths(&key, paths);
            }
            NativeAction::PasteClipboardImage {
                key,
                bytes,
                mime_type,
                filename,
            } => {
                let ext = mime_type
                    .split('/')
                    .nth(1)
                    .unwrap_or("png")
                    .split(';')
                    .next()
                    .unwrap_or("png");
                let resolved_name =
                    filename.unwrap_or_else(|| format!("{}.{ext}", self.next_tag("clipboard")));
                self.attach_bytes_to_composer(&key, resolved_name, mime_type, &bytes);
            }
            NativeAction::AddWorkspace { path, name } => {
                let path_str = path.to_string_lossy().to_string();
                let resolved_name = name.unwrap_or_else(|| {
                    path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("Workspace")
                        .to_string()
                });
                let id = uuid::Uuid::new_v4().to_string();
                let now = (self.now_secs * 1000.0) as i64;
                let ws = WorkspaceRecord::new(id.clone(), resolved_name, path_str.clone(), now);
                let yolo = ws.yolo;
                self.workspaces.push(ws);
                self.workspace_order.push(id.clone());
                self.active_workspace_id = Some(id.clone());
                self.persist_state();
                self.send_native(NativeCommand::StartWorkspaceServer {
                    workspace_id: id,
                    path: path_str,
                    yolo,
                });
            }
            NativeAction::RemoveWorkspace(workspace_id) => {
                self.workspaces.retain(|w| w.id != workspace_id);
                self.workspace_order.retain(|id| id != &workspace_id);
                self.collapsed_workspace_ids.remove(&workspace_id);
                self.workspace_runtime_by_id.remove(&workspace_id);
                self.workspace_socket_by_id.remove(&workspace_id);
                if self.active_workspace_id.as_deref() == Some(workspace_id.as_str()) {
                    self.active_workspace_id = self.workspaces.first().map(|w| w.id.clone());
                }
                self.persist_state();
                self.send_native(NativeCommand::StopWorkspaceServer {
                    workspace_id: workspace_id.clone(),
                });
                self.send_ws(WsCommand::DisconnectWorkspace { workspace_id });
            }
            NativeAction::RestartWorkspaceServer(workspace_id) => {
                if let Some((path, yolo)) = self
                    .workspaces
                    .iter()
                    .find(|w| w.id == workspace_id)
                    .map(|w| (w.path.clone(), w.yolo))
                {
                    self.send_native(NativeCommand::StopWorkspaceServer {
                        workspace_id: workspace_id.clone(),
                    });
                    self.send_native(NativeCommand::StartWorkspaceServer {
                        workspace_id,
                        path,
                        yolo,
                    });
                }
            }
            NativeAction::StopWorkspaceServer(workspace_id) => {
                self.send_native(NativeCommand::StopWorkspaceServer { workspace_id });
            }
            NativeAction::ListWorkspaceFiles { workspace_id, dir } => {
                if let Some(root) = self.workspace_path(&workspace_id) {
                    let request_id = self.next_tag("ls");
                    let show_hidden = self.desktop_settings.show_hidden_files;
                    self.send_native(NativeCommand::ListWorkspaceFiles {
                        request_id,
                        workspace_id,
                        workspace_root: root,
                        dir,
                        show_hidden,
                    });
                }
            }
            NativeAction::LoadFilePreview { workspace_id, path } => {
                if let Some(root) = self.workspace_path(&workspace_id) {
                    let request_id = self.next_tag("preview");
                    self.send_native(NativeCommand::ReadFilePreview {
                        request_id,
                        workspace_id,
                        workspace_root: root,
                        path,
                    });
                }
            }
            NativeAction::FetchImageBytes { request_id, url } => {
                self.send_native(NativeCommand::FetchImageBytes { request_id, url });
            }
            NativeAction::CopyText(text) => {
                self.send_native(NativeCommand::CopyText(text));
            }
            NativeAction::OpenExternalUrl(url) => {
                self.send_native(NativeCommand::OpenExternalUrl(url));
            }
            NativeAction::RevealInOs(path) => {
                self.send_native(NativeCommand::RevealInOs(path));
            }
            NativeAction::OpenInDefaultApp(path) => {
                self.send_native(NativeCommand::OpenInDefaultApp(path));
            }
            NativeAction::TrashPath(path) => {
                self.send_native(NativeCommand::TrashPath(path));
            }
        }
    }

    fn apply_ws_initialized(&mut self, workspace_id: &str, result: InitializeResult) {
        let rt = self
            .workspace_runtime_by_id
            .entry(workspace_id.to_string())
            .or_default();
        rt.reconnecting = false;
        rt.reconnect_attempt = 0;
        rt.last_error = None;
        rt.capabilities = serde_json::to_value(result.capabilities).ok();

        let cwd = self.workspace_path(workspace_id);
        let list_params = ThreadListParams {
            cwd: cwd.clone(),
            limit: None,
            offset: None,
        };
        let _ = self.send_ws_typed(workspace_id, "thread/list", &list_params, true);

        let preflight_params = CreationPreflightParams {
            kind: "chat".to_string(),
            cwd: cwd.clone(),
            provider: None,
            model: None,
        };
        let _ = self.send_ws_typed(
            workspace_id,
            "cowork/creation/preflight",
            &preflight_params,
            true,
        );

        let catalog_params = ProviderCatalogReadParams {
            cwd: cwd.clone(),
            refresh: Some(false),
        };
        let _ = self.send_ws_typed(
            workspace_id,
            "cowork/provider/catalog/read",
            &catalog_params,
            true,
        );
        let connectors_params = ConnectorsOpenAiNativeListParams { cwd: cwd.clone() };
        let _ = self.send_ws_typed(
            workspace_id,
            "cowork/connectors/openai-native/list",
            &connectors_params,
            true,
        );
        let _ = self.send_ws_typed(
            workspace_id,
            "cowork/memory/list",
            &MemoryListParams {
                cwd: cwd.clone(),
                scope: None,
            },
            true,
        );
        let _ = self.send_ws_typed(
            workspace_id,
            "cowork/memory/advanced/list",
            &MemoryAdvancedListParams { cwd },
            true,
        );

        if let Some(active_tid) = self.nav.current().active_thread_id.clone()
            && self.workspace_for_thread(&active_tid).as_deref() == Some(workspace_id)
        {
            let cmd_params = CommandListParams {
                thread_id: active_tid,
            };
            let _ = self.send_ws_typed(workspace_id, "command/list", &cmd_params, true);
        }
    }

    fn apply_ws_notification(&mut self, workspace_id: &str, method: &str, params: Value) {
        let now_ms = (self.now_secs * 1000.0) as i64;
        if let Some(seq) = params.get("seq").and_then(Value::as_u64)
            && let Some(tid) = params.get("threadId").and_then(Value::as_str)
        {
            let rt = self
                .thread_runtime_by_id
                .entry(tid.to_string())
                .or_default();
            if seq > rt.last_event_seq {
                rt.last_event_seq = seq;
            }
        }

        match method {
            "turn/started" => self.reduce_turn_started(&params),
            "turn/completed" => self.reduce_turn_completed(workspace_id, &params, now_ms),
            "item/started" => self.reduce_item_started(&params, now_ms),
            "item/agentMessage/delta" => self.reduce_agent_message_delta(&params, now_ms),
            "item/reasoning/delta" => self.reduce_reasoning_delta(&params, now_ms),
            "item/completed" => self.reduce_item_completed(&params, now_ms),
            "serverRequest/resolved" => self.reduce_server_request_resolved(&params),
            "thread/name/updated" => {
                if let (Some(tid), Some(title)) = (
                    params.get("threadId").and_then(Value::as_str),
                    params
                        .get("title")
                        .or_else(|| params.get("name"))
                        .and_then(Value::as_str),
                ) && let Some(t) = self.threads.iter_mut().find(|t| t.id == tid)
                {
                    t.title = title.to_string();
                }
            }
            "thread/status/changed" => {
                if let (Some(tid), Some(status)) = (
                    params.get("threadId").and_then(Value::as_str),
                    params.get("status").and_then(Value::as_str),
                ) {
                    let rt = self
                        .thread_runtime_by_id
                        .entry(tid.to_string())
                        .or_default();
                    if status == "idle" || status == "completed" {
                        rt.streaming = false;
                    }
                }
            }
            "cowork/sessionEvent" | "cowork/controlEvent" => {
                let evt = params.get("event").unwrap_or(&params);
                self.reduce_cowork_event(workspace_id, evt, now_ms);
            }
            _ => {
                if method.starts_with("cowork/") {
                    self.reduce_cowork_event(workspace_id, &params, now_ms);
                }
            }
        }
    }

    fn reduce_turn_started(&mut self, params: &Value) {
        let Some(tid) = params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let turn_id = params
            .get("turnId")
            .or_else(|| params.get("turn").and_then(|t| t.get("id")))
            .and_then(Value::as_str)
            .map(str::to_string);
        let rt = self.thread_runtime_by_id.entry(tid).or_default();
        rt.streaming = true;
        rt.active_turn_id = turn_id;
        rt.pending_turn_count = rt.pending_turn_count.saturating_sub(1);
        rt.last_error = None;
    }

    fn reduce_turn_completed(&mut self, workspace_id: &str, params: &Value, now_ms: i64) {
        let Some(tid) = params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let status = params
            .get("status")
            .or_else(|| params.get("turn").and_then(|t| t.get("status")))
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let err_msg = params
            .get("error")
            .or_else(|| params.get("turn").and_then(|t| t.get("error")))
            .and_then(|e| {
                e.as_str()
                    .or_else(|| e.get("message").and_then(Value::as_str))
            })
            .map(str::to_string);
        let completed_turn_id = params
            .get("turnId")
            .or_else(|| params.get("turn").and_then(|t| t.get("id")))
            .and_then(Value::as_str);

        let is_active = self.nav.current().active_thread_id.as_deref() == Some(tid.as_str());
        let rt = self.thread_runtime_by_id.entry(tid.clone()).or_default();
        if completed_turn_id.is_none() || rt.active_turn_id.as_deref() == completed_turn_id {
            rt.active_turn_id = None;
        }
        rt.streaming = false;
        rt.pending_turn_count = 0;
        rt.pending_steer = None;
        for item in &mut rt.feed {
            match item {
                FeedItem::Message { streaming, .. } | FeedItem::Reasoning { streaming, .. } => {
                    *streaming = false;
                }
                FeedItem::Tool { streaming, .. } => *streaming = false,
                _ => {}
            }
        }
        if status == "failed" {
            let msg = err_msg.unwrap_or_else(|| "Turn failed".to_string());
            rt.last_error = Some(msg.clone());
            rt.feed.push(FeedItem::Error {
                id: format!("turn-err-{now_ms}"),
                message: msg,
                code: None,
                timestamp_ms: now_ms,
            });
        }
        if !is_active {
            rt.unread = true;
        }
        self.flush_next_pending_message(workspace_id, &tid);
    }

    fn reduce_item_started(&mut self, params: &Value, now_ms: i64) {
        let Some(tid) = params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let item = params.get("item").unwrap_or(params);
        let Some(item_id) = item.get("id").and_then(Value::as_str).map(str::to_string) else {
            return;
        };
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        let rt = self.thread_runtime_by_id.entry(tid).or_default();

        match item_type {
            "userMessage" => {
                let text = extract_item_text(item);
                let client_message_id = item
                    .get("clientMessageId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(ref cid) = client_message_id
                    && let Some(existing) = rt.feed.iter_mut().find(|f| {
                        matches!(
                            f,
                            FeedItem::Message {
                                client_message_id: Some(ec),
                                ..
                            } if ec == cid
                        )
                    })
                {
                    if let FeedItem::Message {
                        id,
                        content,
                        streaming,
                        ..
                    } = existing
                    {
                        *id = item_id;
                        if !text.is_empty() {
                            *content = text;
                        }
                        *streaming = false;
                    }
                    return;
                }
                if !rt.feed.iter().any(|f| feed_item_id(f) == item_id) {
                    rt.feed.push(FeedItem::Message {
                        id: item_id,
                        role: FeedMessageRole::User,
                        content: text,
                        client_message_id,
                        attachments: Vec::new(),
                        references: Vec::new(),
                        citations: Vec::new(),
                        streaming: false,
                        timestamp_ms: now_ms,
                    });
                }
            }
            "agentMessage" => {
                let text = extract_item_text(item);
                if !rt.feed.iter().any(|f| feed_item_id(f) == item_id) {
                    rt.feed.push(FeedItem::Message {
                        id: item_id,
                        role: FeedMessageRole::Assistant,
                        content: text,
                        client_message_id: None,
                        attachments: Vec::new(),
                        references: Vec::new(),
                        citations: parse_citations(item.get("citations")),
                        streaming: true,
                        timestamp_ms: now_ms,
                    });
                }
            }
            "reasoning" => {
                let text = extract_item_text(item);
                let mode = item
                    .get("mode")
                    .and_then(Value::as_str)
                    .unwrap_or("reasoning")
                    .to_string();
                if !rt.feed.iter().any(|f| feed_item_id(f) == item_id) {
                    rt.feed.push(FeedItem::Reasoning {
                        id: item_id,
                        content: text,
                        mode,
                        streaming: true,
                        timestamp_ms: now_ms,
                    });
                }
            }
            "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "toolCall" => {
                let tool_name = item
                    .get("tool")
                    .or_else(|| item.get("toolName"))
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(item_type)
                    .to_string();
                let title = item
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let call_id = item
                    .get("callId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let input = item
                    .get("arguments")
                    .or_else(|| item.get("input"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let status = parse_tool_status(item.get("status").and_then(Value::as_str))
                    .unwrap_or(ToolRunStatus::Running);
                let completed_at_ms = item.get("completedAt").map(|v| parse_timestamp_ms(Some(v)));
                let output_truncated = item
                    .get("outputTruncated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !rt.feed.iter().any(|f| feed_item_id(f) == item_id) {
                    rt.feed.push(FeedItem::Tool {
                        id: item_id,
                        tool_name,
                        title,
                        call_id,
                        status,
                        input,
                        output: None,
                        error: None,
                        diff: None,
                        streaming: !status.is_terminal(),
                        timestamp_ms: now_ms,
                        completed_at_ms,
                        output_truncated,
                    });
                }
            }
            _ => {}
        }
    }

    fn reduce_agent_message_delta(&mut self, params: &Value, now_ms: i64) {
        let Some(tid) = params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
            return;
        };
        let delta = params
            .get("delta")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if delta.is_empty() {
            return;
        }
        let rt = self.thread_runtime_by_id.entry(tid).or_default();
        rt.streaming = true;
        if let Some(FeedItem::Message {
            content, streaming, ..
        }) = rt
            .feed
            .iter_mut()
            .rev()
            .find(|f| matches!(f, FeedItem::Message { id, .. } if id == item_id))
        {
            content.push_str(delta);
            *streaming = true;
        } else {
            rt.feed.push(FeedItem::Message {
                id: item_id.to_string(),
                role: FeedMessageRole::Assistant,
                content: delta.to_string(),
                client_message_id: None,
                attachments: Vec::new(),
                references: Vec::new(),
                citations: Vec::new(),
                streaming: true,
                timestamp_ms: now_ms,
            });
        }
    }

    fn reduce_reasoning_delta(&mut self, params: &Value, now_ms: i64) {
        let Some(tid) = params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
            return;
        };
        let delta = params
            .get("delta")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if delta.is_empty() {
            return;
        }
        let rt = self.thread_runtime_by_id.entry(tid).or_default();
        rt.streaming = true;
        if let Some(FeedItem::Reasoning {
            content, streaming, ..
        }) = rt
            .feed
            .iter_mut()
            .rev()
            .find(|f| matches!(f, FeedItem::Reasoning { id, .. } if id == item_id))
        {
            content.push_str(delta);
            *streaming = true;
        } else {
            rt.feed.push(FeedItem::Reasoning {
                id: item_id.to_string(),
                content: delta.to_string(),
                mode: "reasoning".to_string(),
                streaming: true,
                timestamp_ms: now_ms,
            });
        }
    }

    fn reduce_item_completed(&mut self, params: &Value, now_ms: i64) {
        let Some(tid) = params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let item = params.get("item").unwrap_or(params);
        let Some(item_id) = item.get("id").and_then(Value::as_str) else {
            return;
        };
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        let rt = self.thread_runtime_by_id.entry(tid).or_default();

        if let Some(existing) = rt.feed.iter_mut().find(|f| feed_item_id(f) == item_id) {
            match existing {
                FeedItem::Message {
                    content,
                    citations,
                    streaming,
                    ..
                } => {
                    let final_text = extract_item_text(item);
                    if !final_text.is_empty() {
                        *content = final_text;
                    }
                    let parsed_citations = parse_citations(item.get("citations"));
                    if !parsed_citations.is_empty() {
                        *citations = parsed_citations;
                    }
                    *streaming = false;
                }
                FeedItem::Reasoning {
                    content,
                    mode,
                    streaming,
                    ..
                } => {
                    let final_text = extract_item_text(item);
                    if !final_text.is_empty() {
                        *content = final_text;
                    }
                    if let Some(m) = item.get("mode").and_then(Value::as_str) {
                        *mode = m.to_string();
                    }
                    *streaming = false;
                }
                FeedItem::Tool {
                    title,
                    status,
                    output,
                    error,
                    diff,
                    streaming,
                    completed_at_ms,
                    output_truncated,
                    ..
                } => {
                    // Terminal status preserved across late completion events (`projectedItems.ts`).
                    if !status.is_terminal() {
                        *status = parse_tool_status(item.get("status").and_then(Value::as_str))
                            .unwrap_or(ToolRunStatus::Completed);
                    }
                    if let Some(t) = item.get("title").and_then(Value::as_str) {
                        *title = Some(t.to_string());
                    }
                    if let Some(out) = item.get("result").or_else(|| item.get("output")) {
                        *output = Some(out.clone());
                    }
                    if let Some(err) = item.get("error").and_then(|e| {
                        e.as_str()
                            .or_else(|| e.get("message").and_then(Value::as_str))
                    }) {
                        *error = Some(err.to_string());
                    }
                    if let Some(d) = item.get("diff").and_then(Value::as_str) {
                        *diff = Some(d.to_string());
                    }
                    *completed_at_ms = Some(
                        item.get("completedAt")
                            .map(|v| parse_timestamp_ms(Some(v)))
                            .unwrap_or(now_ms),
                    );
                    if item.get("outputTruncated").and_then(Value::as_bool) == Some(true) {
                        *output_truncated = true;
                    }
                    *streaming = false;
                }
                _ => {}
            }
            return;
        }

        // Fallback creation if completion arrived without prior `item/started`.
        match item_type {
            "agentMessage" => {
                rt.feed.push(FeedItem::Message {
                    id: item_id.to_string(),
                    role: FeedMessageRole::Assistant,
                    content: extract_item_text(item),
                    client_message_id: None,
                    attachments: Vec::new(),
                    references: Vec::new(),
                    citations: parse_citations(item.get("citations")),
                    streaming: false,
                    timestamp_ms: now_ms,
                });
            }
            "reasoning" => {
                rt.feed.push(FeedItem::Reasoning {
                    id: item_id.to_string(),
                    content: extract_item_text(item),
                    mode: item
                        .get("mode")
                        .and_then(Value::as_str)
                        .unwrap_or("reasoning")
                        .to_string(),
                    streaming: false,
                    timestamp_ms: now_ms,
                });
            }
            "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "toolCall" => {
                let status = parse_tool_status(item.get("status").and_then(Value::as_str))
                    .unwrap_or(ToolRunStatus::Completed);
                rt.feed.push(FeedItem::Tool {
                    id: item_id.to_string(),
                    tool_name: item
                        .get("tool")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or(item_type)
                        .to_string(),
                    title: item
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    call_id: item
                        .get("callId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    status,
                    input: item
                        .get("arguments")
                        .or_else(|| item.get("input"))
                        .cloned()
                        .unwrap_or(Value::Null),
                    output: item.get("result").or_else(|| item.get("output")).cloned(),
                    error: item
                        .get("error")
                        .and_then(|e| {
                            e.as_str()
                                .or_else(|| e.get("message").and_then(Value::as_str))
                        })
                        .map(str::to_string),
                    diff: item.get("diff").and_then(Value::as_str).map(str::to_string),
                    streaming: false,
                    timestamp_ms: now_ms,
                    completed_at_ms: Some(
                        item.get("completedAt")
                            .map(|v| parse_timestamp_ms(Some(v)))
                            .unwrap_or(now_ms),
                    ),
                    output_truncated: item
                        .get("outputTruncated")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
            }
            _ => {}
        }
    }

    fn reduce_server_request_resolved(&mut self, params: &Value) {
        let Some(tid) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let req_id_val = params.get("requestId").cloned();
        let item_id = params.get("itemId").and_then(Value::as_str);
        if let Some(rt) = self.thread_runtime_by_id.get_mut(tid) {
            rt.pending_interactions
                .retain(|interaction| match interaction {
                    ChatInteraction::CommandApproval {
                        request_id,
                        item_id: iid,
                        ..
                    }
                    | ChatInteraction::FileChangeApproval {
                        request_id,
                        item_id: iid,
                        ..
                    }
                    | ChatInteraction::UserInput {
                        request_id,
                        item_id: iid,
                        ..
                    } => {
                        let id_matches = req_id_val.as_ref().is_some_and(|v| {
                            serde_json::from_value::<JsonRpcLiteId>(v.clone())
                                .ok()
                                .as_ref()
                                == Some(request_id)
                        });
                        let item_matches = item_id.is_some_and(|i| i == iid);
                        !(id_matches || item_matches)
                    }
                });
        }
    }

    fn reduce_cowork_event(&mut self, _workspace_id: &str, evt: &Value, now_ms: i64) {
        let evt_type = evt.get("type").and_then(Value::as_str).unwrap_or_default();
        let tid = evt
            .get("sessionId")
            .or_else(|| evt.get("threadId"))
            .and_then(Value::as_str)
            .map(str::to_string);

        match evt_type {
            "turn_usage" | "session_usage" => {
                let usage = parse_usage_summary(evt.get("usage").unwrap_or(evt));
                if let Some(id) = tid {
                    self.thread_runtime_by_id
                        .entry(id.clone())
                        .or_default()
                        .usage = Some(usage.clone());
                    self.usage_by_thread.insert(id, evt.clone());
                }
                self.usage_summary = Some(usage);
            }
            "budget_warning" | "budget_exceeded" | "usage_hard_cap" => {
                if let Some(id) = tid {
                    let rt = self.thread_runtime_by_id.entry(id).or_default();
                    if let Some(cap) = evt
                        .get("capUsd")
                        .or_else(|| evt.get("limit"))
                        .and_then(Value::as_f64)
                    {
                        rt.usage_hard_cap = Some(cap);
                    }
                    if evt_type == "budget_exceeded"
                        || evt.get("exceeded").and_then(Value::as_bool) == Some(true)
                    {
                        rt.usage_hard_cap_reached = true;
                    }
                }
            }
            "todos" => {
                if let Some(id) = tid
                    && let Some(items_val) = evt.get("todos").and_then(Value::as_array)
                {
                    let todos: Vec<TodoItemView> = items_val
                        .iter()
                        .filter_map(|v| serde_json::from_value(v.clone()).ok())
                        .collect();
                    let rt = self.thread_runtime_by_id.entry(id).or_default();
                    rt.todos = todos.clone();
                    rt.feed.push(FeedItem::Todos {
                        id: format!("todos-{now_ms}"),
                        items: todos,
                        timestamp_ms: now_ms,
                    });
                }
            }
            "log" => {
                if let Some(id) = tid {
                    let level = evt
                        .get("level")
                        .and_then(Value::as_str)
                        .unwrap_or("info")
                        .to_string();
                    let message = evt
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    self.thread_runtime_by_id
                        .entry(id)
                        .or_default()
                        .feed
                        .push(FeedItem::Log {
                            id: format!("log-{now_ms}"),
                            level,
                            message,
                            timestamp_ms: now_ms,
                        });
                }
            }
            "error" => {
                let message = evt
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown error")
                    .to_string();
                let code = evt.get("code").and_then(Value::as_str).map(str::to_string);
                if let Some(id) = tid {
                    let rt = self.thread_runtime_by_id.entry(id).or_default();
                    rt.last_error = Some(message.clone());
                    rt.feed.push(FeedItem::Error {
                        id: format!("err-{now_ms}"),
                        message,
                        code,
                        timestamp_ms: now_ms,
                    });
                }
            }
            "steer_accepted" => {
                if let Some(id) = tid {
                    self.thread_runtime_by_id
                        .entry(id)
                        .or_default()
                        .pending_steer = None;
                }
            }
            "agent_started" | "agent_completed" | "agent_failed" | "agent_updated" => {
                if let Some(id) = tid
                    && let Some(agent_id) = evt.get("agentId").and_then(Value::as_str)
                {
                    let rt = self.thread_runtime_by_id.entry(id).or_default();
                    let status = evt
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or(match evt_type {
                            "agent_completed" => "completed",
                            "agent_failed" => "failed",
                            _ => "running",
                        })
                        .to_string();
                    let name = evt
                        .get("name")
                        .or_else(|| evt.get("nickname"))
                        .and_then(Value::as_str)
                        .unwrap_or(agent_id)
                        .to_string();
                    if let Some(existing) = rt.agents.iter_mut().find(|a| a.agent_id == agent_id) {
                        existing.status = status;
                        if let Some(err) = evt.get("error").and_then(Value::as_str) {
                            existing.error = Some(err.to_string());
                        }
                    } else {
                        rt.agents.push(ThreadAgentSummary {
                            agent_id: agent_id.to_string(),
                            name,
                            nickname: evt
                                .get("nickname")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            title: evt.get("title").and_then(Value::as_str).map(str::to_string),
                            role: evt.get("role").and_then(Value::as_str).map(str::to_string),
                            depth: evt.get("depth").and_then(Value::as_u64).unwrap_or(0) as u32,
                            status,
                            model: evt.get("model").and_then(Value::as_str).map(str::to_string),
                            usage_label: evt
                                .get("usageLabel")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            started_at: Some(now_ms),
                            completed_at: None,
                            error: evt.get("error").and_then(Value::as_str).map(str::to_string),
                        });
                    }
                }
            }
            "workflow_progress" => {
                if let Some(run_id) = evt.get("runId").and_then(Value::as_str) {
                    let wf = evt
                        .get("workflowName")
                        .and_then(Value::as_str)
                        .unwrap_or("workflow")
                        .to_string();
                    let status = evt
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("running")
                        .to_string();
                    if let Some(existing) = self.workflow_runs.iter_mut().find(|w| w.id == run_id) {
                        existing.status = status;
                        existing.summary = evt
                            .get("summary")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                    } else {
                        self.workflow_runs.push(WorkflowRunView {
                            id: run_id.to_string(),
                            workflow_name: wf,
                            status,
                            started_at: now_ms,
                            finished_at: None,
                            summary: evt
                                .get("summary")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        });
                    }
                }
            }
            "agent_profiles_catalog" => {
                if let Some(profiles) = evt
                    .get("catalog")
                    .and_then(|c| c.get("profiles"))
                    .and_then(Value::as_array)
                {
                    self.subagents = profiles
                        .iter()
                        .filter_map(|v| serde_json::from_value::<SubagentProfile>(v.clone()).ok())
                        .collect();
                }
            }
            "mcp_servers" => {
                self.update_mcp_servers_from_event(evt);
            }
            "session_info" | "session_settings" | "config_updated" => {
                if let Some(id) = tid
                    && let Some(t) = self.threads.iter_mut().find(|t| t.id == id)
                {
                    if let Some(p) = evt.get("provider").and_then(Value::as_str) {
                        t.provider = Some(p.to_string());
                    }
                    if let Some(m) = evt.get("model").and_then(Value::as_str) {
                        t.model = Some(m.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    fn apply_ws_server_request(
        &mut self,
        _workspace_id: &str,
        id: JsonRpcLiteId,
        method: &str,
        params: Value,
    ) {
        let Some(thread_id) = params
            .get("threadId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
        else {
            return;
        };
        let rt = self.thread_runtime_by_id.entry(thread_id).or_default();
        match method {
            "item/commandExecution/requestApproval" => {
                let category = params.get("category").and_then(Value::as_str);
                if category == Some("filesystem") {
                    rt.pending_interactions
                        .push(ChatInteraction::FileChangeApproval {
                            request_id: id,
                            item_id: params
                                .get("itemId")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            path: params
                                .get("path")
                                .or_else(|| params.get("command"))
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            reason: params
                                .get("reason")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                        });
                } else {
                    rt.pending_interactions
                        .push(ChatInteraction::CommandApproval {
                            request_id: id,
                            item_id: params
                                .get("itemId")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            command: params
                                .get("command")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            cwd: params
                                .get("cwd")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            reason: params
                                .get("reason")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            risk_code: params
                                .get("riskCode")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                        });
                }
            }
            "item/tool/requestUserInput" => {
                rt.pending_interactions.push(ChatInteraction::UserInput {
                    request_id: id,
                    item_id: params
                        .get("itemId")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    questions: params.get("questions").cloned().unwrap_or(Value::Null),
                });
            }
            _ => {}
        }
    }

    fn apply_ws_response(
        &mut self,
        workspace_id: &str,
        request_id: u64,
        method: &str,
        result: Result<Value, WsRpcError>,
    ) {
        let payload = match result {
            Ok(v) => v,
            Err(err) => {
                self.apply_ws_error(workspace_id, request_id, method, err);
                return;
            }
        };

        match method {
            "command/list" => {
                if let Some(cmds) = payload
                    .get("commands")
                    .cloned()
                    .and_then(|v| serde_json::from_value::<Vec<CommandInfo>>(v).ok())
                {
                    self.commands_by_workspace
                        .insert(workspace_id.to_string(), cmds);
                }
            }
            "thread/list" => self.apply_thread_list_response(workspace_id, &payload),
            "thread/start" => self.apply_thread_start_response(workspace_id, request_id, &payload),
            "thread/read" | "thread/hydrate" | "thread/resume" => {
                self.apply_thread_snapshot_response(workspace_id, &payload);
            }
            "turn/start" => {
                for draft in self.composer_drafts.values_mut() {
                    draft.submitting = false;
                }
            }
            "cowork/creation/preflight" => {
                if let Ok(preflight) =
                    serde_json::from_value::<CreationPreflightResult>(payload.clone())
                {
                    self.workspace_creation_preflight = Some(preflight);
                }
            }
            "cowork/runtime/diagnostics/read" => {
                if let Ok(diag) = serde_json::from_value::<RuntimeDiagnosticsReadResult>(payload) {
                    self.runtime_diagnostics = Some(diag);
                }
            }
            "cowork/runtime/libreoffice/check" => {
                self.libreoffice_status = Some(payload);
            }
            "cowork/provider/catalog/read" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(arr) = target
                    .get("providers")
                    .or_else(|| target.get("catalog"))
                    .and_then(Value::as_array)
                {
                    self.provider_catalog = arr
                        .iter()
                        .filter_map(|v| serde_json::from_value::<ProviderSummary>(v.clone()).ok())
                        .collect();
                }
            }
            "cowork/provider/authMethods/read" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(obj) = target.get("methodsByProvider").and_then(Value::as_object) {
                    for (prov, val) in obj {
                        if let Some(arr) = val.as_array() {
                            let ids: Vec<String> = arr
                                .iter()
                                .filter_map(|m| {
                                    m.get("id")
                                        .and_then(Value::as_str)
                                        .or_else(|| m.as_str())
                                        .map(str::to_string)
                                })
                                .collect();
                            self.provider_auth_methods.insert(prov.clone(), ids);
                        }
                    }
                }
            }
            "cowork/provider/status/refresh" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(arr) = target.get("statuses").and_then(Value::as_array) {
                    let statuses: Vec<ProviderStatusSummary> = arr
                        .iter()
                        .filter_map(|v| {
                            serde_json::from_value::<ProviderStatusSummary>(v.clone()).ok()
                        })
                        .collect();
                    self.workspace_runtime_by_id
                        .entry(workspace_id.to_string())
                        .or_default()
                        .provider_statuses = statuses;
                }
            }
            "cowork/provider/auth/authorize" => {
                self.last_auth_challenge = Some(payload);
            }
            "cowork/provider/codexAppServer/status" | "cowork/provider/codexAppServer/update" => {
                self.codex_app_server_status = Some(payload);
            }
            "cowork/provider/lmstudio/local/start" => {
                if let Some(modal) = self.lmstudio_start_modal.take()
                    && let Some(thread_id) = modal.thread_id
                {
                    self.dispatch(Action::Chat(ChatAction::RetryFailedTurn { thread_id }));
                }
            }
            "cowork/mcp/servers/read"
            | "cowork/mcp/server/upsert"
            | "cowork/mcp/server/delete"
            | "cowork/mcp/server/setEnabled" => {
                let evt = payload.get("event").unwrap_or(&payload);
                self.update_mcp_servers_from_event(evt);
            }
            "cowork/agentProfiles/catalog/read"
            | "cowork/agentProfiles/upsert"
            | "cowork/agentProfiles/delete"
            | "cowork/agentProfiles/copy" => {
                let evt = payload.get("event").unwrap_or(&payload);
                if let Some(profiles) = evt
                    .get("catalog")
                    .and_then(|c| c.get("profiles"))
                    .and_then(Value::as_array)
                {
                    self.subagents = profiles
                        .iter()
                        .filter_map(|v| serde_json::from_value::<SubagentProfile>(v.clone()).ok())
                        .collect();
                }
            }
            "cowork/memory/list" | "cowork/memory/upsert" | "cowork/memory/delete" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(entries) = target.get("entries").and_then(Value::as_array) {
                    self.memory_entries = entries
                        .iter()
                        .filter_map(|v| serde_json::from_value::<MemoryEntry>(v.clone()).ok())
                        .collect();
                }
            }
            "cowork/memory/advanced/list"
            | "cowork/memory/advanced/upsert"
            | "cowork/memory/advanced/delete" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(entries) = target
                    .get("memories")
                    .or_else(|| target.get("entries"))
                    .and_then(Value::as_array)
                {
                    self.advanced_memories = entries.clone();
                }
            }
            "cowork/connectors/openai-native/list"
            | "cowork/connectors/openai-native/refresh"
            | "cowork/connectors/openai-native/setEnabled" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(arr) = target.get("connectors").and_then(Value::as_array) {
                    self.openai_native_connectors = arr.clone();
                }
            }
            "cowork/plugins/read"
            | "cowork/plugins/catalog/read"
            | "cowork/plugins/enable"
            | "cowork/plugins/disable"
            | "cowork/plugins/delete"
            | "cowork/plugins/install"
            | "cowork/plugins/update" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(arr) = target.get("plugins").and_then(Value::as_array) {
                    self.plugins = arr
                        .iter()
                        .filter_map(|v| serde_json::from_value::<PluginSummary>(v.clone()).ok())
                        .collect();
                }
            }
            "cowork/skills/list"
            | "cowork/skills/catalog/read"
            | "cowork/skills/enable"
            | "cowork/skills/disable"
            | "cowork/skills/delete"
            | "cowork/skills/install" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(arr) = target.get("skills").and_then(Value::as_array) {
                    self.skills = arr
                        .iter()
                        .filter_map(|v| serde_json::from_value::<SkillSummary>(v.clone()).ok())
                        .collect();
                }
            }
            "cowork/marketplaces/read"
            | "cowork/marketplaces/add"
            | "cowork/marketplaces/remove" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(arr) = target.get("marketplaces").and_then(Value::as_array) {
                    self.marketplaces = arr.clone();
                }
            }
            "cowork/skills/improvement/status"
            | "cowork/skills/improvement/run"
            | "cowork/skills/improvement/restore" => {
                self.skill_improvement_status = Some(payload);
            }
            "cowork/backups/workspace/read"
            | "cowork/backups/workspace/checkpoint"
            | "cowork/backups/workspace/deleteCheckpoint" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(arr) = target
                    .get("entries")
                    .or_else(|| target.get("backups"))
                    .and_then(Value::as_array)
                {
                    self.backups = arr
                        .iter()
                        .filter_map(|v| serde_json::from_value::<BackupSummary>(v.clone()).ok())
                        .collect();
                }
            }
            "cowork/conversationImport/sources/list" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(arr) = target.get("sources").and_then(Value::as_array) {
                    self.conversation_import_sources = arr.clone();
                }
            }
            "cowork/conversationImport/preview" => {
                self.conversation_import_preview = Some(payload);
            }
            "task/list" => {
                if let Some(arr) = payload.get("tasks").and_then(Value::as_array) {
                    self.tasks = arr
                        .iter()
                        .filter_map(|v| serde_json::from_value::<TaskSummaryView>(v.clone()).ok())
                        .collect();
                }
            }
            "task/read" => {
                if let Ok(task) = serde_json::from_value::<TaskRecordView>(payload) {
                    self.active_task = Some(task);
                }
            }
            _ => {}
        }
    }

    fn apply_ws_error(
        &mut self,
        workspace_id: &str,
        request_id: u64,
        method: &str,
        err: WsRpcError,
    ) {
        if let Some(draft_id) = self.pending_draft_threads_by_rpc_id.remove(&request_id)
            && let Some(rt) = self.thread_runtime_by_id.get_mut(&draft_id)
        {
            rt.pending_turn_count = 0;
            rt.last_error = Some(err.message.clone());
        }
        if method == "turn/start" {
            for draft in self.composer_drafts.values_mut() {
                if draft.submitting {
                    draft.submitting = false;
                    draft.submission_error = Some(err.message.clone());
                }
            }
        } else if method.starts_with("cowork/") {
            self.settings_mutation_error = Some(err.message.clone());
        }
        let rt = self
            .workspace_runtime_by_id
            .entry(workspace_id.to_string())
            .or_default();
        rt.last_error = Some(err.message);
    }

    fn apply_thread_list_response(&mut self, workspace_id: &str, payload: &Value) {
        let Some(arr) = payload.get("threads").and_then(Value::as_array) else {
            return;
        };
        let drafts: Vec<ThreadRecord> = self
            .threads
            .iter()
            .filter(|t| t.workspace_id == workspace_id && t.draft)
            .cloned()
            .collect();
        self.threads
            .retain(|t| t.workspace_id != workspace_id || t.draft);

        let mut archived = Vec::new();
        for v in arr {
            let Some(id) = v.get("id").and_then(Value::as_str) else {
                continue;
            };
            let title = v
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("New Chat")
                .to_string();
            let is_archived = v.get("archived").and_then(Value::as_bool).unwrap_or(false);
            let pinned = v.get("pinned").and_then(Value::as_bool).unwrap_or(false);
            let record = ThreadRecord {
                id: id.to_string(),
                workspace_id: workspace_id.to_string(),
                title: title.clone(),
                status: ThreadStatus::Active,
                session_id: Some(id.to_string()),
                pinned,
                archived: is_archived,
                draft: false,
                provider: v
                    .get("modelProvider")
                    .or_else(|| v.get("provider"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                model: v.get("model").and_then(Value::as_str).map(str::to_string),
                reasoning_effort: v
                    .get("reasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                preview: v
                    .get("lastMessagePreview")
                    .or_else(|| v.get("preview"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                updated_at: parse_timestamp_ms(v.get("updatedAt")),
                created_at: parse_timestamp_ms(v.get("createdAt")),
                source_task_id: v
                    .get("sourceTaskId")
                    .or_else(|| v.get("taskId"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                last_event_seq: v.get("lastEventSeq").and_then(Value::as_u64).unwrap_or(0),
            };
            if is_archived {
                archived.push(ArchivedThreadSummary {
                    id: id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    title,
                    archived_at: record.updated_at,
                });
            }
            if !drafts.iter().any(|d| d.id == id) {
                self.threads.push(record);
            }
        }
        self.archived_threads
            .retain(|a| a.workspace_id != workspace_id);
        self.archived_threads.extend(archived);
    }

    fn apply_thread_start_response(
        &mut self,
        workspace_id: &str,
        request_id: u64,
        payload: &Value,
    ) {
        let thread_val = payload.get("thread").unwrap_or(payload);
        let Some(server_id) = thread_val
            .get("id")
            .or_else(|| payload.get("threadId"))
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };

        let draft_id = self.pending_draft_threads_by_rpc_id.remove(&request_id);
        if let Some(ref old_id) = draft_id {
            self.rekey_thread_runtime_maps(old_id, &server_id);
            self.threads.retain(|t| t.id != *old_id);
        }

        let record = ThreadRecord {
            id: server_id.clone(),
            workspace_id: workspace_id.to_string(),
            title: thread_val
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("New Chat")
                .to_string(),
            status: ThreadStatus::Active,
            session_id: Some(server_id.clone()),
            pinned: thread_val
                .get("pinned")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            archived: false,
            draft: false,
            provider: thread_val
                .get("modelProvider")
                .or_else(|| thread_val.get("provider"))
                .and_then(Value::as_str)
                .map(str::to_string),
            model: thread_val
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            reasoning_effort: None,
            preview: None,
            updated_at: parse_timestamp_ms(thread_val.get("updatedAt")),
            created_at: parse_timestamp_ms(thread_val.get("createdAt")),
            source_task_id: None,
            last_event_seq: 0,
        };
        if let Some(existing) = self.threads.iter_mut().find(|t| t.id == server_id) {
            *existing = record;
        } else {
            self.threads.insert(0, record);
        }

        let cmd_params = CommandListParams {
            thread_id: server_id.clone(),
        };
        let _ = self.send_ws_typed(workspace_id, "command/list", &cmd_params, true);

        if draft_id.is_some() {
            self.flush_next_pending_message(workspace_id, &server_id);
        } else {
            self.dispatch(Action::Navigate(NavAction::OpenThread(server_id)));
        }
    }

    fn apply_thread_snapshot_response(&mut self, workspace_id: &str, payload: &Value) {
        let Some(snapshot) = payload.get("coworkSnapshot") else {
            return;
        };
        let Some(session_id) = snapshot
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let snap_seq = snapshot
            .get("lastEventSeq")
            .and_then(Value::as_u64)
            .unwrap_or(0);

        if let Some(t) = self.threads.iter_mut().find(|t| t.id == session_id) {
            if let Some(title) = snapshot.get("title").and_then(Value::as_str) {
                t.title = title.to_string();
            }
            if let Some(p) = snapshot.get("provider").and_then(Value::as_str) {
                t.provider = Some(p.to_string());
            }
            if let Some(m) = snapshot.get("model").and_then(Value::as_str) {
                t.model = Some(m.to_string());
            }
            t.last_event_seq = t.last_event_seq.max(snap_seq);
            t.draft = false;
        } else {
            self.threads.push(ThreadRecord {
                id: session_id.clone(),
                workspace_id: workspace_id.to_string(),
                title: snapshot
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Chat")
                    .to_string(),
                provider: snapshot
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                model: snapshot
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                last_event_seq: snap_seq,
                ..ThreadRecord::default()
            });
        }

        let rt = self.thread_runtime_by_id.entry(session_id).or_default();
        rt.hydrating = false;
        rt.hydrated = true;

        // Guard against out-of-order stale snapshots when live events already advanced `last_event_seq`.
        if snap_seq > 0 && rt.last_event_seq > snap_seq {
            return;
        }
        rt.last_event_seq = rt.last_event_seq.max(snap_seq);

        if let Some(feed_arr) = snapshot.get("feed").and_then(Value::as_array) {
            let mut next_feed: Vec<FeedItem> = feed_arr
                .iter()
                .filter_map(parse_snapshot_feed_item)
                .collect();
            // Keep any optimistic local user messages whose clientMessageId has not yet landed in snapshot.
            let seen_cids: HashSet<String> = next_feed
                .iter()
                .filter_map(|item| match item {
                    FeedItem::Message {
                        client_message_id: Some(c),
                        ..
                    } => Some(c.clone()),
                    _ => None,
                })
                .collect();
            for item in &rt.feed {
                if let FeedItem::Message {
                    client_message_id: Some(c),
                    ..
                } = item
                    && !seen_cids.contains(c)
                {
                    next_feed.push(item.clone());
                }
            }
            rt.feed = next_feed;
        }
        if let Some(todos_arr) = snapshot.get("todos").and_then(Value::as_array) {
            rt.todos = todos_arr
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect();
        }
        if let Some(agents_arr) = snapshot.get("agents").and_then(Value::as_array) {
            rt.agents = agents_arr
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect();
        }
        if let Some(usage_val) = snapshot
            .get("sessionUsage")
            .or_else(|| snapshot.get("lastTurnUsage"))
            .filter(|v| !v.is_null())
        {
            rt.usage = Some(parse_usage_summary(usage_val));
        }
    }

    fn update_mcp_servers_from_event(&mut self, evt: &Value) {
        let mut servers = Vec::new();
        for key in ["workspaceServers", "userServers", "servers"] {
            if let Some(arr) = evt.get(key).and_then(Value::as_array) {
                for v in arr {
                    if let Ok(mut summary) = serde_json::from_value::<McpServerSummary>(v.clone()) {
                        if summary.source.is_none() {
                            summary.source = Some(
                                if key == "userServers" {
                                    "user"
                                } else {
                                    "workspace"
                                }
                                .to_string(),
                            );
                        }
                        servers.push(summary);
                    } else if let Some(name) = v.get("name").and_then(Value::as_str) {
                        servers.push(McpServerSummary {
                            name: name.to_string(),
                            enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                            transport: v
                                .get("transport")
                                .and_then(Value::as_str)
                                .unwrap_or("stdio")
                                .to_string(),
                            status: v.get("status").and_then(Value::as_str).map(str::to_string),
                            error: v.get("error").and_then(Value::as_str).map(str::to_string),
                            auth_status: v
                                .get("authStatus")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            source: Some(
                                if key == "userServers" {
                                    "user"
                                } else {
                                    "workspace"
                                }
                                .to_string(),
                            ),
                            config: v.clone(),
                        });
                    }
                }
            }
        }
        if !servers.is_empty()
            || evt.get("servers").is_some()
            || evt.get("workspaceServers").is_some()
        {
            self.mcp_servers = servers;
        }
    }

    fn workspace_for_thread(&self, thread_id: &str) -> Option<String> {
        self.threads
            .iter()
            .find(|t| t.id == thread_id)
            .map(|t| t.workspace_id.clone())
            .or_else(|| self.active_workspace_id.clone())
    }

    fn workspace_path(&self, workspace_id: &str) -> Option<String> {
        self.workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .map(|w| w.path.clone())
    }

    fn persist_state(&mut self) {
        let active_thread_id = self.nav.current().active_thread_id.clone().filter(|tid| {
            self.threads
                .iter()
                .find(|t| &t.id == tid)
                .is_none_or(|t| !t.draft)
        });
        let snapshot = PersistedDesktopState {
            settings: self.desktop_settings.clone(),
            workspaces: self.workspaces.clone(),
            workspace_order: self.workspace_order.clone(),
            collapsed_workspace_ids: self.collapsed_workspace_ids.iter().cloned().collect(),
            active_workspace_id: self.active_workspace_id.clone(),
            active_thread_id,
            onboarding: self.onboarding.clone(),
            feature_flags: self.feature_flags.clone(),
        };
        self.send_native(NativeCommand::SavePersistedState(Box::new(snapshot)));
    }
}

fn inject_cwd(params: &mut Value, cwd: Option<String>) {
    if let (Some(c), Some(obj)) = (cwd, params.as_object_mut()) {
        obj.entry("cwd".to_string()).or_insert(Value::String(c));
    }
}

fn build_turn_input(text: &str, attachments: &[TurnAttachmentInputPart]) -> TurnInput {
    if attachments.is_empty() {
        return TurnInput::Text(text.to_string());
    }
    let mut parts = Vec::new();
    if !text.trim().is_empty() {
        parts.push(json!({ "type": "text", "text": text }));
    }
    for att in attachments {
        if let Ok(v) = serde_json::to_value(att) {
            parts.push(v);
        }
    }
    TurnInput::Parts(parts)
}

fn derive_thread_title(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "New Chat".to_string();
    }
    let first_line = trimmed.lines().next().unwrap_or(trimmed).trim();
    let mut out: String = first_line.chars().take(60).collect();
    if first_line.chars().count() > 60 {
        out.push_str("...");
    }
    out
}

fn feed_item_id(item: &FeedItem) -> &str {
    match item {
        FeedItem::Message { id, .. }
        | FeedItem::Reasoning { id, .. }
        | FeedItem::Tool { id, .. }
        | FeedItem::Todos { id, .. }
        | FeedItem::Log { id, .. }
        | FeedItem::Error { id, .. }
        | FeedItem::System { id, .. } => id.as_str(),
    }
}

fn extract_item_text(item: &Value) -> String {
    if let Some(s) = item.get("text").and_then(Value::as_str) {
        return s.to_string();
    }
    if let Some(arr) = item.get("content").and_then(Value::as_array) {
        let mut out = String::new();
        for part in arr {
            if let Some(t) = part
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| part.as_str())
            {
                out.push_str(t);
            }
        }
        return out;
    }
    if let Some(arr) = item.get("summary").and_then(Value::as_array) {
        let mut out = String::new();
        for part in arr {
            if let Some(t) = part
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| part.as_str())
            {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
        return out;
    }
    String::new()
}

fn parse_tool_status(raw: Option<&str>) -> Option<ToolRunStatus> {
    match raw? {
        "pending" => Some(ToolRunStatus::Pending),
        "running" | "inProgress" | "in_progress" => Some(ToolRunStatus::Running),
        "completed" => Some(ToolRunStatus::Completed),
        "failed" | "error" => Some(ToolRunStatus::Failed),
        "declined" => Some(ToolRunStatus::Declined),
        _ => None,
    }
}

fn parse_usage_summary(val: &Value) -> UsageSummary {
    UsageSummary {
        input_tokens: val
            .get("inputTokens")
            .or_else(|| val.get("input_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: val
            .get("outputTokens")
            .or_else(|| val.get("output_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cached_tokens: val
            .get("cachedTokens")
            .or_else(|| val.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        estimated_cost_usd: val
            .get("estimatedCostUsd")
            .or_else(|| val.get("costUsd"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    }
}

fn parse_timestamp_ms(val: Option<&Value>) -> i64 {
    match val {
        Some(v) if v.is_i64() => v.as_i64().unwrap_or(0),
        Some(v) if v.is_string() => v
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0),
        _ => 0,
    }
}

fn parse_snapshot_feed_item(v: &Value) -> Option<FeedItem> {
    if let Ok(item) = serde_json::from_value::<FeedItem>(v.clone()) {
        return Some(item);
    }
    let id = v.get("id").and_then(Value::as_str)?.to_string();
    let ts = parse_timestamp_ms(v.get("ts").or_else(|| v.get("timestampMs")));
    match v.get("kind").and_then(Value::as_str)? {
        "user" | "assistant" | "system" | "message" => {
            let role_str = v
                .get("role")
                .or_else(|| v.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("assistant");
            let role = match role_str {
                "user" => FeedMessageRole::User,
                "system" => FeedMessageRole::System,
                _ => FeedMessageRole::Assistant,
            };
            Some(FeedItem::Message {
                id,
                role,
                content: v
                    .get("content")
                    .or_else(|| v.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                client_message_id: v
                    .get("clientMessageId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                attachments: Vec::new(),
                references: Vec::new(),
                citations: parse_citations(v.get("citations")),
                streaming: false,
                timestamp_ms: ts,
            })
        }
        "thinking" | "reasoning" => Some(FeedItem::Reasoning {
            id,
            content: v
                .get("text")
                .or_else(|| v.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            mode: v
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("reasoning")
                .to_string(),
            streaming: false,
            timestamp_ms: ts,
        }),
        "tool" => Some(FeedItem::Tool {
            id,
            tool_name: v
                .get("tool")
                .or_else(|| v.get("toolName"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            title: v.get("title").and_then(Value::as_str).map(str::to_string),
            call_id: v.get("callId").and_then(Value::as_str).map(str::to_string),
            status: parse_tool_status(v.get("status").and_then(Value::as_str))
                .unwrap_or(ToolRunStatus::Completed),
            input: v.get("input").cloned().unwrap_or(Value::Null),
            output: v.get("output").cloned(),
            error: v.get("error").and_then(Value::as_str).map(str::to_string),
            diff: v.get("diff").and_then(Value::as_str).map(str::to_string),
            streaming: false,
            timestamp_ms: ts,
            completed_at_ms: v.get("completedAt").map(|c| parse_timestamp_ms(Some(c))),
            output_truncated: v
                .get("outputTruncated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "error" => Some(FeedItem::Error {
            id,
            message: v
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Error")
                .to_string(),
            code: v.get("code").and_then(Value::as_str).map(str::to_string),
            timestamp_ms: ts,
        }),
        _ => None,
    }
}

/// Applies `Action::Shell(ShellAction::DismissToast(...))` when triggered from a `rune_kit::Toast`.
pub fn dismiss_toast(state: &mut AppState, key: String) {
    state.dispatch(Action::Shell(ShellAction::DismissToast(key)));
}

fn parse_citations(val: Option<&Value>) -> Vec<CitationSource> {
    let Some(arr) = val.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| {
            let url = v.get("url").and_then(Value::as_str)?.to_string();
            Some(CitationSource {
                label: v.get("label").and_then(Value::as_str).map(str::to_string),
                title: v.get("title").and_then(Value::as_str).map(str::to_string),
                url,
                domain: v.get("domain").and_then(Value::as_str).map(str::to_string),
                snippet: v.get("snippet").and_then(Value::as_str).map(str::to_string),
                reference_id: v
                    .get("referenceId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("csv") => "text/csv",
        Some("md") | Some("markdown") => "text/markdown",
        Some("json") => "application/json",
        Some("txt") | Some("rs") | Some("ts") | Some("tsx") | Some("py") => "text/plain",
        _ => "application/octet-stream",
    }
}

fn probe_image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    // PNG IHDR width/height at offsets 16..24.
    if bytes.len() >= 24 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return Some((w, h));
    }
    // GIF logical screen width/height at offsets 6..10.
    if bytes.len() >= 10 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        let w = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let h = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        return Some((w, h));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_navigation_and_theme_transitions() {
        let mut state = AppState::default();
        assert_eq!(state.route().view, ViewId::Chat);

        state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
            SettingsPageId::Providers,
        ))));
        assert_eq!(state.route().view, ViewId::Settings);
        assert_eq!(state.route().settings_page, SettingsPageId::Models);
        assert!(state.nav.can_go_back());

        state.dispatch(Action::Navigate(NavAction::GoBack));
        assert_eq!(state.route().view, ViewId::Chat);

        state.dispatch(Action::Shell(ShellAction::SetTheme(ThemePreference::Dark)));
        assert_eq!(state.desktop_settings.theme, ThemePreference::Dark);
        assert!(!state.services.emitted_native_commands.is_empty());
    }

    #[test]
    fn pending_thread_message_queue_preserves_attachments_references_and_fifo_prepend() {
        let mut state = AppState::default();
        let att = vec![TurnAttachmentInputPart::InlineFile {
            filename: "first.txt".to_string(),
            content_base64: "Zmlyc3Q=".to_string(),
            mime_type: "text/plain".to_string(),
        }];
        let refs = vec![TurnReference {
            kind: "skill".to_string(),
            name: "review".to_string(),
        }];
        state.queue_pending_thread_message(
            "local",
            PendingThreadMessage {
                text: " text only ".to_string(),
                ..Default::default()
            },
            false,
        );
        state.queue_pending_thread_message(
            "local",
            PendingThreadMessage {
                text: " ".to_string(),
                attachments: att.clone(),
                references: refs.clone(),
                client_message_id: Some("client-1".to_string()),
                draft_submission: None,
            },
            false,
        );
        state.queue_pending_thread_message(
            "local",
            PendingThreadMessage {
                text: "last".to_string(),
                ..Default::default()
            },
            false,
        );

        assert_eq!(
            state.shift_pending_thread_message("local").unwrap().text,
            "text only"
        );
        let second = state.shift_pending_thread_message("local").unwrap();
        assert_eq!(second.text, "");
        assert_eq!(second.attachments, att);
        assert_eq!(second.references, refs);
        assert_eq!(second.client_message_id.as_deref(), Some("client-1"));

        // Prepend failed item back to front without disturbing "last".
        state.queue_pending_thread_message("local", second, true);
        assert_eq!(
            state
                .shift_pending_thread_message("local")
                .unwrap()
                .client_message_id
                .as_deref(),
            Some("client-1")
        );
        assert_eq!(
            state.shift_pending_thread_message("local").unwrap().text,
            "last"
        );
        assert!(state.shift_pending_thread_message("local").is_none());
        assert!(!state.pending_thread_messages.contains_key("local"));
    }

    #[test]
    fn pending_queue_ignores_empty_or_reference_only_and_rekey_preserves_destination() {
        let mut state = AppState::default();
        state.queue_pending_thread_message(
            "thread-1",
            PendingThreadMessage {
                text: "   ".to_string(),
                attachments: Vec::new(),
                references: vec![TurnReference {
                    kind: "skill".to_string(),
                    name: "review".to_string(),
                }],
                ..Default::default()
            },
            false,
        );
        assert!(!state.pending_thread_messages.contains_key("thread-1"));

        state.queue_pending_thread_message(
            "local",
            PendingThreadMessage {
                text: "local".to_string(),
                ..Default::default()
            },
            false,
        );
        state.queue_pending_thread_message(
            "server",
            PendingThreadMessage {
                text: "server".to_string(),
                ..Default::default()
            },
            false,
        );
        state.rekey_thread_runtime_maps("local", "server");
        assert!(!state.pending_thread_messages.contains_key("local"));
        assert_eq!(
            state.shift_pending_thread_message("server").unwrap().text,
            "server"
        );
        assert!(state.shift_pending_thread_message("server").is_none());
    }

    #[test]
    fn thread_event_reducer_handles_streaming_deltas_dedup_tools_and_snapshot_seq() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));
        state.active_workspace_id = Some("ws-1".to_string());
        state.threads.push(ThreadRecord {
            id: "th-1".to_string(),
            workspace_id: "ws-1".to_string(),
            title: "Test".to_string(),
            ..Default::default()
        });
        state.dispatch(Action::Navigate(NavAction::OpenThread("th-1".to_string())));

        // User sends message -> assigns clientMessageId and sends `turn/start`.
        state.dispatch(Action::Chat(ChatAction::SendMessage {
            thread_id: Some("th-1".to_string()),
            text: "Hello agent".to_string(),
            busy_policy: ThreadBusyPolicy::Steer,
            attachments: Vec::new(),
            references: Vec::new(),
        }));
        let turn_cmd = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. } if method == "turn/start" => {
                    Some(params.clone())
                }
                _ => None,
            })
            .expect("expected turn/start request");
        serde_json::from_value::<TurnStartParams>(turn_cmd.clone())
            .expect("turn/start params must match cowork-protocol schema");
        let cid = turn_cmd["clientMessageId"].as_str().unwrap().to_string();

        // Turn starts and echoes userMessage with clientMessageId (deduplicating optimistic item).
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "turn/started".to_string(),
            params: json!({ "threadId": "th-1", "turnId": "t-1", "seq": 5 }),
        });
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "item/started".to_string(),
            params: json!({
                "threadId": "th-1",
                "seq": 6,
                "item": {
                    "id": "usr-srv-1",
                    "type": "userMessage",
                    "clientMessageId": cid,
                    "text": "Hello agent"
                }
            }),
        });
        assert_eq!(state.active_thread_runtime().unwrap().feed.len(), 1);

        // Reasoning + assistant message deltas + tool execution preserving declined terminal status.
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "item/started".to_string(),
            params: json!({
                "threadId": "th-1",
                "item": { "id": "reason-1", "type": "reasoning", "text": "" }
            }),
        });
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "item/reasoning/delta".to_string(),
            params: json!({ "threadId": "th-1", "itemId": "reason-1", "delta": "Thinking..." }),
        });
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "item/agentMessage/delta".to_string(),
            params: json!({ "threadId": "th-1", "itemId": "asst-1", "delta": "Hi " }),
        });
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "item/agentMessage/delta".to_string(),
            params: json!({ "threadId": "th-1", "itemId": "asst-1", "delta": "there!" }),
        });
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "item/started".to_string(),
            params: json!({
                "threadId": "th-1",
                "item": { "id": "tool-1", "type": "commandExecution", "tool": "bash", "status": "declined" }
            }),
        });
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "th-1",
                "item": { "id": "tool-1", "type": "commandExecution", "status": "completed" }
            }),
        });

        // Stale snapshot (seq 4 < 6) must NOT wipe live streamed feed!
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 99,
            method: "thread/hydrate".to_string(),
            result: Ok(json!({
                "coworkSnapshot": {
                    "sessionId": "th-1",
                    "lastEventSeq": 4,
                    "feed": []
                }
            })),
        });

        let rt = state.active_thread_runtime().unwrap();
        assert_eq!(rt.feed.len(), 4);
        assert!(matches!(
            &rt.feed[2],
            FeedItem::Message { content, .. } if content == "Hi there!"
        ));
        assert!(matches!(
            &rt.feed[3],
            FeedItem::Tool {
                status: ToolRunStatus::Declined,
                ..
            }
        ));

        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "turn/completed".to_string(),
            params: json!({ "threadId": "th-1", "turnId": "t-1", "status": "completed" }),
        });
        assert!(!state.active_thread_runtime().unwrap().streaming);
    }

    #[test]
    fn approval_routing_and_draft_persistence_exclusion() {
        let mut state = AppState::default();
        state.threads.push(ThreadRecord {
            id: "draft-1".to_string(),
            workspace_id: "ws-1".to_string(),
            draft: true,
            ..Default::default()
        });
        state.threads.push(ThreadRecord {
            id: "task-thread".to_string(),
            workspace_id: "ws-1".to_string(),
            source_task_id: Some("task-1".to_string()),
            ..Default::default()
        });
        state.threads.push(ThreadRecord {
            id: "real-thread".to_string(),
            workspace_id: "ws-1".to_string(),
            ..Default::default()
        });
        let persisted = state.persistable_threads();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].id, "real-thread");

        state.apply_store_event(StoreEvent::WsServerRequest {
            workspace_id: "ws-1".to_string(),
            id: JsonRpcLiteId::String("req-fs".to_string()),
            method: "item/commandExecution/requestApproval".to_string(),
            params: json!({
                "threadId": "real-thread",
                "itemId": "it-1",
                "category": "filesystem",
                "path": "/tmp/a.txt",
                "reason": "requires_manual_review"
            }),
        });
        let interactions = &state
            .thread_runtime_by_id
            .get("real-thread")
            .unwrap()
            .pending_interactions;
        assert!(matches!(
            &interactions[0],
            ChatInteraction::FileChangeApproval { .. }
        ));
    }

    #[test]
    fn cowork_prefixed_settings_and_thread_rpcs_conform_to_protocol() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));
        state.threads.push(ThreadRecord {
            id: "th-1".to_string(),
            workspace_id: "ws-1".to_string(),
            ..Default::default()
        });

        state.dispatch(Action::Chat(ChatAction::ArchiveThread("th-1".to_string())));
        state.dispatch(Action::Chat(ChatAction::SetThreadReasoningEffort {
            thread_id: "th-1".to_string(),
            provider: "openai".to_string(),
            effort: ReasoningEffortValue::High,
        }));
        state.dispatch(Action::Settings(SettingsAction::RefreshProviderCatalog {
            workspace_id: "ws-1".to_string(),
        }));

        let sent: Vec<(&str, &Value)> = state
            .services
            .emitted_ws_commands
            .iter()
            .filter_map(|c| match c {
                WsCommand::SendRequest { method, params, .. } => Some((method.as_str(), params)),
                _ => None,
            })
            .collect();

        assert_eq!(sent[0].0, "thread/archived/set");
        assert!(serde_json::from_value::<ThreadArchivedSetParams>(sent[0].1.clone()).is_ok());

        assert_eq!(sent[1].0, "cowork/session/config/set");
        assert!(serde_json::from_value::<SessionConfigSetParams>(sent[1].1.clone()).is_ok());

        assert_eq!(sent[2].0, "cowork/provider/catalog/read");
        assert!(serde_json::from_value::<ProviderCatalogReadParams>(sent[2].1.clone()).is_ok());
    }

    #[test]
    fn composer_sync_and_landing_submit_preserve_and_clear_drafts() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord::new(
            "ws-land",
            "Landing WS",
            "/tmp/land",
            1,
        ));
        state.landing_workspace_id = Some("ws-land".to_string());
        state.threads.push(ThreadRecord {
            id: "th-1".to_string(),
            workspace_id: "ws-land".to_string(),
            title: "Existing".to_string(),
            ..Default::default()
        });

        // Edit landing draft via SetComposerDraftText -> syncs composer_edit.
        state.dispatch(Action::Chat(ChatAction::SetComposerDraftText {
            key: "__new__".to_string(),
            text: "Landing prompt".to_string(),
        }));
        assert_eq!(state.composer_edit.text, "Landing prompt");

        // Switch to existing thread -> composer_edit loads th-1 draft (empty), then typing persists back.
        state.dispatch(Action::Navigate(NavAction::OpenThread("th-1".to_string())));
        assert_eq!(state.composer_edit.text, "");
        state.dispatch(Action::Chat(ChatAction::SetComposerDraftText {
            key: "th-1".to_string(),
            text: "Thread draft".to_string(),
        }));

        // Return to New Chat landing -> restores landing draft and clears cleanly on ClearComposerDraft.
        state.dispatch(Action::Navigate(NavAction::OpenNewChat {
            workspace_id: None,
        }));
        assert_eq!(state.composer_edit.text, "Landing prompt");

        // SendMessage from landing (thread_id: None) creates draft thread in landing_workspace_id and emits thread/start.
        state.dispatch(Action::Chat(ChatAction::SendMessage {
            thread_id: None,
            text: "Landing prompt".to_string(),
            busy_policy: ThreadBusyPolicy::Steer,
            attachments: Vec::new(),
            references: Vec::new(),
        }));
        assert_eq!(state.composer_edit.text, "");
        let draft = state
            .threads
            .iter()
            .find(|t| t.draft)
            .expect("expected draft thread from landing submit");
        assert_eq!(draft.workspace_id, "ws-land");

        // Clipboard PNG paste sets inline attachment + image dimensions preview.
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec();
        png.extend_from_slice(&320u32.to_be_bytes());
        png.extend_from_slice(&200u32.to_be_bytes());
        state.dispatch(Action::Native(NativeAction::PasteClipboardImage {
            key: "th-1".to_string(),
            bytes: png,
            mime_type: "image/png".to_string(),
            filename: Some("clip.png".to_string()),
        }));
        let previews = state.attachment_previews_by_key.get("th-1").unwrap();
        assert_eq!(previews[0].width, Some(320));
        assert_eq!(previews[0].height, Some(200));
        assert!(
            previews[0]
                .data_url
                .as_deref()
                .is_some_and(|u| u.starts_with("data:image/png;base64,"))
        );

        state.dispatch(Action::Navigate(NavAction::OpenThread("th-1".to_string())));
        state.dispatch(Action::Chat(ChatAction::ClearComposerDraft(
            "th-1".to_string(),
        )));
        assert_eq!(state.composer_edit.text, "");
        assert!(!state.attachment_previews_by_key.contains_key("th-1"));
    }
}
