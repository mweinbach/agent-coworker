//! Client-side desktop state store and synchronous action/event reducers.
//!
//! Ported from `apps/desktop/src/app/store.ts`, `apps/desktop/src/app/types.ts`, and
//! `apps/desktop/src/app/store.helpers/`.
//! Views read `&AppState` and dispatch `Action` values via `AppState::dispatch`; background
//! `ws/` and `native/` tasks push `StoreEvent` values and wake Rune's event loop so
//! `AppState::drain_events` reduces them on the UI thread.

use std::collections::{HashMap, HashSet};

use cowork_protocol::{
    CommandInfo, CreationPreflightResult, InitializeResult, JsonRpcLiteId,
    RuntimeDiagnosticsReadResult, TurnAttachmentInputPart, TurnReference,
};
use rune::TextEdit;
use rune_kit::PaneState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::actions::{
    Action, ChatAction, NativeAction, NativeCommand, NavAction, SettingsAction, ShellAction,
    SidebarSectionKey, StoreEvent,
};
use crate::router::{NavigationHistory, NavigationSnapshot, SettingsPageId, ViewId};
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
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub path: String,
    pub one_off_chat: bool,
    pub archived: bool,
    pub created_at: i64,
    pub last_opened_at: i64,
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

/// Sidebar thread metadata matching `apps/desktop/src/app/types.ts`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub pinned: bool,
    pub archived: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub preview: Option<String>,
    pub updated_at: i64,
    pub created_at: i64,
    pub source_task_id: Option<String>,
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

/// One Todo item inside `FeedItem::Todos`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItemView {
    pub id: String,
    pub content: String,
    pub status: String,
    pub priority: Option<String>,
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
        streaming: bool,
        timestamp_ms: i64,
    },
    Reasoning {
        id: String,
        content: String,
        streaming: bool,
        timestamp_ms: i64,
    },
    Tool {
        id: String,
        tool_name: String,
        call_id: Option<String>,
        status: ToolRunStatus,
        input: Value,
        output: Option<Value>,
        error: Option<String>,
        diff: Option<String>,
        streaming: bool,
        timestamp_ms: i64,
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
    pub role: Option<String>,
    pub status: String,
    pub model: Option<String>,
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

/// Live runtime state per thread.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRuntime {
    pub hydrated: bool,
    pub hydrating: bool,
    pub streaming: bool,
    pub active_turn_id: Option<String>,
    pub pending_turn_count: usize,
    pub pending_steer: Option<PendingSteerState>,
    pub attachment_ingesting: bool,
    pub feed: Vec<FeedItem>,
    pub pending_interactions: Vec<ChatInteraction>,
    pub agents: Vec<ThreadAgentSummary>,
    pub agent_run_feeds: HashMap<String, Vec<FeedItem>>,
    pub todos: Vec<TodoItemView>,
    pub unread: bool,
    pub usage: Option<UsageSummary>,
    pub usage_hard_cap: Option<f64>,
    pub usage_hard_cap_reached: bool,
    pub transcript_delivery_failure: Option<TranscriptDeliveryFailure>,
    pub source_task: Option<SourceTaskLock>,
    pub last_error: Option<String>,
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
    pub base_url: Option<String>,
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
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub id: String,
    pub name: String,
    pub configured: bool,
    pub models: Vec<ProviderModelSummary>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatusSummary {
    pub provider: String,
    pub healthy: bool,
    pub auth_method: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub name: String,
    pub enabled: bool,
    pub transport: String,
    pub status: Option<String>,
    pub config: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub scope: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub enabled: bool,
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
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterState {
    pub status: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub error: Option<String>,
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

/// Background channel endpoints attached to `AppState`.
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
    pub runtime_diagnostics: Option<RuntimeDiagnosticsReadResult>,
    pub telemetry_status: Option<Value>,
    pub commands_by_workspace: HashMap<String, Vec<CommandInfo>>,
    pub image_bytes_by_request: HashMap<String, (Option<String>, Vec<u8>)>,
    pub remote_access: RemoteAccessState,
    pub updater: UpdaterState,
    pub pending_rpc_meta: HashMap<u64, PendingRpcMeta>,
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
            runtime_diagnostics: None,
            telemetry_status: None,
            commands_by_workspace: HashMap::new(),
            image_bytes_by_request: HashMap::new(),
            remote_access: RemoteAccessState::default(),
            updater: UpdaterState::default(),
            pending_rpc_meta: HashMap::new(),
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
                        settings_page: SettingsPageId::Models,
                        active_thread_id: Some(thread_id),
                        ..NavigationSnapshot::default()
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
            StoreEvent::FilesPicked { .. } => {}
            StoreEvent::WorkspaceAdded(workspace) => {
                let workspace_id = workspace.id.clone();
                let path = workspace.path.clone();
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
                    yolo: false,
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
            StoreEvent::MenuInvoked(command_id) => match command_id.as_str() {
                "settings" => self.dispatch(Action::Navigate(NavAction::OpenSettings(None))),
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
        let mut next = self.nav.current().clone();
        match action {
            NavAction::OpenView(view) => {
                next.view = view;
                self.nav.push(next);
            }
            NavAction::OpenThread(thread_id) => {
                if let Some(ws_id) = self
                    .threads
                    .iter()
                    .find(|t| t.id == thread_id)
                    .map(|t| t.workspace_id.clone())
                {
                    self.active_workspace_id = Some(ws_id);
                }
                next.view = ViewId::Chat;
                next.active_thread_id = Some(thread_id.clone());
                if let Some(rt) = self.thread_runtime_by_id.get_mut(&thread_id) {
                    rt.unread = false;
                }
                self.nav.push(next);
            }
            NavAction::OpenNewChat { workspace_id } => {
                if let Some(ws_id) = workspace_id {
                    self.active_workspace_id = Some(ws_id.clone());
                    self.landing_workspace_id = Some(ws_id);
                }
                next.view = ViewId::Chat;
                next.active_thread_id = None;
                self.nav.push(next);
            }
            NavAction::OpenTask(task_id) => {
                next.view = ViewId::Task;
                next.active_task_id = Some(task_id);
                self.nav.push(next);
            }
            NavAction::OpenSettings(page) => {
                next.view = ViewId::Settings;
                next.settings_tab = None;
                next.settings_section = None;
                next.new_provider_intent = false;
                if let Some(page) = page {
                    next.settings_page = page.canonical();
                }
                self.nav.push(next);
            }
            NavAction::OpenSettingsIntent {
                page,
                tab,
                section,
                new_provider,
            } => {
                next.view = ViewId::Settings;
                next.settings_page = page.canonical();
                next.settings_tab = tab;
                next.settings_section = section;
                next.new_provider_intent = new_provider;
                self.nav.push(next);
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
                if let Some(ws_id) = workspace_id
                    .or_else(|| self.resolve_management_workspace_id().map(str::to_string))
                {
                    let _ = self.send_ws_request(
                        &ws_id,
                        "creation/repair",
                        serde_json::json!({ "action": action }),
                        false,
                    );
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
            }
            ChatAction::ClearComposerDraft(key) => {
                self.composer_drafts.remove(&key);
            }
            ChatAction::SendMessage {
                thread_id, text, ..
            } => {
                if let Some(tid) = thread_id {
                    let rt = self.thread_runtime_by_id.entry(tid).or_default();
                    rt.pending_turn_count += 1;
                    rt.feed.push(FeedItem::Message {
                        id: format!("optimistic-{}", self.services.next_request_tag),
                        role: FeedMessageRole::User,
                        content: text,
                        client_message_id: None,
                        attachments: Vec::new(),
                        references: Vec::new(),
                        streaming: false,
                        timestamp_ms: (self.now_secs * 1000.0) as i64,
                    });
                    self.services.next_request_tag += 1;
                }
            }
            ChatAction::CancelTurn {
                thread_id,
                include_subagents,
            } => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let _ = self.send_ws_request(
                        &ws_id,
                        "turn/interrupt",
                        serde_json::json!({
                            "threadId": thread_id,
                            "includeSubagents": include_subagents,
                        }),
                        false,
                    );
                }
            }
            ChatAction::ClearThreadUsageHardCap(thread_id) => {
                if let Some(rt) = self.thread_runtime_by_id.get_mut(&thread_id) {
                    rt.usage_hard_cap_reached = false;
                }
            }
            ChatAction::HydrateThread(thread_id) => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let rt = self
                        .thread_runtime_by_id
                        .entry(thread_id.clone())
                        .or_default();
                    rt.hydrating = true;
                    let _ = self.send_ws_request(
                        &ws_id,
                        "thread/hydrate",
                        serde_json::json!({ "threadId": thread_id }),
                        true,
                    );
                }
            }
            ChatAction::CreateThread {
                workspace_id,
                title,
            } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "thread/start",
                    serde_json::json!({ "title": title }),
                    false,
                );
            }
            ChatAction::RenameThread { thread_id, title } => {
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.title = title.clone();
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let _ = self.send_ws_request(
                        &ws_id,
                        "session/title/set",
                        serde_json::json!({ "threadId": thread_id, "title": title }),
                        false,
                    );
                }
            }
            ChatAction::SetThreadPinned { thread_id, pinned } => {
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.pinned = pinned;
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let _ = self.send_ws_request(
                        &ws_id,
                        "thread/pinned/set",
                        serde_json::json!({ "threadId": thread_id, "pinned": pinned }),
                        false,
                    );
                }
            }
            ChatAction::ArchiveThread(thread_id) => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let _ = self.send_ws_request(
                        &ws_id,
                        "thread/archive",
                        serde_json::json!({ "threadId": thread_id }),
                        false,
                    );
                }
            }
            ChatAction::RestoreThread(thread_id) => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let _ = self.send_ws_request(
                        &ws_id,
                        "thread/unarchive",
                        serde_json::json!({ "threadId": thread_id }),
                        false,
                    );
                }
            }
            ChatAction::DeleteThread(thread_id) => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let _ = self.send_ws_request(
                        &ws_id,
                        "session/delete",
                        serde_json::json!({ "threadId": thread_id }),
                        false,
                    );
                }
            }
            ChatAction::ForkThread { thread_id, turn_id } => {
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let _ = self.send_ws_request(
                        &ws_id,
                        "thread/fork",
                        serde_json::json!({ "threadId": thread_id, "turnId": turn_id }),
                        false,
                    );
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
                    let _ = self.send_ws_request(
                        &ws_id,
                        "session/model/set",
                        serde_json::json!({
                            "threadId": thread_id,
                            "provider": provider,
                            "model": model,
                        }),
                        false,
                    );
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
                    let _ = self.send_ws_request(
                        &ws_id,
                        "session/model/set",
                        serde_json::json!({
                            "threadId": thread_id,
                            "provider": provider,
                            "reasoningEffort": effort.as_str(),
                        }),
                        false,
                    );
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
                let result = serde_json::json!({ "answers": answers });
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
        }
    }

    fn reduce_settings(&mut self, action: SettingsAction) {
        match action {
            SettingsAction::UpdateDesktopSettings(settings) => {
                self.desktop_settings = settings;
                self.persist_state();
            }
            SettingsAction::RefreshProviderCatalog { workspace_id } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "provider/catalog/read",
                    serde_json::json!({}),
                    true,
                );
            }
            SettingsAction::SetProviderApiKey {
                workspace_id,
                provider,
                api_key,
            } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "provider/auth/apiKey/set",
                    serde_json::json!({ "provider": provider, "apiKey": api_key }),
                    false,
                );
            }
            SettingsAction::StartProviderAuth {
                workspace_id,
                provider,
            } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "provider/auth/authorize",
                    serde_json::json!({ "provider": provider }),
                    false,
                );
            }
            SettingsAction::LogoutProvider {
                workspace_id,
                provider,
            } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "provider/auth/logout",
                    serde_json::json!({ "provider": provider }),
                    false,
                );
            }
            SettingsAction::SetModelEnabled {
                workspace_id,
                provider,
                model,
                enabled,
            } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "provider/model/enabled/set",
                    serde_json::json!({
                        "provider": provider,
                        "model": model,
                        "enabled": enabled,
                    }),
                    false,
                );
            }
            SettingsAction::UpsertMcpServer {
                workspace_id,
                name,
                config,
            } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "mcp/server/upsert",
                    serde_json::json!({ "name": name, "config": config }),
                    false,
                );
            }
            SettingsAction::DeleteMcpServer { workspace_id, name } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "mcp/server/delete",
                    serde_json::json!({ "name": name }),
                    false,
                );
            }
            SettingsAction::UpsertSubagent {
                workspace_id,
                profile,
            } => {
                if let Ok(params) = serde_json::to_value(profile) {
                    let _ =
                        self.send_ws_request(&workspace_id, "agent/profile/upsert", params, false);
                }
            }
            SettingsAction::DeleteSubagent { workspace_id, id } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "agent/profile/delete",
                    serde_json::json!({ "id": id }),
                    false,
                );
            }
            SettingsAction::UpsertMemory {
                workspace_id,
                key,
                content,
            } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "memory/upsert",
                    serde_json::json!({ "key": key, "content": content }),
                    false,
                );
            }
            SettingsAction::DeleteMemory { workspace_id, key } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "memory/delete",
                    serde_json::json!({ "key": key }),
                    false,
                );
            }
            SettingsAction::SetFeatureFlag { flag_id, enabled } => {
                self.feature_flags.insert(flag_id, enabled);
                self.persist_state();
            }
            SettingsAction::RefreshDiagnostics { workspace_id } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "runtime/diagnostics/read",
                    serde_json::json!({}),
                    true,
                );
            }
            SettingsAction::CheckUpdates => {
                self.send_native(NativeCommand::CheckForUpdates);
            }
            SettingsAction::QuitAndInstallUpdate => {
                self.send_native(NativeCommand::QuitAndInstallUpdate);
            }
            SettingsAction::ListArchivedThreads { workspace_id } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "thread/list",
                    serde_json::json!({ "archived": true }),
                    true,
                );
            }
            SettingsAction::ListBackups { workspace_id } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "workspace/backup/list",
                    serde_json::json!({}),
                    true,
                );
            }
            SettingsAction::RestoreBackup {
                workspace_id,
                backup_id,
            } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "workspace/backup/restore",
                    serde_json::json!({ "backupId": backup_id }),
                    false,
                );
            }
            SettingsAction::ForgetTrustedPhone { phone_id } => {
                self.remote_access
                    .trusted_phones
                    .retain(|p| p.id != phone_id);
            }
            SettingsAction::ExportDiagnosticsBundle => {
                self.send_native(NativeCommand::ExportDiagnosticsBundle);
            }
        }
    }

    fn reduce_native(&mut self, action: NativeAction) {
        match action {
            NativeAction::PickWorkspaceFolder => {
                let request_id = self.next_tag("folder");
                self.send_native(NativeCommand::PickFolder { request_id });
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
                let ws = WorkspaceRecord {
                    id: id.clone(),
                    name: resolved_name,
                    path: path_str.clone(),
                    one_off_chat: false,
                    archived: false,
                    created_at: now,
                    last_opened_at: now,
                };
                self.workspaces.push(ws);
                self.workspace_order.push(id.clone());
                self.active_workspace_id = Some(id.clone());
                self.persist_state();
                self.send_native(NativeCommand::StartWorkspaceServer {
                    workspace_id: id,
                    path: path_str,
                    yolo: false,
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
                if let Some(path) = self
                    .workspaces
                    .iter()
                    .find(|w| w.id == workspace_id)
                    .map(|w| w.path.clone())
                {
                    self.send_native(NativeCommand::StopWorkspaceServer {
                        workspace_id: workspace_id.clone(),
                    });
                    self.send_native(NativeCommand::StartWorkspaceServer {
                        workspace_id,
                        path,
                        yolo: false,
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
        let _ = self.send_ws_request(workspace_id, "thread/list", serde_json::json!({}), true);
        let _ = self.send_ws_request(workspace_id, "command/list", serde_json::json!({}), true);
    }

    fn apply_ws_notification(&mut self, _workspace_id: &str, _method: &str, _params: Value) {
        // Step 2 implements full `threadEventReducer` parity for turn/item deltas,
        // completions, todos, subagents, workflows, and server events.
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
            "item/fileChange/requestApproval" => {
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
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        reason: params
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                    });
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
        _request_id: u64,
        method: &str,
        result: Result<Value, WsRpcError>,
    ) {
        let Ok(payload) = result else {
            return;
        };
        if method == "command/list"
            && let Some(cmds) = payload
                .get("commands")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<CommandInfo>>(v).ok())
        {
            self.commands_by_workspace
                .insert(workspace_id.to_string(), cmds);
        } else if method == "runtime/diagnostics/read"
            && let Ok(diag) = serde_json::from_value::<RuntimeDiagnosticsReadResult>(payload)
        {
            self.runtime_diagnostics = Some(diag);
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
        let snapshot = PersistedDesktopState {
            settings: self.desktop_settings.clone(),
            workspaces: self.workspaces.clone(),
            workspace_order: self.workspace_order.clone(),
            collapsed_workspace_ids: self.collapsed_workspace_ids.iter().cloned().collect(),
            active_workspace_id: self.active_workspace_id.clone(),
            active_thread_id: self.nav.current().active_thread_id.clone(),
            onboarding: self.onboarding.clone(),
            feature_flags: self.feature_flags.clone(),
        };
        self.send_native(NativeCommand::SavePersistedState(Box::new(snapshot)));
    }
}

/// Applies `Action::Shell(ShellAction::DismissToast(...))` when triggered from a `rune_kit::Toast`.
pub fn dismiss_toast(state: &mut AppState, key: String) {
    state.dispatch(Action::Shell(ShellAction::DismissToast(key)));
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
}
