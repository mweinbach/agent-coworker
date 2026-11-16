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
    RuntimeLibreOfficeCheckResult, SessionConfigSetParams, SessionDefaultsApplyParams,
    SessionDeleteParams, SessionModelSetParams, SessionTitleSetParams, ThreadArchivedSetParams,
    ThreadForkParams, ThreadHydrateParams, ThreadListParams, ThreadPinnedSetParams,
    ThreadStartParams, TurnAttachmentInputPart, TurnInput, TurnInterruptParams, TurnReference,
    TurnRetrySpec, TurnStartParams, TurnSteerParams,
};
use rune::TextEdit;
use rune_kit::PaneState;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::actions::{
    Action, ChatAction, NativeAction, NativeCommand, NavAction, SettingsAction, ShellAction,
    SidebarSectionKey, StoreEvent, TaskAction, TranscriptLogEntry,
};
use crate::router::{
    NavigationHistory, NavigationPatch, NavigationSnapshot, SettingsPageId, ViewId,
};
use crate::theme::{self, AccentPalette, ThemePreference};
use crate::ws::{PendingRpcMeta, WsCommand, WsConnectionState, WsRpcError};

pub const WINDOW_MAIN: &str = "main";
pub const WINDOW_QUICK_CHAT: &str = "quick-chat";
pub const WINDOW_UTILITY: &str = "utility";

/// Hidden synthetic prompt used when retrying failed tool calls via `TurnRetrySpec`.
pub const HIDDEN_RETRY_TURN_PROMPT: &str = "Continue from where the previous turn stopped. Retry the failed step only if it is still necessary, then finish the user's request.";

/// Active window surface mode (Electron multi-window equivalent).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowMode {
    #[default]
    Main,
    QuickChat,
    Utility,
}

impl WindowMode {
    pub fn from_window_key(key: &str) -> Self {
        match key {
            WINDOW_QUICK_CHAT => Self::QuickChat,
            WINDOW_UTILITY => Self::Utility,
            _ => Self::Main,
        }
    }
}

/// Target desktop platform override used by scenes/tests to preview Linux, Windows, or macOS chrome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopPlatformOverride {
    MacOs,
    Windows,
    Linux,
}

impl DesktopPlatformOverride {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "macos" | "mac" | "darwin" => Some(Self::MacOs),
            "windows" | "win" | "win32" => Some(Self::Windows),
            "linux" | "x11" | "wayland" => Some(Self::Linux),
            _ => None,
        }
    }

    pub const fn is_macos(self) -> bool {
        matches!(self, Self::MacOs)
    }

    pub const fn is_windows(self) -> bool {
        matches!(self, Self::Windows)
    }

    pub const fn is_linux(self) -> bool {
        matches!(self, Self::Linux)
    }
}

/// Current wall-clock Unix epoch timestamp in seconds (fractional).
pub fn wall_clock_epoch_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
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

pub const DEFAULT_UI_SCALE: f32 = 1.0;
pub const MIN_UI_SCALE: f32 = 0.5;
pub const MAX_UI_SCALE: f32 = 2.5;
pub const UI_SCALE_STEP: f32 = 0.1;
pub const CANVAS_AUTOSAVE_DEBOUNCE_SECS: f64 = 0.6;
pub const CANVAS_REVISION_POLL_SECS: f64 = 1.5;

/// Pending OS window command executed on the Rune UI thread via `WINDOW_HUB`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WindowCommand {
    OpenQuickChat,
    ToggleQuickChat,
    OpenUtility,
    ToggleUtility,
    MinimizeMain,
    ToggleMaximizeMain,
    ToggleFullScreenMain,
    CloseMain,
    QuitApp,
    FocusMain {
        open_new_chat_workspace: Option<String>,
        open_thread_id: Option<String>,
    },
}

/// Server-reported revision metadata for a Canvas document (`FileChangeVersion`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocumentRevision {
    pub modified_at_ms: f64,
    pub change_time_ms: f64,
    pub size: u64,
    pub fingerprint: String,
}

/// Lifecycle state of an active Canvas editing session.
#[derive(Clone, Debug, PartialEq)]
pub enum CanvasDocumentStatus {
    Loading,
    Ready,
    Saving,
    LoadError {
        kind: Option<String>,
        message: String,
    },
    SaveError {
        kind: Option<String>,
        message: String,
    },
    Conflict {
        message: String,
        current_revision: Option<CanvasDocumentRevision>,
    },
}

/// Client-side Canvas document session synced over `cowork/workspace/document/*`.
#[derive(Clone, Debug, PartialEq)]
pub struct CanvasDocumentSession {
    pub workspace_id: String,
    pub document_id: String,
    pub generation: u64,
    pub path: String,
    pub disk_content: String,
    pub draft_content: String,
    pub edit_revision: u64,
    pub last_saved_edit_revision: u64,
    pub truncated: bool,
    pub revision: Option<CanvasDocumentRevision>,
    pub status: CanvasDocumentStatus,
    pub last_saved_at_secs: Option<f64>,
    pub dirty_since_secs: Option<f64>,
    pub last_poll_secs: f64,
}

impl CanvasDocumentSession {
    pub fn dirty(&self) -> bool {
        self.draft_content != self.disk_content
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingCanvasRpc {
    pub document_id: String,
    pub generation: u64,
    pub edit_revision: u64,
    pub target_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingPresentationRpc {
    pub workspace_id: String,
    pub path: String,
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedMessageRole {
    User,
    #[default]
    Assistant,
    System,
}

/// Tool call lifecycle state inside `FeedItem::Tool`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
    #[serde(default)]
    pub last_turn_usage: Option<UsageSummary>,
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
    #[serde(default)]
    pub spreadsheet: Option<crate::views::preview::SpreadsheetPreviewData>,
    #[serde(default)]
    pub presentation: Option<Box<crate::views::preview::PresentationPreviewData>>,
}

/// Returns `true` for PowerPoint deck paths backed by `cowork/workspace/presentation/preview`.
pub fn is_presentation_preview_path(path: &str) -> bool {
    let lower = path.trim().to_ascii_lowercase();
    lower.ends_with(".pptx") || lower.ends_with(".ppt")
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthMethodSpec {
    pub id: String,
    #[serde(rename = "type", default)]
    pub method_type: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub oauth_mode: Option<String>,
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
    #[serde(default)]
    pub plugin_id: Option<String>,
    #[serde(default)]
    pub plugin_name: Option<String>,
    #[serde(default)]
    pub plugin_display_name: Option<String>,
    #[serde(default)]
    pub plugin_scope: Option<String>,
    #[serde(default)]
    pub auth_mode: Option<String>,
    #[serde(default)]
    pub auth_message: Option<String>,
    #[serde(default)]
    pub auth_state: Option<Value>,
    #[serde(default)]
    pub inherited: bool,
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
pub struct ScopedMemoryEntry {
    #[serde(alias = "key")]
    pub id: String,
    #[serde(default)]
    pub scope: String,
    pub content: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub updated_at_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileDefinitionWire {
    #[serde(default = "default_profile_version")]
    pub version: u32,
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true_bool")]
    pub enabled: bool,
    #[serde(default = "default_base_role_value")]
    pub base_role: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub allowed_built_in_tools: Vec<String>,
    #[serde(default)]
    pub allowed_mcp_servers: Vec<String>,
    #[serde(default)]
    pub skill_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_task_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_context_mode: Option<String>,
}

fn default_profile_version() -> u32 {
    1
}

fn default_true_bool() -> bool {
    true
}

fn default_base_role_value() -> String {
    "default".to_string()
}

impl Default for AgentProfileDefinitionWire {
    fn default() -> Self {
        Self {
            version: 1,
            id: String::new(),
            display_name: String::new(),
            description: String::new(),
            enabled: true,
            base_role: "default".to_string(),
            prompt: String::new(),
            allowed_built_in_tools: Vec::new(),
            allowed_mcp_servers: Vec::new(),
            skill_names: Vec::new(),
            model: None,
            reasoning_effort: None,
            default_task_type: None,
            default_context_mode: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileCatalogEntry {
    pub scope: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub built_in: Option<bool>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub effective: bool,
    #[serde(default)]
    pub shadowed: bool,
    #[serde(default)]
    pub workspace_disabled: Option<bool>,
    pub profile: AgentProfileDefinitionWire,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileDiagnostic {
    pub scope: String,
    pub path: String,
    pub severity: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfilesRoots {
    pub global_dir: String,
    pub workspace_dir: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfilesCatalogState {
    #[serde(default)]
    pub profiles: Vec<AgentProfileCatalogEntry>,
    #[serde(default)]
    pub effective_profiles: Vec<AgentProfileCatalogEntry>,
    #[serde(default)]
    pub diagnostics: Vec<AgentProfileDiagnostic>,
    #[serde(default)]
    pub roots: Option<AgentProfilesRoots>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileUpsertInputWire {
    pub scope: String,
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true_bool")]
    pub enabled: bool,
    #[serde(default = "default_base_role_value")]
    pub base_role: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub allowed_built_in_tools: Vec<String>,
    #[serde(default)]
    pub allowed_mcp_servers: Vec<String>,
    #[serde(default)]
    pub skill_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_task_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_context_mode: Option<String>,
}

impl Default for AgentProfileUpsertInputWire {
    fn default() -> Self {
        Self {
            scope: "workspace".to_string(),
            id: String::new(),
            display_name: String::new(),
            description: String::new(),
            enabled: true,
            base_role: "default".to_string(),
            prompt: String::new(),
            allowed_built_in_tools: Vec::new(),
            allowed_mcp_servers: Vec::new(),
            skill_names: Vec::new(),
            model: None,
            reasoning_effort: None,
            default_task_type: None,
            default_context_mode: None,
        }
    }
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
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub objective: String,
    #[serde(default)]
    pub pending_question_count: usize,
    #[serde(default)]
    pub blocking_question_count: usize,
    #[serde(default)]
    pub active_blocker_count: usize,
    #[serde(default)]
    pub completed_work_item_count: usize,
    #[serde(default)]
    pub total_work_item_count: usize,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactView {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mime_type: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub work_item_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub latest_version_id: Option<String>,
    #[serde(default)]
    pub accepted_version_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecordView {
    pub summary: TaskSummaryView,
    pub prompt: String,
    pub questions: Value,
    pub artifacts: Vec<TaskArtifactView>,
    pub runs: Vec<WorkflowRunView>,
    #[serde(default)]
    pub active_artifact_detail: Option<Value>,
    #[serde(default)]
    pub artifact_details_by_id: HashMap<String, Value>,
    #[serde(default)]
    pub blockers: Value,
    #[serde(default)]
    pub work_items: Value,
    #[serde(default)]
    pub threads: Value,
    #[serde(default)]
    pub requirements: Value,
    #[serde(default)]
    pub activity: Vec<Value>,
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

/// Sentinel stored in `landing_workspace_id` when "Quick chat" is selected on the landing page
/// before a backing `one_off_chat` workspace record exists on disk.
pub const ONE_OFF_LANDING_SENTINEL: &str = "__one_off__";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCheckpointSummary {
    pub id: String,
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub changed: bool,
    #[serde(default)]
    pub patch_bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub target_session_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub lifecycle: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub working_directory: String,
    #[serde(default)]
    pub backup_directory: Option<String>,
    #[serde(default)]
    pub original_snapshot_kind: String,
    #[serde(default)]
    pub original_snapshot_bytes: Option<u64>,
    #[serde(default)]
    pub checkpoint_bytes_total: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub checkpoints: Vec<BackupCheckpointSummary>,
    #[serde(default)]
    pub created_at_iso: String,
    #[serde(default)]
    pub updated_at_iso: String,
    #[serde(default)]
    pub closed_at_iso: Option<String>,
    #[serde(default)]
    pub failure_reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDeltaFileView {
    pub path: String,
    pub change: String,
    pub kind: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDeltaView {
    pub target_session_id: String,
    pub checkpoint_id: String,
    #[serde(default)]
    pub baseline_label: String,
    #[serde(default)]
    pub current_label: String,
    #[serde(default)]
    pub added: usize,
    #[serde(default)]
    pub modified: usize,
    #[serde(default)]
    pub deleted: usize,
    #[serde(default)]
    pub files: Vec<BackupDeltaFileView>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageBreakdown {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub turns: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub estimated_cost_usd: f64,
    #[serde(default)]
    pub by_model: HashMap<String, ModelUsageBreakdown>,
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
    pub downloaded_bytes: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub bytes_per_second: Option<u64>,
    #[serde(default)]
    pub packaged: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundleState {
    pub path: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub upload_configured: bool,
    #[serde(default)]
    pub upload_enabled: bool,
    #[serde(default)]
    pub uploaded: bool,
    #[serde(default)]
    pub diagnostic_id: Option<String>,
    #[serde(default)]
    pub upload_url: Option<String>,
    #[serde(default)]
    pub upload_message: Option<String>,
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
    #[serde(default)]
    pub accent_palette: AccentPalette,
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
    #[serde(default = "default_true_bool")]
    pub show_menu_bar: bool,
    pub archived_chats_auto_delete_days: u32,
    pub sidebar_section_order: Vec<SidebarSectionKey>,
    pub privacy_telemetry: PrivacyTelemetrySettings,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            accent_palette: AccentPalette::default(),
            reduced_transparency: false,
            high_contrast: false,
            reduce_motion: false,
            inject_context: true,
            developer_mode: false,
            show_hidden_files: false,
            per_workspace_settings: false,
            quick_chat_icon_enabled: true,
            quick_chat_shortcut_enabled: true,
            quick_chat_shortcut: "CommandOrControl+Shift+Space".to_string(),
            show_menu_bar: true,
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
    #[serde(default)]
    pub threads: Vec<ThreadRecord>,
    pub workspace_order: Vec<String>,
    pub collapsed_workspace_ids: Vec<String>,
    #[serde(default)]
    pub collapsed_sidebar_sections: Vec<SidebarSectionKey>,
    pub active_workspace_id: Option<String>,
    pub active_thread_id: Option<String>,
    pub onboarding: OnboardingState,
    pub feature_flags: HashMap<String, bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_analytics: Option<Value>,
}

/// Feature flag metadata matching `src/shared/featureFlags.ts`.
pub const FEATURE_FLAG_DEFINITIONS: &[(&str, bool, Option<&str>, bool)] = &[
    ("menuBar", true, None, false),
    (
        "remoteAccess",
        false,
        Some("COWORK_ENABLE_REMOTE_ACCESS"),
        true,
    ),
    ("workspacePicker", true, None, false),
    ("workspaceLifecycle", true, None, false),
    ("openAiNativeConnectors", false, None, false),
    ("canvas", false, None, false),
    ("tasks", false, Some("COWORK_ENABLE_TASKS"), false),
    ("workflows", false, Some("COWORK_ENABLE_WORKFLOWS"), false),
];

fn parse_boolean_flag(value: Option<&str>) -> Option<bool> {
    let normalized = value?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Resolves desktop feature flags matching `src/shared/featureFlags.ts::resolveFeatureFlags`.
/// Packaged builds ignore persisted dev overrides and force `remoteAccess` off while
/// preserving non-forced-off environment overrides (`COWORK_ENABLE_TASKS`, `COWORK_ENABLE_WORKFLOWS`).
pub fn resolve_feature_flags_with_env<F>(
    is_packaged: bool,
    overrides: &HashMap<String, bool>,
    env_var: F,
) -> HashMap<String, bool>
where
    F: Fn(&str) -> Option<String>,
{
    let mut values = HashMap::new();
    for &(id, default_enabled, env_key, _) in FEATURE_FLAG_DEFINITIONS {
        let mut enabled = default_enabled;
        if let Some(key) = env_key
            && let Some(env_override) = parse_boolean_flag(env_var(key).as_deref())
        {
            enabled = env_override;
        }
        values.insert(id.to_string(), enabled);
    }
    if !is_packaged {
        for (id, enabled) in overrides {
            values.insert(id.clone(), *enabled);
        }
    }
    if is_packaged {
        for &(id, _, _, packaged_forced_off) in FEATURE_FLAG_DEFINITIONS {
            if packaged_forced_off {
                values.insert(id.to_string(), false);
            }
        }
    }
    values
}

/// Resolves desktop feature flags against the current process environment.
pub fn resolve_feature_flags(
    is_packaged: bool,
    overrides: &HashMap<String, bool>,
) -> HashMap<String, bool> {
    resolve_feature_flags_with_env(is_packaged, overrides, |key| std::env::var(key).ok())
}

/// Non-serialized service handles for background workers and test capture.
pub struct AppServices {
    pub waker: Option<rune::Waker>,
    pub event_tx: mpsc::UnboundedSender<StoreEvent>,
    pub event_rx: mpsc::UnboundedReceiver<StoreEvent>,
    pub ws_tx: Option<mpsc::UnboundedSender<WsCommand>>,
    pub native_tx: Option<mpsc::UnboundedSender<NativeCommand>>,
    pub window_tx: Option<mpsc::UnboundedSender<WindowCommand>>,
    /// Test capture queues used when worker threads are not attached.
    pub emitted_ws_commands: Vec<WsCommand>,
    pub emitted_native_commands: Vec<NativeCommand>,
    pub emitted_window_commands: Vec<WindowCommand>,
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
            window_tx: None,
            emitted_ws_commands: Vec::new(),
            emitted_native_commands: Vec::new(),
            emitted_window_commands: Vec::new(),
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
    pub feature_flag_overrides: HashMap<String, bool>,
    pub workspaces: Vec<WorkspaceRecord>,
    pub workspace_order: Vec<String>,
    pub collapsed_workspace_ids: HashSet<String>,
    pub collapsed_sidebar_sections: HashSet<SidebarSectionKey>,
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
    pub preview_ui: crate::views::preview::PreviewUiState,
    pub toasts: Vec<NotificationRecord>,
    pub operations_by_key: HashMap<String, OperationState>,
    pub tasks: Vec<TaskSummaryView>,
    pub active_task: Option<TaskRecordView>,
    pub workflow_runs: Vec<WorkflowRunView>,
    pub explorer_entries_by_dir: HashMap<String, Vec<WorkspaceFileEntry>>,
    pub explorer_entries_by_workspace: HashMap<(String, String), Vec<WorkspaceFileEntry>>,
    pub explorer_expanded_dirs: HashSet<String>,
    pub provider_catalog: Vec<ProviderSummary>,
    pub provider_auth_methods: HashMap<String, Vec<String>>,
    pub provider_auth_method_specs: HashMap<String, Vec<ProviderAuthMethodSpec>>,
    pub default_model_by_provider: HashMap<String, String>,
    pub last_auth_challenge: Option<Value>,
    pub last_auth_result: Option<Value>,
    pub codex_app_server_status: Option<Value>,
    pub mcp_servers: Vec<McpServerSummary>,
    pub mcp_validation_by_server: HashMap<String, Value>,
    pub mcp_auth_challenge: Option<Value>,
    pub mcp_auth_result: Option<Value>,
    pub marketplaces: Vec<Value>,
    pub openai_native_connectors: Vec<Value>,
    pub skills: Vec<SkillSummary>,
    pub skill_installations: Vec<Value>,
    pub available_skills: Vec<Value>,
    pub effective_skills: Vec<Value>,
    pub skill_scopes: Vec<Value>,
    pub plugins: Vec<PluginSummary>,
    pub installed_plugin_entries: Vec<Value>,
    pub available_plugins: Vec<Value>,
    pub plugin_catalog_warnings: Vec<String>,
    pub skill_improvement_status: Option<Value>,
    pub subagents: Vec<SubagentProfile>,
    pub agent_profiles_catalog: AgentProfilesCatalogState,
    pub memory_entries: Vec<MemoryEntry>,
    pub scoped_memories: Vec<ScopedMemoryEntry>,
    pub advanced_memories: Vec<Value>,
    pub archived_threads: Vec<ArchivedThreadSummary>,
    pub backups: Vec<BackupSummary>,
    pub backup_delta: Option<BackupDeltaView>,
    pub last_backup_restore: Option<Value>,
    pub usage_summary: Option<UsageSummary>,
    pub usage_by_thread: HashMap<String, Value>,
    pub runtime_diagnostics: Option<RuntimeDiagnosticsReadResult>,
    pub diagnostics_bundle: Option<DiagnosticsBundleState>,
    pub libreoffice_check: Option<RuntimeLibreOfficeCheckResult>,
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
    pub chat_ui: crate::views::chat::ChatUiState,
    pub settings_ui: crate::views::settings::SettingsUiState,
    pub shell_ui: crate::views::shell::ShellUiState,
    pub(crate) pending_draft_threads_by_rpc_id: HashMap<u64, String>,
    pub(crate) pending_picker_composer_by_request: HashMap<String, String>,
    pub native_ready: bool,
    pub is_packaged: bool,
    pub system_dark_override: Option<bool>,
    /// Optional platform override used by scenes/tests to preview Linux/Windows/macOS chrome.
    pub menu_platform_override: Option<DesktopPlatformOverride>,
    /// Deferred menu command ID dispatched on the next `poll_app` after popup/modal focus returns.
    pub pending_menu_command: Option<String>,
    /// True when started under a static Rune `--scene`; prevents `NativeReady` from overwriting scene state.
    pub scene_mode: bool,
    /// Wall-clock Unix epoch seconds for timestamps, relative age labels, and timers.
    pub now_secs: f64,
    /// Monotonic Rune frame-loop elapsed seconds passed to `poll_app` (used with `tx.wake_at`).
    pub app_elapsed_secs: f64,
    pub ui_scale: f32,
    pub canvas_document: Option<CanvasDocumentSession>,
    pub product_analytics: Option<Value>,
    pub(crate) pending_launchable_open_path: Option<String>,
    pub(crate) last_launchable_window: WindowMode,
    pub(crate) pending_launchable_paths_by_window: HashMap<WindowMode, String>,
    pub(crate) pending_confirm_dialogs_by_window: HashMap<WindowMode, ConfirmDialogRequest>,
    pub(crate) canvas_generation_seq: u64,
    pub(crate) pending_canvas_rpcs: HashMap<u64, PendingCanvasRpc>,
    pub(crate) pending_presentation_rpcs: HashMap<u64, PendingPresentationRpc>,
    pub(crate) pending_hydrate_threads_by_rpc_id: HashMap<u64, String>,
    pub(crate) persisted_active_thread_id: Option<String>,
    pub(crate) rekeyed_thread_ids: HashMap<String, String>,
    pub(crate) latest_creation_preflight_rpc_id: Option<u64>,
    pub(crate) shared_dirty: bool,
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
            feature_flag_overrides: HashMap::new(),
            workspaces: Vec::new(),
            workspace_order: Vec::new(),
            collapsed_workspace_ids: HashSet::new(),
            collapsed_sidebar_sections: HashSet::new(),
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
            preview_ui: crate::views::preview::PreviewUiState::default(),
            toasts: Vec::new(),
            operations_by_key: HashMap::new(),
            tasks: Vec::new(),
            active_task: None,
            workflow_runs: Vec::new(),
            explorer_entries_by_dir: HashMap::new(),
            explorer_entries_by_workspace: HashMap::new(),
            explorer_expanded_dirs: HashSet::new(),
            provider_catalog: Vec::new(),
            provider_auth_methods: HashMap::new(),
            provider_auth_method_specs: HashMap::new(),
            default_model_by_provider: HashMap::new(),
            last_auth_challenge: None,
            last_auth_result: None,
            codex_app_server_status: None,
            mcp_servers: Vec::new(),
            mcp_validation_by_server: HashMap::new(),
            mcp_auth_challenge: None,
            mcp_auth_result: None,
            marketplaces: Vec::new(),
            openai_native_connectors: Vec::new(),
            skills: Vec::new(),
            skill_installations: Vec::new(),
            available_skills: Vec::new(),
            effective_skills: Vec::new(),
            skill_scopes: Vec::new(),
            plugins: Vec::new(),
            installed_plugin_entries: Vec::new(),
            available_plugins: Vec::new(),
            plugin_catalog_warnings: Vec::new(),
            skill_improvement_status: None,
            subagents: Vec::new(),
            agent_profiles_catalog: AgentProfilesCatalogState::default(),
            memory_entries: Vec::new(),
            scoped_memories: Vec::new(),
            advanced_memories: Vec::new(),
            archived_threads: Vec::new(),
            backups: Vec::new(),
            backup_delta: None,
            last_backup_restore: None,
            usage_summary: None,
            usage_by_thread: HashMap::new(),
            runtime_diagnostics: None,
            diagnostics_bundle: None,
            libreoffice_check: None,
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
            chat_ui: crate::views::chat::ChatUiState::default(),
            settings_ui: crate::views::settings::SettingsUiState::default(),
            shell_ui: crate::views::shell::ShellUiState::default(),
            pending_draft_threads_by_rpc_id: HashMap::new(),
            pending_picker_composer_by_request: HashMap::new(),
            native_ready: false,
            is_packaged: false,
            system_dark_override: None,
            menu_platform_override: None,
            pending_menu_command: None,
            scene_mode: false,
            now_secs: 0.0,
            app_elapsed_secs: 0.0,
            ui_scale: DEFAULT_UI_SCALE,
            canvas_document: None,
            product_analytics: None,
            pending_launchable_open_path: None,
            last_launchable_window: WindowMode::Main,
            pending_launchable_paths_by_window: HashMap::new(),
            pending_confirm_dialogs_by_window: HashMap::new(),
            canvas_generation_seq: 1,
            pending_canvas_rpcs: HashMap::new(),
            pending_presentation_rpcs: HashMap::new(),
            pending_hydrate_threads_by_rpc_id: HashMap::new(),
            persisted_active_thread_id: None,
            rekeyed_thread_ids: HashMap::new(),
            latest_creation_preflight_rpc_id: None,
            shared_dirty: false,
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

    /// Returns cached explorer entries for `workspace_id` and directory `dir`,
    /// normalizing both relative paths (`"./src"`, `""`, `"."`) and canonical/raw root prefixes.
    pub fn explorer_entries(&self, workspace_id: &str, dir: &str) -> Option<&[WorkspaceFileEntry]> {
        let norm = self.normalize_explorer_path(workspace_id, dir);
        self.explorer_entries_by_workspace
            .get(&(workspace_id.to_string(), norm))
            .map(Vec::as_slice)
    }

    fn normalize_explorer_path(&self, workspace_id: &str, raw: &str) -> String {
        fn clean_slashes(s: &str) -> String {
            let replaced = s.trim().replace('\\', "/");
            if replaced.len() > 1 {
                replaced.trim_end_matches('/').to_string()
            } else {
                replaced
            }
        }

        let clean = clean_slashes(raw);
        if clean.is_empty() || clean == "." || clean == "./" {
            return ".".to_string();
        }

        let mut stripped: &str = &clean;
        let mut owned_relative: Option<String> = None;
        if let Some(root) = self.workspace_path(workspace_id) {
            let mut candidates = vec![clean_slashes(&root)];
            if let Ok(canon) = std::fs::canonicalize(&root) {
                let lossy = canon.to_string_lossy();
                let no_unc = lossy.strip_prefix(r"\\?\").unwrap_or(&lossy);
                let canon_clean = clean_slashes(no_unc);
                if !candidates.contains(&canon_clean) {
                    candidates.push(canon_clean);
                }
            }
            for prefix in candidates {
                if clean == prefix {
                    return ".".to_string();
                }
                if prefix == "/" {
                    if let Some(rest) = clean.strip_prefix('/') {
                        owned_relative = Some(rest.to_string());
                        break;
                    }
                } else if clean.starts_with(&prefix)
                    && clean.as_bytes().get(prefix.len()) == Some(&b'/')
                {
                    owned_relative = Some(clean[prefix.len() + 1..].to_string());
                    break;
                }
            }
        }
        if let Some(ref rel) = owned_relative {
            stripped = rel.as_str();
        }
        while let Some(rest) = stripped.strip_prefix("./") {
            stripped = rest;
        }
        let stripped = if stripped.len() > 1 {
            stripped.trim_end_matches('/')
        } else {
            stripped
        };
        if stripped.is_empty() || stripped == "." {
            ".".to_string()
        } else {
            stripped.to_string()
        }
    }

    pub fn resolve_workspace_fs_path(&self, workspace_id: &str, raw: &str) -> String {
        let Some(root) = self.workspace_path(workspace_id) else {
            return raw.to_string();
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() || matches!(trimmed, "." | "./") {
            return root;
        }
        let mut rel = trimmed;
        while let Some(rest) = rel.strip_prefix("./") {
            rel = rest;
        }
        if rel.is_empty() || rel == "." {
            return root;
        }
        if Path::new(rel).is_absolute() {
            raw.to_string()
        } else {
            Path::new(&root).join(rel).to_string_lossy().into_owned()
        }
    }

    fn resolve_active_workspace_fs_path(&self, raw: &str) -> String {
        let trimmed = raw.trim();
        if trimmed.is_empty() || Path::new(trimmed).is_absolute() {
            return raw.to_string();
        }
        if let Some(ws_id) = self.active_workspace_id.as_deref() {
            return self.resolve_workspace_fs_path(ws_id, raw);
        }
        raw.to_string()
    }

    fn sync_active_explorer_dir(&mut self) {
        self.explorer_entries_by_dir.clear();
        let Some(active_ws) = self.active_workspace_id.as_deref() else {
            return;
        };
        for ((ws_id, dir), entries) in &self.explorer_entries_by_workspace {
            if ws_id == active_ws {
                self.explorer_entries_by_dir
                    .insert(dir.clone(), entries.clone());
            }
        }
    }

    fn ensure_or_create_quick_chat_workspace(&mut self) -> String {
        if let Some(existing) = self
            .workspaces
            .iter()
            .find(|w| w.one_off_chat && !w.archived)
            .map(|w| w.id.clone())
        {
            return existing;
        }
        let env = cowork_config::env_map_from_process();
        let home = cowork_config::resolve_home_dir(&env, cowork_config::host_platform());
        let chats_root = cowork_config::get_one_off_chats_root(&home);
        let id = format!("oneoff-{}", uuid::Uuid::new_v4());
        let path = chats_root.join(&id).to_string_lossy().into_owned();
        let now = self.wall_clock_ms();
        let mut ws = WorkspaceRecord::new(id.clone(), "Quick chat".to_string(), path.clone(), now);
        ws.one_off_chat = true;
        let yolo = ws.yolo;
        self.workspaces.push(ws);
        self.workspace_order.push(id.clone());
        self.persist_state();
        self.send_native(NativeCommand::StartWorkspaceServer {
            workspace_id: id.clone(),
            path,
            yolo,
        });
        id
    }

    fn apply_session_config_event(&mut self, workspace_id: &str, evt: &Value) {
        let Some(cfg) = evt.get("config") else {
            return;
        };
        let rt = self
            .workspace_runtime_by_id
            .entry(workspace_id.to_string())
            .or_default();
        rt.control_session_config = Some(cfg.clone());
        if let Some(obj) = cfg.as_object()
            && let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == workspace_id)
        {
            apply_defaults_obj_to_workspace(ws, obj);
        }
        if let Some(tid) = evt
            .get("sessionId")
            .or_else(|| evt.get("threadId"))
            .and_then(Value::as_str)
            && let Some(t) = self.threads.iter_mut().find(|t| t.id == tid)
        {
            if let Some(p) = cfg.get("provider").and_then(Value::as_str) {
                t.provider = Some(p.to_string());
            }
            if let Some(m) = cfg.get("model").and_then(Value::as_str) {
                t.model = Some(m.to_string());
            }
        }
        self.refresh_creation_preflight();
    }

    fn resolve_provider_oauth_method(&self, provider: &str) -> String {
        if let Some(specs) = self.provider_auth_method_specs.get(provider)
            && let Some(m) = specs.iter().find(|m| m.method_type == "oauth")
        {
            return m.id.clone();
        }
        if let Some(ids) = self.provider_auth_methods.get(provider)
            && let Some(id) = ids.iter().find(|id| id.contains("oauth"))
        {
            return id.clone();
        }
        if provider == "codex-cli" {
            "oauth_cli".to_string()
        } else {
            "oauth".to_string()
        }
    }

    fn resolve_provider_api_key_method(&self, provider: &str) -> Option<String> {
        let specs = self.provider_auth_method_specs.get(provider)?;
        specs
            .iter()
            .find(|m| m.method_type == "api" && m.fields.is_empty())
            .or_else(|| specs.iter().find(|m| m.method_type == "api"))
            .map(|m| m.id.clone())
    }

    fn resolve_provider_config_method(&self, provider: &str) -> Result<String, String> {
        if let Some(specs) = self.provider_auth_method_specs.get(provider)
            && !specs.is_empty()
        {
            if let Some(m) = specs
                .iter()
                .find(|m| m.method_type == "api" && !m.fields.is_empty())
            {
                return Ok(m.id.clone());
            }
            return Err(format!(
                "Provider \"{provider}\" does not support structured configuration."
            ));
        }
        if let Some(ids) = self.provider_auth_methods.get(provider)
            && !ids.is_empty()
        {
            if let Some(id) = ids
                .iter()
                .find(|id| *id != "api_key" && !id.contains("oauth"))
            {
                return Ok(id.clone());
            }
            return Err(format!(
                "Provider \"{provider}\" does not support structured configuration."
            ));
        }
        Ok("config".to_string())
    }

    fn send_interaction_server_response(
        &mut self,
        workspace_id: String,
        thread_id: &str,
        id: JsonRpcLiteId,
        result: Value,
    ) {
        let req_key = request_id_key(&id);
        let item_id = self.thread_runtime_by_id.get(thread_id).and_then(|rt| {
            rt.pending_interactions
                .iter()
                .find(|item| interaction_request_id(item) == &id)
                .map(|item| interaction_item_id(item).to_string())
        });
        if self.services.ws_tx.is_some()
            && !matches!(
                self.workspace_socket_by_id.get(&workspace_id),
                Some(WsConnectionState::Connected)
            )
        {
            let rt = self
                .thread_runtime_by_id
                .entry(thread_id.to_string())
                .or_default();
            rt.interaction_errors.insert(
                req_key,
                "The response could not be sent. Reconnect and retry.".to_string(),
            );
            return;
        }
        if let Some(rt) = self.thread_runtime_by_id.get_mut(thread_id) {
            rt.interaction_errors.remove(&req_key);
            if let Some(iid) = item_id {
                rt.interaction_errors.remove(&iid);
            }
        }
        self.send_ws(WsCommand::SendServerResponse {
            workspace_id,
            id,
            result,
        });
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

    /// Emits a `WindowCommand` to `WINDOW_HUB` on the Rune UI thread (or test buffer).
    pub fn send_window(&mut self, cmd: WindowCommand) {
        if let Some(ref tx) = self.services.window_tx {
            let _ = tx.send(cmd);
            if let Some(ref waker) = self.services.waker {
                (waker)();
            }
        } else {
            self.services.emitted_window_commands.push(cmd);
        }
    }

    pub fn is_canvas_enabled(&self) -> bool {
        self.feature_flags.get("canvas").copied().unwrap_or(false)
    }

    /// Mirrors Electron `isCanvasSupportedFile` minus spreadsheets/OOXML decks handled natively.
    /// Returns true when `feature_flags["canvas"]` is enabled AND `path` is a Canvas-editable
    /// markdown/text/code document (keeping spreadsheets/OOXML decks/PDF/images on native preview).
    pub fn should_open_in_canvas(&self, path: &str) -> bool {
        self.is_canvas_enabled() && crate::views::chat::is_canvas_document_path(path)
    }

    pub fn is_workspace_ws_connected(&self, workspace_id: &str) -> bool {
        self.workspace_socket_by_id
            .get(workspace_id)
            .is_some_and(WsConnectionState::is_connected)
    }

    /// Window-scoped dirty/busy work check for close guards.
    ///
    /// Hide-only secondary windows (`quick-chat`, `utility`) check only work belonging to that
    /// window surface so active turns or dirty Canvas docs in Main do not block hiding Utility.
    pub fn has_unsaved_or_busy_work_for(&self, window_key: &str, will_quit: bool) -> bool {
        if will_quit || window_key == "main" {
            return self.has_unsaved_or_busy_work();
        }
        match window_key {
            WINDOW_QUICK_CHAT => !self.composer_edit.text.trim().is_empty(),
            _ => false,
        }
    }

    /// Routes a confirmation dialog to a specific OS window mode (immediate if active, else queued).
    pub fn set_confirm_dialog_for_window(
        &mut self,
        target: WindowMode,
        dialog: ConfirmDialogRequest,
    ) {
        if target == self.window_mode {
            self.pending_confirm_dialog = Some(dialog);
            return;
        }
        self.pending_confirm_dialogs_by_window
            .insert(target, dialog);
        self.shared_dirty = true;
        match target {
            WindowMode::Main => self.send_window(WindowCommand::FocusMain {
                open_new_chat_workspace: None,
                open_thread_id: None,
            }),
            WindowMode::QuickChat => self.send_window(WindowCommand::OpenQuickChat),
            WindowMode::Utility => self.send_window(WindowCommand::OpenUtility),
        }
    }

    /// Pulls any queued confirmation dialog/launchable path targeted at the active window mode.
    pub fn sync_pending_confirm_dialog_for_window(&mut self) -> bool {
        let Some(dialog) = self
            .pending_confirm_dialogs_by_window
            .remove(&self.window_mode)
        else {
            return false;
        };
        if dialog.id.starts_with("launchable-open:")
            && let Some(path) = self
                .pending_launchable_paths_by_window
                .remove(&self.window_mode)
        {
            self.pending_launchable_open_path = Some(path);
        }
        self.pending_confirm_dialog = Some(dialog);
        self.shared_dirty = true;
        true
    }

    /// True when closing the window risks losing unsent drafts, active turns, approvals, or dirty Canvas edits.
    pub fn has_unsaved_or_busy_work(&self) -> bool {
        if !self.composer_edit.text.trim().is_empty() {
            return true;
        }
        if self.composer_drafts.values().any(|d| {
            !d.text.trim().is_empty()
                || !d.attachments.is_empty()
                || !d.references.is_empty()
                || d.submitting
        }) {
            return true;
        }
        if self.thread_runtime_by_id.values().any(|rt| {
            rt.streaming
                || rt.active_turn_id.is_some()
                || rt.pending_turn_count > 0
                || !rt.pending_interactions.is_empty()
        }) {
            return true;
        }
        if self
            .pending_thread_messages
            .values()
            .any(|queue| !queue.is_empty())
        {
            return true;
        }
        if let Some(doc) = self.canvas_document.as_ref() {
            let matches_session = self.chat_ui.canvas.synced_doc_identity.as_deref()
                == Some(&format!(
                    "session\0{}\0{}",
                    doc.workspace_id, doc.document_id
                ));
            return doc.dirty()
                || (matches_session && self.chat_ui.canvas.source_edit.text != doc.draft_content);
        }
        self.chat_ui.canvas.is_dirty()
    }

    fn clamp_ui_scale(scale: f32) -> f32 {
        ((scale * 10.0).round() / 10.0).clamp(MIN_UI_SCALE, MAX_UI_SCALE)
    }

    pub fn zoom_in(&mut self) {
        self.ui_scale = Self::clamp_ui_scale(self.ui_scale + UI_SCALE_STEP);
    }

    pub fn zoom_out(&mut self) {
        self.ui_scale = Self::clamp_ui_scale(self.ui_scale - UI_SCALE_STEP);
    }

    pub fn reset_zoom(&mut self) {
        self.ui_scale = DEFAULT_UI_SCALE;
    }

    pub fn effective_desktop_platform(&self) -> DesktopPlatformOverride {
        self.menu_platform_override
            .unwrap_or_else(DesktopPlatformOverride::current)
    }

    /// Queues a menu command ID to run on the next `poll_app` tick (once modal focus returns).
    pub fn queue_menu_command(&mut self, tx: &mut rune::Tx, command_id: impl Into<String>) {
        self.pending_menu_command = Some(command_id.into());
        tx.wake_after(std::time::Duration::ZERO);
    }

    fn dispatch_menu_window_or_tx(&mut self, tx: Option<&mut rune::Tx>, command_id: &str) -> bool {
        match command_id {
            "app.quit" | "file.quit" | "quit" => {
                if let Some(tx) = tx {
                    tx.quit();
                } else {
                    self.send_window(WindowCommand::QuitApp);
                }
                true
            }
            "file.close_window" | "window.close" | "close_window" => {
                if let Some(tx) = tx {
                    tx.close_window();
                } else {
                    self.send_window(WindowCommand::CloseMain);
                }
                true
            }
            "window.minimize" | "minimize" => {
                if let Some(tx) = tx {
                    tx.minimize();
                } else {
                    self.send_window(WindowCommand::MinimizeMain);
                }
                true
            }
            "window.zoom" | "window.maximize" | "zoom_window" | "maximize" => {
                if let Some(tx) = tx {
                    tx.toggle_maximized();
                } else {
                    self.send_window(WindowCommand::ToggleMaximizeMain);
                }
                true
            }
            "view.toggle_fullscreen" | "toggle_fullscreen" | "window.toggle_fullscreen" => {
                if let Some(tx) = tx {
                    tx.toggle_full_screen();
                } else {
                    self.send_window(WindowCommand::ToggleFullScreenMain);
                }
                true
            }
            "edit.undo" | "undo" => {
                let Some(tx) = tx else { return false };
                tx.send_key(rune::KeyEvent {
                    key: rune::Key::Command('z'),
                    mods: rune::Mods {
                        cmd: true,
                        ..Default::default()
                    },
                });
                true
            }
            "edit.redo" | "redo" => {
                let Some(tx) = tx else { return false };
                tx.send_key(rune::KeyEvent {
                    key: rune::Key::Command('z'),
                    mods: rune::Mods {
                        cmd: true,
                        shift: true,
                        ..Default::default()
                    },
                });
                true
            }
            "edit.cut" | "cut" => {
                let Some(tx) = tx else { return false };
                tx.send_key(rune::KeyEvent {
                    key: rune::Key::Command('x'),
                    mods: rune::Mods {
                        cmd: true,
                        ..Default::default()
                    },
                });
                true
            }
            "edit.copy" | "copy" => {
                let Some(tx) = tx else { return false };
                tx.send_key(rune::KeyEvent {
                    key: rune::Key::Command('c'),
                    mods: rune::Mods {
                        cmd: true,
                        ..Default::default()
                    },
                });
                true
            }
            "edit.paste" | "paste" => {
                let Some(tx) = tx else { return false };
                tx.request_paste();
                true
            }
            "edit.delete" | "delete" => {
                let Some(tx) = tx else { return false };
                tx.send_key(rune::KeyEvent {
                    key: rune::Key::Delete,
                    mods: rune::Mods::default(),
                });
                true
            }
            "edit.select_all" | "select_all" => {
                let Some(tx) = tx else { return false };
                tx.send_key(rune::KeyEvent {
                    key: rune::Key::Command('a'),
                    mods: rune::Mods {
                        cmd: true,
                        ..Default::default()
                    },
                });
                true
            }
            "help.github" | "open_github" => {
                const URL: &str = "https://github.com/mweinbach/agent-coworker";
                if let Some(tx) = tx {
                    if tx.open_url(URL).is_err() {
                        self.send_native(NativeCommand::OpenExternalUrl(URL.to_string()));
                    }
                } else {
                    self.send_native(NativeCommand::OpenExternalUrl(URL.to_string()));
                }
                true
            }
            "app.about" | "help.about" | "about" => {
                self.dispatch(Action::Shell(ShellAction::OpenAbout));
                true
            }
            "view.toggle_show_menu_bar" => {
                self.dispatch(Action::Shell(ShellAction::ToggleShowMenuBar));
                true
            }
            _ => false,
        }
    }

    /// Executes an application or in-window menu command with access to Rune's `&mut Tx`.
    pub fn dispatch_menu_command_with_tx(&mut self, tx: &mut rune::Tx, command_id: &str) -> bool {
        if let Some(legacy_id) = match command_id {
            "file.new_chat" | "new_chat" => Some("new_chat"),
            "file.open_quick_chat" | "open_quick_chat" => Some("open_quick_chat"),
            "file.open_skills" | "open_skills" => Some("open_skills"),
            "file.open_command_palette" | "command_palette" => Some("command_palette"),
            "file.open_settings" | "app.settings" | "settings" => Some("settings"),
            "file.open_workspaces_settings" | "open_workspaces_settings" => {
                Some("open_workspaces_settings")
            }
            "view.toggle_sidebar" | "toggle_sidebar" => Some("toggle_sidebar"),
            "view.zoom_in" | "zoom_in" => Some("zoom_in"),
            "view.zoom_out" | "zoom_out" => Some("zoom_out"),
            "view.reset_zoom" | "reset_zoom" => Some("reset_zoom"),
            "help.updates" | "open_updates" => Some("open_updates"),
            "open_utility" => Some("open_utility"),
            "tray_click" | "toggle_utility" => Some("tray_click"),
            _ => None,
        } {
            self.apply_store_event(StoreEvent::MenuInvoked(legacy_id.to_string()));
            return true;
        }
        self.dispatch_menu_window_or_tx(Some(tx), command_id)
    }

    fn dispatch_unhandled_menu_event(&mut self, command_id: &str) {
        let normalized = match command_id {
            "file.new_chat" => Some("new_chat"),
            "file.open_skills" => Some("open_skills"),
            "file.open_command_palette" => Some("command_palette"),
            "file.open_settings" | "app.settings" => Some("settings"),
            "file.open_workspaces_settings" => Some("open_workspaces_settings"),
            "view.toggle_sidebar" => Some("toggle_sidebar"),
            "view.zoom_in" => Some("zoom_in"),
            "view.zoom_out" => Some("zoom_out"),
            "view.reset_zoom" => Some("reset_zoom"),
            "help.updates" => Some("open_updates"),
            _ => None,
        };
        if let Some(legacy_id) = normalized {
            self.apply_store_event(StoreEvent::MenuInvoked(legacy_id.to_string()));
            return;
        }
        let _ = self.dispatch_menu_window_or_tx(None, command_id);
    }

    /// Wall-clock Unix epoch milliseconds (`now_secs` when initialized, else system clock).
    pub fn wall_clock_ms(&self) -> i64 {
        if self.now_secs > 0.0 {
            (self.now_secs * 1000.0).round() as i64
        } else {
            (wall_clock_epoch_secs() * 1000.0).round() as i64
        }
    }

    /// Wall-clock Unix epoch seconds (`now_secs` when initialized, else system clock).
    pub fn wall_clock_secs(&self) -> u64 {
        if self.now_secs > 0.0 {
            self.now_secs as u64
        } else {
            wall_clock_epoch_secs() as u64
        }
    }

    /// Relative delay in seconds until the next Canvas autosave or revision poll (`tx.wake_at`).
    pub fn next_canvas_wake_delay_secs(&self) -> Option<f64> {
        self.next_canvas_wake_at()
            .map(|due| (due - self.now_secs).max(0.0))
    }

    /// Next wall-clock instant (`now_secs` units) when Canvas autosave or revision polling is due.
    pub fn next_canvas_wake_at(&self) -> Option<f64> {
        let doc = self.canvas_document.as_ref()?;
        if !matches!(
            doc.status,
            CanvasDocumentStatus::Ready | CanvasDocumentStatus::SaveError { .. }
        ) {
            return None;
        }
        let mut next: Option<f64> = None;
        if !doc.truncated
            && doc.dirty()
            && !matches!(doc.status, CanvasDocumentStatus::SaveError { .. })
        {
            let autosave_at =
                doc.dirty_since_secs.unwrap_or(self.now_secs) + CANVAS_AUTOSAVE_DEBOUNCE_SECS;
            next = Some(autosave_at);
        }
        if self.is_workspace_ws_connected(&doc.workspace_id) {
            let poll_at = doc.last_poll_secs + CANVAS_REVISION_POLL_SECS;
            next = Some(match next {
                Some(existing) => existing.min(poll_at),
                None => poll_at,
            });
        }
        next
    }

    /// Runs debounced Canvas autosave (`0.6s`) and revision polling (`1.5s`).
    pub fn tick_canvas_timers(&mut self) -> bool {
        let Some(doc) = self.canvas_document.as_ref() else {
            return false;
        };
        let status_ready = matches!(doc.status, CanvasDocumentStatus::Ready);
        let status_pollable = matches!(
            doc.status,
            CanvasDocumentStatus::Ready | CanvasDocumentStatus::SaveError { .. }
        );
        if !status_pollable {
            return false;
        }
        let should_autosave = status_ready
            && !doc.truncated
            && doc.dirty()
            && doc
                .dirty_since_secs
                .is_some_and(|since| self.now_secs >= since + CANVAS_AUTOSAVE_DEBOUNCE_SECS);
        if should_autosave {
            self.request_canvas_save();
            return true;
        }
        let poll_ws_ready =
            self.is_workspace_ws_connected(&doc.workspace_id) || self.services.ws_tx.is_none();
        let should_poll =
            poll_ws_ready && (self.now_secs >= doc.last_poll_secs + CANVAS_REVISION_POLL_SECS);
        if should_poll {
            self.request_canvas_revision();
            return true;
        }
        false
    }

    pub(crate) fn sync_preview_ui(&mut self) {
        let preview_path = self.active_file_preview.as_ref().map(|p| p.path.as_str());
        let spreadsheet = self
            .active_file_preview
            .as_ref()
            .and_then(|p| p.spreadsheet.as_ref());
        let presentation = self
            .active_file_preview
            .as_ref()
            .and_then(|p| p.presentation.as_deref());
        self.preview_ui
            .sync_for_all_previews(preview_path, spreadsheet, presentation);
    }

    fn workspace_paths_match(&self, workspace_id: &str, lhs: &str, rhs: &str) -> bool {
        if lhs == rhs {
            return true;
        }
        let resolved_lhs = self.resolve_workspace_fs_path(workspace_id, lhs);
        let resolved_rhs = self.resolve_workspace_fs_path(workspace_id, rhs);
        if resolved_lhs == resolved_rhs {
            return true;
        }
        match (
            std::fs::canonicalize(&resolved_lhs),
            std::fs::canonicalize(&resolved_rhs),
        ) {
            (Ok(canon_lhs), Ok(canon_rhs)) => canon_lhs == canon_rhs,
            _ => false,
        }
    }

    fn open_presentation_preview(
        &mut self,
        workspace_id: String,
        workspace_root: String,
        resolved_path: String,
    ) {
        if self.canvas_document.as_ref().is_some_and(|d| !d.dirty()) {
            self.close_canvas_document();
        }
        self.shell_ui.right_overlay_open = false;
        self.context_sidebar.set_open(false);
        let title = resolved_path
            .rsplit(['/', '\\'])
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(&resolved_path)
            .to_string();
        self.active_file_preview = Some(FilePreviewState {
            workspace_id: workspace_id.clone(),
            path: resolved_path.clone(),
            title,
            content: None,
            is_binary: true,
            is_markdown: false,
            truncated: false,
            error: None,
            spreadsheet: None,
            presentation: Some(Box::new(
                crate::views::preview::PresentationPreviewData::loading(),
            )),
        });
        self.request_presentation_preview(workspace_id, workspace_root, resolved_path);
    }

    fn request_presentation_preview(
        &mut self,
        workspace_id: String,
        workspace_root: String,
        resolved_path: String,
    ) {
        if let Some(preview) = self.active_file_preview.as_mut()
            && preview.workspace_id == workspace_id
            && preview.path == resolved_path
        {
            preview.error = None;
            preview.presentation = Some(Box::new(
                crate::views::preview::PresentationPreviewData::loading(),
            ));
        }
        self.sync_preview_ui();
        let req_id = self.send_ws_request(
            &workspace_id,
            "cowork/workspace/presentation/preview",
            json!({
                "cwd": workspace_root,
                "path": resolved_path,
            }),
            false,
        );
        self.pending_presentation_rpcs.clear();
        self.pending_presentation_rpcs.insert(
            req_id,
            PendingPresentationRpc {
                workspace_id,
                path: resolved_path,
            },
        );
    }

    fn apply_presentation_preview_response(&mut self, request_id: u64, payload: &Value) {
        let Some(pending) = self.pending_presentation_rpcs.remove(&request_id) else {
            return;
        };
        let Some(preview) = self.active_file_preview.as_mut() else {
            return;
        };
        if preview.workspace_id != pending.workspace_id
            || preview.path != pending.path
            || preview.presentation.is_none()
        {
            return;
        }
        let parsed = crate::views::preview::PresentationPreviewData::from_rpc_payload(payload);
        preview.error = None;
        preview.presentation = Some(Box::new(parsed));
        self.sync_preview_ui();
    }

    fn apply_presentation_preview_error(&mut self, request_id: u64, err: &WsRpcError) {
        let Some(pending) = self.pending_presentation_rpcs.remove(&request_id) else {
            return;
        };
        let Some(preview) = self.active_file_preview.as_mut() else {
            return;
        };
        if preview.workspace_id != pending.workspace_id
            || preview.path != pending.path
            || preview.presentation.is_none()
        {
            return;
        }
        let message = if err.message.trim().is_empty() {
            "Failed to render PowerPoint deck."
        } else {
            err.message.as_str()
        };
        preview.error = None;
        preview.presentation = Some(Box::new(
            crate::views::preview::PresentationPreviewData::from_error("compile_error", message),
        ));
        self.sync_preview_ui();
    }

    fn open_canvas_document(&mut self, workspace_id: String, path: String) {
        let resolved_path = self.resolve_workspace_fs_path(&workspace_id, &path);
        self.close_canvas_document();
        self.pending_presentation_rpcs.clear();
        self.active_file_preview = None;
        self.sync_preview_ui();
        self.context_sidebar.set_open(true);
        self.canvas_generation_seq += 1;
        let generation = self.canvas_generation_seq;
        let document_id = self.next_tag("canvas");
        self.canvas_document = Some(CanvasDocumentSession {
            workspace_id: workspace_id.clone(),
            document_id: document_id.clone(),
            generation,
            path: resolved_path.clone(),
            disk_content: String::new(),
            draft_content: String::new(),
            edit_revision: 0,
            last_saved_edit_revision: 0,
            truncated: false,
            revision: None,
            status: CanvasDocumentStatus::Loading,
            last_saved_at_secs: None,
            dirty_since_secs: None,
            last_poll_secs: self.now_secs,
        });
        let req_id = self.send_ws_request(
            &workspace_id,
            "cowork/workspace/document/open",
            json!({
                "path": resolved_path,
                "documentId": document_id,
                "generation": generation,
            }),
            false,
        );
        self.pending_canvas_rpcs.insert(
            req_id,
            PendingCanvasRpc {
                document_id,
                generation,
                edit_revision: 0,
                target_path: None,
            },
        );
    }

    fn reload_canvas_document(&mut self) {
        let Some(prev) = self.canvas_document.take() else {
            return;
        };
        let _ = self.send_ws_request(
            &prev.workspace_id,
            "cowork/workspace/document/close",
            json!({
                "documentId": prev.document_id,
                "generation": prev.generation,
            }),
            false,
        );
        self.pending_canvas_rpcs
            .retain(|_, pending| pending.generation != prev.generation);

        self.canvas_generation_seq += 1;
        let generation = self.canvas_generation_seq;
        let workspace_id = prev.workspace_id;
        let document_id = prev.document_id;
        let path = prev.path;
        self.canvas_document = Some(CanvasDocumentSession {
            workspace_id: workspace_id.clone(),
            document_id: document_id.clone(),
            generation,
            path: path.clone(),
            disk_content: String::new(),
            draft_content: String::new(),
            edit_revision: 0,
            last_saved_edit_revision: 0,
            truncated: false,
            revision: None,
            status: CanvasDocumentStatus::Loading,
            last_saved_at_secs: prev.last_saved_at_secs,
            dirty_since_secs: None,
            last_poll_secs: self.now_secs,
        });
        let req_id = self.send_ws_request(
            &workspace_id,
            "cowork/workspace/document/open",
            json!({
                "path": path,
                "documentId": document_id,
                "generation": generation,
            }),
            false,
        );
        self.pending_canvas_rpcs.insert(
            req_id,
            PendingCanvasRpc {
                document_id,
                generation,
                edit_revision: 0,
                target_path: None,
            },
        );
    }

    fn close_canvas_document(&mut self) {
        self.chat_ui.canvas.clear();
        let Some(prev) = self.canvas_document.take() else {
            return;
        };
        self.pending_canvas_rpcs
            .retain(|_, pending| pending.generation != prev.generation);
        let _ = self.send_ws_request(
            &prev.workspace_id,
            "cowork/workspace/document/close",
            json!({
                "documentId": prev.document_id,
                "generation": prev.generation,
            }),
            false,
        );
    }

    fn request_canvas_save(&mut self) {
        let Some(doc) = self.canvas_document.as_mut() else {
            return;
        };
        if doc.truncated
            || matches!(
                doc.status,
                CanvasDocumentStatus::Loading
                    | CanvasDocumentStatus::Saving
                    | CanvasDocumentStatus::LoadError { .. }
            )
        {
            return;
        }
        let workspace_id = doc.workspace_id.clone();
        let document_id = doc.document_id.clone();
        let generation = doc.generation;
        let edit_revision = doc.edit_revision;
        let content = doc.draft_content.clone();
        doc.status = CanvasDocumentStatus::Saving;
        doc.dirty_since_secs = None;
        let req_id = self.send_ws_request(
            &workspace_id,
            "cowork/workspace/document/save",
            json!({
                "documentId": document_id,
                "generation": generation,
                "editRevision": edit_revision,
                "content": content,
            }),
            false,
        );
        self.pending_canvas_rpcs.insert(
            req_id,
            PendingCanvasRpc {
                document_id,
                generation,
                edit_revision,
                target_path: None,
            },
        );
    }

    fn request_canvas_save_as(&mut self, path: String) {
        let trimmed = path.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let Some(doc) = self.canvas_document.as_mut() else {
            return;
        };
        if matches!(
            doc.status,
            CanvasDocumentStatus::Loading
                | CanvasDocumentStatus::Saving
                | CanvasDocumentStatus::LoadError { .. }
        ) {
            return;
        }
        let workspace_id = doc.workspace_id.clone();
        let document_id = doc.document_id.clone();
        let generation = doc.generation;
        let edit_revision = doc.edit_revision;
        let content = doc.draft_content.clone();
        doc.status = CanvasDocumentStatus::Saving;
        doc.dirty_since_secs = None;
        let req_id = self.send_ws_request(
            &workspace_id,
            "cowork/workspace/document/saveAs",
            json!({
                "documentId": document_id,
                "generation": generation,
                "editRevision": edit_revision,
                "content": content,
                "path": trimmed,
            }),
            false,
        );
        self.pending_canvas_rpcs.insert(
            req_id,
            PendingCanvasRpc {
                document_id,
                generation,
                edit_revision,
                target_path: Some(trimmed),
            },
        );
    }

    fn request_canvas_revision(&mut self) {
        let Some(doc) = self.canvas_document.as_mut() else {
            return;
        };
        let workspace_id = doc.workspace_id.clone();
        let document_id = doc.document_id.clone();
        let generation = doc.generation;
        let edit_revision = doc.edit_revision;
        doc.last_poll_secs = self.now_secs;
        let req_id = self.send_ws_request(
            &workspace_id,
            "cowork/workspace/document/revision",
            json!({
                "documentId": document_id,
                "generation": generation,
            }),
            false,
        );
        self.pending_canvas_rpcs.insert(
            req_id,
            PendingCanvasRpc {
                document_id,
                generation,
                edit_revision,
                target_path: None,
            },
        );
    }

    fn apply_canvas_rpc_response(&mut self, request_id: u64, method: &str, payload: &Value) {
        let pending = self.pending_canvas_rpcs.remove(&request_id);
        let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let resp_doc = payload.get("document");
        let resp_doc_id = payload
            .get("documentId")
            .or_else(|| resp_doc.and_then(|d| d.get("documentId")))
            .and_then(Value::as_str);
        let resp_gen = payload
            .get("generation")
            .or_else(|| resp_doc.and_then(|d| d.get("generation")))
            .and_then(Value::as_u64);

        let expected_gen = resp_gen.or_else(|| pending.as_ref().map(|p| p.generation));
        let expected_doc_id = resp_doc_id
            .map(str::to_string)
            .or_else(|| pending.as_ref().map(|p| p.document_id.clone()));

        let Some(active_doc) = self.canvas_document.as_ref() else {
            return;
        };
        if expected_gen != Some(active_doc.generation)
            || expected_doc_id
                .as_deref()
                .is_some_and(|id| id != active_doc.document_id)
        {
            return;
        }

        match method {
            "cowork/workspace/document/open" => {
                let Some(doc) = self.canvas_document.as_mut() else {
                    return;
                };
                if ok && let Some(snap) = resp_doc {
                    let path = snap
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or(&doc.path)
                        .to_string();
                    let content = snap
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let truncated = snap
                        .get("truncated")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let revision = snap.get("revision").and_then(|r| {
                        serde_json::from_value::<CanvasDocumentRevision>(r.clone()).ok()
                    });
                    doc.path = path;
                    doc.disk_content = content.clone();
                    doc.draft_content = content;
                    doc.truncated = truncated;
                    doc.revision = revision;
                    doc.last_saved_edit_revision = doc.edit_revision;
                    doc.dirty_since_secs = None;
                    doc.last_poll_secs = self.now_secs;
                    doc.status = CanvasDocumentStatus::Ready;
                } else {
                    let kind = payload
                        .get("error")
                        .and_then(|e| e.get("kind"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let message = payload
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Unable to open document.")
                        .to_string();
                    doc.status = CanvasDocumentStatus::LoadError { kind, message };
                }
            }
            "cowork/workspace/document/revision" => {
                let (dirty, in_flight) = self
                    .canvas_document
                    .as_ref()
                    .map(|d| {
                        (
                            d.dirty(),
                            matches!(
                                d.status,
                                CanvasDocumentStatus::Loading | CanvasDocumentStatus::Saving
                            ),
                        )
                    })
                    .unwrap_or((false, true));
                if ok {
                    let new_rev = payload.get("revision").and_then(|r| {
                        serde_json::from_value::<CanvasDocumentRevision>(r.clone()).ok()
                    });
                    let Some(new_rev) = new_rev else {
                        return;
                    };
                    if in_flight {
                        return;
                    }
                    let changed = self
                        .canvas_document
                        .as_ref()
                        .is_some_and(|d| d.revision.as_ref() != Some(&new_rev));
                    if !changed {
                        return;
                    }
                    if !dirty {
                        self.reload_canvas_document();
                    } else if let Some(doc) = self.canvas_document.as_mut() {
                        doc.status = CanvasDocumentStatus::Conflict {
                            message: "The file changed on disk while you have unsaved edits."
                                .to_string(),
                            current_revision: Some(new_rev),
                        };
                        doc.dirty_since_secs = None;
                    }
                } else {
                    let kind = payload
                        .get("error")
                        .and_then(|e| e.get("kind"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if kind.as_deref() == Some("session_not_found") && !in_flight {
                        if !dirty {
                            self.reload_canvas_document();
                        } else if let Some(doc) = self.canvas_document.as_mut() {
                            let message = payload
                                .get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("Document session expired on server.")
                                .to_string();
                            doc.status = CanvasDocumentStatus::SaveError { kind, message };
                        }
                    }
                }
            }
            "cowork/workspace/document/save" | "cowork/workspace/document/saveAs" => {
                let save_as = method.ends_with("/saveAs");
                let saved_edit_rev = payload
                    .get("editRevision")
                    .and_then(Value::as_u64)
                    .or_else(|| pending.as_ref().map(|p| p.edit_revision))
                    .unwrap_or(0);
                let saved_path = payload
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| pending.as_ref().and_then(|p| p.target_path.clone()));
                if ok {
                    let status_str = payload
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("saved");
                    let new_rev = payload.get("revision").and_then(|r| {
                        serde_json::from_value::<CanvasDocumentRevision>(r.clone()).ok()
                    });
                    let Some(doc) = self.canvas_document.as_mut() else {
                        return;
                    };
                    if status_str == "saved" {
                        if let Some(p) = saved_path {
                            doc.path = p;
                        }
                        if let Some(rev) = new_rev {
                            doc.revision = Some(rev);
                        }
                        doc.last_saved_edit_revision =
                            doc.last_saved_edit_revision.max(saved_edit_rev);
                        doc.last_saved_at_secs = Some(self.now_secs);
                        if doc.edit_revision <= saved_edit_rev {
                            doc.disk_content = doc.draft_content.clone();
                            doc.dirty_since_secs = None;
                            doc.status = CanvasDocumentStatus::Ready;
                        } else {
                            // Newer keystrokes arrived while this save was in-flight; keep dirty and debounce again.
                            doc.dirty_since_secs = Some(self.now_secs);
                            doc.status = CanvasDocumentStatus::Ready;
                        }
                    } else if doc.edit_revision <= saved_edit_rev {
                        doc.status = CanvasDocumentStatus::Ready;
                    }
                    let save_as_refresh = if save_as {
                        Some((doc.workspace_id.clone(), doc.path.clone()))
                    } else {
                        None
                    };
                    if let Some((ws_id, doc_path)) = save_as_refresh {
                        let parent_raw = Path::new(&doc_path)
                            .parent()
                            .and_then(|p| p.to_str())
                            .unwrap_or(".");
                        let dir = self.normalize_explorer_path(&ws_id, parent_raw);
                        self.dispatch(Action::Native(NativeAction::ListWorkspaceFiles {
                            workspace_id: ws_id,
                            dir,
                        }));
                    }
                } else {
                    let kind = payload
                        .get("error")
                        .and_then(|e| e.get("kind"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let message = payload
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Failed to save document.")
                        .to_string();
                    let current_revision = payload.get("currentRevision").and_then(|r| {
                        serde_json::from_value::<CanvasDocumentRevision>(r.clone()).ok()
                    });
                    if let Some(doc) = self.canvas_document.as_mut() {
                        doc.dirty_since_secs = None;
                        if kind.as_deref() == Some("conflict") {
                            doc.status = CanvasDocumentStatus::Conflict {
                                message,
                                current_revision,
                            };
                        } else {
                            doc.status = CanvasDocumentStatus::SaveError { kind, message };
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn apply_canvas_rpc_error(&mut self, request_id: u64, method: &str, err: &WsRpcError) {
        let Some(pending) = self.pending_canvas_rpcs.remove(&request_id) else {
            return;
        };
        let Some(doc) = self.canvas_document.as_mut() else {
            return;
        };
        if doc.document_id != pending.document_id || doc.generation != pending.generation {
            return;
        }
        if method.ends_with("/save") || method.ends_with("/saveAs") {
            doc.dirty_since_secs = None;
            doc.status = CanvasDocumentStatus::SaveError {
                kind: None,
                message: err.message.clone(),
            };
        } else if method.ends_with("/open") {
            doc.dirty_since_secs = None;
            doc.status = CanvasDocumentStatus::LoadError {
                kind: None,
                message: err.message.clone(),
            };
        }
    }

    fn apply_workspace_file_changed(&mut self, workspace_id: &str, params: &Value) {
        let Some(changed_path) = params.get("path").and_then(Value::as_str) else {
            return;
        };

        if let Some((preview_ws, preview_path, has_pres)) =
            self.active_file_preview.as_ref().map(|p| {
                (
                    p.workspace_id.clone(),
                    p.path.clone(),
                    p.presentation.is_some(),
                )
            })
            && has_pres
            && preview_ws == workspace_id
            && self.workspace_paths_match(workspace_id, changed_path, &preview_path)
            && let Some(root) = self.workspace_path(workspace_id)
        {
            self.request_presentation_preview(workspace_id.to_string(), root, preview_path);
        }

        let Some(doc) = self.canvas_document.as_ref() else {
            return;
        };
        if doc.workspace_id != workspace_id
            || matches!(
                doc.status,
                CanvasDocumentStatus::Loading | CanvasDocumentStatus::Saving
            )
        {
            return;
        }
        if !self.workspace_paths_match(workspace_id, changed_path, &doc.path) {
            return;
        }
        // Ignore our own save echoes when server broadcasts matching revision.
        if let Some(version) = params
            .get("version")
            .and_then(|v| serde_json::from_value::<CanvasDocumentRevision>(v.clone()).ok())
            && doc.revision.as_ref() == Some(&version)
        {
            return;
        }
        self.request_canvas_revision();
    }

    fn iso_timestamp_now(&self) -> String {
        let millis = self.wall_clock_ms();
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn emit_client_transcript_user_message(
        &mut self,
        thread_id: &str,
        text: &str,
        client_message_id: Option<&str>,
    ) {
        if thread_id.is_empty() {
            return;
        }
        let ts = self.iso_timestamp_now();
        let payload = json!({
            "type": "user_message",
            "text": text,
            "clientMessageId": client_message_id,
        });
        self.send_native(NativeCommand::AppendTranscriptEvent(TranscriptLogEntry {
            ts,
            thread_id: thread_id.to_string(),
            direction: "client".to_string(),
            payload,
        }));
    }

    fn emit_server_transcript_notification(&mut self, method: &str, params: &Value) {
        let should_log = matches!(
            method,
            "turn/started"
                | "turn/completed"
                | "item/started"
                | "item/agentMessage/delta"
                | "item/reasoning/delta"
                | "item/completed"
                | "cowork/sessionEvent"
                | "cowork/controlEvent"
                | "cowork/session/turnUsage"
                | "cowork/session/usage"
        );
        if !should_log {
            return;
        }
        let thread_id = params
            .get("threadId")
            .or_else(|| params.get("sessionId"))
            .or_else(|| params.get("event").and_then(|e| e.get("sessionId")))
            .and_then(Value::as_str);
        let Some(tid) = thread_id.filter(|id| !id.is_empty()) else {
            return;
        };
        let payload = match method {
            "cowork/sessionEvent" | "cowork/controlEvent" => params
                .get("event")
                .cloned()
                .unwrap_or_else(|| params.clone()),
            _ => json!({
                "method": method,
                "params": params,
            }),
        };
        let ts = self.iso_timestamp_now();
        self.send_native(NativeCommand::AppendTranscriptEvent(TranscriptLogEntry {
            ts,
            thread_id: tid.to_string(),
            direction: "server".to_string(),
            payload,
        }));
    }

    fn request_local_transcript(&mut self, thread_id: &str) {
        let mut candidate_ids = vec![thread_id.to_string()];
        if let Some(t) = self.threads.iter().find(|t| t.id == thread_id)
            && let Some(sid) = t
                .session_id
                .as_ref()
                .filter(|s| !s.is_empty() && *s != thread_id)
        {
            candidate_ids.push(sid.clone());
        }
        let request_id = self.next_tag("transcript");
        self.send_native(NativeCommand::ReadLocalTranscript {
            request_id,
            thread_id: thread_id.to_string(),
            candidate_ids,
        });
    }

    fn replay_local_transcript(&mut self, thread_id: &str, entries: Vec<TranscriptLogEntry>) {
        let should_skip_for_live = self
            .thread_runtime_by_id
            .get(thread_id)
            .is_some_and(|rt| rt.hydrated && !rt.transcript_only && rt.last_event_seq > 0);
        if should_skip_for_live {
            if let Some(rt) = self.thread_runtime_by_id.get_mut(thread_id) {
                rt.hydrating = false;
            }
            return;
        }
        let workspace_id = self.workspace_for_thread(thread_id).unwrap_or_default();
        {
            let rt = self
                .thread_runtime_by_id
                .entry(thread_id.to_string())
                .or_default();
            rt.feed.clear();
            rt.agents.clear();
            rt.agent_run_feeds.clear();
            rt.todos.clear();
            rt.pending_interactions.clear();
            rt.usage = None;
            rt.last_turn_usage = None;
            rt.streaming = false;
            rt.active_turn_id = None;
            rt.hydrated = true;
            rt.hydrating = false;
            rt.transcript_only = true;
        }

        let mut seen_user_keys: HashSet<String> = HashSet::new();
        for (idx, entry) in entries.into_iter().enumerate() {
            let ts_ms = chrono::DateTime::parse_from_rfc3339(&entry.ts)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_else(|_| self.wall_clock_ms());

            if let Some(method) = entry.payload.get("method").and_then(Value::as_str)
                && let Some(params) = entry.payload.get("params")
            {
                let mut params_owned = params.clone();
                if let Some(obj) = params_owned.as_object_mut()
                    && !obj.contains_key("threadId")
                {
                    obj.insert("threadId".to_string(), json!(thread_id));
                }
                self.apply_ws_notification_inner(&workspace_id, method, params_owned, ts_ms, false);
                continue;
            }

            let Some(evt_type) = entry.payload.get("type").and_then(Value::as_str) else {
                continue;
            };
            match evt_type {
                "user_message" => {
                    let content = entry
                        .payload
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if content.trim().is_empty() {
                        continue;
                    }
                    let cid = entry
                        .payload
                        .get("clientMessageId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let dedupe_key = cid
                        .as_ref()
                        .map(|c| format!("cid:{c}"))
                        .unwrap_or_else(|| format!("txt:{}", content.trim()));
                    if !seen_user_keys.insert(dedupe_key) {
                        continue;
                    }
                    let rt = self
                        .thread_runtime_by_id
                        .entry(thread_id.to_string())
                        .or_default();
                    rt.feed.push(FeedItem::Message {
                        id: format!("transcript-user-{idx}"),
                        role: FeedMessageRole::User,
                        content,
                        client_message_id: cid,
                        attachments: Vec::new(),
                        references: Vec::new(),
                        citations: Vec::new(),
                        streaming: false,
                        timestamp_ms: ts_ms,
                    });
                }
                "assistant_message" => {
                    let content = entry
                        .payload
                        .get("text")
                        .or_else(|| entry.payload.get("content"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if content.trim().is_empty() {
                        continue;
                    }
                    let rt = self
                        .thread_runtime_by_id
                        .entry(thread_id.to_string())
                        .or_default();
                    rt.feed.push(FeedItem::Message {
                        id: format!("transcript-assistant-{idx}"),
                        role: FeedMessageRole::Assistant,
                        content,
                        client_message_id: None,
                        attachments: Vec::new(),
                        references: Vec::new(),
                        citations: Vec::new(),
                        streaming: false,
                        timestamp_ms: ts_ms,
                    });
                }
                "reasoning" => {
                    let content = entry
                        .payload
                        .get("text")
                        .or_else(|| entry.payload.get("content"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if content.trim().is_empty() {
                        continue;
                    }
                    let rt = self
                        .thread_runtime_by_id
                        .entry(thread_id.to_string())
                        .or_default();
                    rt.feed.push(FeedItem::Reasoning {
                        id: format!("transcript-reasoning-{idx}"),
                        content,
                        mode: "summary".to_string(),
                        streaming: false,
                        timestamp_ms: ts_ms,
                    });
                }
                _ => {
                    let mut evt = entry.payload.clone();
                    if let Some(obj) = evt.as_object_mut()
                        && !obj.contains_key("sessionId")
                        && !obj.contains_key("threadId")
                    {
                        obj.insert("sessionId".to_string(), json!(thread_id));
                    }
                    self.reduce_cowork_event(&workspace_id, &evt, ts_ms);
                }
            }
        }
        if let Some(rt) = self.thread_runtime_by_id.get_mut(thread_id) {
            rt.streaming = false;
            rt.active_turn_id = None;
            rt.hydrating = false;
            rt.hydrated = true;
            rt.transcript_only = true;
            for item in &mut rt.feed {
                match item {
                    FeedItem::Message { streaming, .. }
                    | FeedItem::Reasoning { streaming, .. }
                    | FeedItem::Tool { streaming, .. } => *streaming = false,
                    _ => {}
                }
            }
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
        if old_id != new_id {
            self.rekeyed_thread_ids
                .insert(old_id.to_string(), new_id.to_string());
        }
        self.nav.rekey_thread_id(old_id, new_id);
        if self.persisted_active_thread_id.as_deref() == Some(old_id) {
            self.persisted_active_thread_id = Some(new_id.to_string());
        }
    }

    /// Rewrites any stale draft thread IDs held in this window's navigation history
    /// after another window (or earlier response) rekeyed them to server thread IDs.
    pub fn reconcile_rekeyed_thread_ids(&mut self) -> bool {
        if self.rekeyed_thread_ids.is_empty() {
            return false;
        }
        let pairs: Vec<(String, String)> = self
            .rekeyed_thread_ids
            .keys()
            .filter_map(|old_id| {
                self.resolve_rekeyed_thread_id(old_id)
                    .map(|new_id| (old_id.clone(), new_id))
            })
            .collect();
        let mut changed = false;
        for (old_id, new_id) in pairs {
            if self.nav.rekey_thread_id(&old_id, &new_id) {
                changed = true;
            }
        }
        if changed
            && self.window_mode == WindowMode::Main
            && let Some(cur_tid) = self.nav.current().active_thread_id.clone()
        {
            self.persisted_active_thread_id = Some(cur_tid).filter(|tid| {
                self.threads
                    .iter()
                    .find(|t| &t.id == tid)
                    .is_none_or(|t| !t.draft)
            });
        }
        changed
    }

    fn resolve_rekeyed_thread_id(&self, start: &str) -> Option<String> {
        let mut cur = start;
        let mut resolved = None;
        for _ in 0..8 {
            let Some(next) = self.rekeyed_thread_ids.get(cur) else {
                break;
            };
            if next == cur || next == start {
                break;
            }
            cur = next.as_str();
            resolved = Some(next.clone());
        }
        resolved
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
        if self.tick_canvas_timers() {
            changed = true;
        }
        if changed {
            self.shared_dirty = true;
        }
        changed
    }

    /// Applies an asynchronous `StoreEvent` onto `AppState`.
    pub fn apply_store_event(&mut self, event: StoreEvent) {
        self.shared_dirty = true;
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
                self.product_analytics = persisted.product_analytics;
                self.feature_flag_overrides = persisted.feature_flags;
                self.feature_flags =
                    resolve_feature_flags(is_packaged, &self.feature_flag_overrides);
                self.workspaces = persisted.workspaces;
                self.workspace_order = persisted.workspace_order;
                let ws_ids: HashSet<&str> = self.workspaces.iter().map(|w| w.id.as_str()).collect();
                self.threads = persisted
                    .threads
                    .into_iter()
                    .filter(|t| {
                        !t.draft
                            && t.source_task_id.is_none()
                            && ws_ids.contains(t.workspace_id.as_str())
                    })
                    .collect();
                self.archived_threads = self
                    .threads
                    .iter()
                    .filter(|t| t.archived)
                    .map(|t| ArchivedThreadSummary {
                        id: t.id.clone(),
                        workspace_id: t.workspace_id.clone(),
                        title: t.title.clone(),
                        archived_at: t.updated_at,
                    })
                    .collect();
                self.collapsed_workspace_ids =
                    persisted.collapsed_workspace_ids.into_iter().collect();
                self.collapsed_sidebar_sections =
                    persisted.collapsed_sidebar_sections.into_iter().collect();
                self.active_workspace_id = persisted
                    .active_workspace_id
                    .filter(|id| self.workspaces.iter().any(|w| w.id == *id && !w.archived));
                let restored_thread = persisted.active_thread_id.and_then(|thread_id| {
                    if let Some(t) = self.threads.iter().find(|t| t.id == thread_id) {
                        if t.archived {
                            None
                        } else {
                            Some((t.id.clone(), Some(t.workspace_id.clone())))
                        }
                    } else if self.threads.is_empty() && self.active_workspace_id.is_some() {
                        Some((thread_id, self.active_workspace_id.clone()))
                    } else {
                        None
                    }
                });
                if let Some((thread_id, thread_ws_id)) = restored_thread {
                    if let Some(ws_id) = thread_ws_id
                        && self.workspaces.iter().any(|w| w.id == ws_id && !w.archived)
                    {
                        self.active_workspace_id = Some(ws_id);
                    }
                    self.persisted_active_thread_id = Some(thread_id.clone());
                    self.nav.replace_current(NavigationSnapshot {
                        view: ViewId::Chat,
                        settings_page: self.nav.current().settings_page,
                        last_non_settings_view: ViewId::Chat,
                        active_thread_id: Some(thread_id.clone()),
                        ..NavigationSnapshot::default()
                    });
                    self.request_local_transcript(&thread_id);
                } else {
                    self.persisted_active_thread_id = None;
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
                self.sync_active_explorer_dir();
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
                let mcp_enabled = workspace.default_enable_mcp;
                let mut added_new = false;
                if let Some(existing) = self.workspaces.iter_mut().find(|w| w.id == workspace_id) {
                    *existing = workspace;
                } else {
                    self.workspaces.push(workspace);
                    self.workspace_order.push(workspace_id.clone());
                    added_new = true;
                }
                self.active_workspace_id = Some(workspace_id.clone());
                self.sync_active_explorer_dir();
                if !self.scene_mode {
                    self.persist_state();
                }
                self.send_native(NativeCommand::StartWorkspaceServer {
                    workspace_id,
                    path,
                    yolo,
                });
                if added_new {
                    self.send_native(NativeCommand::TrackAnalyticsEvent {
                        name: "workspace_added".to_string(),
                        properties: json!({
                            "eventSource": "renderer",
                            "workspaceCount": self.workspaces.len(),
                            "mcpEnabled": mcp_enabled,
                            "yoloEnabled": yolo,
                        }),
                    });
                }
            }
            StoreEvent::WorkspaceFilesListed {
                workspace_id,
                dir,
                mut entries,
                ..
            } => {
                let norm_dir = self.normalize_explorer_path(&workspace_id, &dir);
                for entry in &mut entries {
                    entry.path = self.normalize_explorer_path(&workspace_id, &entry.path);
                }
                self.explorer_entries_by_workspace
                    .insert((workspace_id.clone(), norm_dir), entries);
                if self.active_workspace_id.as_deref() == Some(workspace_id.as_str()) {
                    self.sync_active_explorer_dir();
                }
            }
            StoreEvent::FilePreviewLoaded { path, result, .. } => {
                match result {
                    Ok(preview) => self.active_file_preview = Some(preview),
                    Err(err) => {
                        if let Some(ref mut preview) = self.active_file_preview
                            && preview.path == path
                        {
                            preview.error = Some(err);
                        }
                    }
                }
                self.sync_preview_ui();
            }
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
            StoreEvent::WsServerResponseResult {
                workspace_id: _,
                request_id,
                ok,
                error,
            } => {
                let req_key = request_id_key(&request_id);
                for rt in self.thread_runtime_by_id.values_mut() {
                    let matched_item_id = rt.pending_interactions.iter().find_map(|item| {
                        (interaction_request_id(item) == &request_id)
                            .then(|| interaction_item_id(item).to_string())
                    });
                    let had_error = rt.interaction_errors.contains_key(&req_key);
                    if matched_item_id.is_none() && !had_error {
                        continue;
                    }
                    if ok {
                        rt.pending_interactions
                            .retain(|item| interaction_request_id(item) != &request_id);
                        rt.interaction_errors.remove(&req_key);
                        if let Some(iid) = matched_item_id {
                            rt.interaction_errors.remove(&iid);
                        }
                    } else {
                        let msg = error.clone().unwrap_or_else(|| {
                            "The response could not be sent. Reconnect and retry.".to_string()
                        });
                        rt.interaction_errors.insert(req_key.clone(), msg);
                    }
                }
                if ok {
                    self.chat_ui.clear_ask_request_by_key(&req_key);
                }
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
            StoreEvent::DiagnosticsBundleUpdated(bundle) => {
                self.diagnostics_bundle = bundle;
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
                "open_workspaces_settings" => {
                    self.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
                        SettingsPageId::Defaults,
                    ))));
                }
                "command_palette" => {
                    self.dispatch(Action::Shell(ShellAction::ToggleCommandPalette));
                }
                "zoom_in" => {
                    self.dispatch(Action::Shell(ShellAction::ZoomIn));
                }
                "zoom_out" => {
                    self.dispatch(Action::Shell(ShellAction::ZoomOut));
                }
                "reset_zoom" => {
                    self.dispatch(Action::Shell(ShellAction::ResetZoom));
                }
                "open_quick_chat" | "file.open_quick_chat" => {
                    self.dispatch(Action::Shell(ShellAction::OpenQuickChatWindow));
                }
                "open_utility" => {
                    self.dispatch(Action::Shell(ShellAction::OpenUtilityWindow));
                }
                "tray_click" | "toggle_utility" => {
                    self.dispatch(Action::Shell(ShellAction::ToggleUtilityWindow));
                }
                _ => {
                    self.dispatch_unhandled_menu_event(&command_id);
                }
            },
            StoreEvent::QuickChatToggled => {
                self.dispatch(Action::Shell(ShellAction::ToggleQuickChatWindow));
            }
            StoreEvent::DeepLink(url) => {
                let trimmed = url.trim();
                if let Some(rest) = trimmed.strip_prefix("cowork://") {
                    let path_only = rest.split(['?', '#']).next().unwrap_or("");
                    let mut parts = path_only.split('/').filter(|s| !s.is_empty());
                    match parts.next() {
                        Some("settings") => {
                            let page = parts.next().map(SettingsPageId::from_route_segment);
                            self.dispatch(Action::Navigate(NavAction::OpenSettings(page)));
                        }
                        Some("tasks") => {
                            if self.feature_flags.get("tasks").copied().unwrap_or(false) {
                                if let Some(task_id) = parts.next() {
                                    self.dispatch(Action::Navigate(NavAction::OpenTask(
                                        task_id.to_string(),
                                    )));
                                } else {
                                    self.dispatch(Action::Navigate(NavAction::OpenView(
                                        ViewId::Task,
                                    )));
                                }
                            }
                        }
                        Some("chat") | Some("new") => {
                            self.dispatch(Action::Navigate(NavAction::OpenNewChat {
                                workspace_id: None,
                            }));
                        }
                        _ => {}
                    }
                }
            }
            StoreEvent::WorkspaceEntryRenamed {
                workspace_id,
                old_path,
                new_path,
            } => {
                let norm_old = self.normalize_explorer_path(&workspace_id, &old_path);
                let norm_new = self.normalize_explorer_path(&workspace_id, &new_path);
                let new_name = Path::new(&new_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&new_path)
                    .to_string();
                for ((ws_id, _), entries) in &mut self.explorer_entries_by_workspace {
                    if ws_id != &workspace_id {
                        continue;
                    }
                    for entry in entries.iter_mut() {
                        if entry.path == old_path || entry.path == norm_old {
                            entry.path = norm_new.clone();
                            entry.name = new_name.clone();
                        }
                    }
                }
                self.sync_active_explorer_dir();
                let mut renamed_preview = false;
                if let Some(ref mut preview) = self.active_file_preview
                    && preview.workspace_id == workspace_id
                    && (preview.path == old_path || preview.path == norm_old)
                {
                    preview.path = new_path.clone();
                    preview.title = new_name;
                    renamed_preview = true;
                }
                if renamed_preview {
                    self.sync_preview_ui();
                }
                if let Some(ref mut doc) = self.canvas_document
                    && doc.workspace_id == workspace_id
                    && (doc.path == old_path || doc.path == norm_old)
                {
                    doc.path = new_path;
                }
            }
            StoreEvent::WorkspaceEntryRenameFailed { error, .. } => {
                self.dispatch(Action::Shell(ShellAction::PushToast {
                    key: "explorer-rename-failed".to_string(),
                    title: "Could not rename item".to_string(),
                    description: Some(error),
                    tone: NotificationTone::Error,
                }));
            }
            StoreEvent::LaunchableFileConfirmRequired { path, file_name } => {
                let target = self.last_launchable_window;
                let tag = self.next_tag("launchable");
                let req = ConfirmDialogRequest {
                    id: format!("launchable-open:{tag}"),
                    title: "Open file that can run code?".to_string(),
                    message: format!(
                        "\"{file_name}\" can run programs on this computer.\n\nOpening it runs it outside Cowork's sandbox. Only continue if you trust where this file came from."
                    ),
                    confirm_label: "Open Anyway".to_string(),
                    cancel_label: "Cancel".to_string(),
                    destructive: true,
                };
                if target == self.window_mode {
                    self.pending_launchable_open_path = Some(path);
                    self.pending_confirm_dialog = Some(req);
                } else {
                    self.pending_launchable_paths_by_window.insert(target, path);
                    self.set_confirm_dialog_for_window(target, req);
                }
            }
            StoreEvent::ConfirmWindowClose {
                window_id,
                request_id,
                title,
                message,
            } => {
                let target = WindowMode::from_window_key(&window_id);
                let req = ConfirmDialogRequest {
                    id: format!("window-close:{window_id}:{request_id}"),
                    title,
                    message,
                    confirm_label: "Close Anyway".to_string(),
                    cancel_label: "Keep Open".to_string(),
                    destructive: true,
                };
                self.set_confirm_dialog_for_window(target, req);
            }
            StoreEvent::LocalTranscriptLoaded {
                thread_id, result, ..
            } => match result {
                Ok(entries) => self.replay_local_transcript(&thread_id, entries),
                Err(err) => {
                    let was_hydrated = self
                        .thread_runtime_by_id
                        .get(&thread_id)
                        .is_some_and(|rt| rt.hydrated);
                    let rt = self.thread_runtime_by_id.entry(thread_id).or_default();
                    rt.hydrating = false;
                    if !was_hydrated {
                        rt.last_error = Some(err);
                    }
                }
            },
            StoreEvent::ProductAnalyticsStateUpdated(val) => {
                self.product_analytics = val;
            }
        }
    }

    /// Synchronous state transition entrypoint called by views, keyboard shortcuts, and tests.
    pub fn dispatch(&mut self, action: Action) {
        if !matches!(
            action,
            Action::Navigate(_) | Action::Shell(ShellAction::SetWindowMode(_))
        ) {
            self.shared_dirty = true;
        }
        match action {
            Action::Navigate(nav) => self.reduce_nav(nav),
            Action::Shell(shell) => self.reduce_shell(shell),
            Action::Chat(chat) => self.reduce_chat(chat),
            Action::Task(task) => self.reduce_task(task),
            Action::Settings(settings) => self.reduce_settings(settings),
            Action::Native(native) => self.reduce_native(native),
        }
    }

    fn reduce_nav(&mut self, action: NavAction) {
        let prev_tid = self.nav.current().active_thread_id.clone();
        let prev_ws = self.active_workspace_id.clone();
        let prev_landing = self.landing_workspace_id.clone();
        let mut already_persisted = false;

        match action {
            NavAction::OpenView(view) => {
                if view == ViewId::Task {
                    self.active_task = None;
                    self.nav.update(NavigationPatch {
                        view: Some(view),
                        active_task_id: Some(None),
                        ..Default::default()
                    });
                    if let Some(ws_id) = self.active_workspace_id.clone() {
                        self.send_task_ws(&ws_id, "task/list", json!({}));
                    }
                    self.refresh_creation_preflight();
                } else {
                    self.nav.update(NavigationPatch {
                        view: Some(view),
                        ..Default::default()
                    });
                    if view == ViewId::Chat && self.nav.current().active_thread_id.is_none() {
                        self.refresh_creation_preflight();
                    }
                }
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
                    self.sync_active_explorer_dir();
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
                if !self.scene_mode && self.window_mode == WindowMode::Main {
                    self.persist_state();
                    already_persisted = true;
                }
                let needs_hydrate = self
                    .thread_runtime_by_id
                    .get(&thread_id)
                    .is_none_or(|rt| (!rt.hydrated || rt.transcript_only) && !rt.hydrating);
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
                    self.sync_active_explorer_dir();
                }
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Chat),
                    active_thread_id: Some(None),
                    ..Default::default()
                });
                let new_key = self.composer_key();
                self.sync_composer_edit_across_switch(&old_key, &new_key);
                self.refresh_creation_preflight();
            }
            NavAction::OpenTask(task_id) => {
                if self
                    .active_task
                    .as_ref()
                    .is_some_and(|t| t.summary.id != task_id)
                {
                    self.active_task = None;
                }
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Task),
                    active_task_id: Some(Some(task_id.clone())),
                    ..Default::default()
                });
                if let Some(ws_id) = self.active_workspace_id.clone() {
                    self.send_task_ws(&ws_id, "task/read", json!({ "taskId": task_id }));
                }
            }
            NavAction::OpenSettings(page) => {
                let canonical = page.map(SettingsPageId::canonical);
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Settings),
                    settings_page: canonical,
                    settings_tab: Some(None),
                    settings_section: Some(None),
                    new_provider_intent: Some(false),
                    ..Default::default()
                });
                if canonical == Some(SettingsPageId::ToolAccess) {
                    self.bootstrap_active_workspace_tool_access();
                }
            }
            NavAction::OpenSettingsIntent {
                page,
                tab,
                section,
                new_provider,
            } => {
                let canonical = page.canonical();
                self.nav.update(NavigationPatch {
                    view: Some(ViewId::Settings),
                    settings_page: Some(canonical),
                    settings_tab: Some(tab),
                    settings_section: Some(section),
                    new_provider_intent: Some(new_provider),
                    ..Default::default()
                });
                if canonical == SettingsPageId::ToolAccess {
                    self.bootstrap_active_workspace_tool_access();
                }
            }
            NavAction::SelectWorkspace(workspace_id) => {
                self.active_workspace_id = Some(workspace_id);
                self.sync_active_explorer_dir();
                self.refresh_creation_preflight();
            }
            NavAction::GoBack => {
                let old_key = self.composer_key();
                if self.nav.go_back() {
                    let new_key = self.composer_key();
                    self.sync_composer_edit_across_switch(&old_key, &new_key);
                    self.refresh_creation_preflight_if_creation_route();
                }
            }
            NavAction::GoForward => {
                let old_key = self.composer_key();
                if self.nav.go_forward() {
                    let new_key = self.composer_key();
                    self.sync_composer_edit_across_switch(&old_key, &new_key);
                    self.refresh_creation_preflight_if_creation_route();
                }
            }
            NavAction::Replace(snapshot) => {
                let old_key = self.composer_key();
                self.nav.replace_current(snapshot);
                let new_key = self.composer_key();
                self.sync_composer_edit_across_switch(&old_key, &new_key);
                self.refresh_creation_preflight_if_creation_route();
            }
        }

        if self.active_workspace_id != prev_ws || self.landing_workspace_id != prev_landing {
            self.shared_dirty = true;
        }
        if !already_persisted
            && !self.scene_mode
            && self.window_mode == WindowMode::Main
            && (self.nav.current().active_thread_id != prev_tid
                || self.active_workspace_id != prev_ws)
        {
            self.persist_state();
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
            ShellAction::ToggleSidebarSectionCollapsed(section) => {
                if !self.collapsed_sidebar_sections.remove(&section) {
                    self.collapsed_sidebar_sections.insert(section);
                }
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
                self.command_palette_query.clear();
                self.command_palette_edit = TextEdit::new("");
                self.command_palette_edit.focused = self.command_palette_open;
                self.shell_ui.command_palette_selected = 0;
            }
            ShellAction::SetCommandPaletteOpen(open) => {
                self.command_palette_open = open;
                self.command_palette_query.clear();
                self.command_palette_edit = TextEdit::new("");
                self.command_palette_edit.focused = open;
                self.shell_ui.command_palette_selected = 0;
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
                    created_at_secs: self.wall_clock_secs(),
                });
            }
            ShellAction::DismissToast(key) => {
                self.toasts.retain(|t| t.key != key);
            }
            ShellAction::CompleteOnboardingStep(step) => {
                self.onboarding.completed_steps.insert(step);
                self.persist_state();
            }
            ShellAction::CompleteOnboarding => {
                self.onboarding.completed = true;
                self.onboarding.dismissed = false;
                self.persist_state();
            }
            ShellAction::SkipOnboarding => {
                self.onboarding.dismissed = true;
                self.onboarding.completed = false;
                self.persist_state();
            }
            ShellAction::OpenFilePreview(preview) => {
                self.pending_presentation_rpcs.clear();
                self.active_file_preview = Some(preview);
                self.sync_preview_ui();
            }
            ShellAction::CloseFilePreview => {
                self.pending_presentation_rpcs.clear();
                self.active_file_preview = None;
                self.sync_preview_ui();
            }
            ShellAction::SetLandingWorkspace(ws_id) => {
                self.landing_workspace_id = ws_id;
                self.refresh_creation_preflight();
            }
            ShellAction::SelectLandingQuickChat => {
                let existing = self
                    .workspaces
                    .iter()
                    .find(|w| w.one_off_chat && !w.archived)
                    .map(|w| w.id.clone());
                self.landing_workspace_id =
                    Some(existing.unwrap_or_else(|| ONE_OFF_LANDING_SENTINEL.to_string()));
                self.refresh_creation_preflight();
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
            ShellAction::ResolveConfirmDialog { id, confirmed } => {
                self.pending_confirm_dialog = None;
                if id.starts_with("launchable-open:") {
                    if let Some(path) = self.pending_launchable_open_path.take()
                        && confirmed
                    {
                        self.send_native(NativeCommand::OpenInDefaultApp {
                            path,
                            confirmed: true,
                        });
                    }
                } else if let Some(rest) = id.strip_prefix("window-close:")
                    && let Some((window_id, request_id)) = rest.split_once(':')
                {
                    self.send_native(NativeCommand::ResolveWindowClose {
                        window_id: window_id.to_string(),
                        request_id: request_id.to_string(),
                        confirmed,
                    });
                }
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
            ShellAction::ZoomIn => self.zoom_in(),
            ShellAction::ZoomOut => self.zoom_out(),
            ShellAction::ResetZoom => self.reset_zoom(),
            ShellAction::OpenQuickChatWindow => {
                self.send_window(WindowCommand::OpenQuickChat);
            }
            ShellAction::ToggleQuickChatWindow => {
                self.send_window(WindowCommand::ToggleQuickChat);
            }
            ShellAction::OpenUtilityWindow => {
                self.send_window(WindowCommand::OpenUtility);
            }
            ShellAction::ToggleUtilityWindow => {
                self.send_window(WindowCommand::ToggleUtility);
            }
            ShellAction::SetShowMenuBar(show) => {
                self.desktop_settings.show_menu_bar = show;
                self.persist_state();
            }
            ShellAction::ToggleShowMenuBar => {
                self.desktop_settings.show_menu_bar = !self.desktop_settings.show_menu_bar;
                self.persist_state();
            }
            ShellAction::OpenAbout => {
                let version = crate::native::resolve_desktop_app_version();
                self.dispatch(Action::Shell(ShellAction::PushToast {
                    key: "app-about".to_string(),
                    title: "Cowork Desktop".to_string(),
                    description: Some(format!("Version {version}")),
                    tone: NotificationTone::Info,
                }));
            }
            ShellAction::FocusMainWindow {
                open_new_chat_workspace,
                open_thread_id,
            } => {
                if self.window_mode == WindowMode::Main {
                    self.apply_main_focus_nav(open_new_chat_workspace, open_thread_id);
                    self.send_window(WindowCommand::FocusMain {
                        open_new_chat_workspace: None,
                        open_thread_id: None,
                    });
                } else {
                    self.send_window(WindowCommand::FocusMain {
                        open_new_chat_workspace,
                        open_thread_id,
                    });
                }
            }
        }
    }

    pub fn swap_shared_core(&mut self, other: &mut Self) {
        std::mem::swap(self, other);
        // Preserve per-window state across shared-core synchronization.
        std::mem::swap(&mut self.window_mode, &mut other.window_mode);
        std::mem::swap(&mut self.nav, &mut other.nav);
        std::mem::swap(&mut self.sidebar, &mut other.sidebar);
        std::mem::swap(&mut self.context_sidebar, &mut other.context_sidebar);
        std::mem::swap(&mut self.sidebar_search, &mut other.sidebar_search);
        std::mem::swap(
            &mut self.sidebar_search_edit,
            &mut other.sidebar_search_edit,
        );
        std::mem::swap(
            &mut self.command_palette_open,
            &mut other.command_palette_open,
        );
        std::mem::swap(
            &mut self.command_palette_query,
            &mut other.command_palette_query,
        );
        std::mem::swap(
            &mut self.command_palette_edit,
            &mut other.command_palette_edit,
        );
        std::mem::swap(&mut self.quick_chat_open, &mut other.quick_chat_open);
        std::mem::swap(&mut self.composer_edit, &mut other.composer_edit);
        std::mem::swap(
            &mut self.pending_confirm_dialog,
            &mut other.pending_confirm_dialog,
        );
        std::mem::swap(
            &mut self.pending_launchable_open_path,
            &mut other.pending_launchable_open_path,
        );
        std::mem::swap(&mut self.chat_ui, &mut other.chat_ui);
        std::mem::swap(&mut self.settings_ui, &mut other.settings_ui);
        std::mem::swap(&mut self.shell_ui, &mut other.shell_ui);
        std::mem::swap(&mut self.scene_mode, &mut other.scene_mode);
        std::mem::swap(
            &mut self.pending_menu_command,
            &mut other.pending_menu_command,
        );
        std::mem::swap(&mut self.now_secs, &mut other.now_secs);
        std::mem::swap(&mut self.app_elapsed_secs, &mut other.app_elapsed_secs);
    }

    pub fn apply_main_focus_nav(
        &mut self,
        open_new_chat_workspace: Option<String>,
        open_thread_id: Option<String>,
    ) {
        if let Some(tid) = open_thread_id {
            self.dispatch(Action::Navigate(NavAction::OpenThread(tid)));
        } else if let Some(ws_id) = open_new_chat_workspace {
            self.dispatch(Action::Navigate(NavAction::OpenNewChat {
                workspace_id: (!ws_id.is_empty()).then_some(ws_id),
            }));
        }
    }

    fn send_task_ws(&mut self, workspace_id: &str, method: &str, mut params: Value) {
        let cwd = self.workspace_path(workspace_id);
        inject_cwd(&mut params, cwd);
        let _ = self.send_ws_request(workspace_id, method, params, false);
    }

    fn reduce_task(&mut self, action: TaskAction) {
        match action {
            TaskAction::ListTasks { workspace_id } => {
                self.send_task_ws(&workspace_id, "task/list", json!({}));
            }
            TaskAction::ReadTask {
                workspace_id,
                task_id,
            } => {
                self.send_task_ws(&workspace_id, "task/read", json!({ "taskId": task_id }));
            }
            TaskAction::CreateTask {
                workspace_id,
                title,
                objective,
                context,
                review_required,
                provider,
                model,
                idempotency_key,
                requirements,
                work_items,
            } => {
                let mut params = Map::new();
                let key = idempotency_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.chars().take(200).collect::<String>())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let title_val: String = {
                    let t = title.trim();
                    let raw = if t.is_empty() { "Untitled task" } else { t };
                    raw.chars().take(160).collect()
                };
                let obj_val = {
                    let o = objective.trim();
                    if o.is_empty() { title_val.as_str() } else { o }
                };
                let ctx_val = context
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(obj_val);
                let reqs_val = if requirements.is_empty() {
                    vec![json!({
                        "kind": "acceptance_criterion",
                        "text": format!("Deliver: {obj_val}"),
                        "permanence": "fixed",
                    })]
                } else {
                    requirements
                };
                let work_items_val = if work_items.is_empty() {
                    let wi_title: String = title_val.chars().take(200).collect();
                    vec![json!({
                        "key": "wi-1",
                        "title": wi_title,
                        "description": obj_val,
                        "expectedOutputs": ["Primary task deliverable"],
                    })]
                } else {
                    work_items
                };

                params.insert("idempotencyKey".to_string(), json!(key));
                params.insert("title".to_string(), json!(title_val));
                params.insert("objective".to_string(), json!(obj_val));
                params.insert("context".to_string(), json!(ctx_val));
                params.insert("requirements".to_string(), json!(reqs_val));
                params.insert("workItems".to_string(), json!(work_items_val));
                if let Some(r) = review_required {
                    params.insert("reviewRequired".to_string(), json!(r));
                }
                if let Some(p) = provider.filter(|s| !s.trim().is_empty()) {
                    params.insert("provider".to_string(), json!(p));
                }
                if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                    params.insert("model".to_string(), json!(m));
                }
                self.send_task_ws(&workspace_id, "task/create", Value::Object(params));
            }
            TaskAction::UpdateBrief {
                workspace_id,
                task_id,
                expected_revision,
                title,
                objective,
            } => {
                let mut params = Map::new();
                params.insert("taskId".to_string(), json!(task_id));
                params.insert("expectedRevision".to_string(), json!(expected_revision));
                if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
                    params.insert("title".to_string(), json!(t));
                }
                if let Some(o) = objective.filter(|s| !s.trim().is_empty()) {
                    params.insert("objective".to_string(), json!(o));
                }
                self.send_task_ws(&workspace_id, "task/updateBrief", Value::Object(params));
            }
            TaskAction::ResolveQuestions {
                workspace_id,
                task_id,
                expected_revision,
                answers,
            } => {
                let params = json!({
                    "taskId": task_id,
                    "expectedRevision": expected_revision,
                    "answers": answers,
                });
                self.send_task_ws(&workspace_id, "task/questions/resolve", params);
            }
            TaskAction::ReadArtifact {
                workspace_id,
                task_id,
                artifact_id,
            } => {
                self.send_task_ws(
                    &workspace_id,
                    "task/artifact/read",
                    json!({ "taskId": task_id, "artifactId": artifact_id }),
                );
            }
            TaskAction::AcceptArtifactVersion {
                workspace_id,
                task_id,
                artifact_id,
                version_id,
                expected_revision,
            } => {
                let mut params = Map::new();
                params.insert("taskId".to_string(), json!(task_id));
                params.insert("artifactId".to_string(), json!(artifact_id));
                params.insert("expectedRevision".to_string(), json!(expected_revision));
                if let Some(v) = version_id.filter(|s| !s.trim().is_empty()) {
                    params.insert("versionId".to_string(), json!(v));
                }
                self.send_task_ws(
                    &workspace_id,
                    "task/artifact/version/accept",
                    Value::Object(params),
                );
            }
            TaskAction::RestoreArtifactVersion {
                workspace_id,
                task_id,
                artifact_id,
                version_id,
                expected_revision,
                change_summary,
            } => {
                let mut params = Map::new();
                params.insert("taskId".to_string(), json!(task_id));
                params.insert("artifactId".to_string(), json!(artifact_id));
                params.insert("versionId".to_string(), json!(version_id));
                params.insert("expectedRevision".to_string(), json!(expected_revision));
                if let Some(s) = change_summary.filter(|s| !s.trim().is_empty()) {
                    params.insert("changeSummary".to_string(), json!(s));
                }
                self.send_task_ws(
                    &workspace_id,
                    "task/artifact/version/restore",
                    Value::Object(params),
                );
            }
            TaskAction::CreateTaskThread {
                workspace_id,
                task_id,
                expected_revision,
                title,
                work_item_id,
                provider,
                model,
            } => {
                let mut params = Map::new();
                params.insert("taskId".to_string(), json!(task_id));
                params.insert("expectedRevision".to_string(), json!(expected_revision));
                params.insert("title".to_string(), json!(title));
                if let Some(w) = work_item_id.filter(|s| !s.trim().is_empty()) {
                    params.insert("workItemId".to_string(), json!(w));
                }
                if let Some(p) = provider.filter(|s| !s.trim().is_empty()) {
                    params.insert("provider".to_string(), json!(p));
                }
                if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                    params.insert("model".to_string(), json!(m));
                }
                self.send_task_ws(&workspace_id, "task/thread/create", Value::Object(params));
            }
            TaskAction::AcceptTask {
                workspace_id,
                task_id,
                expected_revision,
            } => {
                self.send_task_ws(
                    &workspace_id,
                    "task/accept",
                    json!({ "taskId": task_id, "expectedRevision": expected_revision }),
                );
            }
            TaskAction::RequestChanges {
                workspace_id,
                task_id,
                expected_revision,
                feedback,
            } => {
                self.send_task_ws(
                    &workspace_id,
                    "task/requestChanges",
                    json!({
                        "taskId": task_id,
                        "expectedRevision": expected_revision,
                        "feedback": feedback,
                    }),
                );
            }
            TaskAction::CancelTask {
                workspace_id,
                task_id,
                expected_revision,
                reason,
            } => {
                let mut params = Map::new();
                params.insert("taskId".to_string(), json!(task_id));
                params.insert("expectedRevision".to_string(), json!(expected_revision));
                if let Some(r) = reason.filter(|s| !s.trim().is_empty()) {
                    params.insert("reason".to_string(), json!(r));
                }
                self.send_task_ws(&workspace_id, "task/cancel", Value::Object(params));
            }
            TaskAction::ReopenTask {
                workspace_id,
                task_id,
                expected_revision,
                reason,
            } => {
                let mut params = Map::new();
                params.insert("taskId".to_string(), json!(task_id));
                params.insert("expectedRevision".to_string(), json!(expected_revision));
                if let Some(r) = reason.filter(|s| !s.trim().is_empty()) {
                    params.insert("reason".to_string(), json!(r));
                }
                self.send_task_ws(&workspace_id, "task/reopen", Value::Object(params));
            }
            TaskAction::RetryTask {
                workspace_id,
                task_id,
                expected_revision,
            } => {
                self.send_task_ws(
                    &workspace_id,
                    "task/retry",
                    json!({ "taskId": task_id, "expectedRevision": expected_revision }),
                );
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
                let is_landing_draft = key == "__new__";
                let draft = self.composer_drafts.entry(key).or_default();
                draft.provider = Some(provider);
                draft.model = Some(model);
                if is_landing_draft {
                    self.refresh_creation_preflight();
                }
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
                    if let Some(req_id) =
                        self.send_ws_typed(&ws_id, "thread/hydrate", &params, true)
                    {
                        self.pending_hydrate_threads_by_rpc_id
                            .insert(req_id, thread_id.clone());
                    }
                    let cmd_params = CommandListParams {
                        thread_id: thread_id.clone(),
                    };
                    let _ = self.send_ws_typed(&ws_id, "command/list", &cmd_params, true);
                    let already_hydrated = self
                        .thread_runtime_by_id
                        .get(&thread_id)
                        .is_some_and(|rt| rt.hydrated && !rt.transcript_only);
                    if !self.is_workspace_ws_connected(&ws_id) && !already_hydrated {
                        self.request_local_transcript(&thread_id);
                    }
                } else {
                    self.request_local_transcript(&thread_id);
                }
            }
            ChatAction::CreateThread {
                workspace_id,
                title: _,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let client_thread_id = Some(self.next_tag("client-thread"));
                let ws = self.workspaces.iter().find(|w| w.id == workspace_id);
                let (provider, model) = self
                    .resolve_submission_model(None, None, ws)
                    .map(|(p, m)| (Some(p), Some(m)))
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
                let mut changed = false;
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.title = title.clone();
                    changed = !t.draft;
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = SessionTitleSetParams { thread_id, title };
                    let _ = self.send_ws_typed(&ws_id, "cowork/session/title/set", &params, false);
                }
                if changed && !self.scene_mode {
                    self.persist_state();
                }
            }
            ChatAction::SetThreadPinned { thread_id, pinned } => {
                let mut changed = false;
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.pinned = pinned;
                    changed = !t.draft;
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = ThreadPinnedSetParams { thread_id, pinned };
                    let _ = self.send_ws_typed(&ws_id, "thread/pinned/set", &params, false);
                }
                if changed && !self.scene_mode {
                    self.persist_state();
                }
            }
            ChatAction::ArchiveThread(thread_id) => {
                let mut changed = false;
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.archived = true;
                    changed = !t.draft;
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = ThreadArchivedSetParams {
                        thread_id,
                        archived: true,
                    };
                    let _ = self.send_ws_typed(&ws_id, "thread/archived/set", &params, false);
                }
                if changed && !self.scene_mode {
                    self.persist_state();
                }
            }
            ChatAction::RestoreThread(thread_id) => {
                let mut changed = false;
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.archived = false;
                    changed = !t.draft;
                }
                self.archived_threads.retain(|t| t.id != thread_id);
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = ThreadArchivedSetParams {
                        thread_id,
                        archived: false,
                    };
                    let _ = self.send_ws_typed(&ws_id, "thread/archived/set", &params, false);
                }
                if changed && !self.scene_mode {
                    self.persist_state();
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
                let mut changed = false;
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.provider = Some(provider.clone());
                    t.model = Some(model.clone());
                    changed = !t.draft;
                }
                if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let params = SessionModelSetParams {
                        thread_id,
                        provider: Some(provider),
                        model,
                    };
                    let _ = self.send_ws_typed(&ws_id, "cowork/session/model/set", &params, false);
                }
                if changed && !self.scene_mode {
                    self.persist_state();
                }
            }
            ChatAction::SetThreadReasoningEffort {
                thread_id,
                provider,
                effort,
            } => {
                let mut changed = false;
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.reasoning_effort = Some(effort.as_str().to_string());
                    changed = !t.draft;
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
                if changed && !self.scene_mode {
                    self.persist_state();
                }
            }
            ChatAction::ResolveServerRequest {
                workspace_id,
                thread_id,
                id,
                response,
            } => {
                if let Ok(result) = serde_json::to_value(response) {
                    self.send_interaction_server_response(workspace_id, &thread_id, id, result);
                }
            }
            ChatAction::SubmitUserInput {
                workspace_id,
                thread_id,
                id,
                answers,
            } => {
                let result = json!({ "answers": answers });
                self.send_interaction_server_response(workspace_id, &thread_id, id, result);
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
                } else if let Some(ws_id) = self.workspace_for_thread(&thread_id) {
                    let supports_retry_lineage = self
                        .workspace_runtime_by_id
                        .get(&ws_id)
                        .and_then(|w| w.capabilities.as_ref())
                        .and_then(|c| c.get("toolRetryLineage"))
                        .and_then(Value::as_bool)
                        != Some(false);
                    let retry_plan = self.thread_runtime_by_id.get(&thread_id).and_then(|rt| {
                        let last_user_idx = rt.feed.iter().rposition(|item| {
                            matches!(
                                item,
                                FeedItem::Message {
                                    role: FeedMessageRole::User,
                                    content,
                                    ..
                                } if content.trim() != HIDDEN_RETRY_TURN_PROMPT
                            )
                        });
                        let tail_start = last_user_idx.map(|i| i + 1).unwrap_or(0);
                        let failed_tool_ids: Vec<String> = rt.feed[tail_start..]
                            .iter()
                            .filter_map(|item| match item {
                                FeedItem::Tool {
                                    id,
                                    status: ToolRunStatus::Failed,
                                    ..
                                } => Some(id.clone()),
                                _ => None,
                            })
                            .collect();
                        if supports_retry_lineage && !failed_tool_ids.is_empty() {
                            return Some((
                                TurnInput::Text(HIDDEN_RETRY_TURN_PROMPT.to_string()),
                                None,
                                Some(TurnRetrySpec {
                                    tool_item_ids: failed_tool_ids,
                                }),
                            ));
                        }
                        let user_idx = last_user_idx?;
                        if let FeedItem::Message {
                            content,
                            attachments,
                            references,
                            ..
                        } = &rt.feed[user_idx]
                        {
                            if content.trim().is_empty() && attachments.is_empty() {
                                return None;
                            }
                            let refs = (!references.is_empty()).then(|| {
                                references
                                    .iter()
                                    .filter_map(|r| serde_json::to_value(r).ok())
                                    .collect()
                            });
                            return Some((build_turn_input(content, attachments), refs, None));
                        }
                        None
                    });
                    if let Some((input, references, retry)) = retry_plan {
                        let cid = self.next_tag("retry");
                        let params = TurnStartParams {
                            thread_id,
                            client_message_id: Some(cid),
                            input,
                            references,
                            retry,
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
            ChatAction::OpenCanvasDocument { workspace_id, path } => {
                self.open_canvas_document(workspace_id, path);
            }
            ChatAction::ReloadCanvasDocument => {
                self.reload_canvas_document();
            }
            ChatAction::UpdateCanvasDraft {
                document_id,
                generation,
                content,
            } => {
                if let Some(ref mut doc) = self.canvas_document
                    && doc.document_id == document_id
                    && doc.generation == generation
                    && !doc.truncated
                    && doc.draft_content != content
                {
                    doc.draft_content = content;
                    doc.edit_revision += 1;
                    if doc.dirty() {
                        if doc.dirty_since_secs.is_none() {
                            doc.dirty_since_secs = Some(self.now_secs);
                        }
                    } else {
                        doc.dirty_since_secs = None;
                    }
                    if matches!(doc.status, CanvasDocumentStatus::SaveError { .. }) {
                        doc.status = CanvasDocumentStatus::Ready;
                    }
                }
            }
            ChatAction::SaveCanvasDocument => {
                self.request_canvas_save();
            }
            ChatAction::SaveCanvasDocumentAs { path } => {
                self.request_canvas_save_as(path);
            }
            ChatAction::CloseCanvasDocument => {
                self.close_canvas_document();
            }
            ChatAction::SendCanvasEditPrompt { prompt } => {
                if !prompt.trim().is_empty() {
                    let tid = self.nav.current().active_thread_id.clone();
                    self.submit_chat_message(
                        tid,
                        prompt,
                        ThreadBusyPolicy::Steer,
                        Vec::new(),
                        Vec::new(),
                    );
                }
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
        let timestamp_ms = self.wall_clock_ms();

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
                        thread_id: tid.clone(),
                        turn_id: active_turn_id,
                        client_message_id: Some(client_message_id.clone()),
                        input,
                        references: (!references.is_empty()).then(|| {
                            references
                                .iter()
                                .filter_map(|r| serde_json::to_value(r).ok())
                                .collect()
                        }),
                    };
                    let _ = self.send_ws_typed(&ws_id, "turn/steer", &params, false);
                    self.emit_client_transcript_user_message(
                        &tid,
                        &trimmed,
                        Some(&client_message_id),
                    );
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
                        thread_id: tid.clone(),
                        client_message_id: Some(client_message_id.clone()),
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
                    self.emit_client_transcript_user_message(
                        &tid,
                        &trimmed,
                        Some(&client_message_id),
                    );
                }
            }
            None => {
                let target_ws = self.resolve_landing_target_workspace();
                let (chosen_provider, chosen_model) = match self.resolve_submission_model(
                    None,
                    self.composer_drafts.get("__new__"),
                    target_ws,
                ) {
                    Some((provider, model)) => (Some(provider), Some(model)),
                    None if !self.provider_catalog.is_empty() => {
                        let message = "No configured provider or model is available. Connect a provider in Settings before sending.".to_string();
                        let draft = self
                            .composer_drafts
                            .entry("__new__".to_string())
                            .or_default();
                        draft.submitting = false;
                        draft.submission_error = Some(message.clone());
                        let toast_ts = self.wall_clock_secs();
                        self.toasts.retain(|t| t.key != "no-configured-model");
                        self.toasts.push(NotificationRecord {
                            key: "no-configured-model".to_string(),
                            title: "Select or connect a model".to_string(),
                            description: Some(message),
                            tone: NotificationTone::Warning,
                            created_at_secs: toast_ts,
                        });
                        return;
                    }
                    None => (None, None),
                };
                let ws_id =
                    if self.landing_workspace_id.as_deref() == Some(ONE_OFF_LANDING_SENTINEL) {
                        let id = self.ensure_or_create_quick_chat_workspace();
                        self.landing_workspace_id = Some(id.clone());
                        id
                    } else {
                        match self
                            .landing_workspace_id
                            .clone()
                            .filter(|id| self.workspaces.iter().any(|w| &w.id == id && !w.archived))
                            .or_else(|| {
                                self.active_workspace_id.clone().filter(|id| {
                                    self.workspaces.iter().any(|w| &w.id == id && !w.archived)
                                })
                            })
                            .or_else(|| self.resolve_management_workspace_id().map(str::to_string))
                        {
                            Some(id) => id,
                            None => {
                                let id = self.ensure_or_create_quick_chat_workspace();
                                self.landing_workspace_id = Some(id.clone());
                                id
                            }
                        }
                    };
                let draft_thread_id = self.next_tag("__draft");
                let title = derive_thread_title(&trimmed);
                let draft_reasoning_effort = self
                    .composer_drafts
                    .get("__new__")
                    .and_then(|d| d.reasoning_effort);
                let draft_thread = ThreadRecord {
                    id: draft_thread_id.clone(),
                    workspace_id: ws_id.clone(),
                    title,
                    draft: true,
                    provider: chosen_provider.clone(),
                    model: chosen_model.clone(),
                    reasoning_effort: draft_reasoning_effort.map(|e| e.as_str().to_string()),
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

    fn resolve_landing_target_workspace(&self) -> Option<&WorkspaceRecord> {
        if self.landing_workspace_id.as_deref() == Some(ONE_OFF_LANDING_SENTINEL) {
            return None;
        }
        let id = self
            .landing_workspace_id
            .as_deref()
            .or(self.active_workspace_id.as_deref())
            .or_else(|| self.resolve_management_workspace_id());
        id.and_then(|target| {
            self.workspaces
                .iter()
                .find(|w| w.id == target && !w.archived)
        })
        .or_else(|| self.resolve_workspace_display_targets().into_iter().next())
    }

    fn is_workspace_preflight_ready(&self, workspace_id: &str) -> bool {
        self.is_workspace_ws_connected(workspace_id)
            || self
                .workspace_runtime_by_id
                .get(workspace_id)
                .is_some_and(|rt| rt.capabilities.is_some())
    }

    fn resolve_creation_preflight_request(&self) -> Option<(String, CreationPreflightParams)> {
        let cur = self.nav.current();
        if cur.view == ViewId::Task && cur.active_task_id.is_none() {
            let ws = self
                .active_workspace()
                .or_else(|| self.resolve_landing_target_workspace())?;
            let draft = self.composer_drafts.get("__new__");
            let resolved = self.resolve_submission_model(None, draft, Some(ws));
            return Some((
                ws.id.clone(),
                CreationPreflightParams {
                    kind: "task".to_string(),
                    cwd: Some(ws.path.clone()),
                    provider: resolved.as_ref().map(|(p, _)| p.clone()),
                    model: resolved.as_ref().map(|(_, m)| m.clone()),
                },
            ));
        }

        let draft = self.composer_drafts.get("__new__");
        if self.landing_workspace_id.as_deref() == Some(ONE_OFF_LANDING_SENTINEL) {
            let transport_ws = self
                .resolve_management_workspace_id()
                .and_then(|id| self.workspaces.iter().find(|w| w.id == id && !w.archived))
                .filter(|w| self.is_workspace_preflight_ready(&w.id))
                .or_else(|| {
                    self.workspaces
                        .iter()
                        .find(|w| !w.archived && self.is_workspace_preflight_ready(&w.id))
                })?;
            let resolved = self.resolve_submission_model(None, draft, Some(transport_ws));
            return Some((
                transport_ws.id.clone(),
                CreationPreflightParams {
                    kind: "chat".to_string(),
                    cwd: None,
                    provider: resolved.as_ref().map(|(p, _)| p.clone()),
                    model: resolved.as_ref().map(|(_, m)| m.clone()),
                },
            ));
        }

        let ws = self.resolve_landing_target_workspace()?;
        let resolved = self.resolve_submission_model(None, draft, Some(ws));
        Some((
            ws.id.clone(),
            CreationPreflightParams {
                kind: "chat".to_string(),
                cwd: Some(ws.path.clone()),
                provider: resolved.as_ref().map(|(p, _)| p.clone()),
                model: resolved.as_ref().map(|(_, m)| m.clone()),
            },
        ))
    }

    fn refresh_creation_preflight(&mut self) {
        if self.scene_mode {
            return;
        }
        let Some((ws_id, params)) = self.resolve_creation_preflight_request() else {
            return;
        };
        if !self.is_workspace_preflight_ready(&ws_id) {
            return;
        }
        self.latest_creation_preflight_rpc_id =
            self.send_ws_typed(&ws_id, "cowork/creation/preflight", &params, true);
    }

    fn refresh_creation_preflight_if_creation_route(&mut self) {
        let cur = self.nav.current();
        if (cur.view == ViewId::Chat && cur.active_thread_id.is_none())
            || (cur.view == ViewId::Task && cur.active_task_id.is_none())
        {
            self.refresh_creation_preflight();
        }
    }

    /// Resolves `(provider, model)` from draft, thread, workspace, or provider catalog defaults.
    /// Shared by submission flows, `CreateThread`, and `views::chat::composer::resolve_composer_model`.
    pub fn resolve_submission_model(
        &self,
        thread: Option<&ThreadRecord>,
        draft: Option<&ComposerDraft>,
        ws: Option<&WorkspaceRecord>,
    ) -> Option<(String, String)> {
        let preferred_provider = draft
            .and_then(|d| d.provider.as_deref())
            .or_else(|| thread.and_then(|t| t.provider.as_deref()))
            .or_else(|| ws.and_then(|w| w.default_provider.as_deref()))
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let preferred_model = draft
            .and_then(|d| d.model.as_deref())
            .or_else(|| thread.and_then(|t| t.model.as_deref()))
            .or_else(|| ws.and_then(|w| w.default_model.as_deref()))
            .map(str::trim)
            .filter(|s| !s.is_empty());

        if let (Some(pid), Some(mid)) = (preferred_provider, preferred_model) {
            return Some((pid.to_string(), mid.to_string()));
        }

        if let Some(pid) = preferred_provider
            && let Some(prov) = self.provider_catalog.iter().find(|p| p.id == pid)
        {
            let fallback_mid = self
                .default_model_by_provider
                .get(pid)
                .map(String::as_str)
                .or_else(|| {
                    prov.models
                        .iter()
                        .find(|m| m.enabled && !is_hidden_lmstudio_model_id(&prov.id, &m.id))
                        .map(|m| m.id.as_str())
                });
            if let Some(mid) = fallback_mid {
                return Some((pid.to_string(), mid.to_string()));
            }
        }

        for provider in self.provider_catalog.iter().filter(|p| p.configured) {
            if let Some(mid) = self.default_model_by_provider.get(&provider.id)
                && provider.models.iter().any(|m| {
                    m.id == *mid && m.enabled && !is_hidden_lmstudio_model_id(&provider.id, &m.id)
                })
            {
                return Some((provider.id.clone(), mid.clone()));
            }
            if let Some(m) = provider
                .models
                .iter()
                .find(|m| m.enabled && !is_hidden_lmstudio_model_id(&provider.id, &m.id))
            {
                return Some((provider.id.clone(), m.id.clone()));
            }
        }

        None
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
            client_message_id: pending.client_message_id.clone(),
            input,
            references,
            retry: None,
            tools: None,
        };
        let _ = self.send_ws_typed(workspace_id, "turn/start", &params, false);
        self.emit_client_transcript_user_message(
            thread_id,
            &pending.text,
            pending.client_message_id.as_deref(),
        );
    }

    fn reduce_settings(&mut self, action: SettingsAction) {
        match action {
            SettingsAction::UpdateDesktopSettings(settings) => {
                self.desktop_settings = settings;
                self.persist_state();
            }
            SettingsAction::SetAccentPalette(palette) => {
                if self.desktop_settings.accent_palette != palette {
                    self.desktop_settings.accent_palette = palette;
                    self.persist_state();
                }
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
                let method_id = self.resolve_provider_api_key_method(&provider);
                let params = ProviderAuthSetApiKeyParams {
                    cwd,
                    provider,
                    method_id,
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
                let method_id = self.resolve_provider_oauth_method(&provider);
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
                let method_id = match self.resolve_provider_config_method(&provider) {
                    Ok(id) => id,
                    Err(message) => {
                        self.last_auth_result = Some(json!({
                            "ok": false,
                            "provider": provider,
                            "message": message.clone(),
                        }));
                        self.settings_mutation_error = Some(message);
                        return;
                    }
                };
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
                    let prev_yolo = ws.yolo;
                    apply_defaults_obj_to_workspace(ws, obj);
                    if ws.yolo != prev_yolo {
                        restart_for_yolo = Some((ws.path.clone(), ws.yolo));
                    }
                }
                self.persist_state();
                let config_map = defaults
                    .as_object()
                    .map(build_session_defaults_config_map)
                    .filter(|m| !m.is_empty());
                let params = SessionDefaultsApplyParams {
                    cwd,
                    thread_id: self.nav.current().active_thread_id.clone(),
                    provider: defaults
                        .get("defaultProvider")
                        .or_else(|| defaults.get("provider"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    model: defaults
                        .get("defaultModel")
                        .or_else(|| defaults.get("model"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    enable_mcp: defaults
                        .get("defaultEnableMcp")
                        .or_else(|| defaults.get("enableMcp"))
                        .and_then(Value::as_bool),
                    config: config_map,
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
                } else {
                    self.refresh_creation_preflight();
                }
            }
            SettingsAction::UpsertMcpServer {
                workspace_id,
                name,
                config,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let mut server_obj = config.as_object().cloned().unwrap_or_default();
                let source = server_obj
                    .remove("source")
                    .and_then(|v| v.as_str().map(str::to_string));
                let previous_name = server_obj
                    .remove("previousName")
                    .and_then(|v| v.as_str().map(str::to_string));
                server_obj
                    .entry("name".to_string())
                    .or_insert_with(|| Value::String(name));
                let mut body = serde_json::Map::new();
                body.insert("cwd".to_string(), json!(cwd));
                body.insert("server".to_string(), Value::Object(server_obj));
                if let Some(src) = source {
                    body.insert("source".to_string(), Value::String(src));
                }
                if let Some(prev) = previous_name {
                    body.insert("previousName".to_string(), Value::String(prev));
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/upsert",
                    Value::Object(body),
                    false,
                );
            }
            SettingsAction::DeleteMcpServer { workspace_id, name } => {
                let cwd = self.workspace_path(&workspace_id);
                let matching_sources: Vec<String> = self
                    .mcp_servers
                    .iter()
                    .filter(|s| s.name == name)
                    .filter_map(|s| s.source.clone())
                    .collect();
                let source = if matching_sources.len() == 1 {
                    Some(matching_sources[0].clone())
                } else {
                    None
                };
                let mut body = serde_json::Map::new();
                body.insert("cwd".to_string(), json!(cwd));
                body.insert("name".to_string(), Value::String(name));
                if let Some(src) = source {
                    body.insert("source".to_string(), Value::String(src));
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/delete",
                    Value::Object(body),
                    false,
                );
            }
            SettingsAction::UpsertScopedMcpServer {
                workspace_id,
                name,
                source,
                previous_name,
                server,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let mut server_obj = server.as_object().cloned().unwrap_or_default();
                server_obj
                    .entry("name".to_string())
                    .or_insert_with(|| Value::String(name));
                let mut body = serde_json::Map::new();
                body.insert("cwd".to_string(), json!(cwd));
                body.insert("source".to_string(), Value::String(source));
                body.insert("server".to_string(), Value::Object(server_obj));
                if let Some(prev) = previous_name.filter(|s| !s.trim().is_empty()) {
                    body.insert("previousName".to_string(), Value::String(prev));
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/upsert",
                    Value::Object(body),
                    false,
                );
            }
            SettingsAction::DeleteScopedMcpServer {
                workspace_id,
                name,
                source,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/delete",
                    json!({ "cwd": cwd, "name": name, "source": source }),
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
                let mut params = self.build_mcp_target_params(cwd.as_deref(), &name, &source);
                params.insert("enabled".to_string(), json!(enabled));
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/setEnabled",
                    Value::Object(params),
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
                let mut params = self.build_mcp_target_params(cwd.as_deref(), &name, &source);
                params.insert("apiKey".to_string(), json!(api_key));
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/auth/setApiKey",
                    Value::Object(params),
                    false,
                );
            }
            SettingsAction::ValidateMcpServer {
                workspace_id,
                name,
                source,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = self.build_mcp_target_params(cwd.as_deref(), &name, &source);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/validate",
                    Value::Object(params),
                    false,
                );
            }
            SettingsAction::AuthorizeMcpOAuth {
                workspace_id,
                name,
                source,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = self.build_mcp_target_params(cwd.as_deref(), &name, &source);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/auth/authorize",
                    Value::Object(params),
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
                let mut params = self.build_mcp_target_params(cwd.as_deref(), &name, &source);
                params.insert("code".to_string(), json!(callback_url));
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/mcp/server/auth/callback",
                    Value::Object(params),
                    false,
                );
            }
            SettingsAction::UpsertSubagent {
                workspace_id,
                profile,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let scope = profile
                    .scope
                    .clone()
                    .filter(|s| s == "global" || s == "workspace")
                    .unwrap_or_else(|| "workspace".to_string());
                let base_role = profile
                    .tool_preset
                    .clone()
                    .filter(|r| {
                        matches!(
                            r.as_str(),
                            "default" | "explorer" | "research" | "worker" | "reviewer"
                        )
                    })
                    .unwrap_or_else(|| "default".to_string());
                let existing = self
                    .agent_profiles_catalog
                    .profiles
                    .iter()
                    .find(|e| e.profile.id == profile.id && e.scope == scope)
                    .map(|e| &e.profile);
                let input = AgentProfileUpsertInputWire {
                    scope,
                    id: profile.id,
                    display_name: profile.name,
                    description: profile.description,
                    enabled: existing.map(|e| e.enabled).unwrap_or(true),
                    base_role,
                    prompt: profile.system_prompt,
                    allowed_built_in_tools: profile.allowed_tools,
                    allowed_mcp_servers: existing
                        .map(|e| e.allowed_mcp_servers.clone())
                        .unwrap_or_default(),
                    skill_names: existing.map(|e| e.skill_names.clone()).unwrap_or_default(),
                    model: profile.model.filter(|m| !m.trim().is_empty()),
                    reasoning_effort: profile.reasoning_effort.filter(|r| !r.trim().is_empty()),
                    default_task_type: existing.and_then(|e| e.default_task_type.clone()),
                    default_context_mode: existing.and_then(|e| e.default_context_mode.clone()),
                };
                let profile_payload = build_agent_profile_upsert_payload(&input);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/upsert",
                    json!({ "cwd": cwd, "profile": profile_payload }),
                    false,
                );
            }
            SettingsAction::DeleteSubagent { workspace_id, id } => {
                let cwd = self.workspace_path(&workspace_id);
                let scope = self
                    .agent_profiles_catalog
                    .profiles
                    .iter()
                    .find(|p| p.profile.id == id)
                    .map(|p| p.scope.clone())
                    .or_else(|| {
                        self.subagents
                            .iter()
                            .find(|p| p.id == id)
                            .and_then(|p| p.scope.clone())
                    })
                    .unwrap_or_else(|| "workspace".to_string());
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/delete",
                    json!({ "cwd": cwd, "scope": scope, "id": id }),
                    false,
                );
            }
            SettingsAction::ReadAgentProfilesCatalog { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/catalog/read",
                    json!({ "cwd": cwd }),
                    true,
                );
            }
            SettingsAction::UpsertAgentProfile {
                workspace_id,
                input,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let profile_payload = build_agent_profile_upsert_payload(&input);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/upsert",
                    json!({ "cwd": cwd, "profile": profile_payload }),
                    false,
                );
            }
            SettingsAction::DeleteAgentProfile {
                workspace_id,
                scope,
                id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/delete",
                    json!({ "cwd": cwd, "scope": scope, "id": id }),
                    false,
                );
            }
            SettingsAction::SetAgentProfileWorkspaceAvailability {
                workspace_id,
                id,
                disabled,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/workspaceAvailability/set",
                    json!({ "cwd": cwd, "id": id, "disabled": disabled }),
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
                    json!({ "cwd": cwd, "copy": { "sourceRef": id, "targetScope": target_scope } }),
                    false,
                );
            }
            SettingsAction::CopyAgentProfileNamed {
                workspace_id,
                source_ref,
                target_scope,
                target_id,
                target_display_name,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let mut copy = serde_json::Map::new();
                copy.insert("sourceRef".to_string(), Value::String(source_ref));
                copy.insert("targetScope".to_string(), Value::String(target_scope));
                if let Some(tid) = target_id.filter(|s| !s.trim().is_empty()) {
                    copy.insert("targetId".to_string(), Value::String(tid));
                }
                if let Some(tdn) = target_display_name.filter(|s| !s.trim().is_empty()) {
                    copy.insert("targetDisplayName".to_string(), Value::String(tdn));
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/agentProfiles/copy",
                    json!({ "cwd": cwd, "copy": copy }),
                    false,
                );
            }
            SettingsAction::UpsertMemory {
                workspace_id,
                key,
                content,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let scope = self
                    .scoped_memories
                    .iter()
                    .find(|m| m.id == key && !m.scope.is_empty())
                    .map(|m| m.scope.clone())
                    .unwrap_or_else(|| "workspace".to_string());
                let params = MemoryUpsertParams {
                    cwd,
                    scope,
                    id: (!key.is_empty()).then_some(key),
                    content,
                    mode: Some("upsert".to_string()),
                };
                let _ = self.send_ws_typed(&workspace_id, "cowork/memory/upsert", &params, false);
            }
            SettingsAction::DeleteMemory { workspace_id, key } => {
                let cwd = self.workspace_path(&workspace_id);
                let scope = self
                    .scoped_memories
                    .iter()
                    .find(|m| m.id == key && !m.scope.is_empty())
                    .map(|m| m.scope.clone())
                    .unwrap_or_else(|| "workspace".to_string());
                let params = MemoryDeleteParams {
                    cwd,
                    scope,
                    id: key,
                };
                let _ = self.send_ws_typed(&workspace_id, "cowork/memory/delete", &params, false);
            }
            SettingsAction::ReadMemories {
                workspace_id,
                scope,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let params = MemoryListParams { cwd, scope };
                let _ = self.send_ws_typed(&workspace_id, "cowork/memory/list", &params, true);
            }
            SettingsAction::UpsertScopedMemory {
                workspace_id,
                scope,
                id,
                content,
                mode,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let normalized_scope = if scope == "user" {
                    "user".to_string()
                } else {
                    "workspace".to_string()
                };
                let normalized_mode = match mode.as_deref() {
                    Some("create") => Some("create".to_string()),
                    Some("upsert") => Some("upsert".to_string()),
                    _ => Some("upsert".to_string()),
                };
                let params = MemoryUpsertParams {
                    cwd,
                    scope: normalized_scope,
                    id: id.filter(|s| !s.trim().is_empty()),
                    content,
                    mode: normalized_mode,
                };
                let _ = self.send_ws_typed(&workspace_id, "cowork/memory/upsert", &params, false);
            }
            SettingsAction::DeleteScopedMemory {
                workspace_id,
                scope,
                id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let normalized_scope = if scope == "user" {
                    "user".to_string()
                } else {
                    "workspace".to_string()
                };
                let params = MemoryDeleteParams {
                    cwd,
                    scope: normalized_scope,
                    id,
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
                skill_name,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/skills/improvement/restore",
                    json!({ "cwd": cwd, "skillName": skill_name }),
                    false,
                );
            }
            SettingsAction::RefreshPluginsAndSkills { workspace_id } => {
                let cwd = self.workspace_path(&workspace_id);
                let c = json!({ "cwd": cwd });
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
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/marketplaces/read",
                    c.clone(),
                    true,
                );
                let _ = self.send_ws_request(&workspace_id, "cowork/mcp/servers/read", c, true);
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
                let matching_scopes: Vec<String> = self
                    .plugins
                    .iter()
                    .filter(|p| p.id == id)
                    .filter_map(|p| p.scope.clone())
                    .collect();
                let mut body = serde_json::Map::new();
                body.insert("cwd".to_string(), json!(cwd));
                body.insert("pluginId".to_string(), Value::String(id));
                if matching_scopes.len() == 1 {
                    body.insert(
                        "scope".to_string(),
                        Value::String(matching_scopes[0].clone()),
                    );
                }
                let _ = self.send_ws_request(&workspace_id, method, Value::Object(body), false);
            }
            SettingsAction::SetPluginEnabledScoped {
                workspace_id,
                id,
                scope,
                enabled,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let method = if enabled {
                    "cowork/plugins/enable"
                } else {
                    "cowork/plugins/disable"
                };
                let mut body = serde_json::Map::new();
                body.insert("cwd".to_string(), json!(cwd));
                body.insert("pluginId".to_string(), Value::String(id));
                if let Some(s) = scope.filter(|s| !s.trim().is_empty()) {
                    body.insert("scope".to_string(), Value::String(s));
                }
                let _ = self.send_ws_request(&workspace_id, method, Value::Object(body), false);
            }
            SettingsAction::DeletePlugin { workspace_id, id } => {
                let cwd = self.workspace_path(&workspace_id);
                let matching_scopes: Vec<String> = self
                    .plugins
                    .iter()
                    .filter(|p| p.id == id)
                    .filter_map(|p| p.scope.clone())
                    .collect();
                let mut body = serde_json::Map::new();
                body.insert("cwd".to_string(), json!(cwd));
                body.insert("pluginId".to_string(), Value::String(id));
                if matching_scopes.len() == 1 {
                    body.insert(
                        "scope".to_string(),
                        Value::String(matching_scopes[0].clone()),
                    );
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/plugins/delete",
                    Value::Object(body),
                    false,
                );
            }
            SettingsAction::DeletePluginScoped {
                workspace_id,
                id,
                scope,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let mut body = serde_json::Map::new();
                body.insert("cwd".to_string(), json!(cwd));
                body.insert("pluginId".to_string(), Value::String(id));
                if let Some(s) = scope.filter(|s| !s.trim().is_empty()) {
                    body.insert("scope".to_string(), Value::String(s));
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/plugins/delete",
                    Value::Object(body),
                    false,
                );
            }
            SettingsAction::UpdatePlugin { workspace_id, id } => {
                let cwd = self.workspace_path(&workspace_id);
                let matching_scopes: Vec<String> = self
                    .plugins
                    .iter()
                    .filter(|p| p.id == id)
                    .filter_map(|p| p.scope.clone())
                    .collect();
                let mut body = serde_json::Map::new();
                body.insert("cwd".to_string(), json!(cwd));
                body.insert("pluginId".to_string(), Value::String(id));
                if matching_scopes.len() == 1 {
                    body.insert(
                        "scope".to_string(),
                        Value::String(matching_scopes[0].clone()),
                    );
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/plugins/update",
                    Value::Object(body),
                    false,
                );
            }
            SettingsAction::UpdatePluginScoped {
                workspace_id,
                id,
                scope,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let mut body = serde_json::Map::new();
                body.insert("cwd".to_string(), json!(cwd));
                body.insert("pluginId".to_string(), Value::String(id));
                if let Some(s) = scope.filter(|s| !s.trim().is_empty()) {
                    body.insert("scope".to_string(), Value::String(s));
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/plugins/update",
                    Value::Object(body),
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
                    json!({ "cwd": cwd, "skillName": name }),
                    false,
                );
            }
            SettingsAction::DeleteSkill { workspace_id, name } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/skills/delete",
                    json!({ "cwd": cwd, "skillName": name }),
                    false,
                );
            }
            SettingsAction::SetSkillInstallationEnabled {
                workspace_id,
                installation_id,
                enabled,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let method = if enabled {
                    "cowork/skills/installation/enable"
                } else {
                    "cowork/skills/installation/disable"
                };
                let _ = self.send_ws_request(
                    &workspace_id,
                    method,
                    json!({ "cwd": cwd, "installationId": installation_id }),
                    false,
                );
            }
            SettingsAction::DeleteSkillInstallation {
                workspace_id,
                installation_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/skills/installation/delete",
                    json!({ "cwd": cwd, "installationId": installation_id }),
                    false,
                );
            }
            SettingsAction::UpdateSkillInstallation {
                workspace_id,
                installation_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/skills/installation/update",
                    json!({ "cwd": cwd, "installationId": installation_id }),
                    false,
                );
            }
            SettingsAction::AddMarketplace { workspace_id, url } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/marketplaces/add",
                    json!({ "cwd": cwd, "sourceInput": url }),
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
                if self.is_packaged {
                    return;
                }
                self.feature_flag_overrides.insert(flag_id, enabled);
                self.feature_flags = resolve_feature_flags(false, &self.feature_flag_overrides);
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
                    smoke: Some(true),
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
            SettingsAction::DeleteBackupEntry {
                workspace_id,
                target_session_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/backups/workspace/deleteEntry",
                    json!({ "cwd": cwd, "targetSessionId": target_session_id }),
                    false,
                );
            }
            SettingsAction::RestoreBackup {
                workspace_id,
                backup_id,
            } => {
                let (target_session_id, checkpoint_id) = match backup_id.split_once("::") {
                    Some((sid, cp)) => (sid.to_string(), Some(cp.to_string())),
                    None => (backup_id, None),
                };
                self.dispatch(Action::Settings(SettingsAction::RestoreBackupCheckpoint {
                    workspace_id,
                    target_session_id,
                    checkpoint_id,
                }));
            }
            SettingsAction::RestoreBackupCheckpoint {
                workspace_id,
                target_session_id,
                checkpoint_id,
            } => {
                let cwd = self.workspace_path(&workspace_id);
                let mut params = Map::new();
                params.insert("cwd".to_string(), json!(cwd));
                params.insert("targetSessionId".to_string(), json!(target_session_id));
                if let Some(cp) = checkpoint_id.filter(|s| !s.is_empty()) {
                    params.insert("checkpointId".to_string(), json!(cp));
                }
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/backups/workspace/restore",
                    Value::Object(params),
                    false,
                );
            }
            SettingsAction::PreviewConversationImport {
                workspace_id,
                params,
            } => {
                let _ = self.send_ws_request(
                    &workspace_id,
                    "cowork/conversationImport/preview",
                    params,
                    false,
                );
            }
            SettingsAction::ExecuteConversationImport {
                workspace_id,
                params,
            } => {
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
                self.send_native(NativeCommand::ForgetTrustedPhone(phone_id));
            }
            SettingsAction::RevokeAllTrustedPhones => {
                self.remote_access.trusted_phones.clear();
                self.send_native(NativeCommand::RevokeAllTrustedPhones);
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
            SettingsAction::OpenLogsFolder => {
                self.send_native(NativeCommand::OpenLogsFolder);
            }
            SettingsAction::RevealDiagnosticsBundle { path } => {
                let target =
                    path.or_else(|| self.diagnostics_bundle.as_ref().map(|b| b.path.clone()));
                self.send_native(NativeCommand::RevealDiagnosticsBundle(target));
            }
            SettingsAction::UploadDiagnosticsBundle { path, confirmed } => {
                let target =
                    path.or_else(|| self.diagnostics_bundle.as_ref().map(|b| b.path.clone()));
                self.send_native(NativeCommand::UploadDiagnosticsBundle {
                    path: target,
                    confirmed,
                });
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
                let now = self.wall_clock_ms();
                let ws = WorkspaceRecord::new(id.clone(), resolved_name, path_str.clone(), now);
                let yolo = ws.yolo;
                self.workspaces.push(ws);
                self.workspace_order.push(id.clone());
                self.active_workspace_id = Some(id.clone());
                self.sync_active_explorer_dir();
                self.persist_state();
                self.send_native(NativeCommand::StartWorkspaceServer {
                    workspace_id: id,
                    path: path_str,
                    yolo,
                });
            }
            NativeAction::RemoveWorkspace(workspace_id) => {
                let before_len = self.workspaces.len();
                self.workspaces.retain(|w| w.id != workspace_id);
                let removed = self.workspaces.len() < before_len;
                self.workspace_order.retain(|id| id != &workspace_id);
                self.collapsed_workspace_ids.remove(&workspace_id);
                self.threads.retain(|t| t.workspace_id != workspace_id);
                self.archived_threads
                    .retain(|t| t.workspace_id != workspace_id);
                self.workspace_runtime_by_id.remove(&workspace_id);
                self.workspace_socket_by_id.remove(&workspace_id);
                self.explorer_entries_by_workspace
                    .retain(|(ws_id, _), _| ws_id != &workspace_id);
                let expanded_prefix = format!("{workspace_id}::");
                self.explorer_expanded_dirs
                    .retain(|key| !key.starts_with(&expanded_prefix));
                if self.active_workspace_id.as_deref() == Some(workspace_id.as_str()) {
                    self.active_workspace_id = self.workspaces.first().map(|w| w.id.clone());
                }
                if self
                    .canvas_document
                    .as_ref()
                    .is_some_and(|d| d.workspace_id == workspace_id)
                {
                    self.close_canvas_document();
                }
                self.sync_active_explorer_dir();
                self.persist_state();
                self.send_native(NativeCommand::StopWorkspaceServer {
                    workspace_id: workspace_id.clone(),
                });
                if removed {
                    self.send_native(NativeCommand::TrackAnalyticsEvent {
                        name: "workspace_removed".to_string(),
                        properties: json!({
                            "eventSource": "renderer",
                            "workspaceCount": self.workspaces.len(),
                        }),
                    });
                }
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
                    let resolved_dir = self.resolve_workspace_fs_path(&workspace_id, &dir);
                    self.send_native(NativeCommand::ListWorkspaceFiles {
                        request_id,
                        workspace_id,
                        workspace_root: root,
                        dir: resolved_dir,
                        show_hidden,
                    });
                }
            }
            NativeAction::LoadFilePreview { workspace_id, path } => {
                if let Some(root) = self.workspace_path(&workspace_id) {
                    let resolved_path = self.resolve_workspace_fs_path(&workspace_id, &path);
                    if self.should_open_in_canvas(&resolved_path) {
                        self.open_canvas_document(workspace_id, resolved_path);
                    } else if is_presentation_preview_path(&resolved_path) {
                        self.open_presentation_preview(workspace_id, root, resolved_path);
                    } else {
                        self.pending_presentation_rpcs.clear();
                        if self.canvas_document.as_ref().is_some_and(|d| !d.dirty()) {
                            self.close_canvas_document();
                        }
                        self.shell_ui.right_overlay_open = false;
                        self.context_sidebar.set_open(false);
                        let request_id = self.next_tag("preview");
                        self.send_native(NativeCommand::ReadFilePreview {
                            request_id,
                            workspace_id,
                            workspace_root: root,
                            path: resolved_path,
                        });
                    }
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
                let resolved = self.resolve_active_workspace_fs_path(&path);
                self.send_native(NativeCommand::RevealInOs(resolved));
            }
            NativeAction::OpenInDefaultApp(path) => {
                let resolved = self.resolve_active_workspace_fs_path(&path);
                self.last_launchable_window = self.window_mode;
                self.send_native(NativeCommand::OpenInDefaultApp {
                    path: resolved,
                    confirmed: false,
                });
            }
            NativeAction::TrashPath(path) => {
                let resolved = self.resolve_active_workspace_fs_path(&path);
                self.send_native(NativeCommand::TrashPath(resolved));
            }
            NativeAction::RenameWorkspaceEntry {
                workspace_id,
                path,
                new_name,
            } => {
                if let Some(root) = self.workspace_path(&workspace_id) {
                    let request_id = self.next_tag("rename");
                    let resolved_path = self.resolve_workspace_fs_path(&workspace_id, &path);
                    self.send_native(NativeCommand::RenameWorkspaceEntry {
                        request_id,
                        workspace_id,
                        workspace_root: root,
                        path: resolved_path,
                        new_name,
                    });
                }
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

        self.refresh_creation_preflight();
        if self.latest_creation_preflight_rpc_id.is_none()
            && self.workspaces.iter().all(|w| w.id != workspace_id)
        {
            let resolved =
                self.resolve_submission_model(None, self.composer_drafts.get("__new__"), None);
            let preflight_params = CreationPreflightParams {
                kind: "chat".to_string(),
                cwd: cwd.clone(),
                provider: resolved.as_ref().map(|(p, _)| p.clone()),
                model: resolved.as_ref().map(|(_, m)| m.clone()),
            };
            self.latest_creation_preflight_rpc_id = self.send_ws_typed(
                workspace_id,
                "cowork/creation/preflight",
                &preflight_params,
                true,
            );
        }

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
        let status_params = ProviderStatusRefreshParams {
            cwd: cwd.clone(),
            refresh_bedrock_discovery: Some(false),
        };
        let _ = self.send_ws_typed(
            workspace_id,
            "cowork/provider/status/refresh",
            &status_params,
            true,
        );
        let auth_methods_params = ProviderAuthMethodsReadParams { cwd: cwd.clone() };
        let _ = self.send_ws_typed(
            workspace_id,
            "cowork/provider/authMethods/read",
            &auth_methods_params,
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
            &MemoryAdvancedListParams { cwd: cwd.clone() },
            true,
        );
        let _ = self.send_ws_request(
            workspace_id,
            "cowork/agentProfiles/catalog/read",
            json!({ "cwd": cwd }),
            true,
        );
        self.bootstrap_tool_access_catalogs(workspace_id);

        if let Some(active_tid) = self.nav.current().active_thread_id.clone()
            && self.workspace_for_thread(&active_tid).as_deref() == Some(workspace_id)
            && self
                .threads
                .iter()
                .find(|t| t.id == active_tid)
                .is_none_or(|t| !t.draft)
        {
            if self
                .thread_runtime_by_id
                .get(&active_tid)
                .is_none_or(|rt| (!rt.hydrated || rt.transcript_only) && !rt.hydrating)
            {
                self.dispatch(Action::Chat(ChatAction::HydrateThread(active_tid)));
            } else {
                let cmd_params = CommandListParams {
                    thread_id: active_tid,
                };
                let _ = self.send_ws_typed(workspace_id, "command/list", &cmd_params, true);
            }
        }
    }

    fn apply_ws_notification(&mut self, workspace_id: &str, method: &str, params: Value) {
        let now_ms = self.wall_clock_ms();
        self.apply_ws_notification_inner(workspace_id, method, params, now_ms, true);
    }

    fn apply_ws_notification_inner(
        &mut self,
        workspace_id: &str,
        method: &str,
        params: Value,
        now_ms: i64,
        record_transcript: bool,
    ) {
        if record_transcript {
            self.emit_server_transcript_notification(method, &params);
        }
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
            if record_transcript && seq > 0 {
                rt.transcript_only = false;
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
                    if !t.draft && !self.scene_mode {
                        self.persist_state();
                    }
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
            "cowork/session/turnUsage" => {
                if params.get("type").is_some() {
                    self.reduce_cowork_event(workspace_id, &params, now_ms);
                } else {
                    let mut normalized = params;
                    if let Some(obj) = normalized.as_object_mut() {
                        obj.insert("type".to_string(), json!("turn_usage"));
                    }
                    self.reduce_cowork_event(workspace_id, &normalized, now_ms);
                }
            }
            "cowork/session/usage" => {
                if params.get("type").is_some() {
                    self.reduce_cowork_event(workspace_id, &params, now_ms);
                } else {
                    let mut normalized = params;
                    if let Some(obj) = normalized.as_object_mut() {
                        obj.insert("type".to_string(), json!("session_usage"));
                    }
                    self.reduce_cowork_event(workspace_id, &normalized, now_ms);
                }
            }
            "task/created" | "task/updated" => {
                let task_val = params.get("task").unwrap_or(&params);
                self.apply_task_record_update(workspace_id, task_val, false);
            }
            "task/activity" => {
                if let (Some(task_id), Some(activity)) = (
                    params.get("taskId").and_then(Value::as_str),
                    params.get("activity").cloned(),
                ) && let Some(active) = self
                    .active_task
                    .as_mut()
                    .filter(|t| t.summary.id == task_id)
                {
                    let dup = activity
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|aid| {
                            active
                                .activity
                                .iter()
                                .any(|a| a.get("id").and_then(Value::as_str) == Some(aid))
                        });
                    if !dup {
                        active.activity.insert(0, activity);
                    }
                }
            }
            "cowork/workspace/fileChanged" => {
                self.apply_workspace_file_changed(workspace_id, &params);
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
                let matched_existing = if let Some(ref cid) = client_message_id {
                    rt.feed.iter_mut().find(|f| {
                        matches!(
                            f,
                            FeedItem::Message {
                                client_message_id: Some(ec),
                                ..
                            } if ec == cid
                        )
                    })
                } else {
                    let trimmed_incoming = text.trim();
                    rt.feed.iter_mut().find(|f| {
                        matches!(
                            f,
                            FeedItem::Message {
                                id,
                                role: FeedMessageRole::User,
                                content,
                                client_message_id: Some(_),
                                ..
                            } if id.starts_with("optimistic-") && content.trim() == trimmed_incoming
                        )
                    })
                };
                if let Some(existing) = matched_existing {
                    if let FeedItem::Message {
                        id,
                        content,
                        client_message_id: existing_cid,
                        streaming,
                        ..
                    } = existing
                    {
                        *id = item_id;
                        if !text.is_empty() {
                            *content = text;
                        }
                        *existing_cid = None;
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
        let req_id = params
            .get("requestId")
            .and_then(|v| serde_json::from_value::<JsonRpcLiteId>(v.clone()).ok());
        let item_id = params.get("itemId").and_then(Value::as_str);
        if let Some(rt) = self.thread_runtime_by_id.get_mut(tid) {
            rt.pending_interactions.retain(|interaction| {
                let id_matches = req_id
                    .as_ref()
                    .is_some_and(|id| id == interaction_request_id(interaction));
                let item_matches = item_id.is_some_and(|i| i == interaction_item_id(interaction));
                !(id_matches || item_matches)
            });
            if let Some(ref id) = req_id {
                rt.interaction_errors.remove(&request_id_key(id));
            }
            if let Some(iid) = item_id {
                rt.interaction_errors.remove(iid);
            }
        }
    }

    fn reduce_cowork_event(&mut self, workspace_id: &str, evt: &Value, now_ms: i64) {
        let evt_type = evt.get("type").and_then(Value::as_str).unwrap_or_default();
        let tid = evt
            .get("sessionId")
            .or_else(|| evt.get("threadId"))
            .and_then(Value::as_str)
            .map(str::to_string);

        match evt_type {
            "turn_usage" => {
                let usage = parse_usage_summary(evt.get("usage").unwrap_or(evt));
                if let Some(id) = tid {
                    let rt = self.thread_runtime_by_id.entry(id).or_default();
                    rt.last_turn_usage = Some(usage.clone());
                    if rt.usage.is_none() {
                        rt.usage = Some(usage.clone());
                    }
                }
                if self.usage_summary.is_none() {
                    self.usage_summary = Some(usage);
                }
            }
            "session_usage" => {
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
                self.apply_agent_profiles_catalog_event(evt);
            }
            "provider_catalog" => {
                self.apply_provider_catalog_event(evt);
            }
            "provider_status" => {
                self.apply_provider_status_event(workspace_id, evt);
            }
            "provider_auth_methods" => {
                self.apply_provider_auth_methods_event(evt);
            }
            "memory_list" => {
                self.apply_memory_list_event(evt);
            }
            "plugins_catalog" => {
                self.apply_plugins_catalog_event(evt);
            }
            "skills_catalog" => {
                self.apply_skills_catalog_event(evt);
            }
            "skills_list" => {
                self.apply_skills_list_event(evt);
            }
            "mcp_servers" => {
                self.update_mcp_servers_from_event(evt);
            }
            "mcp_server_validation" => {
                self.apply_mcp_validation_event(evt);
            }
            "mcp_server_auth_challenge" => {
                self.apply_mcp_auth_challenge_event(evt);
            }
            "mcp_server_auth_result" => {
                self.apply_mcp_auth_result_event(evt);
            }
            "session_config" => {
                self.apply_session_config_event(workspace_id, evt);
            }
            "workspace_backups" => {
                if let Some(arr) = evt
                    .get("entries")
                    .or_else(|| evt.get("backups"))
                    .and_then(Value::as_array)
                {
                    self.backups = arr.iter().filter_map(parse_backup_summary).collect();
                }
            }
            "session_info" | "session_settings" | "config_updated" => {
                self.apply_session_config_event(workspace_id, evt);
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
                    questions: params
                        .get("questions")
                        .cloned()
                        .unwrap_or_else(|| params.clone()),
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
                let pending_tid = self.pending_hydrate_threads_by_rpc_id.remove(&request_id);
                if payload.get("coworkSnapshot").is_some() {
                    self.apply_thread_snapshot_response(workspace_id, &payload);
                } else if let Some(tid) = pending_tid {
                    let already_hydrated = self
                        .thread_runtime_by_id
                        .get(&tid)
                        .is_some_and(|rt| rt.hydrated && !rt.feed.is_empty());
                    if !already_hydrated {
                        self.request_local_transcript(&tid);
                    } else if let Some(rt) = self.thread_runtime_by_id.get_mut(&tid) {
                        rt.hydrating = false;
                    }
                }
            }
            "turn/start" => {
                for draft in self.composer_drafts.values_mut() {
                    draft.submitting = false;
                }
            }
            "cowork/creation/preflight" => {
                if self
                    .latest_creation_preflight_rpc_id
                    .is_none_or(|latest| latest == request_id)
                    && let Ok(preflight) =
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
                let target = payload.get("event").unwrap_or(&payload);
                if let Ok(parsed) =
                    serde_json::from_value::<RuntimeLibreOfficeCheckResult>(target.clone())
                {
                    self.libreoffice_status = serde_json::to_value(&parsed).ok();
                    self.libreoffice_check = Some(parsed);
                } else {
                    self.libreoffice_status = Some(payload);
                }
            }
            "cowork/session/defaults/apply" | "cowork/session/config/set" => {
                let target = payload.get("event").unwrap_or(&payload);
                self.apply_session_config_event(workspace_id, target);
            }
            "cowork/provider/catalog/read"
            | "cowork/provider/customModel/add"
            | "cowork/provider/customModel/delete"
            | "cowork/provider/model/setEnabled"
            | "cowork/provider/model/resetEnabled" => {
                self.apply_provider_catalog_event(&payload);
            }
            "cowork/provider/authMethods/read" => {
                self.apply_provider_auth_methods_event(&payload);
            }
            "cowork/provider/status/refresh" => {
                self.apply_provider_status_event(workspace_id, &payload);
            }
            "cowork/provider/auth/authorize" => {
                self.last_auth_challenge = Some(payload);
            }
            "cowork/provider/auth/callback"
            | "cowork/provider/auth/setApiKey"
            | "cowork/provider/auth/setConfig" => {
                let evt = payload.get("event").unwrap_or(&payload);
                self.last_auth_result = Some(evt.clone());
                if evt.get("ok").and_then(Value::as_bool) == Some(false)
                    && let Some(msg) = evt.get("message").and_then(Value::as_str)
                {
                    self.settings_mutation_error = Some(msg.to_string());
                } else {
                    self.dispatch(Action::Settings(SettingsAction::RefreshProviderCatalog {
                        workspace_id: workspace_id.to_string(),
                    }));
                }
            }
            "cowork/provider/auth/logout" => {
                let evt = payload.get("event").unwrap_or(&payload);
                self.last_auth_result = Some(evt.clone());
                if evt.get("ok").and_then(Value::as_bool) == Some(false) {
                    if let Some(msg) = evt.get("message").and_then(Value::as_str) {
                        self.settings_mutation_error = Some(msg.to_string());
                    }
                } else {
                    self.dispatch(Action::Settings(SettingsAction::RefreshProviderCatalog {
                        workspace_id: workspace_id.to_string(),
                    }));
                }
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
            "cowork/mcp/list"
            | "cowork/mcp/servers/read"
            | "cowork/mcp/server/upsert"
            | "cowork/mcp/server/delete"
            | "cowork/mcp/server/setEnabled" => {
                let evt = payload.get("event").unwrap_or(&payload);
                self.update_mcp_servers_from_event(evt);
            }
            "cowork/mcp/server/validate" => {
                let evt = payload.get("event").unwrap_or(&payload);
                self.apply_mcp_validation_event(evt);
            }
            "cowork/mcp/server/auth/authorize"
            | "cowork/mcp/server/auth/callback"
            | "cowork/mcp/server/auth/setApiKey" => {
                let evt = payload.get("event").unwrap_or(&payload);
                self.apply_mcp_auth_event(evt);
            }
            "cowork/agentProfiles/catalog/read"
            | "cowork/agentProfiles/upsert"
            | "cowork/agentProfiles/delete"
            | "cowork/agentProfiles/copy"
            | "cowork/agentProfiles/workspaceAvailability/set" => {
                let evt = payload.get("event").unwrap_or(&payload);
                self.apply_agent_profiles_catalog_event(evt);
            }
            "cowork/memory/list" | "cowork/memory/upsert" | "cowork/memory/delete" => {
                let target = payload.get("event").unwrap_or(&payload);
                self.apply_memory_list_event(target);
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
                if let Some(events) = payload.get("events").and_then(Value::as_array) {
                    let now_ms = self.wall_clock_ms();
                    for ev in events {
                        self.reduce_cowork_event(workspace_id, ev, now_ms);
                    }
                } else {
                    let target = payload.get("event").unwrap_or(&payload);
                    self.apply_plugins_catalog_event(target);
                }
            }
            "cowork/skills/list"
            | "cowork/skills/catalog/read"
            | "cowork/skills/enable"
            | "cowork/skills/disable"
            | "cowork/skills/delete"
            | "cowork/skills/install"
            | "cowork/skills/installation/enable"
            | "cowork/skills/installation/disable"
            | "cowork/skills/installation/delete"
            | "cowork/skills/installation/update"
            | "cowork/skills/installation/copy" => {
                let target = payload.get("event").unwrap_or(&payload);
                if target.get("catalog").is_some() {
                    self.apply_skills_catalog_event(target);
                } else {
                    self.apply_skills_list_event(target);
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
            | "cowork/backups/workspace/deleteCheckpoint"
            | "cowork/backups/workspace/deleteEntry"
            | "cowork/backups/workspace/restore" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(arr) = target
                    .get("entries")
                    .or_else(|| target.get("backups"))
                    .and_then(Value::as_array)
                {
                    self.backups = arr.iter().filter_map(parse_backup_summary).collect();
                }
                if method == "cowork/backups/workspace/deleteEntry"
                    && let Some(ref delta) = self.backup_delta
                    && !self
                        .backups
                        .iter()
                        .any(|b| b.target_session_id == delta.target_session_id)
                {
                    self.backup_delta = None;
                }
                if method == "cowork/backups/workspace/restore" {
                    self.last_backup_restore = Some(payload);
                }
            }
            "cowork/backups/workspace/delta/read" => {
                let target = payload.get("event").unwrap_or(&payload);
                if let Some(delta) = parse_backup_delta(target) {
                    self.backup_delta = Some(delta);
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
                        .filter_map(|v| parse_task_summary(v, workspace_id))
                        .collect();
                }
            }
            "task/read"
            | "task/create"
            | "task/updateBrief"
            | "task/questions/resolve"
            | "task/accept"
            | "task/requestChanges"
            | "task/cancel"
            | "task/reopen"
            | "task/retry"
            | "task/thread/create" => {
                let task_val = payload.get("task").unwrap_or(&payload);
                let select_active = matches!(method, "task/read" | "task/create");
                self.apply_task_record_update(workspace_id, task_val, select_active);
                if method == "task/create"
                    && let Some(tid) = task_val.get("id").and_then(Value::as_str)
                {
                    self.nav.update(NavigationPatch {
                        view: Some(ViewId::Task),
                        active_task_id: Some(Some(tid.to_string())),
                        ..Default::default()
                    });
                }
                if method == "task/thread/create"
                    && let Some(thread_val) = payload.get("thread")
                    && let Some(thread_id) = self.upsert_thread_from_value(workspace_id, thread_val)
                {
                    self.dispatch(Action::Navigate(NavAction::OpenThread(thread_id)));
                }
            }
            "task/artifact/read"
            | "task/artifact/version/accept"
            | "task/artifact/version/restore" => {
                if let Some(task_val) = payload.get("task") {
                    self.apply_task_record_update(workspace_id, task_val, false);
                }
                let detail = payload.get("detail").cloned().unwrap_or(payload.clone());
                let artifact_id = detail
                    .get("artifact")
                    .and_then(|a| a.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(active) = self.active_task.as_mut() {
                    if let Some(aid) = artifact_id {
                        active.artifact_details_by_id.insert(aid, detail.clone());
                    }
                    active.active_artifact_detail = Some(detail);
                }
            }
            "cowork/workspace/document/open"
            | "cowork/workspace/document/revision"
            | "cowork/workspace/document/save"
            | "cowork/workspace/document/saveAs" => {
                self.apply_canvas_rpc_response(request_id, method, &payload);
            }
            "cowork/workspace/document/close" => {
                self.pending_canvas_rpcs.remove(&request_id);
            }
            "cowork/workspace/presentation/preview" => {
                self.apply_presentation_preview_response(request_id, &payload);
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
        if method == "cowork/workspace/presentation/preview" {
            self.apply_presentation_preview_error(request_id, &err);
            return;
        }
        if let Some(draft_id) = self.pending_draft_threads_by_rpc_id.remove(&request_id)
            && let Some(rt) = self.thread_runtime_by_id.get_mut(&draft_id)
        {
            rt.pending_turn_count = 0;
            rt.last_error = Some(err.message.clone());
        }
        if matches!(method, "thread/read" | "thread/hydrate" | "thread/resume")
            && let Some(tid) = self.pending_hydrate_threads_by_rpc_id.remove(&request_id)
        {
            let already_hydrated = self
                .thread_runtime_by_id
                .get(&tid)
                .is_some_and(|rt| rt.hydrated && !rt.feed.is_empty());
            if let Some(rt) = self.thread_runtime_by_id.get_mut(&tid) {
                rt.hydrating = false;
            }
            if !already_hydrated {
                self.request_local_transcript(&tid);
            }
        }
        if method.starts_with("cowork/workspace/document/") {
            self.apply_canvas_rpc_error(request_id, method, &err);
        }
        if method == "turn/start" {
            for draft in self.composer_drafts.values_mut() {
                if draft.submitting {
                    draft.submitting = false;
                    draft.submission_error = Some(err.message.clone());
                }
            }
        } else if method.starts_with("cowork/") && !method.starts_with("cowork/workspace/document/")
        {
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

        if let Some(active_tid) = self.nav.current().active_thread_id.clone() {
            if let Some(active_thread) = self.threads.iter().find(|t| t.id == active_tid) {
                if active_thread.workspace_id == workspace_id
                    && !active_thread.draft
                    && !active_thread.archived
                    && self
                        .thread_runtime_by_id
                        .get(&active_tid)
                        .is_none_or(|rt| (!rt.hydrated || rt.transcript_only) && !rt.hydrating)
                    && self.is_workspace_ws_connected(workspace_id)
                {
                    self.dispatch(Action::Chat(ChatAction::HydrateThread(active_tid)));
                }
            } else if self.active_workspace_id.as_deref() == Some(workspace_id)
                && !self
                    .pending_draft_threads_by_rpc_id
                    .values()
                    .any(|id| id == &active_tid)
            {
                let mut cur = self.nav.current().clone();
                cur.active_thread_id = None;
                self.nav.replace_current(cur);
                if self.window_mode == WindowMode::Main {
                    self.persisted_active_thread_id = None;
                }
            }
        }

        if !self.scene_mode {
            self.persist_state();
        }
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
        let draft_reasoning_effort = draft_id.as_ref().and_then(|old_id| {
            self.threads
                .iter()
                .find(|t| t.id == *old_id)
                .and_then(|t| t.reasoning_effort.clone())
        });
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
            reasoning_effort: thread_val
                .get("reasoningEffort")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(draft_reasoning_effort),
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
        if !self.scene_mode {
            self.persist_state();
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

        if !self.scene_mode {
            self.persist_state();
        }

        let rt = self.thread_runtime_by_id.entry(session_id).or_default();
        rt.hydrating = false;
        rt.hydrated = true;
        rt.transcript_only = false;

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
            // Keep only truly unpersisted optimistic local user messages (never re-append confirmed items).
            let seen_ids: HashSet<String> = next_feed
                .iter()
                .map(|item| feed_item_id(item).to_string())
                .collect();
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
            let mut snapshot_user_counts: HashMap<String, usize> = HashMap::new();
            for item in &next_feed {
                if let FeedItem::Message {
                    role: FeedMessageRole::User,
                    content,
                    ..
                } = item
                {
                    *snapshot_user_counts
                        .entry(content.trim().to_string())
                        .or_insert(0) += 1;
                }
            }
            let mut rt_user_counts: HashMap<String, usize> = HashMap::new();
            for item in &rt.feed {
                if let FeedItem::Message {
                    id,
                    role: FeedMessageRole::User,
                    content,
                    client_message_id,
                    ..
                } = item
                {
                    let trimmed = content.trim().to_string();
                    let seen_count = rt_user_counts.entry(trimmed.clone()).or_insert(0);
                    *seen_count += 1;
                    if let Some(c) = client_message_id {
                        let snapshot_count =
                            snapshot_user_counts.get(&trimmed).copied().unwrap_or(0);
                        if id.starts_with("optimistic-")
                            && !seen_ids.contains(id)
                            && !seen_cids.contains(c)
                            && *seen_count > snapshot_count
                        {
                            next_feed.push(item.clone());
                        }
                    }
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

    fn apply_agent_profiles_catalog_event(&mut self, evt: &Value) {
        let Some(catalog_val) = evt.get("catalog") else {
            return;
        };
        if let Ok(catalog) =
            serde_json::from_value::<AgentProfilesCatalogState>(catalog_val.clone())
        {
            self.agent_profiles_catalog = catalog;
            if !self.agent_profiles_catalog.profiles.is_empty() {
                self.subagents = self
                    .agent_profiles_catalog
                    .profiles
                    .iter()
                    .map(catalog_entry_to_subagent_profile)
                    .collect();
                return;
            }
        }
        if let Some(profiles) = catalog_val.get("profiles").and_then(Value::as_array) {
            self.subagents = profiles
                .iter()
                .filter_map(|v| {
                    serde_json::from_value::<AgentProfileCatalogEntry>(v.clone())
                        .ok()
                        .map(|entry| catalog_entry_to_subagent_profile(&entry))
                        .or_else(|| serde_json::from_value::<SubagentProfile>(v.clone()).ok())
                })
                .collect();
        }
    }

    fn apply_memory_list_event(&mut self, evt: &Value) {
        let Some(arr) = evt
            .get("memories")
            .or_else(|| evt.get("entries"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let parsed: Vec<ScopedMemoryEntry> =
            arr.iter().filter_map(parse_scoped_memory_entry).collect();
        let scoped_only = (evt.get("entry").is_none() && evt.get("deleted").is_none())
            .then(|| {
                evt.get("scope")
                    .and_then(Value::as_str)
                    .filter(|s| *s == "user" || *s == "workspace")
            })
            .flatten();
        if let Some(target_scope) = scoped_only {
            self.scoped_memories.retain(|m| m.scope != target_scope);
            self.scoped_memories.extend(parsed);
        } else {
            self.scoped_memories = parsed;
        }
        self.memory_entries = self
            .scoped_memories
            .iter()
            .map(|m| MemoryEntry {
                key: m.id.clone(),
                content: m.content.clone(),
                updated_at: m.updated_at_ms,
            })
            .collect();
    }

    fn apply_plugins_catalog_event(&mut self, evt: &Value) {
        let catalog = evt.get("catalog");
        if let Some(arr) = evt
            .get("plugins")
            .or_else(|| {
                catalog.and_then(|c| c.get("plugins").or_else(|| c.get("installedPlugins")))
            })
            .and_then(Value::as_array)
        {
            self.installed_plugin_entries = arr.clone();
            self.plugins = arr.iter().filter_map(parse_plugin_summary).collect();
        }
        let available_partial =
            evt.get("availablePluginsPartial").and_then(Value::as_bool) == Some(true);
        if let Some(avail) = catalog
            .and_then(|c| c.get("availablePlugins"))
            .or_else(|| evt.get("availablePlugins"))
            .and_then(Value::as_array)
        {
            if available_partial && avail.is_empty() && !self.available_plugins.is_empty() {
                let installed_ids: HashSet<&str> =
                    self.plugins.iter().map(|p| p.id.as_str()).collect();
                self.available_plugins.retain(|p| {
                    p.get("id")
                        .and_then(Value::as_str)
                        .is_none_or(|id| !installed_ids.contains(id))
                });
            } else {
                self.available_plugins = avail.clone();
            }
        }
        if let Some(warnings) = catalog
            .and_then(|c| c.get("warnings"))
            .or_else(|| evt.get("warnings"))
            .and_then(Value::as_array)
        {
            self.plugin_catalog_warnings = warnings
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
        }
    }

    fn apply_skills_catalog_event(&mut self, evt: &Value) {
        let catalog = evt.get("catalog").unwrap_or(evt);
        if let Some(scopes) = catalog.get("scopes").and_then(Value::as_array) {
            self.skill_scopes = scopes.clone();
        }
        if let Some(installations) = catalog.get("installations").and_then(Value::as_array) {
            self.skill_installations = installations.clone();
        }
        let available_partial =
            evt.get("availableSkillsPartial").and_then(Value::as_bool) == Some(true);
        if let Some(avail) = catalog.get("availableSkills").and_then(Value::as_array) {
            if available_partial && avail.is_empty() && !self.available_skills.is_empty() {
                let installed_names: HashSet<&str> = self
                    .skill_installations
                    .iter()
                    .filter_map(|s| s.get("name").and_then(Value::as_str))
                    .collect();
                self.available_skills.retain(|s| {
                    s.get("name")
                        .and_then(Value::as_str)
                        .is_none_or(|name| !installed_names.contains(name))
                });
            } else {
                self.available_skills = avail.clone();
            }
        }
        if let Some(effective) = catalog.get("effectiveSkills").and_then(Value::as_array) {
            self.effective_skills = effective.clone();
            self.skills = effective.iter().filter_map(parse_skill_summary).collect();
        } else if let Some(installations) = catalog.get("installations").and_then(Value::as_array)
            && self.skills.is_empty()
        {
            self.skills = installations
                .iter()
                .filter_map(parse_skill_summary)
                .collect();
        }
    }

    fn bootstrap_active_workspace_tool_access(&mut self) {
        let Some(ws_id) = self.active_workspace_id.clone() else {
            return;
        };
        let is_running = self
            .workspace_runtime_by_id
            .get(&ws_id)
            .is_some_and(|rt| matches!(rt.server_state, ServerLifecycleState::Running { .. }))
            || self
                .workspace_socket_by_id
                .get(&ws_id)
                .is_some_and(|s| !matches!(s, WsConnectionState::Disconnected));
        if !is_running {
            return;
        }
        self.bootstrap_tool_access_catalogs(&ws_id);
    }

    fn bootstrap_tool_access_catalogs(&mut self, workspace_id: &str) {
        let cwd = self.workspace_path(workspace_id);
        let params = json!({ "cwd": cwd });
        for method in [
            "cowork/plugins/catalog/read",
            "cowork/skills/catalog/read",
            "cowork/marketplaces/read",
            "cowork/mcp/servers/read",
        ] {
            let _ = self.send_ws_request(workspace_id, method, params.clone(), true);
        }
    }

    fn build_mcp_target_params(
        &self,
        cwd: Option<&str>,
        name: &str,
        source: &str,
    ) -> serde_json::Map<String, Value> {
        let mut params = serde_json::Map::new();
        params.insert("cwd".to_string(), json!(cwd));
        params.insert("name".to_string(), json!(name));
        if !source.is_empty() {
            params.insert("source".to_string(), json!(source));
        }
        if let Some(srv) = self.mcp_servers.iter().find(|srv| {
            srv.name == name && (source.is_empty() || srv.source.as_deref() == Some(source))
        }) {
            if let Some(plugin_id) = srv
                .plugin_id
                .as_deref()
                .or_else(|| srv.config.get("pluginId").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
            {
                params.insert("pluginId".to_string(), json!(plugin_id));
            }
            if let Some(plugin_scope) = srv
                .plugin_scope
                .as_deref()
                .or_else(|| srv.config.get("pluginScope").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
            {
                params.insert("pluginScope".to_string(), json!(plugin_scope));
            }
        }
        params
    }

    fn apply_skills_list_event(&mut self, evt: &Value) {
        let Some(arr) = evt.get("skills").and_then(Value::as_array) else {
            return;
        };
        let updated: Vec<SkillSummary> = arr
            .iter()
            .filter_map(|v| {
                let mut summary = parse_skill_summary(v)?;
                let has_explicit_scope = v
                    .get("scope")
                    .or_else(|| v.get("origin").and_then(|o| o.get("scope")))
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty());
                let prev = summary
                    .id
                    .as_deref()
                    .and_then(|id| self.skills.iter().find(|s| s.id.as_deref() == Some(id)))
                    .or_else(|| self.skills.iter().find(|s| s.name == summary.name));
                let inst = summary
                    .installation_id
                    .as_deref()
                    .and_then(|iid| {
                        self.skill_installations
                            .iter()
                            .find(|i| i.get("installationId").and_then(Value::as_str) == Some(iid))
                    })
                    .or_else(|| {
                        self.skill_installations.iter().find(|i| {
                            i.get("name")
                                .or_else(|| i.get("skillName"))
                                .and_then(Value::as_str)
                                == Some(summary.name.as_str())
                        })
                    });
                if summary.installation_id.is_none() {
                    summary.installation_id =
                        prev.and_then(|s| s.installation_id.clone()).or_else(|| {
                            inst.and_then(|i| i.get("installationId"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        });
                }
                if !has_explicit_scope {
                    if let Some(prev_scope) =
                        prev.map(|s| s.scope.as_str()).filter(|s| !s.is_empty())
                    {
                        summary.scope = prev_scope.to_string();
                    } else if let Some(inst_scope) = inst
                        .and_then(|i| i.get("scope"))
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                    {
                        summary.scope = inst_scope.to_string();
                    }
                }
                if summary.source.is_none() {
                    summary.source = prev.and_then(|s| s.source.clone()).or_else(|| {
                        inst.and_then(|i| {
                            i.get("source")
                                .or_else(|| i.get("origin").and_then(|o| o.get("kind")))
                        })
                        .and_then(Value::as_str)
                        .map(str::to_string)
                    });
                }
                if summary.version.is_none() {
                    summary.version = prev.and_then(|s| s.version.clone()).or_else(|| {
                        inst.and_then(|i| i.get("version"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                }
                Some(summary)
            })
            .collect();
        self.skills = updated;
    }

    fn update_mcp_servers_from_event(&mut self, evt: &Value) {
        let mut servers = Vec::new();
        for key in ["workspaceServers", "userServers", "servers"] {
            let default_source = if key == "userServers" {
                "user"
            } else {
                "workspace"
            };
            if let Some(arr) = evt.get(key).and_then(Value::as_array) {
                for v in arr {
                    if let Some(summary) = parse_mcp_server_summary(v, default_source) {
                        servers.push(summary);
                    }
                }
            }
        }
        if !servers.is_empty()
            || evt.get("servers").is_some()
            || evt.get("workspaceServers").is_some()
            || evt.get("userServers").is_some()
        {
            self.mcp_servers = servers;
        }
    }

    fn apply_provider_auth_methods_event(&mut self, evt: &Value) {
        let target = evt.get("event").unwrap_or(evt);
        let Some(obj) = target
            .get("methods")
            .or_else(|| target.get("methodsByProvider"))
            .and_then(Value::as_object)
        else {
            return;
        };
        for (prov, val) in obj {
            if let Some(arr) = val.as_array() {
                let specs: Vec<ProviderAuthMethodSpec> = arr
                    .iter()
                    .filter_map(parse_provider_auth_method_spec)
                    .collect();
                let ids: Vec<String> = specs.iter().map(|m| m.id.clone()).collect();
                self.provider_auth_methods.insert(prov.clone(), ids);
                self.provider_auth_method_specs.insert(prov.clone(), specs);
            }
        }
    }

    fn apply_provider_catalog_event(&mut self, evt: &Value) {
        let target = evt.get("event").unwrap_or(evt);
        let connected: HashSet<&str> = target
            .get("connected")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if let Some(defaults) = target.get("default").and_then(Value::as_object) {
            for (prov, model_val) in defaults {
                if let Some(model) = model_val.as_str().filter(|m| !m.trim().is_empty()) {
                    self.default_model_by_provider
                        .insert(prov.clone(), model.to_string());
                }
            }
        }
        if let Some(arr) = target
            .get("all")
            .or_else(|| target.get("providers"))
            .or_else(|| target.get("catalog"))
            .and_then(Value::as_array)
        {
            for v in arr {
                if let (Some(id), Some(def)) = (
                    v.get("id").and_then(Value::as_str),
                    v.get("defaultModel")
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty()),
                ) {
                    self.default_model_by_provider
                        .entry(id.to_string())
                        .or_insert_with(|| def.to_string());
                }
            }
            self.provider_catalog = arr
                .iter()
                .filter_map(|v| parse_provider_summary(v, &connected))
                .collect();
        }
        self.refresh_creation_preflight();
    }

    fn apply_provider_status_event(&mut self, workspace_id: &str, evt: &Value) {
        let target = evt.get("event").unwrap_or(evt);
        if let Some(arr) = target
            .get("providers")
            .or_else(|| target.get("statuses"))
            .and_then(Value::as_array)
        {
            let statuses: Vec<ProviderStatusSummary> = arr
                .iter()
                .filter_map(parse_provider_status_summary)
                .collect();
            self.workspace_runtime_by_id
                .entry(workspace_id.to_string())
                .or_default()
                .provider_statuses = statuses;
        }
        self.refresh_creation_preflight();
    }

    fn apply_mcp_validation_event(&mut self, evt: &Value) {
        let Some(name) = evt.get("name").and_then(Value::as_str) else {
            return;
        };
        let ok = evt.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let message = evt
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        self.mcp_validation_by_server
            .insert(name.to_string(), evt.clone());
        for srv in &mut self.mcp_servers {
            if srv.name == name {
                srv.status = Some(if ok { "connected" } else { "error" }.to_string());
                srv.error = if ok { None } else { message.clone() };
            }
        }
        self.toasts.push(NotificationRecord {
            key: format!("mcp-validate:{name}"),
            title: if ok {
                format!("MCP validation passed: {name}")
            } else {
                format!("MCP validation failed: {name}")
            },
            description: message,
            tone: if ok {
                NotificationTone::Success
            } else {
                NotificationTone::Error
            },
            created_at_secs: self.wall_clock_secs(),
        });
    }

    fn apply_mcp_auth_event(&mut self, evt: &Value) {
        match evt.get("type").and_then(Value::as_str) {
            Some("mcp_server_auth_challenge") => self.apply_mcp_auth_challenge_event(evt),
            _ => self.apply_mcp_auth_result_event(evt),
        }
    }

    fn apply_mcp_auth_challenge_event(&mut self, evt: &Value) {
        self.mcp_auth_challenge = Some(evt.clone());
        let name = evt
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("MCP server");
        let instructions = evt
            .pointer("/challenge/instructions")
            .and_then(Value::as_str)
            .unwrap_or("");
        let url = evt
            .pointer("/challenge/url")
            .and_then(Value::as_str)
            .filter(|u| !u.trim().is_empty());
        let detail = match (instructions.trim().is_empty(), url) {
            (false, Some(u)) => Some(format!("{instructions} URL: {u}")),
            (false, None) => Some(instructions.to_string()),
            (true, Some(u)) => Some(u.to_string()),
            (true, None) => None,
        };
        self.toasts.push(NotificationRecord {
            key: format!("mcp-auth-challenge:{name}"),
            title: format!("MCP auth challenge: {name}"),
            description: detail,
            tone: NotificationTone::Info,
            created_at_secs: self.wall_clock_secs(),
        });
    }

    fn apply_mcp_auth_result_event(&mut self, evt: &Value) {
        self.mcp_auth_result = Some(evt.clone());
        let Some(name) = evt.get("name").and_then(Value::as_str) else {
            return;
        };
        let ok = evt.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let mode = evt.get("mode").and_then(Value::as_str).map(str::to_string);
        let message = evt
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        for srv in &mut self.mcp_servers {
            if srv.name == name {
                if let Some(m) = mode.clone() {
                    srv.auth_mode = Some(m.clone());
                    srv.auth_status = Some(m.clone());
                    if let Some(obj) = srv.config.as_object_mut() {
                        obj.insert("authMode".to_string(), json!(m));
                    }
                }
                srv.auth_message = message.clone();
                srv.error = if ok { None } else { message.clone() };
            }
        }
        self.toasts.push(NotificationRecord {
            key: format!("mcp-auth-result:{name}"),
            title: if ok {
                format!("MCP auth updated: {name}")
            } else {
                format!("MCP auth failed: {name}")
            },
            description: message,
            tone: if ok {
                NotificationTone::Success
            } else {
                NotificationTone::Error
            },
            created_at_secs: self.wall_clock_secs(),
        });
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
        let raw_active_tid = if self.window_mode == WindowMode::Main {
            self.nav.current().active_thread_id.clone()
        } else {
            self.persisted_active_thread_id.clone()
        };
        let active_thread_id = raw_active_tid.filter(|tid| {
            self.threads
                .iter()
                .find(|t| &t.id == tid)
                .is_none_or(|t| !t.draft)
        });
        if self.window_mode == WindowMode::Main {
            self.persisted_active_thread_id = active_thread_id.clone();
        }
        let snapshot = PersistedDesktopState {
            settings: self.desktop_settings.clone(),
            workspaces: self.workspaces.clone(),
            threads: self.persistable_threads(),
            workspace_order: self.workspace_order.clone(),
            collapsed_workspace_ids: self.collapsed_workspace_ids.iter().cloned().collect(),
            collapsed_sidebar_sections: self.collapsed_sidebar_sections.iter().copied().collect(),
            active_workspace_id: self.active_workspace_id.clone(),
            active_thread_id,
            onboarding: self.onboarding.clone(),
            feature_flags: self.feature_flag_overrides.clone(),
            product_analytics: self.product_analytics.clone(),
        };
        self.send_native(NativeCommand::SavePersistedState(Box::new(snapshot)));
    }

    fn upsert_task_summary(&mut self, summary: TaskSummaryView) {
        if let Some(existing) = self.tasks.iter_mut().find(|t| t.id == summary.id) {
            *existing = summary;
        } else {
            self.tasks.insert(0, summary);
        }
    }

    fn apply_task_record_update(&mut self, workspace_id: &str, val: &Value, select_active: bool) {
        let Some(mut task) = parse_task_record(val, workspace_id) else {
            return;
        };
        if let Some(existing) = self
            .active_task
            .as_ref()
            .filter(|t| t.summary.id == task.summary.id)
        {
            if task.runs.is_empty() && !existing.runs.is_empty() {
                task.runs = existing.runs.clone();
            }
            if task.active_artifact_detail.is_none() {
                task.active_artifact_detail = existing.active_artifact_detail.clone();
            }
            for (k, v) in &existing.artifact_details_by_id {
                task.artifact_details_by_id
                    .entry(k.clone())
                    .or_insert_with(|| v.clone());
            }
        }
        self.upsert_task_summary(task.summary.clone());
        let viewing_this_task = self.nav.current().active_task_id.as_deref()
            == Some(task.summary.id.as_str())
            || self
                .active_task
                .as_ref()
                .is_some_and(|t| t.summary.id == task.summary.id);
        if select_active || viewing_this_task {
            self.active_task = Some(task);
        }
    }

    fn upsert_thread_from_value(&mut self, workspace_id: &str, v: &Value) -> Option<String> {
        let id = v.get("id").and_then(Value::as_str)?;
        let title = v
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("New Chat")
            .to_string();
        let archived = v.get("archived").and_then(Value::as_bool).unwrap_or(false);
        let pinned = v.get("pinned").and_then(Value::as_bool).unwrap_or(false);
        let record = ThreadRecord {
            id: id.to_string(),
            workspace_id: workspace_id.to_string(),
            title,
            status: ThreadStatus::Active,
            session_id: Some(id.to_string()),
            pinned,
            archived,
            draft: false,
            provider: v
                .get("modelProvider")
                .or_else(|| v.get("provider"))
                .and_then(Value::as_str)
                .map(str::to_string),
            model: v.get("model").and_then(Value::as_str).map(str::to_string),
            updated_at: parse_timestamp_ms(v.get("updatedAt").or_else(|| v.get("createdAt"))),
            preview: v.get("preview").and_then(Value::as_str).map(str::to_string),
            ..Default::default()
        };
        if let Some(existing) = self.threads.iter_mut().find(|t| t.id == id) {
            *existing = record;
        } else {
            self.threads.push(record);
        }
        Some(id.to_string())
    }
}

pub(crate) fn is_hidden_lmstudio_model_id(provider_id: &str, model_id: &str) -> bool {
    if !provider_id.eq_ignore_ascii_case("lmstudio") {
        return false;
    }
    let lower = model_id.to_ascii_lowercase();
    lower.contains("embed") || lower.contains("rerank") || lower.contains("whisper")
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
        "pending" | "approval-requested" => Some(ToolRunStatus::Pending),
        "running" | "inProgress" | "in_progress" | "input-streaming" | "input-available" => {
            Some(ToolRunStatus::Running)
        }
        "completed" | "output-available" => Some(ToolRunStatus::Completed),
        "failed" | "error" | "output-error" => Some(ToolRunStatus::Failed),
        "declined" | "output-denied" => Some(ToolRunStatus::Declined),
        _ => None,
    }
}

fn parse_usage_summary(val: &Value) -> UsageSummary {
    let mut by_model = HashMap::new();
    if let Some(arr) = val.get("byModel").and_then(Value::as_array) {
        for item in arr {
            let provider = item
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let model = item
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if model.is_empty() && provider.is_empty() {
                continue;
            }
            let key = if provider.is_empty() {
                model.clone()
            } else {
                format!("{provider}:{model}")
            };
            by_model.insert(
                key,
                ModelUsageBreakdown {
                    provider,
                    model,
                    turns: item.get("turns").and_then(Value::as_u64).unwrap_or(0) as usize,
                    input_tokens: item
                        .get("totalPromptTokens")
                        .or_else(|| item.get("promptTokens"))
                        .or_else(|| item.get("inputTokens"))
                        .or_else(|| item.get("input_tokens"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    output_tokens: item
                        .get("totalCompletionTokens")
                        .or_else(|| item.get("completionTokens"))
                        .or_else(|| item.get("outputTokens"))
                        .or_else(|| item.get("output_tokens"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    cached_tokens: item
                        .get("totalCachedPromptTokens")
                        .or_else(|| item.get("cachedPromptTokens"))
                        .or_else(|| item.get("cachedTokens"))
                        .or_else(|| item.get("cached_tokens"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    estimated_cost_usd: item
                        .get("estimatedTotalCostUsd")
                        .or_else(|| item.get("estimatedCostUsd"))
                        .or_else(|| item.get("costUsd"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                },
            );
        }
    } else if let Some(obj) = val.get("byModel").and_then(Value::as_object) {
        for (k, item) in obj {
            if let Ok(parsed) = serde_json::from_value::<ModelUsageBreakdown>(item.clone()) {
                by_model.insert(k.clone(), parsed);
            }
        }
    }

    UsageSummary {
        input_tokens: val
            .get("totalPromptTokens")
            .or_else(|| val.get("promptTokens"))
            .or_else(|| val.get("inputTokens"))
            .or_else(|| val.get("input_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: val
            .get("totalCompletionTokens")
            .or_else(|| val.get("completionTokens"))
            .or_else(|| val.get("outputTokens"))
            .or_else(|| val.get("output_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cached_tokens: val
            .get("totalCachedPromptTokens")
            .or_else(|| val.get("cachedPromptTokens"))
            .or_else(|| val.get("cachedTokens"))
            .or_else(|| val.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        estimated_cost_usd: val
            .get("estimatedTotalCostUsd")
            .or_else(|| val.get("estimatedCostUsd"))
            .or_else(|| val.get("costUsd"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        by_model,
    }
}

fn parse_task_summary(val: &Value, fallback_workspace_id: &str) -> Option<TaskSummaryView> {
    if let Ok(mut parsed) = serde_json::from_value::<TaskSummaryView>(val.clone()) {
        if parsed.workspace_id.is_empty() {
            parsed.workspace_id = fallback_workspace_id.to_string();
        }
        return Some(parsed);
    }
    let id = val
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let workspace_id = val
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_workspace_id)
        .to_string();
    Some(TaskSummaryView {
        id,
        workspace_id,
        title: val
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: val
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        schedule: val
            .get("schedule")
            .and_then(Value::as_str)
            .map(str::to_string),
        last_run_at: val.get("lastRunAt").and_then(Value::as_i64),
        revision: val.get("revision").and_then(Value::as_i64).unwrap_or(0),
        objective: val
            .get("objective")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pending_question_count: val
            .get("pendingQuestionCount")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        blocking_question_count: val
            .get("blockingQuestionCount")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        active_blocker_count: val
            .get("activeBlockerCount")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        completed_work_item_count: val
            .get("completedWorkItemCount")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        total_work_item_count: val
            .get("totalWorkItemCount")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        updated_at: val
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

fn parse_task_artifact(val: &Value) -> Option<TaskArtifactView> {
    if let Ok(mut parsed) = serde_json::from_value::<TaskArtifactView>(val.clone()) {
        if parsed.title.is_empty() {
            parsed.title = parsed.name.clone();
        }
        return Some(parsed);
    }
    let id = val
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let title = val
        .get("title")
        .or_else(|| val.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let path = val
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = val
        .get("name")
        .or_else(|| val.get("title"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(&path).to_string());
    Some(TaskArtifactView {
        id,
        name,
        path,
        mime_type: val
            .get("mimeType")
            .or_else(|| val.get("mediaType"))
            .and_then(Value::as_str)
            .map(str::to_string),
        title,
        kind: val
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        work_item_id: val
            .get("workItemId")
            .and_then(Value::as_str)
            .map(str::to_string),
        thread_id: val
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string),
        latest_version_id: val
            .get("latestVersionId")
            .and_then(Value::as_str)
            .map(str::to_string),
        accepted_version_id: val
            .get("acceptedVersionId")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_task_record(val: &Value, fallback_workspace_id: &str) -> Option<TaskRecordView> {
    if val.get("summary").is_some_and(Value::is_object)
        && let Ok(parsed) = serde_json::from_value::<TaskRecordView>(val.clone())
    {
        return Some(parsed);
    }
    let summary = parse_task_summary(val, fallback_workspace_id)?;
    let prompt = val
        .get("prompt")
        .or_else(|| val.get("objective"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let artifacts = val
        .get("artifacts")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_task_artifact).collect())
        .unwrap_or_default();
    let runs = val
        .get("runs")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<WorkflowRunView>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let activity = val
        .get("activity")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Some(TaskRecordView {
        summary,
        prompt,
        questions: val.get("questions").cloned().unwrap_or(Value::Null),
        artifacts,
        runs,
        active_artifact_detail: val.get("activeArtifactDetail").cloned(),
        artifact_details_by_id: HashMap::new(),
        blockers: val.get("blockers").cloned().unwrap_or(Value::Null),
        work_items: val.get("workItems").cloned().unwrap_or(Value::Null),
        threads: val.get("threads").cloned().unwrap_or(Value::Null),
        requirements: val.get("requirements").cloned().unwrap_or(Value::Null),
        activity,
    })
}

fn build_agent_profile_upsert_payload(input: &AgentProfileUpsertInputWire) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("version".to_string(), json!(1));
    map.insert(
        "scope".to_string(),
        Value::String(if input.scope == "global" {
            "global".to_string()
        } else {
            "workspace".to_string()
        }),
    );
    map.insert("id".to_string(), Value::String(input.id.clone()));
    map.insert(
        "displayName".to_string(),
        Value::String(input.display_name.clone()),
    );
    map.insert(
        "description".to_string(),
        Value::String(input.description.clone()),
    );
    map.insert("enabled".to_string(), Value::Bool(input.enabled));
    map.insert(
        "baseRole".to_string(),
        Value::String(
            if matches!(
                input.base_role.as_str(),
                "default" | "explorer" | "research" | "worker" | "reviewer"
            ) {
                input.base_role.clone()
            } else {
                "default".to_string()
            },
        ),
    );
    map.insert("prompt".to_string(), Value::String(input.prompt.clone()));
    map.insert(
        "allowedBuiltInTools".to_string(),
        json!(input.allowed_built_in_tools),
    );
    map.insert(
        "allowedMcpServers".to_string(),
        json!(input.allowed_mcp_servers),
    );
    map.insert("skillNames".to_string(), json!(input.skill_names));
    if let Some(model) = input.model.as_deref().filter(|s| !s.trim().is_empty()) {
        map.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(effort) = input
        .reasoning_effort
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        map.insert(
            "reasoningEffort".to_string(),
            Value::String(effort.to_string()),
        );
    }
    if let Some(task_type) = input
        .default_task_type
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        map.insert(
            "defaultTaskType".to_string(),
            Value::String(task_type.to_string()),
        );
    }
    if let Some(ctx_mode) = input
        .default_context_mode
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        map.insert(
            "defaultContextMode".to_string(),
            Value::String(ctx_mode.to_string()),
        );
    }
    Value::Object(map)
}

fn parse_scoped_memory_entry(v: &Value) -> Option<ScopedMemoryEntry> {
    let id = v
        .get("id")
        .or_else(|| v.get("key"))
        .and_then(Value::as_str)?
        .to_string();
    let scope = v
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("workspace")
        .to_string();
    let content = v
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let created_at = v
        .get("createdAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let updated_at = v
        .get("updatedAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let updated_at_ms = v.get("updatedAt").and_then(|val| {
        val.as_i64().or_else(|| {
            val.as_str().and_then(|s| {
                chrono::DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|dt| dt.timestamp_millis())
            })
        })
    });
    Some(ScopedMemoryEntry {
        id,
        scope,
        content,
        created_at,
        updated_at,
        updated_at_ms,
    })
}

struct ClearableDefaultKey {
    desktop_key: &'static str,
    server_key: &'static str,
    clear_desktop_key: &'static str,
    clear_server_key: &'static str,
}

const CLEARABLE_DEFAULT_KEYS: [ClearableDefaultKey; 4] = [
    ClearableDefaultKey {
        desktop_key: "defaultToolOutputOverflowChars",
        server_key: "toolOutputOverflowChars",
        clear_desktop_key: "clearDefaultToolOutputOverflowChars",
        clear_server_key: "clearToolOutputOverflowChars",
    },
    ClearableDefaultKey {
        desktop_key: "defaultMemoryGenerationModel",
        server_key: "memoryGenerationModel",
        clear_desktop_key: "clearDefaultMemoryGenerationModel",
        clear_server_key: "clearMemoryGenerationModel",
    },
    ClearableDefaultKey {
        desktop_key: "defaultSkillImprovementModel",
        server_key: "skillImprovementModel",
        clear_desktop_key: "clearDefaultSkillImprovementModel",
        clear_server_key: "clearSkillImprovementModel",
    },
    ClearableDefaultKey {
        desktop_key: "defaultToolCalling",
        server_key: "toolCalling",
        clear_desktop_key: "clearDefaultToolCalling",
        clear_server_key: "clearToolCalling",
    },
];

fn should_clear_default(obj: &Map<String, Value>, spec: &ClearableDefaultKey) -> bool {
    obj.get(spec.clear_desktop_key).and_then(Value::as_bool) == Some(true)
        || obj.get(spec.clear_server_key).and_then(Value::as_bool) == Some(true)
}

fn apply_defaults_obj_to_workspace(ws: &mut WorkspaceRecord, obj: &Map<String, Value>) {
    if !ws.defaults.is_object() {
        ws.defaults = json!({});
    }
    if let Some(dst) = ws.defaults.as_object_mut() {
        for (k, v) in obj {
            dst.insert(k.clone(), v.clone());
        }
        for spec in &CLEARABLE_DEFAULT_KEYS {
            if should_clear_default(obj, spec) {
                dst.remove(spec.desktop_key);
                dst.remove(spec.server_key);
                dst.remove(spec.clear_desktop_key);
                dst.remove(spec.clear_server_key);
            } else if let Some(val) = obj
                .get(spec.server_key)
                .or_else(|| obj.get(spec.desktop_key))
            {
                dst.insert(spec.desktop_key.to_string(), val.clone());
                dst.insert(spec.server_key.to_string(), val.clone());
                dst.remove(spec.clear_desktop_key);
                dst.remove(spec.clear_server_key);
            }
        }
    }
    if let Some(yolo) = obj.get("yolo").and_then(Value::as_bool) {
        ws.yolo = yolo;
    }
    if let Some(p) = obj
        .get("defaultProvider")
        .or_else(|| obj.get("provider"))
        .and_then(Value::as_str)
    {
        ws.default_provider = (!p.trim().is_empty()).then(|| p.to_string());
    }
    if let Some(m) = obj
        .get("defaultModel")
        .or_else(|| obj.get("model"))
        .and_then(Value::as_str)
    {
        ws.default_model = (!m.trim().is_empty()).then(|| m.to_string());
    }
    if let Some(val) = obj
        .get("defaultPreferredChildModel")
        .or_else(|| obj.get("preferredChildModel"))
    {
        ws.default_preferred_child_model = val
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }
    if let Some(val) = obj
        .get("defaultChildModelRoutingMode")
        .or_else(|| obj.get("childModelRoutingMode"))
    {
        ws.default_child_model_routing_mode = val
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }
    if let Some(val) = obj
        .get("defaultPreferredChildModelRef")
        .or_else(|| obj.get("preferredChildModelRef"))
    {
        ws.default_preferred_child_model_ref = val
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }
    if let Some(arr) = obj
        .get("defaultAllowedChildModelRefs")
        .or_else(|| obj.get("allowedChildModelRefs"))
        .and_then(Value::as_array)
    {
        ws.default_allowed_child_model_refs = arr
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    if let Some(mcp) = obj
        .get("defaultEnableMcp")
        .or_else(|| obj.get("enableMcp"))
        .and_then(Value::as_bool)
    {
        ws.default_enable_mcp = mcp;
    }
    if let Some(b) = obj
        .get("defaultBackupsEnabled")
        .or_else(|| obj.get("backupsEnabled"))
        .and_then(Value::as_bool)
    {
        ws.default_backups_enabled = b;
    }
    if let Some(un) = obj.get("userName").and_then(Value::as_str) {
        ws.user_name = Some(un.to_string());
    }
    if let Some(up) = obj.get("userProfile") {
        ws.user_profile = Some(up.clone());
    }
    if let Some(po) = obj.get("providerOptions") {
        ws.provider_options = Some(po.clone());
    }
}

fn build_session_defaults_config_map(raw: &Map<String, Value>) -> Map<String, Value> {
    let mut map = raw.clone();
    for spec in &CLEARABLE_DEFAULT_KEYS {
        for (desktop_key, server_key) in [
            (spec.desktop_key, spec.server_key),
            (spec.clear_desktop_key, spec.clear_server_key),
        ] {
            if let Some(val) = map.remove(desktop_key)
                && !map.contains_key(server_key)
            {
                map.insert(server_key.to_string(), val);
            }
        }
    }
    for (desktop_key, server_key) in [
        ("defaultPreferredChildModel", "preferredChildModel"),
        ("defaultChildModelRoutingMode", "childModelRoutingMode"),
        ("defaultPreferredChildModelRef", "preferredChildModelRef"),
        ("defaultAllowedChildModelRefs", "allowedChildModelRefs"),
        ("defaultBackupsEnabled", "backupsEnabled"),
        (
            "defaultWorkflowMaxConcurrentAgents",
            "workflowMaxConcurrentAgents",
        ),
        ("advancedMemoryEnabled", "advancedMemory"),
    ] {
        if let Some(val) = map.remove(desktop_key)
            && !map.contains_key(server_key)
        {
            map.insert(server_key.to_string(), val);
        }
    }
    for spec in &CLEARABLE_DEFAULT_KEYS {
        if should_clear_default(raw, spec) {
            map.remove(spec.server_key);
            map.insert(spec.clear_server_key.to_string(), json!(true));
        } else if map.contains_key(spec.server_key) {
            map.remove(spec.clear_server_key);
        }
    }
    map
}

fn parse_profile_model_provider(model_ref: &str) -> Option<String> {
    cowork_config::parse_child_model_ref(model_ref, None)
        .and_then(|(prov, _, _, explicit)| explicit.then(|| prov.as_str().to_string()))
}

fn catalog_entry_to_subagent_profile(entry: &AgentProfileCatalogEntry) -> SubagentProfile {
    SubagentProfile {
        id: entry.profile.id.clone(),
        name: entry.profile.display_name.clone(),
        description: entry.profile.description.clone(),
        provider: entry
            .profile
            .model
            .as_deref()
            .and_then(parse_profile_model_provider),
        model: entry.profile.model.clone(),
        system_prompt: entry.profile.prompt.clone(),
        tool_preset: Some(entry.profile.base_role.clone()),
        allowed_tools: entry.profile.allowed_built_in_tools.clone(),
        denied_tools: Vec::new(),
        builtin: entry.built_in.unwrap_or(false),
        reasoning_effort: entry.profile.reasoning_effort.clone(),
        scope: Some(entry.scope.clone()),
    }
}

fn parse_plugin_summary(v: &Value) -> Option<PluginSummary> {
    let id = v.get("id").and_then(Value::as_str)?.to_string();
    let name = v
        .get("displayName")
        .or_else(|| v.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let description = v
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let version = v.get("version").and_then(Value::as_str).map(str::to_string);
    let enabled = v.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let scope = v.get("scope").and_then(Value::as_str).map(str::to_string);
    let source = v
        .get("source")
        .or_else(|| v.get("discoveryKind"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let icon = v
        .get("icon")
        .or_else(|| v.get("interface").and_then(|i| i.get("icon")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let update_available = v
        .get("updateAvailable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let error = v
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            v.get("warnings")
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let skill_count = v
        .get("skillCount")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .or_else(|| v.get("skills").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0);
    let mcp_count = v
        .get("mcpCount")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .or_else(|| v.get("mcpServers").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0);
    let subagent_count = v
        .get("subagentCount")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(0);
    Some(PluginSummary {
        id,
        name,
        description,
        version,
        enabled,
        scope,
        source,
        icon,
        update_available,
        error,
        skill_count,
        mcp_count,
        subagent_count,
    })
}

fn parse_provider_model_summary(v: &Value) -> Option<ProviderModelSummary> {
    let id = v.get("id").and_then(Value::as_str)?.to_string();
    let name = v
        .get("name")
        .or_else(|| v.get("displayName"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&id)
        .to_string();
    let enabled = v.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let custom = v.get("custom").and_then(Value::as_bool).unwrap_or_else(|| {
        v.get("origin").and_then(Value::as_str) == Some("custom")
            || v.pointer("/runtimeOptions/source").and_then(Value::as_str) == Some("custom")
    });
    let reasoning_efforts: Vec<String> = v
        .get("reasoningEfforts")
        .or_else(|| v.pointer("/reasoning/availableEfforts"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let supports_reasoning = v
        .get("supportsReasoning")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| v.get("reasoning").is_some() || !reasoning_efforts.is_empty());
    Some(ProviderModelSummary {
        id,
        name,
        enabled,
        custom,
        supports_reasoning,
        reasoning_efforts,
    })
}

fn parse_provider_summary(v: &Value, connected: &HashSet<&str>) -> Option<ProviderSummary> {
    let id = v.get("id").and_then(Value::as_str)?.to_string();
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let configured = v
        .get("configured")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            connected.contains(id.as_str())
                || v.get("state").and_then(Value::as_str) == Some("ready")
        });
    let models = v
        .get("models")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(parse_provider_model_summary)
                .collect()
        })
        .unwrap_or_default();
    let config = v.get("config").cloned().unwrap_or_else(|| v.clone());
    let capabilities = v.get("capabilities").cloned().unwrap_or(Value::Null);
    Some(ProviderSummary {
        id,
        name,
        configured,
        models,
        config,
        capabilities,
    })
}

fn parse_provider_status_summary(v: &Value) -> Option<ProviderStatusSummary> {
    let provider = v.get("provider").and_then(Value::as_str)?.to_string();
    let authorized = v.get("authorized").and_then(Value::as_bool);
    let verified = v.get("verified").and_then(Value::as_bool);
    let healthy = v
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| verified.unwrap_or(false) || authorized.unwrap_or(false));
    let connected = v
        .get("connected")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| authorized.unwrap_or(healthy));
    let auth_method = v
        .get("authMethod")
        .or_else(|| v.get("methodId"))
        .or_else(|| v.get("mode"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let detail = v
        .get("detail")
        .or_else(|| v.get("message"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let saved_api_key_mask = v
        .get("savedApiKeyMask")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            v.get("savedApiKeyMasks")
                .and_then(Value::as_object)
                .and_then(|m| m.get("api_key").or_else(|| m.get("apiKey")))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let source = v.get("source").and_then(Value::as_str).map(str::to_string);
    let usage = v.get("usage").cloned();
    let rate_limits = v.get("rateLimits").cloned();
    Some(ProviderStatusSummary {
        provider,
        healthy,
        connected,
        auth_method,
        detail,
        saved_api_key_mask,
        source,
        usage,
        rate_limits,
    })
}

fn extract_mcp_transport_kind(v: &Value, config: &Value) -> String {
    fn from_val(val: &Value) -> Option<&str> {
        match val {
            Value::String(s) if !s.trim().is_empty() => Some(s.as_str()),
            Value::Object(obj) => obj
                .get("type")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty()),
            _ => None,
        }
    }
    v.get("transport")
        .and_then(from_val)
        .or_else(|| config.get("transport").and_then(from_val))
        .unwrap_or("stdio")
        .to_string()
}

fn parse_mcp_server_summary(v: &Value, default_source: &str) -> Option<McpServerSummary> {
    let explicit_config = v.get("config").filter(|c| c.is_object()).cloned();
    let config = explicit_config.unwrap_or_else(|| v.clone());
    let name = v
        .get("name")
        .or_else(|| config.get("name"))
        .and_then(Value::as_str)?
        .to_string();
    let enabled = v
        .get("enabled")
        .or_else(|| config.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let transport = extract_mcp_transport_kind(v, &config);
    let source = v
        .get("source")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or_else(|| Some(default_source.to_string()));
    let plugin_id = v
        .get("pluginId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let plugin_name = v
        .get("pluginName")
        .and_then(Value::as_str)
        .map(str::to_string);
    let plugin_display_name = v
        .get("pluginDisplayName")
        .and_then(Value::as_str)
        .map(str::to_string);
    let plugin_scope = v
        .get("pluginScope")
        .and_then(Value::as_str)
        .map(str::to_string);
    let auth_mode = v
        .get("authMode")
        .or_else(|| config.get("authMode"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let auth_state = v.get("authState").cloned();
    let auth_message = v
        .get("authMessage")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            auth_state
                .as_ref()
                .and_then(|s| s.get("message"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
        });
    let auth_status = v
        .get("authStatus")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| auth_mode.clone())
        .or_else(|| {
            auth_state
                .as_ref()
                .and_then(|s| s.get("status"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let status = v.get("status").and_then(Value::as_str).map(str::to_string);
    let error = v
        .get("error")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            if auth_mode.as_deref() == Some("error") {
                auth_message.clone()
            } else {
                None
            }
        });
    let inherited = v.get("inherited").and_then(Value::as_bool).unwrap_or(false);
    Some(McpServerSummary {
        name,
        enabled,
        transport,
        status,
        error,
        auth_status,
        source,
        plugin_id,
        plugin_name,
        plugin_display_name,
        plugin_scope,
        auth_mode,
        auth_message,
        auth_state,
        inherited,
        config,
    })
}

fn parse_skill_summary(v: &Value) -> Option<SkillSummary> {
    let name = v.get("name").and_then(Value::as_str)?.to_string();
    let id = v.get("id").and_then(Value::as_str).map(str::to_string);
    let installation_id = v
        .get("installationId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let description = v
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let scope = v
        .get("scope")
        .or_else(|| v.get("origin").and_then(|o| o.get("scope")))
        .and_then(Value::as_str)
        .unwrap_or("workspace")
        .to_string();
    let enabled = v.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let source = v
        .get("source")
        .or_else(|| v.get("origin").and_then(|o| o.get("kind")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let icon = v
        .get("icon")
        .or_else(|| v.get("interface").and_then(|i| i.get("icon")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let version = v.get("version").and_then(Value::as_str).map(str::to_string);
    let update_available = v
        .get("updateAvailable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let error = v
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            v.get("diagnostics")
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(|d| d.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    Some(SkillSummary {
        id,
        name,
        description,
        scope,
        enabled,
        source,
        icon,
        version,
        update_available,
        error,
        installation_id,
    })
}

fn parse_backup_summary(v: &Value) -> Option<BackupSummary> {
    let target_session_id = v
        .get("targetSessionId")
        .or_else(|| v.get("id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| target_session_id.clone());
    let title = v.get("title").and_then(Value::as_str).map(str::to_string);
    let label = v
        .get("label")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            title
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| target_session_id.clone());
    let created_at = parse_timestamp_ms(v.get("createdAt"));
    let created_at_iso = v
        .get("createdAtIso")
        .or_else(|| v.get("createdAt"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let updated_at_iso = v
        .get("updatedAtIso")
        .or_else(|| v.get("updatedAt"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let closed_at_iso = v
        .get("closedAtIso")
        .or_else(|| v.get("closedAt"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let original_snapshot_bytes = v.get("originalSnapshotBytes").and_then(Value::as_u64);
    let checkpoint_bytes_total = v.get("checkpointBytesTotal").and_then(Value::as_u64);
    let total_bytes = v.get("totalBytes").and_then(Value::as_u64);
    let size_bytes = v
        .get("sizeBytes")
        .and_then(Value::as_u64)
        .or(total_bytes)
        .or(original_snapshot_bytes)
        .unwrap_or(0);
    let checkpoints = v
        .get("checkpoints")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|c| serde_json::from_value::<BackupCheckpointSummary>(c.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    Some(BackupSummary {
        id,
        label,
        created_at,
        size_bytes,
        target_session_id,
        title,
        provider: v
            .get("provider")
            .and_then(Value::as_str)
            .map(str::to_string),
        model: v.get("model").and_then(Value::as_str).map(str::to_string),
        lifecycle: v
            .get("lifecycle")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: v
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        working_directory: v
            .get("workingDirectory")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        backup_directory: v
            .get("backupDirectory")
            .and_then(Value::as_str)
            .map(str::to_string),
        original_snapshot_kind: v
            .get("originalSnapshotKind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        original_snapshot_bytes,
        checkpoint_bytes_total,
        total_bytes,
        checkpoints,
        created_at_iso,
        updated_at_iso,
        closed_at_iso,
        failure_reason: v
            .get("failureReason")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_backup_delta(v: &Value) -> Option<BackupDeltaView> {
    let target_session_id = v
        .get("targetSessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let checkpoint_id = v
        .get("checkpointId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let counts = v.get("counts");
    let count_field = |k: &str| {
        counts
            .and_then(|c| c.get(k))
            .and_then(Value::as_u64)
            .or_else(|| v.get(k).and_then(Value::as_u64))
            .unwrap_or(0) as usize
    };
    let files = v
        .get("files")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|f| serde_json::from_value::<BackupDeltaFileView>(f.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    Some(BackupDeltaView {
        target_session_id,
        checkpoint_id,
        baseline_label: v
            .get("baselineLabel")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        current_label: v
            .get("currentLabel")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        added: count_field("added"),
        modified: count_field("modified"),
        deleted: count_field("deleted"),
        files,
        truncated: v.get("truncated").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn parse_provider_auth_method_spec(v: &Value) -> Option<ProviderAuthMethodSpec> {
    if let Some(s) = v.as_str() {
        return (!s.is_empty()).then(|| ProviderAuthMethodSpec {
            id: s.to_string(),
            method_type: String::new(),
            label: None,
            fields: Vec::new(),
            oauth_mode: None,
        });
    }
    let id = v.get("id").and_then(Value::as_str)?.to_string();
    let method_type = v
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let label = v.get("label").and_then(Value::as_str).map(str::to_string);
    let fields = v
        .get("fields")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    f.get("id")
                        .or_else(|| f.get("key"))
                        .or_else(|| f.get("name"))
                        .and_then(Value::as_str)
                        .or_else(|| f.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    let oauth_mode = v
        .get("oauthMode")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(ProviderAuthMethodSpec {
        id,
        method_type,
        label,
        fields,
        oauth_mode,
    })
}

fn interaction_request_id(item: &ChatInteraction) -> &JsonRpcLiteId {
    match item {
        ChatInteraction::CommandApproval { request_id, .. }
        | ChatInteraction::FileChangeApproval { request_id, .. }
        | ChatInteraction::UserInput { request_id, .. } => request_id,
    }
}

fn interaction_item_id(item: &ChatInteraction) -> &str {
    match item {
        ChatInteraction::CommandApproval { item_id, .. }
        | ChatInteraction::FileChangeApproval { item_id, .. }
        | ChatInteraction::UserInput { item_id, .. } => item_id.as_str(),
    }
}

fn request_id_key(id: &JsonRpcLiteId) -> String {
    match id {
        JsonRpcLiteId::String(s) => s.clone(),
        JsonRpcLiteId::Number(n) => n.to_string(),
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
        "tool" => {
            let status = parse_tool_status(
                v.get("status")
                    .or_else(|| v.get("state"))
                    .and_then(Value::as_str),
            )
            .unwrap_or(ToolRunStatus::Completed);
            let output = v.get("output").or_else(|| v.get("result")).cloned();
            let error = v
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    (status == ToolRunStatus::Failed)
                        .then(|| {
                            output.as_ref().and_then(|out| {
                                out.as_str().map(str::to_string).or_else(|| {
                                    out.get("error").and_then(Value::as_str).map(str::to_string)
                                })
                            })
                        })
                        .flatten()
                });
            let diff = v
                .get("diff")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    output
                        .as_ref()
                        .and_then(|out| out.get("diff"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            let output_truncated = v
                .get("outputTruncated")
                .and_then(Value::as_bool)
                .or_else(|| {
                    output
                        .as_ref()
                        .and_then(|out| out.get("outputTruncated"))
                        .and_then(Value::as_bool)
                })
                .unwrap_or(false);
            Some(FeedItem::Tool {
                id,
                tool_name: v
                    .get("tool")
                    .or_else(|| v.get("toolName"))
                    .or_else(|| v.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string(),
                title: v
                    .get("title")
                    .or_else(|| output.as_ref().and_then(|out| out.get("title")))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                call_id: v.get("callId").and_then(Value::as_str).map(str::to_string),
                status,
                input: v
                    .get("input")
                    .or_else(|| v.get("args"))
                    .cloned()
                    .unwrap_or(Value::Null),
                output,
                error,
                diff,
                streaming: matches!(status, ToolRunStatus::Running),
                timestamp_ms: ts,
                completed_at_ms: v.get("completedAt").map(|c| parse_timestamp_ms(Some(c))),
                output_truncated,
            })
        }
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

        state.services.emitted_native_commands.clear();
        state.dispatch(Action::Settings(SettingsAction::SetAccentPalette(
            AccentPalette::OchreAmber,
        )));
        assert_eq!(
            state.desktop_settings.accent_palette,
            AccentPalette::OchreAmber
        );
        assert!(!state.services.emitted_native_commands.is_empty());

        let mut legacy_json =
            serde_json::to_value(DesktopSettings::default()).expect("serialize DesktopSettings");
        legacy_json
            .as_object_mut()
            .expect("object")
            .remove("accentPalette");
        let legacy: DesktopSettings = serde_json::from_value(legacy_json)
            .expect("legacy DesktopSettings without accentPalette must deserialize");
        assert_eq!(legacy.accent_palette, AccentPalette::default());
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

    #[test]
    fn usage_turn_vs_session_by_model_and_updater_byte_progress() {
        let mut state = AppState::default();
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "cowork/session/turnUsage".to_string(),
            params: json!({
                "type": "turn_usage",
                "sessionId": "th-1",
                "turnId": "turn-1",
                "usage": {
                    "promptTokens": 1200,
                    "completionTokens": 300,
                    "totalTokens": 1500,
                    "cachedPromptTokens": 400,
                    "estimatedCostUsd": 0.012
                }
            }),
        });
        let rt = state.thread_runtime_by_id.get("th-1").unwrap();
        let last_turn = rt.last_turn_usage.as_ref().unwrap();
        assert_eq!(last_turn.input_tokens, 1200);
        assert_eq!(last_turn.output_tokens, 300);
        assert_eq!(last_turn.cached_tokens, 400);
        assert!((last_turn.estimated_cost_usd - 0.012).abs() < 1e-9);

        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "cowork/session/usage".to_string(),
            params: json!({
                "type": "session_usage",
                "sessionId": "th-1",
                "usage": {
                    "totalPromptTokens": 5000,
                    "totalCompletionTokens": 1400,
                    "totalCachedPromptTokens": 1200,
                    "estimatedTotalCostUsd": 0.085,
                    "byModel": [{
                        "provider": "openai",
                        "model": "gpt-5.4",
                        "turns": 3,
                        "totalPromptTokens": 5000,
                        "totalCompletionTokens": 1400,
                        "totalCachedPromptTokens": 1200,
                        "estimatedCostUsd": 0.085
                    }]
                }
            }),
        });
        let rt = state.thread_runtime_by_id.get("th-1").unwrap();
        assert_eq!(rt.last_turn_usage.as_ref().unwrap().input_tokens, 1200);
        let total = rt.usage.as_ref().unwrap();
        assert_eq!(total.input_tokens, 5000);
        assert_eq!(total.output_tokens, 1400);
        assert_eq!(total.cached_tokens, 1200);
        let model = total.by_model.get("openai:gpt-5.4").unwrap();
        assert_eq!(model.turns, 3);
        assert_eq!(model.input_tokens, 5000);

        state.apply_store_event(StoreEvent::UpdaterChanged(UpdaterState {
            status: "downloading".to_string(),
            download_progress: Some(0.5),
            downloaded_bytes: Some(5_000_000),
            total_bytes: Some(10_000_000),
            bytes_per_second: Some(1_250_000),
            ..UpdaterState::default()
        }));
        assert_eq!(state.updater.downloaded_bytes, Some(5_000_000));
        assert_eq!(state.updater.total_bytes, Some(10_000_000));
        assert_eq!(state.updater.bytes_per_second, Some(1_250_000));
    }

    #[test]
    fn sidebar_section_collapse_persists_and_reloads() {
        let mut state = AppState::default();
        state.dispatch(Action::Shell(ShellAction::ToggleSidebarSectionCollapsed(
            crate::actions::SidebarSectionKey::Tasks,
        )));
        assert!(
            state
                .collapsed_sidebar_sections
                .contains(&crate::actions::SidebarSectionKey::Tasks)
        );
        let saved = match state.services.emitted_native_commands.last() {
            Some(NativeCommand::SavePersistedState(snapshot)) => (**snapshot).clone(),
            other => panic!("expected SavePersistedState, got {other:?}"),
        };
        assert_eq!(
            saved.collapsed_sidebar_sections,
            vec![crate::actions::SidebarSectionKey::Tasks]
        );

        let mut reloaded = AppState::default();
        reloaded.apply_store_event(StoreEvent::NativeReady {
            persisted: Box::new(saved),
            is_packaged: false,
            system_dark: Some(false),
        });
        assert!(
            reloaded
                .collapsed_sidebar_sections
                .contains(&crate::actions::SidebarSectionKey::Tasks)
        );
    }

    #[test]
    fn task_actions_and_server_payloads_reduce_cleanly() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Repo".to_string(),
            path: "/tmp/repo".to_string(),
            ..Default::default()
        });
        state.active_workspace_id = Some("ws-1".to_string());

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 10,
            method: "task/list".to_string(),
            result: Ok(json!({
                "tasks": [{
                    "id": "task-1",
                    "workspacePath": "/tmp/repo",
                    "title": "Audit desktop",
                    "objective": "Verify task sync",
                    "status": "blocked",
                    "revision": 2,
                    "pendingQuestionCount": 1,
                    "blockingQuestionCount": 1,
                    "updatedAt": "2026-11-14T00:00:00Z"
                }],
                "total": 1
            })),
        });
        assert_eq!(state.tasks.len(), 1);
        assert_eq!(state.tasks[0].id, "task-1");
        assert_eq!(state.tasks[0].workspace_id, "ws-1");
        assert_eq!(state.tasks[0].revision, 2);

        state.dispatch(Action::Navigate(NavAction::OpenTask("task-1".to_string())));
        let read_cmd = state.services.emitted_ws_commands.last().unwrap();
        match read_cmd {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "task/read");
                assert_eq!(params["cwd"], "/tmp/repo");
                assert_eq!(params["taskId"], "task-1");
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 11,
            method: "task/read".to_string(),
            result: Ok(json!({
                "task": {
                    "id": "task-1",
                    "workspacePath": "/tmp/repo",
                    "title": "Audit desktop",
                    "objective": "Verify task sync",
                    "status": "blocked",
                    "revision": 3,
                    "questions": [{ "id": "q-1", "prompt": "Proceed?" }],
                    "artifacts": [{
                        "id": "art-1",
                        "title": "Plan.md",
                        "path": "docs/plan.md",
                        "kind": "document"
                    }],
                    "activity": [{ "id": "act-1", "kind": "created" }]
                }
            })),
        });
        let active = state.active_task.as_ref().unwrap();
        assert_eq!(active.summary.revision, 3);
        assert_eq!(active.artifacts[0].name, "Plan.md");

        state.dispatch(Action::Task(TaskAction::ResolveQuestions {
            workspace_id: "ws-1".to_string(),
            task_id: "task-1".to_string(),
            expected_revision: 3,
            answers: vec![crate::actions::TaskQuestionAnswerParam {
                question_id: "q-1".to_string(),
                option_id: Some("opt-yes".to_string()),
                text: None,
            }],
        }));
        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "task/questions/resolve");
                assert_eq!(params["expectedRevision"], 3);
                assert_eq!(params["answers"][0]["questionId"], "q-1");
                assert_eq!(params["answers"][0]["optionId"], "opt-yes");
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }

        state.dispatch(Action::Task(TaskAction::ReadArtifact {
            workspace_id: "ws-1".to_string(),
            task_id: "task-1".to_string(),
            artifact_id: "art-1".to_string(),
        }));
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 12,
            method: "task/artifact/read".to_string(),
            result: Ok(json!({
                "detail": {
                    "artifact": { "id": "art-1", "title": "Plan.md" },
                    "latestVersionId": "v-2"
                }
            })),
        });
        assert_eq!(
            state
                .active_task
                .as_ref()
                .and_then(|t| t.artifact_details_by_id.get("art-1"))
                .and_then(|d| d.get("latestVersionId"))
                .and_then(Value::as_str),
            Some("v-2")
        );

        state.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Task)));
        assert!(state.active_task.is_none());
        assert_eq!(state.nav.current().active_task_id, None);
    }

    #[test]
    fn create_task_emits_server_valid_payload() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Repo".to_string(),
            path: "/tmp/repo".to_string(),
            ..Default::default()
        });
        state.active_workspace_id = Some("ws-1".to_string());

        state.dispatch(Action::Task(TaskAction::CreateTask {
            workspace_id: "ws-1".to_string(),
            title: "Ship parity".to_string(),
            objective: "Implement full schema alignment".to_string(),
            context: None,
            review_required: Some(true),
            provider: Some("anthropic".to_string()),
            model: None,
            idempotency_key: None,
            requirements: Vec::new(),
            work_items: Vec::new(),
        }));

        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "task/create");
                assert_eq!(params["cwd"], "/tmp/repo");
                assert!(!params["idempotencyKey"].as_str().unwrap_or("").is_empty());
                assert_eq!(params["title"], "Ship parity");
                assert_eq!(params["objective"], "Implement full schema alignment");
                assert_eq!(params["context"], "Implement full schema alignment");
                assert_eq!(params["reviewRequired"], true);
                assert_eq!(params["provider"], "anthropic");
                let req = &params["requirements"][0];
                assert_eq!(req["kind"], "acceptance_criterion");
                assert!(!req["text"].as_str().unwrap_or("").is_empty());
                assert_eq!(req["permanence"], "fixed");
                let wi = &params["workItems"][0];
                assert_eq!(wi["key"], "wi-1");
                assert!(!wi["expectedOutputs"][0].as_str().unwrap_or("").is_empty());
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }
    }

    #[test]
    fn settings_protocol_payloads_match_server_schemas() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Repo".to_string(),
            path: "/tmp/repo".to_string(),
            ..Default::default()
        });

        state.dispatch(Action::Settings(SettingsAction::CopyAgentProfile {
            workspace_id: "ws-1".to_string(),
            id: "global:reviewer".to_string(),
            target_scope: "workspace".to_string(),
        }));
        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "cowork/agentProfiles/copy");
                assert_eq!(params["copy"]["sourceRef"], "global:reviewer");
                assert_eq!(params["copy"]["targetScope"], "workspace");
                assert!(params.get("id").is_none());
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }

        state.dispatch(Action::Settings(SettingsAction::RestoreSkillImprovement {
            workspace_id: "ws-1".to_string(),
            skill_name: "code-review".to_string(),
        }));
        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "cowork/skills/improvement/restore");
                assert_eq!(params["skillName"], "code-review");
                assert!(params.get("backupId").is_none());
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }

        let before = state.services.emitted_ws_commands.len();
        state.dispatch(Action::Settings(SettingsAction::RefreshPluginsAndSkills {
            workspace_id: "ws-1".to_string(),
        }));
        let refresh_methods: Vec<String> = state.services.emitted_ws_commands[before..]
            .iter()
            .filter_map(|cmd| match cmd {
                WsCommand::SendRequest { method, .. } => Some(method.clone()),
                _ => None,
            })
            .collect();
        assert!(!refresh_methods.contains(&"cowork/plugins/read".to_string()));
        assert!(refresh_methods.contains(&"cowork/plugins/catalog/read".to_string()));
        assert!(refresh_methods.contains(&"cowork/skills/list".to_string()));

        state.dispatch(Action::Settings(SettingsAction::SetSkillEnabled {
            workspace_id: "ws-1".to_string(),
            name: "alpha".to_string(),
            enabled: false,
        }));
        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "cowork/skills/disable");
                assert_eq!(params["skillName"], "alpha");
                assert!(params.get("name").is_none());
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }

        state.dispatch(Action::Settings(SettingsAction::DeleteSkill {
            workspace_id: "ws-1".to_string(),
            name: "beta".to_string(),
        }));
        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "cowork/skills/delete");
                assert_eq!(params["skillName"], "beta");
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }

        state.dispatch(Action::Settings(SettingsAction::AddMarketplace {
            workspace_id: "ws-1".to_string(),
            url: "owner/repo".to_string(),
        }));
        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "cowork/marketplaces/add");
                assert_eq!(params["sourceInput"], "owner/repo");
                assert!(params.get("source").is_none());
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }

        state.dispatch(Action::Settings(SettingsAction::CompleteMcpOAuthCallback {
            workspace_id: "ws-1".to_string(),
            name: "linear".to_string(),
            source: "workspace".to_string(),
            callback_url: "http://127.0.0.1/cb?code=abc".to_string(),
        }));
        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "cowork/mcp/server/auth/callback");
                assert_eq!(params["code"], "http://127.0.0.1/cb?code=abc");
                assert!(params.get("callbackUrl").is_none());
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }

        state.dispatch(Action::Settings(
            SettingsAction::PreviewConversationImport {
                workspace_id: "ws-1".to_string(),
                params: json!({ "source": "claude", "sourcePath": "/tmp/export.json" }),
            },
        ));
        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "cowork/conversationImport/preview");
                assert!(params.get("cwd").is_none());
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }

        state.dispatch(Action::Settings(
            SettingsAction::ExecuteConversationImport {
                workspace_id: "ws-1".to_string(),
                params: json!({ "source": "claude", "sourcePath": "/tmp/export.json" }),
            },
        ));
        match state.services.emitted_ws_commands.last().unwrap() {
            WsCommand::SendRequest { method, params, .. } => {
                assert_eq!(method, "cowork/conversationImport/import");
                assert!(params.get("cwd").is_none());
            }
            other => panic!("expected SendRequest, got {other:?}"),
        }
    }

    #[test]
    fn explorer_entries_are_workspace_scoped_and_normalized() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "One".to_string(),
            path: "/tmp/ws1".to_string(),
            ..Default::default()
        });
        state.workspaces.push(WorkspaceRecord {
            id: "ws-2".to_string(),
            name: "Two".to_string(),
            path: "/tmp/ws2".to_string(),
            ..Default::default()
        });
        state.active_workspace_id = Some("ws-1".to_string());

        state.dispatch(Action::Native(NativeAction::ListWorkspaceFiles {
            workspace_id: "ws-1".to_string(),
            dir: ".".to_string(),
        }));
        match state.services.emitted_native_commands.last().unwrap() {
            NativeCommand::ListWorkspaceFiles { dir, .. } => assert_eq!(dir, "/tmp/ws1"),
            other => panic!("expected ListWorkspaceFiles, got {other:?}"),
        }

        state.apply_store_event(StoreEvent::WorkspaceFilesListed {
            workspace_id: "ws-1".to_string(),
            dir: "/tmp/ws1".to_string(),
            entries: vec![WorkspaceFileEntry {
                name: "src".to_string(),
                path: "/tmp/ws1/src".to_string(),
                is_dir: true,
                size_bytes: None,
                git_status: None,
            }],
        });
        state.apply_store_event(StoreEvent::WorkspaceFilesListed {
            workspace_id: "ws-1".to_string(),
            dir: "/tmp/ws1/src/".to_string(),
            entries: vec![WorkspaceFileEntry {
                name: "lib.rs".to_string(),
                path: "/tmp/ws1/src/lib.rs".to_string(),
                is_dir: false,
                size_bytes: Some(42),
                git_status: None,
            }],
        });

        assert_eq!(state.explorer_entries("ws-1", ".").unwrap()[0].path, "src");
        assert_eq!(
            state.explorer_entries("ws-1", "./src").unwrap()[0].path,
            "src/lib.rs"
        );
        assert!(state.explorer_entries_by_dir.contains_key("."));
        assert!(state.explorer_entries_by_dir.contains_key("src"));

        state.dispatch(Action::Navigate(NavAction::SelectWorkspace(
            "ws-2".to_string(),
        )));
        assert!(state.explorer_entries_by_dir.is_empty());

        state.apply_store_event(StoreEvent::WorkspaceFilesListed {
            workspace_id: "ws-2".to_string(),
            dir: ".".to_string(),
            entries: vec![WorkspaceFileEntry {
                name: "README.md".to_string(),
                path: "/tmp/ws2/README.md".to_string(),
                is_dir: false,
                size_bytes: Some(12),
                git_status: None,
            }],
        });
        assert_eq!(
            state.explorer_entries_by_dir.get(".").unwrap()[0].name,
            "README.md"
        );

        state.dispatch(Action::Navigate(NavAction::SelectWorkspace(
            "ws-1".to_string(),
        )));
        assert_eq!(
            state.explorer_entries_by_dir.get(".").unwrap()[0].name,
            "src"
        );

        state.dispatch(Action::Native(NativeAction::RemoveWorkspace(
            "ws-1".to_string(),
        )));
        assert!(state.explorer_entries("ws-1", ".").is_none());
        assert_eq!(
            state.explorer_entries_by_dir.get(".").unwrap()[0].name,
            "README.md"
        );
    }

    #[test]
    fn resolve_feature_flags_and_packaged_gating() {
        let mut overrides = HashMap::new();
        overrides.insert("remoteAccess".to_string(), true);
        overrides.insert("canvas".to_string(), true);

        let dev_flags = resolve_feature_flags_with_env(false, &overrides, |key| match key {
            "COWORK_ENABLE_TASKS" => Some("1".to_string()),
            _ => None,
        });
        assert_eq!(dev_flags.get("remoteAccess"), Some(&true));
        assert_eq!(dev_flags.get("canvas"), Some(&true));
        assert_eq!(dev_flags.get("tasks"), Some(&true));
        assert_eq!(dev_flags.get("menuBar"), Some(&true));

        let pkg_flags = resolve_feature_flags_with_env(true, &overrides, |key| match key {
            "COWORK_ENABLE_REMOTE_ACCESS" => Some("true".to_string()),
            "COWORK_ENABLE_TASKS" => Some("on".to_string()),
            _ => None,
        });
        assert_eq!(pkg_flags.get("remoteAccess"), Some(&false));
        assert_eq!(pkg_flags.get("canvas"), Some(&false));
        assert_eq!(pkg_flags.get("tasks"), Some(&true));

        let mut persisted = PersistedDesktopState::default();
        persisted
            .feature_flags
            .insert("remoteAccess".to_string(), true);
        persisted.feature_flags.insert("canvas".to_string(), true);

        let mut state = AppState::default();
        state.apply_store_event(StoreEvent::NativeReady {
            persisted: Box::new(persisted),
            is_packaged: true,
            system_dark: None,
        });
        assert_eq!(state.feature_flags.get("remoteAccess"), Some(&false));
        assert_eq!(state.feature_flags.get("canvas"), Some(&false));
        assert_eq!(state.feature_flag_overrides.get("canvas"), Some(&true));

        state.dispatch(Action::Settings(SettingsAction::SetFeatureFlag {
            flag_id: "remoteAccess".to_string(),
            enabled: true,
        }));
        assert_eq!(state.feature_flags.get("remoteAccess"), Some(&false));

        state.apply_store_event(StoreEvent::DeepLink(
            "cowork://settings/toolAccess".to_string(),
        ));
        assert_eq!(state.nav.current().view, ViewId::Settings);
        assert_eq!(
            state.nav.current().settings_page,
            crate::router::SettingsPageId::ToolAccess
        );
    }

    #[test]
    fn request_user_input_preserves_canonical_question_and_options() {
        let mut state = AppState::default();
        state.apply_store_event(StoreEvent::WsServerRequest {
            workspace_id: "ws-1".to_string(),
            id: JsonRpcLiteId::Number(77),
            method: "item/tool/requestUserInput".to_string(),
            params: json!({
                "threadId": "th-1",
                "itemId": "call-1",
                "question": "Pick deployment target",
                "options": ["staging", "production"]
            }),
        });
        let rt = state.thread_runtime_by_id.get("th-1").unwrap();
        match rt.pending_interactions.first().unwrap() {
            ChatInteraction::UserInput {
                item_id, questions, ..
            } => {
                assert_eq!(item_id, "call-1");
                assert_eq!(questions["question"], "Pick deployment target");
                assert_eq!(questions["options"][0], "staging");
            }
            other => panic!("expected UserInput, got {other:?}"),
        }
    }

    #[test]
    fn update_workspace_defaults_remaps_overflow_and_updates_control_session_config() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));
        state.active_workspace_id = Some("ws-1".to_string());

        state.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
            workspace_id: "ws-1".to_string(),
            defaults: json!({ "defaultToolOutputOverflowChars": 32768 }),
        }));

        let (rpc_id, params) = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest {
                    request_id: id,
                    method,
                    params,
                    ..
                } if method == "cowork/session/defaults/apply" => Some((*id, params.clone())),
                _ => None,
            })
            .expect("expected cowork/session/defaults/apply request");
        assert_eq!(params["config"]["toolOutputOverflowChars"], 32768);
        assert!(
            params["config"]
                .get("defaultToolOutputOverflowChars")
                .is_none()
        );

        let ws = state.workspaces.iter().find(|w| w.id == "ws-1").unwrap();
        assert_eq!(ws.defaults["defaultToolOutputOverflowChars"], 32768);
        assert!(
            ws.defaults
                .get("clearDefaultToolOutputOverflowChars")
                .is_none()
        );

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: rpc_id,
            method: "cowork/session/defaults/apply".to_string(),
            result: Ok(json!({
                "event": {
                    "type": "session_config",
                    "config": {
                        "toolOutputOverflowChars": 32768,
                        "defaultToolOutputOverflowChars": 32768
                    }
                }
            })),
        });
        assert_eq!(
            state
                .workspace_runtime_by_id
                .get("ws-1")
                .and_then(|rt| rt.control_session_config.as_ref())
                .and_then(|c| c.get("toolOutputOverflowChars")),
            Some(&json!(32768))
        );

        state.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
            workspace_id: "ws-1".to_string(),
            defaults: json!({
                "clearDefaultToolOutputOverflowChars": true,
                "defaultToolOutputOverflowChars": 999
            }),
        }));
        let clear_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/session/defaults/apply" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            clear_params["config"]["clearToolOutputOverflowChars"],
            json!(true)
        );
        assert!(
            clear_params["config"]
                .get("toolOutputOverflowChars")
                .is_none()
        );
        let ws = state.workspaces.iter().find(|w| w.id == "ws-1").unwrap();
        assert!(ws.defaults.get("defaultToolOutputOverflowChars").is_none());
        assert!(ws.defaults.get("toolOutputOverflowChars").is_none());
    }

    #[test]
    fn check_libreoffice_runtime_sends_smoke_true_and_parses_typed_result() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));

        state.dispatch(Action::Settings(SettingsAction::CheckLibreOfficeRuntime {
            workspace_id: "ws-1".to_string(),
        }));
        let (rpc_id, params) = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest {
                    request_id: id,
                    method,
                    params,
                    ..
                } if method == "cowork/runtime/libreoffice/check" => Some((*id, params.clone())),
                _ => None,
            })
            .expect("expected libreoffice check request");
        assert_eq!(params["cwd"], "/tmp/demo");
        assert_eq!(params["smoke"], json!(true));

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: rpc_id,
            method: "cowork/runtime/libreoffice/check".to_string(),
            result: Ok(json!({
                "status": {
                    "status": "available",
                    "checkedAt": "2026-11-15T00:00:00Z",
                    "message": "LibreOffice 24.8 ready",
                    "version": "24.8.1",
                    "resolvedPath": "/Applications/LibreOffice.app/Contents/MacOS/soffice",
                    "smoke": {
                        "ok": true,
                        "durationMs": 42,
                        "sizeBytes": 1234
                    }
                }
            })),
        });
        let parsed = state
            .libreoffice_check
            .as_ref()
            .expect("expected parsed RuntimeLibreOfficeCheckResult");
        assert_eq!(parsed.status.status, "available");
        assert_eq!(parsed.status.smoke.as_ref().map(|s| s.ok), Some(true));
        assert!(state.libreoffice_status.is_some());
    }

    #[test]
    fn backup_entries_delta_delete_entry_and_restore_round_trip() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 1,
            method: "cowork/backups/workspace/read".to_string(),
            result: Ok(json!({
                "event": {
                    "entries": [{
                        "targetSessionId": "sess-1",
                        "title": "Refactor store",
                        "lifecycle": "active",
                        "status": "ready",
                        "workingDirectory": "/tmp/demo",
                        "originalSnapshotKind": "tar",
                        "totalBytes": 4096,
                        "createdAt": "2026-11-15T00:00:00Z",
                        "updatedAt": "2026-11-15T00:05:00Z",
                        "checkpoints": [{
                            "id": "cp-1",
                            "index": 1,
                            "createdAt": "2026-11-15T00:05:00Z",
                            "trigger": "turn_end",
                            "changed": true,
                            "patchBytes": 512
                        }]
                    }]
                }
            })),
        });
        assert_eq!(state.backups.len(), 1);
        assert_eq!(state.backups[0].target_session_id, "sess-1");
        assert_eq!(state.backups[0].label, "Refactor store");
        assert_eq!(state.backups[0].size_bytes, 4096);
        assert_eq!(state.backups[0].checkpoints.len(), 1);
        assert_eq!(state.backups[0].checkpoints[0].id, "cp-1");

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 2,
            method: "cowork/backups/workspace/delta/read".to_string(),
            result: Ok(json!({
                "event": {
                    "targetSessionId": "sess-1",
                    "checkpointId": "cp-1",
                    "baselineLabel": "Baseline",
                    "currentLabel": "Checkpoint #1",
                    "counts": { "added": 1, "modified": 2, "deleted": 0 },
                    "files": [
                        { "path": "src/main.rs", "change": "modified", "kind": "file" }
                    ],
                    "truncated": false
                }
            })),
        });
        let delta = state.backup_delta.as_ref().expect("expected backup delta");
        assert_eq!(delta.added, 1);
        assert_eq!(delta.modified, 2);
        assert_eq!(delta.files.len(), 1);

        state.dispatch(Action::Settings(SettingsAction::DeleteBackupEntry {
            workspace_id: "ws-1".to_string(),
            target_session_id: "sess-1".to_string(),
        }));
        let delete_req = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest {
                    request_id: id,
                    method,
                    params,
                    ..
                } if method == "cowork/backups/workspace/deleteEntry" => {
                    Some((*id, params.clone()))
                }
                _ => None,
            });
        let (del_id, del_params) = delete_req.expect("expected deleteEntry request");
        assert_eq!(del_params["targetSessionId"], "sess-1");

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: del_id,
            method: "cowork/backups/workspace/deleteEntry".to_string(),
            result: Ok(json!({ "event": { "entries": [] } })),
        });
        assert!(state.backups.is_empty());
        assert!(state.backup_delta.is_none());

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 99,
            method: "cowork/backups/workspace/restore".to_string(),
            result: Ok(json!({ "restoredCount": 3 })),
        });
        assert_eq!(
            state
                .last_backup_restore
                .as_ref()
                .and_then(|v| v.get("restoredCount")),
            Some(&json!(3))
        );
    }

    #[test]
    fn select_landing_quick_chat_defers_workspace_creation_until_submit() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-work", "Work", "/tmp/work", 1));
        state.active_workspace_id = Some("ws-work".to_string());

        state.dispatch(Action::Shell(ShellAction::SelectLandingQuickChat));
        assert_eq!(
            state.landing_workspace_id.as_deref(),
            Some(ONE_OFF_LANDING_SENTINEL)
        );
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.active_workspace_id.as_deref(), Some("ws-work"));

        state.dispatch(Action::Chat(ChatAction::SendMessage {
            thread_id: None,
            text: "Quick question".to_string(),
            busy_policy: ThreadBusyPolicy::Steer,
            attachments: Vec::new(),
            references: Vec::new(),
        }));

        let qc_ws = state
            .workspaces
            .iter()
            .find(|w| w.one_off_chat)
            .expect("expected quick-chat workspace created on submit");
        let qc_id = qc_ws.id.clone();
        assert_eq!(state.landing_workspace_id.as_deref(), Some(qc_id.as_str()));
        assert!(state.services.emitted_native_commands.iter().any(|cmd| {
            matches!(
                cmd,
                NativeCommand::StartWorkspaceServer { workspace_id, .. } if workspace_id == &qc_id
            )
        }));
        let start_ws = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest {
                    workspace_id,
                    method,
                    ..
                } if method == "thread/start" => Some(workspace_id.clone()),
                _ => None,
            });
        assert_eq!(start_ws.as_deref(), Some(qc_id.as_str()));
    }

    #[test]
    fn thread_start_response_preserves_reasoning_effort() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));
        state.active_workspace_id = Some("ws-1".to_string());

        state.dispatch(Action::Chat(ChatAction::SetComposerDraftEffort {
            key: "__new__".to_string(),
            effort: Some(ReasoningEffortValue::High),
        }));
        state.dispatch(Action::Chat(ChatAction::SendMessage {
            thread_id: None,
            text: "First draft".to_string(),
            busy_policy: ThreadBusyPolicy::Steer,
            attachments: Vec::new(),
            references: Vec::new(),
        }));
        let rpc_id = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest {
                    request_id: id,
                    method,
                    ..
                } if method == "thread/start" => Some(*id),
                _ => None,
            })
            .expect("expected thread/start request");

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: rpc_id,
            method: "thread/start".to_string(),
            result: Ok(json!({
                "thread": {
                    "id": "th-server-1",
                    "title": "First draft"
                }
            })),
        });
        let th1 = state
            .threads
            .iter()
            .find(|t| t.id == "th-server-1")
            .expect("expected server thread");
        assert_eq!(th1.reasoning_effort.as_deref(), Some("high"));

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 888,
            method: "thread/start".to_string(),
            result: Ok(json!({
                "thread": {
                    "id": "th-server-2",
                    "title": "Second",
                    "reasoningEffort": "xhigh"
                }
            })),
        });
        let th2 = state
            .threads
            .iter()
            .find(|t| t.id == "th-server-2")
            .expect("expected second server thread");
        assert_eq!(th2.reasoning_effort.as_deref(), Some("xhigh"));
    }

    #[test]
    fn start_provider_auth_and_set_provider_config_respect_method_specs() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 10,
            method: "cowork/provider/authMethods/read".to_string(),
            result: Ok(json!({
                "event": {
                    "type": "provider_auth_methods",
                    "methods": {
                        "anthropic": [
                            { "id": "api_key", "type": "api", "label": "API key" },
                            { "id": "claude-oauth", "type": "oauth", "label": "Claude Pro/Max" }
                        ],
                        "codex-cli": [
                            { "id": "oauth_cli", "type": "oauth", "label": "Codex CLI" }
                        ],
                        "bedrock": [
                            {
                                "id": "aws_profile",
                                "type": "api",
                                "label": "AWS Profile",
                                "fields": [{ "id": "profile", "label": "Profile" }]
                            }
                        ]
                    }
                }
            })),
        });

        state.dispatch(Action::Settings(SettingsAction::StartProviderAuth {
            workspace_id: "ws-1".to_string(),
            provider: "anthropic".to_string(),
        }));
        let auth_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/provider/auth/authorize" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .expect("expected authorize request for anthropic");
        assert_eq!(auth_params["methodId"], "claude-oauth");

        state.dispatch(Action::Settings(SettingsAction::StartProviderAuth {
            workspace_id: "ws-1".to_string(),
            provider: "codex-cli".to_string(),
        }));
        let codex_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/provider/auth/authorize" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(codex_params["methodId"], "oauth_cli");

        state.dispatch(Action::Settings(SettingsAction::SetProviderConfig {
            workspace_id: "ws-1".to_string(),
            provider: "bedrock".to_string(),
            config: json!({ "profile": "prod" }),
        }));
        let bedrock_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/provider/auth/setConfig" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .expect("expected setConfig for bedrock");
        assert_eq!(bedrock_params["methodId"], "aws_profile");

        let before_invalid = state.services.emitted_ws_commands.len();
        state.dispatch(Action::Settings(SettingsAction::SetProviderConfig {
            workspace_id: "ws-1".to_string(),
            provider: "anthropic".to_string(),
            config: json!({ "baseUrl": "https://example.test" }),
        }));
        assert_eq!(state.services.emitted_ws_commands.len(), before_invalid);
        assert_eq!(
            state.last_auth_result.as_ref().and_then(|r| r.get("ok")),
            Some(&json!(false))
        );
    }

    #[test]
    fn retry_failed_turn_preserves_attachments_references_and_tool_retry_lineage() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));
        state.threads.push(ThreadRecord {
            id: "th-1".to_string(),
            workspace_id: "ws-1".to_string(),
            ..Default::default()
        });
        let rt = state
            .thread_runtime_by_id
            .entry("th-1".to_string())
            .or_default();
        rt.feed.push(FeedItem::Message {
            id: "u-1".to_string(),
            role: FeedMessageRole::User,
            content: "Check attachment and skill".to_string(),
            client_message_id: Some("cm-1".to_string()),
            attachments: vec![TurnAttachmentInputPart::UploadedFile {
                filename: "spec.txt".to_string(),
                path: "/tmp/demo/spec.txt".to_string(),
                mime_type: "text/plain".to_string(),
            }],
            references: vec![TurnReference {
                kind: "skill".to_string(),
                name: "rust-review".to_string(),
            }],
            citations: Vec::new(),
            streaming: false,
            timestamp_ms: 1,
        });
        rt.feed.push(FeedItem::Error {
            id: "err-1".to_string(),
            message: "Network timeout".to_string(),
            code: None,
            timestamp_ms: 2,
        });

        state.dispatch(Action::Chat(ChatAction::RetryFailedTurn {
            thread_id: "th-1".to_string(),
        }));
        let retry_full = state
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
            .expect("expected full-turn retry turn/start");
        let parts = retry_full["input"].as_array().expect("multipart input");
        assert!(parts.iter().any(|p| p["type"] == "uploadedFile"));
        assert_eq!(retry_full["references"][0]["name"], "rust-review");
        assert!(retry_full["retry"].is_null());

        state
            .thread_runtime_by_id
            .get_mut("th-1")
            .unwrap()
            .feed
            .push(FeedItem::Tool {
                id: "tool-fail-1".to_string(),
                tool_name: "read_file".to_string(),
                title: None,
                call_id: None,
                status: ToolRunStatus::Failed,
                input: json!({}),
                output: None,
                error: Some("EACCES".to_string()),
                diff: None,
                streaming: false,
                timestamp_ms: 3,
                completed_at_ms: Some(4),
                output_truncated: false,
            });
        state.dispatch(Action::Chat(ChatAction::RetryFailedTurn {
            thread_id: "th-1".to_string(),
        }));
        let retry_tool = state
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
            .expect("expected tool-retry turn/start");
        assert_eq!(retry_tool["input"], HIDDEN_RETRY_TURN_PROMPT);
        assert_eq!(retry_tool["retry"]["toolItemIds"], json!(["tool-fail-1"]));
    }

    #[test]
    fn resolve_server_request_retains_pending_on_failure_and_populates_interaction_errors() {
        let mut state = AppState::default();
        state.apply_store_event(StoreEvent::WsServerRequest {
            workspace_id: "ws-1".to_string(),
            id: JsonRpcLiteId::Number(77),
            method: "item/commandExecution/requestApproval".to_string(),
            params: json!({
                "threadId": "th-1",
                "itemId": "cmd-1",
                "command": "cargo check"
            }),
        });
        assert_eq!(
            state.thread_runtime_by_id["th-1"]
                .pending_interactions
                .len(),
            1
        );

        state.dispatch(Action::Chat(ChatAction::ResolveServerRequest {
            workspace_id: "ws-1".to_string(),
            thread_id: "th-1".to_string(),
            id: JsonRpcLiteId::Number(77),
            response: cowork_protocol::ServerRequestReceiptResponse::Approval { approved: true },
        }));
        assert_eq!(
            state.thread_runtime_by_id["th-1"]
                .pending_interactions
                .len(),
            1
        );

        state.apply_store_event(StoreEvent::WsServerResponseResult {
            workspace_id: "ws-1".to_string(),
            request_id: JsonRpcLiteId::Number(77),
            ok: false,
            error: Some("WebSocket write failed".to_string()),
        });
        let rt = &state.thread_runtime_by_id["th-1"];
        assert_eq!(rt.pending_interactions.len(), 1);
        assert_eq!(
            rt.interaction_errors.get("77").map(String::as_str),
            Some("WebSocket write failed")
        );

        state.dispatch(Action::Chat(ChatAction::ResolveServerRequest {
            workspace_id: "ws-1".to_string(),
            thread_id: "th-1".to_string(),
            id: JsonRpcLiteId::Number(77),
            response: cowork_protocol::ServerRequestReceiptResponse::Approval { approved: true },
        }));
        assert!(
            state.thread_runtime_by_id["th-1"]
                .interaction_errors
                .is_empty()
        );

        state.apply_store_event(StoreEvent::WsServerResponseResult {
            workspace_id: "ws-1".to_string(),
            request_id: JsonRpcLiteId::Number(77),
            ok: true,
            error: None,
        });
        assert!(
            state.thread_runtime_by_id["th-1"]
                .pending_interactions
                .is_empty()
        );
    }

    #[test]
    fn restore_backup_checkpoint_and_diagnostics_actions_emit_expected_commands() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));

        state.dispatch(Action::Settings(SettingsAction::RestoreBackupCheckpoint {
            workspace_id: "ws-1".to_string(),
            target_session_id: "sess-1".to_string(),
            checkpoint_id: None,
        }));
        let restore_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/backups/workspace/restore" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(restore_params["targetSessionId"], "sess-1");
        assert!(restore_params.get("checkpointId").is_none());

        let bundle = DiagnosticsBundleState {
            path: "/tmp/diag.json".to_string(),
            created_at: "2026-11-15T00:00:00Z".to_string(),
            summary: "ok".to_string(),
            upload_configured: true,
            upload_enabled: true,
            ..Default::default()
        };
        state.apply_store_event(StoreEvent::DiagnosticsBundleUpdated(Some(bundle.clone())));
        assert_eq!(state.diagnostics_bundle, Some(bundle));

        state.dispatch(Action::Settings(SettingsAction::OpenLogsFolder));
        state.dispatch(Action::Settings(SettingsAction::UploadDiagnosticsBundle {
            path: None,
            confirmed: true,
        }));
        state.dispatch(Action::Settings(SettingsAction::RevokeAllTrustedPhones));
        assert!(
            state
                .services
                .emitted_native_commands
                .iter()
                .any(|c| matches!(c, NativeCommand::OpenLogsFolder))
        );
        assert!(
            state
                .services
                .emitted_native_commands
                .iter()
                .any(|c| matches!(
                    c,
                    NativeCommand::UploadDiagnosticsBundle {
                        path: Some(p),
                        confirmed: true,
                    } if p == "/tmp/diag.json"
                ))
        );
        assert!(
            state
                .services
                .emitted_native_commands
                .iter()
                .any(|c| matches!(c, NativeCommand::RevokeAllTrustedPhones))
        );
    }

    #[test]
    fn agent_profiles_and_memory_schemas_match_server() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 1,
            method: "cowork/agentProfiles/catalog/read".to_string(),
            result: Ok(json!({
                "event": {
                    "type": "agent_profiles_catalog",
                    "sessionId": "s-1",
                    "catalog": {
                        "profiles": [
                            {
                                "scope": "global",
                                "builtIn": false,
                                "locked": false,
                                "effective": true,
                                "shadowed": false,
                                "workspaceDisabled": true,
                                "profile": {
                                    "version": 1,
                                    "id": "reviewer",
                                    "displayName": "Code Reviewer",
                                    "description": "Checks correctness",
                                    "enabled": true,
                                    "baseRole": "reviewer",
                                    "prompt": "Review carefully.",
                                    "allowedBuiltInTools": ["read_file"],
                                    "allowedMcpServers": ["github"],
                                    "skillNames": ["rust-audit"],
                                    "model": "anthropic/claude-sonnet-4-5",
                                    "reasoningEffort": "high"
                                }
                            }
                        ],
                        "effectiveProfiles": [],
                        "diagnostics": [
                            {
                                "scope": "workspace",
                                "path": "/tmp/demo/.cowork/agent-profiles/bad.json",
                                "severity": "warning",
                                "message": "Invalid profile JSON"
                            }
                        ],
                        "roots": {
                            "globalDir": "/tmp/.cowork/agent-profiles",
                            "workspaceDir": "/tmp/demo/.cowork/agent-profiles"
                        }
                    }
                }
            })),
        });

        assert_eq!(state.agent_profiles_catalog.profiles.len(), 1);
        assert_eq!(
            state.agent_profiles_catalog.profiles[0].workspace_disabled,
            Some(true)
        );
        assert_eq!(state.agent_profiles_catalog.diagnostics.len(), 1);
        assert_eq!(
            state
                .agent_profiles_catalog
                .roots
                .as_ref()
                .map(|r| r.workspace_dir.as_str()),
            Some("/tmp/demo/.cowork/agent-profiles")
        );
        assert_eq!(state.subagents.len(), 1);
        assert_eq!(state.subagents[0].name, "Code Reviewer");
        assert_eq!(state.subagents[0].scope.as_deref(), Some("global"));
        assert_eq!(state.subagents[0].tool_preset.as_deref(), Some("reviewer"));

        state.dispatch(Action::Settings(SettingsAction::UpsertAgentProfile {
            workspace_id: "ws-1".to_string(),
            input: AgentProfileUpsertInputWire {
                scope: "workspace".to_string(),
                id: "auditor".to_string(),
                display_name: "Security Auditor".to_string(),
                description: "Finds security issues".to_string(),
                enabled: true,
                base_role: "explorer".to_string(),
                prompt: "Audit carefully".to_string(),
                allowed_built_in_tools: vec!["read_file".to_string()],
                allowed_mcp_servers: vec![],
                skill_names: vec!["sec".to_string()],
                model: None,
                reasoning_effort: Some("medium".to_string()),
                default_task_type: None,
                default_context_mode: None,
            },
        }));
        let upsert_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/agentProfiles/upsert" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(upsert_params["profile"]["version"], 1);
        assert_eq!(upsert_params["profile"]["displayName"], "Security Auditor");
        assert_eq!(upsert_params["profile"]["baseRole"], "explorer");
        assert!(upsert_params["profile"].get("model").is_none());

        state.dispatch(Action::Settings(
            SettingsAction::SetAgentProfileWorkspaceAvailability {
                workspace_id: "ws-1".to_string(),
                id: "reviewer".to_string(),
                disabled: false,
            },
        ));
        let avail_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/agentProfiles/workspaceAvailability/set" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(avail_params["id"], "reviewer");
        assert_eq!(avail_params["disabled"], false);

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 2,
            method: "cowork/memory/list".to_string(),
            result: Ok(json!({
                "event": {
                    "type": "memory_list",
                    "scope": null,
                    "memories": [
                        {
                            "id": "mem-ws",
                            "scope": "workspace",
                            "content": "Use Bun in this repo",
                            "createdAt": "2026-11-15T00:00:00Z",
                            "updatedAt": "2026-11-15T01:00:00Z"
                        },
                        {
                            "id": "mem-user",
                            "scope": "user",
                            "content": "Prefer concise answers",
                            "createdAt": "2026-11-15T00:00:00Z",
                            "updatedAt": "2026-11-15T02:00:00Z"
                        }
                    ]
                }
            })),
        });
        assert_eq!(state.scoped_memories.len(), 2);
        assert_eq!(state.memory_entries.len(), 2);
        assert_eq!(state.memory_entries[0].key, "mem-ws");
        assert!(state.memory_entries[0].updated_at.is_some());

        // Scoped list for "user" updates user entries without dropping workspace entries.
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 3,
            method: "cowork/memory/list".to_string(),
            result: Ok(json!({
                "event": {
                    "type": "memory_list",
                    "scope": "user",
                    "memories": [
                        {
                            "id": "mem-user",
                            "scope": "user",
                            "content": "Updated user preference",
                            "createdAt": "2026-11-15T00:00:00Z",
                            "updatedAt": "2026-11-15T03:00:00Z"
                        }
                    ]
                }
            })),
        });
        assert_eq!(state.scoped_memories.len(), 2);
        assert!(state.scoped_memories.iter().any(|m| m.id == "mem-ws"));

        state.dispatch(Action::Settings(SettingsAction::UpsertMemory {
            workspace_id: "ws-1".to_string(),
            key: "mem-user".to_string(),
            content: "New user memory".to_string(),
        }));
        let mem_upsert = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/memory/upsert" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(mem_upsert["scope"], "user");
        assert_eq!(mem_upsert["mode"], "upsert");
        assert_eq!(mem_upsert["id"], "mem-user");
    }

    #[test]
    fn plugins_skills_and_mcp_schemas_match_server() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));

        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 10,
            method: "cowork/plugins/catalog/read".to_string(),
            result: Ok(json!({
                "event": {
                    "type": "plugins_catalog",
                    "sessionId": "s-1",
                    "catalog": {
                        "plugins": [
                            {
                                "id": "plug-a",
                                "name": "plug-a",
                                "displayName": "Plugin Alpha",
                                "description": "Tools for alpha",
                                "scope": "user",
                                "discoveryKind": "marketplace",
                                "installed": true,
                                "enabled": true,
                                "version": "1.2.0",
                                "updateAvailable": null,
                                "skills": [{ "name": "alpha-skill" }],
                                "mcpServers": ["alpha-mcp"],
                                "apps": [],
                                "warnings": []
                            }
                        ],
                        "availablePlugins": [
                            {
                                "id": "plug-b",
                                "name": "plug-b",
                                "displayName": "Plugin Beta"
                            }
                        ],
                        "warnings": ["partial refresh"]
                    }
                }
            })),
        });
        assert_eq!(state.plugins.len(), 1);
        assert_eq!(state.plugins[0].name, "Plugin Alpha");
        assert_eq!(state.plugins[0].scope.as_deref(), Some("user"));
        assert_eq!(state.plugins[0].skill_count, 1);
        assert_eq!(state.plugins[0].mcp_count, 1);
        assert_eq!(state.available_plugins.len(), 1);
        assert_eq!(state.plugin_catalog_warnings, vec!["partial refresh"]);

        // Scoped plugin disable inherits "user" scope from parsed plugin summary.
        state.dispatch(Action::Settings(SettingsAction::SetPluginEnabled {
            workspace_id: "ws-1".to_string(),
            id: "plug-a".to_string(),
            enabled: false,
        }));
        let plugin_disable = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/plugins/disable" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(plugin_disable["pluginId"], "plug-a");
        assert_eq!(plugin_disable["scope"], "user");

        // Plugin mutation multi-event array updates plugins, skills_catalog, and mcp_servers together.
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 11,
            method: "cowork/plugins/disable".to_string(),
            result: Ok(json!({
                "events": [
                    {
                        "type": "plugins_catalog",
                        "catalog": {
                            "plugins": [
                                {
                                    "id": "plug-a",
                                    "name": "plug-a",
                                    "displayName": "Plugin Alpha",
                                    "description": "Tools for alpha",
                                    "scope": "user",
                                    "enabled": false,
                                    "skills": [],
                                    "mcpServers": [],
                                    "warnings": []
                                }
                            ],
                            "availablePlugins": [],
                            "warnings": []
                        }
                    },
                    {
                        "type": "skills_catalog",
                        "catalog": {
                            "scopes": [{ "scope": "workspace", "writable": true, "readable": true }],
                            "installations": [
                                {
                                    "installationId": "inst-1",
                                    "name": "custom-skill",
                                    "description": "Custom skill",
                                    "scope": "user",
                                    "enabled": true,
                                    "diagnostics": []
                                }
                            ],
                            "effectiveSkills": [
                                {
                                    "installationId": "inst-1",
                                    "name": "custom-skill",
                                    "description": "Custom skill",
                                    "scope": "user",
                                    "enabled": true,
                                    "diagnostics": []
                                }
                            ],
                            "availableSkills": [{ "id": "avail-1", "name": "avail-skill" }]
                        }
                    },
                    {
                        "type": "mcp_servers",
                        "userServers": [
                            {
                                "name": "github",
                                "transport": "http",
                                "enabled": true
                            }
                        ],
                        "workspaceServers": []
                    }
                ]
            })),
        });
        assert!(!state.plugins[0].enabled);
        assert_eq!(state.skill_installations.len(), 1);
        assert_eq!(state.available_skills.len(), 1);
        assert_eq!(state.skills.len(), 1);
        assert_eq!(state.skills[0].installation_id.as_deref(), Some("inst-1"));
        assert_eq!(state.mcp_servers.len(), 1);
        assert_eq!(state.mcp_servers[0].source.as_deref(), Some("user"));

        state.dispatch(Action::Settings(SettingsAction::UpsertScopedMcpServer {
            workspace_id: "ws-1".to_string(),
            name: "github-enterprise".to_string(),
            source: "user".to_string(),
            previous_name: Some("github".to_string()),
            server: json!({ "transport": { "type": "http", "url": "https://example.com" } }),
        }));
        let mcp_upsert = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/mcp/server/upsert" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(mcp_upsert["source"], "user");
        assert_eq!(mcp_upsert["previousName"], "github");
        assert_eq!(mcp_upsert["server"]["name"], "github-enterprise");
    }

    #[test]
    fn child_routing_defaults_subagent_colon_delimiter_and_partial_catalogs() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));

        // 1. UpdateWorkspaceDefaults syncs child model routing fields + remaps server keys.
        state.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
            workspace_id: "ws-1".to_string(),
            defaults: json!({
                "defaultChildModelRoutingMode": "custom",
                "defaultPreferredChildModel": "claude-haiku-4-5",
                "defaultPreferredChildModelRef": "anthropic:claude-haiku-4-5",
                "defaultAllowedChildModelRefs": ["anthropic:claude-haiku-4-5", "openai:gpt-4.1-mini"],
                "defaultBackupsEnabled": false
            }),
        }));
        let params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/session/defaults/apply" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(params["config"]["childModelRoutingMode"], "custom");
        assert_eq!(params["config"]["preferredChildModel"], "claude-haiku-4-5");
        assert_eq!(
            params["config"]["preferredChildModelRef"],
            "anthropic:claude-haiku-4-5"
        );
        assert_eq!(
            params["config"]["allowedChildModelRefs"],
            json!(["anthropic:claude-haiku-4-5", "openai:gpt-4.1-mini"])
        );
        assert_eq!(params["config"]["backupsEnabled"], false);
        assert!(
            params["config"]
                .get("defaultPreferredChildModelRef")
                .is_none()
        );
        let ws = state.workspaces.iter().find(|w| w.id == "ws-1").unwrap();
        assert_eq!(
            ws.default_child_model_routing_mode.as_deref(),
            Some("custom")
        );
        assert_eq!(
            ws.default_preferred_child_model.as_deref(),
            Some("claude-haiku-4-5")
        );
        assert_eq!(
            ws.default_preferred_child_model_ref.as_deref(),
            Some("anthropic:claude-haiku-4-5")
        );
        assert_eq!(
            ws.default_allowed_child_model_refs,
            vec![
                "anthropic:claude-haiku-4-5".to_string(),
                "openai:gpt-4.1-mini".to_string()
            ]
        );
        assert!(!ws.default_backups_enabled);

        // Incoming session_config syncs updated defaults back onto WorkspaceRecord.
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "cowork/controlEvent".to_string(),
            params: json!({
                "event": {
                    "type": "session_config",
                    "config": {
                        "childModelRoutingMode": "inherit",
                        "preferredChildModel": "gpt-4.1",
                        "preferredChildModelRef": "openai:gpt-4.1",
                        "allowedChildModelRefs": ["openai:gpt-4.1"],
                        "backupsEnabled": true
                    }
                }
            }),
        });
        let ws = state.workspaces.iter().find(|w| w.id == "ws-1").unwrap();
        assert_eq!(
            ws.default_child_model_routing_mode.as_deref(),
            Some("inherit")
        );
        assert_eq!(ws.default_preferred_child_model.as_deref(), Some("gpt-4.1"));
        assert_eq!(
            ws.default_preferred_child_model_ref.as_deref(),
            Some("openai:gpt-4.1")
        );
        assert_eq!(
            ws.default_allowed_child_model_refs,
            vec!["openai:gpt-4.1".to_string()]
        );
        assert!(ws.default_backups_enabled);

        // 2. Colon provider delimiter parsing + UpsertSubagent preservation of existing fields.
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 21,
            method: "cowork/agentProfiles/catalog/read".to_string(),
            result: Ok(json!({
                "event": {
                    "type": "agent_profiles_catalog",
                    "catalog": {
                        "profiles": [
                            {
                                "scope": "workspace",
                                "builtIn": false,
                                "locked": false,
                                "effective": true,
                                "shadowed": false,
                                "profile": {
                                    "version": 1,
                                    "id": "reviewer",
                                    "displayName": "Reviewer",
                                    "description": "Review code",
                                    "enabled": false,
                                    "baseRole": "reviewer",
                                    "prompt": "Old prompt",
                                    "allowedBuiltInTools": ["read_file"],
                                    "allowedMcpServers": ["github"],
                                    "skillNames": ["rust-audit"],
                                    "model": "anthropic:claude-sonnet-4-5"
                                }
                            },
                            {
                                "scope": "workspace",
                                "effective": true,
                                "shadowed": false,
                                "profile": {
                                    "version": 1,
                                    "id": "local-ollama",
                                    "displayName": "Local",
                                    "description": "",
                                    "enabled": true,
                                    "baseRole": "worker",
                                    "prompt": "",
                                    "allowedBuiltInTools": [],
                                    "allowedMcpServers": [],
                                    "skillNames": [],
                                    "model": "llama3:8b"
                                }
                            }
                        ]
                    }
                }
            })),
        });
        assert_eq!(state.subagents[0].provider.as_deref(), Some("anthropic"));
        assert_eq!(state.subagents[1].provider, None);

        let mut updated = state.subagents[0].clone();
        updated.system_prompt = "New prompt".to_string();
        state.dispatch(Action::Settings(SettingsAction::UpsertSubagent {
            workspace_id: "ws-1".to_string(),
            profile: updated,
        }));
        let subagent_upsert = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/agentProfiles/upsert" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(subagent_upsert["profile"]["enabled"], false);
        assert_eq!(
            subagent_upsert["profile"]["allowedMcpServers"],
            json!(["github"])
        );
        assert_eq!(
            subagent_upsert["profile"]["skillNames"],
            json!(["rust-audit"])
        );

        // 3. Partial marketplace responses preserve un-installed entries.
        state.available_plugins = vec![json!({ "id": "plug-a" }), json!({ "id": "plug-keep" })];
        state.available_skills = vec![
            json!({ "name": "skill-a" }),
            json!({ "name": "skill-keep" }),
        ];
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: 22,
            method: "cowork/plugins/install".to_string(),
            result: Ok(json!({
                "events": [
                    {
                        "type": "plugins_catalog",
                        "availablePluginsPartial": true,
                        "catalog": {
                            "plugins": [{ "id": "plug-a", "name": "plug-a" }],
                            "availablePlugins": [],
                            "warnings": []
                        }
                    },
                    {
                        "type": "skills_catalog",
                        "availableSkillsPartial": true,
                        "catalog": {
                            "scopes": [],
                            "installations": [{ "installationId": "i1", "name": "skill-a" }],
                            "effectiveSkills": [],
                            "availableSkills": []
                        }
                    }
                ]
            })),
        });
        assert_eq!(state.available_plugins, vec![json!({ "id": "plug-keep" })]);
        assert_eq!(
            state.available_skills,
            vec![json!({ "name": "skill-keep" })]
        );

        // 4. Clearing memory/skill/toolCalling defaults strips both desktop & server keys.
        state.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
            workspace_id: "ws-1".to_string(),
            defaults: json!({
                "memoryGenerationModel": "openai:gpt-4.1-mini",
                "skillImprovementModel": "anthropic:claude-sonnet-4-5",
                "defaultToolCalling": { "enabled": true }
            }),
        }));
        {
            let ws = state.workspaces.iter().find(|w| w.id == "ws-1").unwrap();
            assert_eq!(ws.defaults["memoryGenerationModel"], "openai:gpt-4.1-mini");
            assert_eq!(
                ws.defaults["defaultMemoryGenerationModel"],
                "openai:gpt-4.1-mini"
            );
            assert_eq!(
                ws.defaults["skillImprovementModel"],
                "anthropic:claude-sonnet-4-5"
            );
            assert_eq!(ws.defaults["toolCalling"]["enabled"], true);
        }
        state.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
            workspace_id: "ws-1".to_string(),
            defaults: json!({
                "clearMemoryGenerationModel": true,
                "clearSkillImprovementModel": true,
                "clearToolCalling": true
            }),
        }));
        {
            let ws = state.workspaces.iter().find(|w| w.id == "ws-1").unwrap();
            for cleared_key in [
                "memoryGenerationModel",
                "defaultMemoryGenerationModel",
                "clearMemoryGenerationModel",
                "skillImprovementModel",
                "defaultSkillImprovementModel",
                "clearSkillImprovementModel",
                "toolCalling",
                "defaultToolCalling",
                "clearToolCalling",
            ] {
                assert!(
                    ws.defaults.get(cleared_key).is_none(),
                    "expected {cleared_key} cleared from ws.defaults"
                );
            }
        }
        let clear_defaults_req = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/session/defaults/apply" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            clear_defaults_req["config"]["clearMemoryGenerationModel"],
            json!(true)
        );
        assert_eq!(
            clear_defaults_req["config"]["clearSkillImprovementModel"],
            json!(true)
        );
        assert_eq!(
            clear_defaults_req["config"]["clearToolCalling"],
            json!(true)
        );
    }

    #[test]
    fn ws_server_response_result_clears_ask_buffers_only_on_ok() {
        let mut state = AppState::default();
        let req_id = JsonRpcLiteId::String("ask-req-1".to_string());
        state.thread_runtime_by_id.insert(
            "th-1".to_string(),
            ThreadRuntime {
                pending_interactions: vec![ChatInteraction::UserInput {
                    request_id: req_id.clone(),
                    item_id: "item-ask-1".to_string(),
                    questions: json!([{
                        "id": "q1",
                        "question": "Pick one",
                        "options": ["A", "B"],
                    }]),
                }],
                ..Default::default()
            },
        );
        state
            .chat_ui
            .ask_active_question_idx
            .insert("ask-req-1".to_string(), 1);
        state.chat_ui.ask_text_edits.insert(
            "ask-req-1:q1".to_string(),
            rune::TextEdit::new("custom draft"),
        );
        state
            .chat_ui
            .ask_selected_options
            .insert("ask-req-1:q1".to_string(), vec!["A".to_string()]);

        state.apply_store_event(StoreEvent::WsServerResponseResult {
            workspace_id: "ws-1".to_string(),
            request_id: req_id.clone(),
            ok: false,
            error: Some("Disconnected".to_string()),
        });
        assert_eq!(
            state.chat_ui.ask_active_question_idx.get("ask-req-1"),
            Some(&1)
        );
        assert_eq!(
            state
                .chat_ui
                .ask_text_edits
                .get("ask-req-1:q1")
                .map(|te| te.text.as_str()),
            Some("custom draft")
        );

        state.apply_store_event(StoreEvent::WsServerResponseResult {
            workspace_id: "ws-1".to_string(),
            request_id: req_id,
            ok: true,
            error: None,
        });
        assert!(
            !state
                .chat_ui
                .ask_active_question_idx
                .contains_key("ask-req-1")
        );
        assert!(!state.chat_ui.ask_text_edits.contains_key("ask-req-1:q1"));
        assert!(
            !state
                .chat_ui
                .ask_selected_options
                .contains_key("ask-req-1:q1")
        );
    }

    #[test]
    fn mcp_server_catalog_entry_preserves_plugin_transport_and_auth() {
        let mut state = AppState::default();
        let evt = json!({
            "type": "mcp_servers",
            "sessionId": "s-1",
            "servers": [
                {
                    "name": "linear",
                    "transport": { "type": "http", "url": "https://mcp.linear.app/mcp" },
                    "enabled": true,
                    "auth": { "type": "oauth" },
                    "source": "plugin",
                    "inherited": false,
                    "authMode": "oauth_pending",
                    "authScope": "user",
                    "authMessage": "Sign in required",
                    "pluginId": "linear@official",
                    "pluginName": "linear",
                    "pluginDisplayName": "Linear",
                    "pluginScope": "user",
                    "authState": { "status": "needs_authorization", "message": "Sign in required" }
                },
                {
                    "name": "broken-sse",
                    "transport": { "type": "sse", "url": "https://example.com/sse" },
                    "enabled": true,
                    "source": "user",
                    "inherited": true,
                    "authMode": "error",
                    "authScope": "user",
                    "authMessage": "Token expired",
                    "authState": { "status": "expired", "message": "Token expired" }
                }
            ]
        });

        state.reduce_cowork_event("ws-1", &evt, 1);
        assert_eq!(state.mcp_servers.len(), 2);

        let linear = &state.mcp_servers[0];
        assert_eq!(linear.name, "linear");
        assert_eq!(linear.transport, "http");
        assert_eq!(linear.source.as_deref(), Some("plugin"));
        assert_eq!(linear.plugin_id.as_deref(), Some("linear@official"));
        assert_eq!(linear.plugin_scope.as_deref(), Some("user"));
        assert_eq!(linear.plugin_display_name.as_deref(), Some("Linear"));
        assert_eq!(linear.auth_mode.as_deref(), Some("oauth_pending"));
        assert_eq!(linear.auth_status.as_deref(), Some("oauth_pending"));
        assert_eq!(linear.auth_message.as_deref(), Some("Sign in required"));
        assert!(!linear.inherited);
        assert_eq!(
            linear
                .config
                .pointer("/transport/url")
                .and_then(Value::as_str),
            Some("https://mcp.linear.app/mcp")
        );

        let broken = &state.mcp_servers[1];
        assert_eq!(broken.transport, "sse");
        assert_eq!(broken.source.as_deref(), Some("user"));
        assert!(broken.inherited);
        assert_eq!(broken.error.as_deref(), Some("Token expired"));
    }

    #[test]
    fn plugin_mcp_actions_forward_plugin_metadata_and_handle_validation_and_auth() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Demo".to_string(),
            path: "/tmp/ws-1".to_string(),
            ..Default::default()
        });
        state.active_workspace_id = Some("ws-1".to_string());
        state
            .workspace_socket_by_id
            .insert("ws-1".to_string(), WsConnectionState::Connected);
        state.reduce_cowork_event(
            "ws-1",
            &json!({
                "type": "mcp_servers",
                "servers": [{
                    "name": "github",
                    "transport": { "type": "http", "url": "https://api.github.com/mcp" },
                    "enabled": true,
                    "source": "plugin",
                    "inherited": false,
                    "authMode": "missing",
                    "authScope": "workspace",
                    "authMessage": "Sign in",
                    "pluginId": "github@corp",
                    "pluginScope": "workspace",
                    "authState": { "status": "not_configured" }
                }]
            }),
            1,
        );

        let before = state.services.emitted_ws_commands.len();
        state.dispatch(Action::Settings(SettingsAction::SetMcpServerEnabled {
            workspace_id: "ws-1".to_string(),
            name: "github".to_string(),
            source: "plugin".to_string(),
            enabled: false,
        }));
        state.dispatch(Action::Settings(SettingsAction::SetMcpServerApiKey {
            workspace_id: "ws-1".to_string(),
            name: "github".to_string(),
            source: "plugin".to_string(),
            api_key: "secret-key".to_string(),
        }));
        state.dispatch(Action::Settings(SettingsAction::ValidateMcpServer {
            workspace_id: "ws-1".to_string(),
            name: "github".to_string(),
            source: "plugin".to_string(),
        }));
        state.dispatch(Action::Settings(SettingsAction::AuthorizeMcpOAuth {
            workspace_id: "ws-1".to_string(),
            name: "github".to_string(),
            source: "plugin".to_string(),
        }));
        state.dispatch(Action::Settings(SettingsAction::CompleteMcpOAuthCallback {
            workspace_id: "ws-1".to_string(),
            name: "github".to_string(),
            source: "plugin".to_string(),
            callback_url: "code-123".to_string(),
        }));

        let sent: Vec<(u64, String, Value)> = state.services.emitted_ws_commands[before..]
            .iter()
            .filter_map(|cmd| match cmd {
                WsCommand::SendRequest {
                    request_id,
                    method,
                    params,
                    ..
                } => Some((*request_id, method.clone(), params.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(sent.len(), 5);
        for (req_id, method, params) in &sent {
            assert_eq!(params["pluginId"], "github@corp", "{method}");
            assert_eq!(params["pluginScope"], "workspace", "{method}");
            if method == "cowork/mcp/server/validate" {
                state.apply_ws_response(
                    "ws-1",
                    *req_id,
                    method,
                    Ok(json!({
                        "event": {
                            "type": "mcp_server_validation",
                            "name": "github",
                            "ok": true,
                            "mode": "http",
                            "message": "3 tools discovered",
                            "toolCount": 3
                        }
                    })),
                );
            } else if method == "cowork/mcp/server/auth/authorize" {
                state.apply_ws_response(
                    "ws-1",
                    *req_id,
                    method,
                    Ok(json!({
                        "event": {
                            "type": "mcp_server_auth_challenge",
                            "name": "github",
                            "challenge": { "method": "manual", "url": "https://github.com/login", "instructions": "Open browser" }
                        }
                    })),
                );
            } else if method == "cowork/mcp/server/auth/callback" {
                state.apply_ws_response(
                    "ws-1",
                    *req_id,
                    method,
                    Ok(json!({
                        "event": {
                            "type": "mcp_server_auth_result",
                            "name": "github",
                            "ok": true,
                            "mode": "oauth",
                            "message": "Connected"
                        }
                    })),
                );
            }
        }

        assert_eq!(
            state
                .mcp_validation_by_server
                .get("github")
                .and_then(|v| v.get("toolCount"))
                .and_then(Value::as_u64),
            Some(3)
        );
        assert_eq!(state.mcp_servers[0].status.as_deref(), Some("connected"));
        assert_eq!(state.mcp_servers[0].auth_status.as_deref(), Some("oauth"));
        assert_eq!(
            state
                .mcp_auth_challenge
                .as_ref()
                .and_then(|v| v.pointer("/challenge/url"))
                .and_then(Value::as_str),
            Some("https://github.com/login")
        );
        assert_eq!(
            state
                .mcp_auth_result
                .as_ref()
                .and_then(|v| v.get("ok"))
                .and_then(Value::as_bool),
            Some(true)
        );

        state.apply_ws_response(
            "ws-1",
            999,
            "cowork/mcp/list",
            Ok(json!({
                "event": {
                    "type": "mcp_servers",
                    "servers": [{
                        "name": "local-mcp",
                        "transport": { "type": "stdio", "command": "npx" },
                        "enabled": true,
                        "source": "workspace",
                        "inherited": false,
                        "authMode": "none",
                        "authScope": "workspace",
                        "authMessage": "",
                        "authState": { "status": "not_configured" }
                    }]
                }
            })),
        );
        assert_eq!(state.mcp_servers.len(), 1);
        assert_eq!(state.mcp_servers[0].name, "local-mcp");
    }

    #[test]
    fn tool_access_catalogs_bootstrap_and_skills_list_preserves_metadata() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Demo".to_string(),
            path: "/tmp/ws-1".to_string(),
            ..Default::default()
        });
        state.active_workspace_id = Some("ws-1".to_string());
        state
            .workspace_socket_by_id
            .insert("ws-1".to_string(), WsConnectionState::Connected);
        state.workspace_runtime_by_id.insert(
            "ws-1".to_string(),
            WorkspaceRuntime {
                server_state: ServerLifecycleState::Running {
                    ws_url: "ws://127.0.0.1:7337/ws".to_string(),
                    port: 7337,
                },
                ..Default::default()
            },
        );

        let before_init = state.services.emitted_ws_commands.len();
        let init_res: InitializeResult = serde_json::from_value(json!({
            "protocolVersion": "1",
            "serverInfo": { "name": "cowork-server" },
            "capabilities": { "experimentalApi": true },
            "transport": { "type": "websocket", "protocolMode": "jsonrpc-lite" }
        }))
        .unwrap();
        state.apply_store_event(StoreEvent::WsInitialized {
            workspace_id: "ws-1".to_string(),
            result: Box::new(init_res),
        });
        let init_methods: Vec<String> = state.services.emitted_ws_commands[before_init..]
            .iter()
            .filter_map(|cmd| match cmd {
                WsCommand::SendRequest { method, .. } => Some(method.clone()),
                _ => None,
            })
            .collect();
        for required in [
            "cowork/plugins/catalog/read",
            "cowork/skills/catalog/read",
            "cowork/marketplaces/read",
            "cowork/mcp/servers/read",
        ] {
            assert!(
                init_methods.iter().any(|m| m == required),
                "WsInitialized must bootstrap {required}"
            );
        }

        let before_nav = state.services.emitted_ws_commands.len();
        state.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
            SettingsPageId::ToolAccess,
        ))));
        let nav_methods: Vec<String> = state.services.emitted_ws_commands[before_nav..]
            .iter()
            .filter_map(|cmd| match cmd {
                WsCommand::SendRequest { method, .. } => Some(method.clone()),
                _ => None,
            })
            .collect();
        for required in [
            "cowork/plugins/catalog/read",
            "cowork/skills/catalog/read",
            "cowork/marketplaces/read",
            "cowork/mcp/servers/read",
        ] {
            assert!(
                nav_methods.iter().any(|m| m == required),
                "Opening Tool Access must refresh {required}"
            );
        }

        state.reduce_cowork_event(
            "ws-1",
            &json!({
                "type": "skills_catalog",
                "catalog": {
                    "installations": [{
                        "installationId": "inst-user-1",
                        "name": "pdf-reader",
                        "scope": "user",
                        "source": "marketplace",
                        "version": "1.2.0"
                    }],
                    "effectiveSkills": [{
                        "id": "sk-pdf",
                        "installationId": "inst-user-1",
                        "name": "pdf-reader",
                        "description": "Reads PDFs",
                        "scope": "user",
                        "enabled": true,
                        "source": "marketplace",
                        "version": "1.2.0"
                    }]
                }
            }),
            1,
        );
        state.reduce_cowork_event(
            "ws-1",
            &json!({
                "type": "skills_list",
                "skills": [{
                    "name": "pdf-reader",
                    "description": "Reads PDFs",
                    "enabled": false
                }]
            }),
            2,
        );
        assert_eq!(state.skills.len(), 1);
        assert_eq!(state.skills[0].scope, "user");
        assert_eq!(
            state.skills[0].installation_id.as_deref(),
            Some("inst-user-1")
        );
        assert_eq!(state.skills[0].source.as_deref(), Some("marketplace"));
        assert_eq!(state.skills[0].version.as_deref(), Some("1.2.0"));
        assert!(!state.skills[0].enabled);
    }

    #[test]
    fn provider_catalog_and_status_parse_live_server_payloads() {
        let mut state = AppState::default();
        state.apply_ws_response(
            "ws-1",
            1,
            "cowork/provider/catalog/read",
            Ok(json!({
                "event": {
                    "type": "provider_catalog",
                    "sessionId": "s-1",
                    "all": [{
                        "id": "openai",
                        "name": "OpenAI",
                        "defaultModel": "gpt-5.4",
                        "state": "ready",
                        "models": [{
                            "id": "gpt-5.4",
                            "displayName": "GPT-5.4",
                            "knowledgeCutoff": "2025-03",
                            "supportsImageInput": true,
                            "reasoning": {
                                "defaultEffort": "medium",
                                "availableEfforts": ["low", "medium", "high"]
                            }
                        }, {
                            "id": "gpt-custom-e2e",
                            "displayName": "Custom E2E",
                            "runtimeOptions": { "source": "custom" }
                        }]
                    }],
                    "default": { "openai": "gpt-5.4" },
                    "connected": ["openai"]
                }
            })),
        );
        assert_eq!(state.provider_catalog.len(), 1);
        assert_eq!(state.provider_catalog[0].id, "openai");
        assert!(state.provider_catalog[0].configured);
        assert_eq!(state.provider_catalog[0].models.len(), 2);
        assert_eq!(state.provider_catalog[0].models[0].name, "GPT-5.4");
        assert!(!state.provider_catalog[0].models[0].custom);
        assert!(state.provider_catalog[0].models[0].enabled);
        assert!(state.provider_catalog[0].models[0].supports_reasoning);
        assert_eq!(state.provider_catalog[0].models[1].id, "gpt-custom-e2e");
        assert!(state.provider_catalog[0].models[1].custom);
        assert_eq!(
            state.provider_catalog[0].models[0].reasoning_efforts,
            vec!["low", "medium", "high"]
        );
        assert_eq!(
            state
                .default_model_by_provider
                .get("openai")
                .map(String::as_str),
            Some("gpt-5.4")
        );

        state.apply_ws_response(
            "ws-1",
            2,
            "cowork/provider/status/refresh",
            Ok(json!({
                "event": {
                    "type": "provider_status",
                    "sessionId": "s-1",
                    "providers": [{
                        "provider": "openai",
                        "authorized": true,
                        "verified": true,
                        "mode": "api_key",
                        "account": null,
                        "message": "Configured via API key",
                        "checkedAt": "2026-01-01T00:00:00Z",
                        "methodId": "api_key",
                        "savedApiKeyMasks": {
                            "exa_api_key": "exa-...tool",
                            "api_key": "sk-...mock"
                        }
                    }, {
                        "provider": "google",
                        "authorized": false,
                        "verified": false,
                        "savedApiKeyMasks": {
                            "exa_api_key": "exa-...only"
                        }
                    }]
                }
            })),
        );
        let statuses = &state.workspace_runtime_by_id["ws-1"].provider_statuses;
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].provider, "openai");
        assert!(statuses[0].connected);
        assert!(statuses[0].healthy);
        assert_eq!(statuses[0].auth_method.as_deref(), Some("api_key"));
        assert_eq!(
            statuses[0].detail.as_deref(),
            Some("Configured via API key")
        );
        assert_eq!(
            statuses[0].saved_api_key_mask.as_deref(),
            Some("sk-...mock")
        );
        assert_eq!(statuses[1].provider, "google");
        assert!(statuses[1].saved_api_key_mask.is_none());
    }

    #[test]
    fn wave2_zoom_window_commands_and_shared_core_swap() {
        let mut main_state = AppState::default();
        assert!((main_state.ui_scale - DEFAULT_UI_SCALE).abs() < f32::EPSILON);

        for _ in 0..20 {
            main_state.dispatch(Action::Shell(ShellAction::ZoomIn));
        }
        assert!((main_state.ui_scale - MAX_UI_SCALE).abs() < f32::EPSILON);

        for _ in 0..25 {
            main_state.apply_store_event(StoreEvent::MenuInvoked("zoom_out".to_string()));
        }
        assert!((main_state.ui_scale - MIN_UI_SCALE).abs() < f32::EPSILON);

        main_state.apply_store_event(StoreEvent::MenuInvoked("reset_zoom".to_string()));
        assert!((main_state.ui_scale - DEFAULT_UI_SCALE).abs() < f32::EPSILON);

        assert_eq!(
            main_state.desktop_settings.quick_chat_shortcut,
            "CommandOrControl+Shift+Space"
        );

        main_state.apply_store_event(StoreEvent::QuickChatToggled);
        main_state.apply_store_event(StoreEvent::MenuInvoked("open_quick_chat".to_string()));
        main_state.apply_store_event(StoreEvent::MenuInvoked("open_utility".to_string()));
        main_state.apply_store_event(StoreEvent::MenuInvoked("tray_click".to_string()));
        assert_eq!(
            main_state.services.emitted_window_commands,
            vec![
                WindowCommand::ToggleQuickChat,
                WindowCommand::OpenQuickChat,
                WindowCommand::OpenUtility,
                WindowCommand::ToggleUtility,
            ]
        );

        let mut quick_state = AppState {
            window_mode: WindowMode::QuickChat,
            nav: NavigationHistory::default(),
            ..Default::default()
        };
        quick_state.composer_edit = TextEdit::new("local draft");
        quick_state.now_secs = 42.0;

        main_state.workspaces.push(WorkspaceRecord {
            id: "ws-shared".to_string(),
            name: "Shared".to_string(),
            path: "/tmp/shared".to_string(),
            ..Default::default()
        });
        main_state.dispatch(Action::Shell(ShellAction::ZoomIn));
        main_state.swap_shared_core(&mut quick_state);

        assert_eq!(quick_state.window_mode, WindowMode::QuickChat);
        assert_eq!(quick_state.composer_edit.text, "local draft");
        assert_eq!(quick_state.now_secs, 42.0);
        assert_eq!(quick_state.workspaces.len(), 1);
        assert!((quick_state.ui_scale - 1.1).abs() < 1e-5);
        assert!(main_state.workspaces.is_empty());

        let initial_quick_snap = quick_state.nav.current().clone();
        quick_state.dispatch(Action::Shell(ShellAction::FocusMainWindow {
            open_new_chat_workspace: Some("ws-shared".to_string()),
            open_thread_id: None,
        }));
        assert_eq!(quick_state.nav.current(), &initial_quick_snap);
        let focus_target = match quick_state.services.emitted_window_commands.last().cloned() {
            Some(WindowCommand::FocusMain {
                open_new_chat_workspace,
                open_thread_id,
            }) => (open_new_chat_workspace, open_thread_id),
            other => panic!("expected WindowCommand::FocusMain, got {other:?}"),
        };
        assert_eq!(focus_target.0.as_deref(), Some("ws-shared"));
        assert_eq!(focus_target.1, None);

        quick_state.swap_shared_core(&mut main_state);
        assert_eq!(main_state.window_mode, WindowMode::Main);
        assert_eq!(main_state.workspaces.len(), 1);
        main_state.apply_main_focus_nav(focus_target.0, focus_target.1);
        assert_eq!(main_state.nav.current().view, ViewId::Chat);
    }

    #[test]
    fn review127_should_open_in_canvas_matches_markdown_text_config_and_excludes_spreadsheets() {
        let mut state = AppState::default();
        assert!(!state.should_open_in_canvas("notes.markdown"));

        state.feature_flags.insert("canvas".to_string(), true);
        for path in [
            "notes.markdown",
            "README.md",
            ".env",
            ".gitignore",
            "Makefile",
            "src/main.rs",
        ] {
            assert!(
                state.should_open_in_canvas(path),
                "expected Canvas support for {path}"
            );
        }
        for path in [
            "budget.xlsx",
            "sheet.xls",
            "deck.pptx",
            "scan.pdf",
            "img.png",
        ] {
            assert!(
                !state.should_open_in_canvas(path),
                "expected native preview (not Canvas) for {path}"
            );
        }
    }

    #[test]
    fn review127_canvas_revision_rpc_guards_in_flight_transient_errors_and_session_expiry() {
        let rev1 = CanvasDocumentRevision {
            modified_at_ms: 100.0,
            change_time_ms: 100.0,
            size: 12,
            fingerprint: "fp-1".to_string(),
        };
        let rev2 = CanvasDocumentRevision {
            modified_at_ms: 200.0,
            change_time_ms: 200.0,
            size: 15,
            fingerprint: "fp-2".to_string(),
        };
        let make_doc =
            |generation: u64, draft: &str, status: CanvasDocumentStatus| CanvasDocumentSession {
                workspace_id: "ws-1".to_string(),
                document_id: "doc-1".to_string(),
                generation,
                path: "/tmp/note.md".to_string(),
                disk_content: "initial".to_string(),
                draft_content: draft.to_string(),
                edit_revision: 1,
                last_saved_edit_revision: 0,
                truncated: false,
                revision: Some(rev1.clone()),
                status,
                last_saved_at_secs: None,
                dirty_since_secs: Some(10.0),
                last_poll_secs: 10.0,
            };

        // 1. Transport error on `/revision` must preserve dirty_since_secs and Ready status.
        let mut state = AppState {
            canvas_document: Some(make_doc(1, "edited", CanvasDocumentStatus::Ready)),
            ..Default::default()
        };
        state.pending_canvas_rpcs.insert(
            7,
            PendingCanvasRpc {
                document_id: "doc-1".to_string(),
                generation: 1,
                edit_revision: 1,
                target_path: None,
            },
        );
        state.apply_canvas_rpc_error(
            7,
            "cowork/workspace/document/revision",
            &WsRpcError {
                code: -32000,
                message: "timeout".to_string(),
                data: None,
            },
        );
        let doc = state.canvas_document.as_ref().expect("doc kept");
        assert_eq!(doc.dirty_since_secs, Some(10.0));
        assert_eq!(doc.status, CanvasDocumentStatus::Ready);

        // 2. Transient `ok: false` response on `/revision` leaves doc intact (not LoadError/Conflict).
        state.apply_canvas_rpc_response(
            8,
            "cowork/workspace/document/revision",
            &json!({
                "ok": false,
                "documentId": "doc-1",
                "generation": 1,
                "error": { "kind": "io_error", "message": "temporary stat failure" }
            }),
        );
        let doc = state.canvas_document.as_ref().expect("doc kept");
        assert_eq!(doc.dirty_since_secs, Some(10.0));
        assert_eq!(doc.status, CanvasDocumentStatus::Ready);

        // 3. `ok: true` with newer revision must be ignored while `Saving` (in_flight guard).
        state.canvas_document = Some(make_doc(1, "edited", CanvasDocumentStatus::Saving));
        state.apply_canvas_rpc_response(
            9,
            "cowork/workspace/document/revision",
            &json!({
                "ok": true,
                "documentId": "doc-1",
                "generation": 1,
                "revision": rev2,
            }),
        );
        assert_eq!(
            state.canvas_document.as_ref().expect("doc kept").status,
            CanvasDocumentStatus::Saving
        );

        // 4. `session_not_found` sets SaveError when dirty, or triggers reload when clean.
        state.canvas_document = Some(make_doc(1, "edited", CanvasDocumentStatus::Ready));
        state.apply_canvas_rpc_response(
            10,
            "cowork/workspace/document/revision",
            &json!({
                "ok": false,
                "documentId": "doc-1",
                "generation": 1,
                "error": { "kind": "session_not_found", "message": "expired" }
            }),
        );
        assert!(matches!(
            state.canvas_document.as_ref().expect("doc kept").status,
            CanvasDocumentStatus::SaveError {
                kind: Some(ref k),
                ..
            } if k == "session_not_found"
        ));

        state.canvas_document = Some(make_doc(1, "initial", CanvasDocumentStatus::Ready));
        state.apply_canvas_rpc_response(
            11,
            "cowork/workspace/document/revision",
            &json!({
                "ok": false,
                "documentId": "doc-1",
                "generation": 1,
                "error": { "kind": "session_not_found", "message": "expired" }
            }),
        );
        let reloaded = state.canvas_document.as_ref().expect("doc reloaded");
        assert!(reloaded.generation > 1);
        assert_eq!(reloaded.status, CanvasDocumentStatus::Loading);
    }

    #[test]
    fn review127_focus_main_window_routes_once_across_quick_chat_and_main() {
        let mut quick = AppState {
            window_mode: WindowMode::QuickChat,
            ..Default::default()
        };
        let mut main = AppState {
            window_mode: WindowMode::Main,
            ..Default::default()
        };
        main.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "One".to_string(),
            path: "/tmp/one".to_string(),
            ..Default::default()
        });
        main.threads.push(ThreadRecord {
            id: "t-1".to_string(),
            workspace_id: "ws-1".to_string(),
            title: "Thread".to_string(),
            ..Default::default()
        });

        main.swap_shared_core(&mut quick);
        let snap_before = quick.nav.current().clone();
        let len_before = quick.nav.len();

        quick.dispatch(Action::Shell(ShellAction::FocusMainWindow {
            open_new_chat_workspace: None,
            open_thread_id: Some("t-1".to_string()),
        }));
        assert_eq!(quick.nav.current(), &snap_before);
        assert_eq!(quick.nav.len(), len_before);

        let (ws_id, thread_id) = match quick.services.emitted_window_commands.pop() {
            Some(WindowCommand::FocusMain {
                open_new_chat_workspace,
                open_thread_id,
            }) => (open_new_chat_workspace, open_thread_id),
            other => panic!("expected FocusMain, got {other:?}"),
        };

        quick.swap_shared_core(&mut main);
        main.apply_main_focus_nav(ws_id, thread_id);
        assert_eq!(main.nav.current().view, ViewId::Chat);
        assert_eq!(main.nav.current().active_thread_id.as_deref(), Some("t-1"));
        assert_eq!(main.active_workspace_id.as_deref(), Some("ws-1"));
    }

    #[test]
    fn review127_per_window_confirm_dialogs_and_scoped_close_guards() {
        let mut main = AppState {
            window_mode: WindowMode::Main,
            ..Default::default()
        };
        let mut quick = AppState {
            window_mode: WindowMode::QuickChat,
            ..Default::default()
        };

        let quick_dialog = ConfirmDialogRequest {
            id: "launchable-open:quick".to_string(),
            title: "Open Script".to_string(),
            message: "Confirm launch".to_string(),
            confirm_label: "Open".to_string(),
            cancel_label: "Cancel".to_string(),
            destructive: true,
        };
        main.set_confirm_dialog_for_window(WindowMode::QuickChat, quick_dialog.clone());
        assert!(main.pending_confirm_dialog.is_none());
        assert_eq!(
            main.services.emitted_window_commands,
            vec![WindowCommand::OpenQuickChat]
        );

        main.swap_shared_core(&mut quick);
        assert!(quick.sync_pending_confirm_dialog_for_window());
        assert_eq!(quick.pending_confirm_dialog.as_ref(), Some(&quick_dialog));
        assert!(!quick.sync_pending_confirm_dialog_for_window());

        // Scoped close guard: streaming/dirty Canvas on Main must not block hiding Utility.
        main.thread_runtime_by_id.insert(
            "t-busy".to_string(),
            ThreadRuntime {
                streaming: true,
                ..Default::default()
            },
        );
        assert!(!main.has_unsaved_or_busy_work_for(WINDOW_UTILITY, false));
        assert!(!main.has_unsaved_or_busy_work_for(WINDOW_QUICK_CHAT, false));
        assert!(main.has_unsaved_or_busy_work_for("main", false));
        assert!(main.has_unsaved_or_busy_work_for(WINDOW_UTILITY, true));

        quick.composer_edit = TextEdit::new("quick draft");
        assert!(quick.has_unsaved_or_busy_work_for(WINDOW_QUICK_CHAT, false));

        // #131: Clean Canvas autosave must clear `has_unsaved_or_busy_work()` even before
        // `chat_ui.canvas` re-syncs, and `CloseCanvasDocument` clears `chat_ui.canvas`.
        main.thread_runtime_by_id.clear();
        main.canvas_document = Some(CanvasDocumentSession {
            workspace_id: "ws-1".to_string(),
            document_id: "doc-1".to_string(),
            generation: 1,
            path: "/tmp/note.md".to_string(),
            disk_content: "saved".to_string(),
            draft_content: "saved".to_string(),
            edit_revision: 1,
            last_saved_edit_revision: 1,
            truncated: false,
            revision: None,
            status: CanvasDocumentStatus::Ready,
            last_saved_at_secs: Some(12.0),
            dirty_since_secs: None,
            last_poll_secs: 12.0,
        });
        main.chat_ui.canvas.sync_session(
            "session\0ws-1\0doc-1",
            "session\0ws-1\0doc-1\x001\0ready",
            1,
            "before-autosave",
            "saved",
            true,
            true,
            false,
        );
        assert!(main.chat_ui.canvas.is_dirty());
        assert!(!main.has_unsaved_or_busy_work());

        main.chat_ui
            .canvas
            .source_edit
            .replace_text("unsynced edit");
        assert!(main.has_unsaved_or_busy_work());
        main.dispatch(Action::Chat(ChatAction::CloseCanvasDocument));
        assert!(main.canvas_document.is_none());
        assert!(main.chat_ui.canvas.synced_doc_identity.is_none());
        assert!(!main.has_unsaved_or_busy_work());
    }

    #[test]
    fn wave2_launchable_confirm_and_window_close_guard_flows() {
        let mut state = AppState::default();
        assert!(!state.has_unsaved_or_busy_work());

        state.composer_edit = TextEdit::new("unsent text");
        assert!(state.has_unsaved_or_busy_work());
        state.composer_edit = TextEdit::new("");
        assert!(!state.has_unsaved_or_busy_work());

        state.thread_runtime_by_id.insert(
            "t-busy".to_string(),
            ThreadRuntime {
                streaming: true,
                ..Default::default()
            },
        );
        assert!(state.has_unsaved_or_busy_work());
        state.thread_runtime_by_id.clear();

        state.dispatch(Action::Native(NativeAction::OpenInDefaultApp(
            "/tmp/script.sh".to_string(),
        )));
        assert!(matches!(
            state.services.emitted_native_commands.last(),
            Some(NativeCommand::OpenInDefaultApp {
                path,
                confirmed: false,
            }) if path == "/tmp/script.sh"
        ));

        state.apply_store_event(StoreEvent::LaunchableFileConfirmRequired {
            path: "/tmp/script.sh".to_string(),
            file_name: "script.sh".to_string(),
        });
        let launch_id = state
            .pending_confirm_dialog
            .as_ref()
            .expect("launchable confirm dialog should open")
            .id
            .clone();
        state.dispatch(Action::Shell(ShellAction::ResolveConfirmDialog {
            id: launch_id,
            confirmed: true,
        }));
        assert!(matches!(
            state.services.emitted_native_commands.last(),
            Some(NativeCommand::OpenInDefaultApp {
                path,
                confirmed: true,
            }) if path == "/tmp/script.sh"
        ));

        state.apply_store_event(StoreEvent::ConfirmWindowClose {
            window_id: "main".to_string(),
            request_id: "req-1".to_string(),
            title: "Unsaved changes".to_string(),
            message: "Close?".to_string(),
        });
        let close_id = state
            .pending_confirm_dialog
            .as_ref()
            .expect("close confirm dialog should open")
            .id
            .clone();
        state.dispatch(Action::Shell(ShellAction::ResolveConfirmDialog {
            id: close_id,
            confirmed: false,
        }));
        assert!(matches!(
            state.services.emitted_native_commands.last(),
            Some(NativeCommand::ResolveWindowClose {
                window_id,
                request_id,
                confirmed: false,
            }) if window_id == "main" && request_id == "req-1"
        ));
    }

    #[test]
    fn wave2_canvas_routing_lifecycle_debounce_poll_conflict_and_self_echo() {
        let mut state = AppState {
            now_secs: 100.0,
            ..Default::default()
        };
        state.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Repo".to_string(),
            path: "/tmp/repo".to_string(),
            ..Default::default()
        });
        state
            .workspace_socket_by_id
            .insert("ws-1".to_string(), crate::ws::WsConnectionState::Connected);

        // Canvas feature flag defaults to false -> Explorer routes markdown to FilePreview.
        assert!(!state.should_open_in_canvas("README.md"));
        state.dispatch(Action::Native(NativeAction::LoadFilePreview {
            workspace_id: "ws-1".to_string(),
            path: "README.md".to_string(),
        }));
        assert!(state.canvas_document.is_none());
        assert!(matches!(
            state.services.emitted_native_commands.last(),
            Some(NativeCommand::ReadFilePreview { path, .. }) if path == "/tmp/repo/README.md"
        ));

        // Enable Canvas flag: text/markdown opens in Canvas, spreadsheets & PDF stay out.
        state.feature_flags.insert("canvas".to_string(), true);
        assert!(state.should_open_in_canvas("README.md"));
        assert!(state.should_open_in_canvas("src/main.rs"));
        assert!(!state.should_open_in_canvas("sheet.xlsx"));
        assert!(!state.should_open_in_canvas("data.csv"));
        assert!(!state.should_open_in_canvas("manual.pdf"));

        // Stale open drops when document closed before response arrives.
        state.dispatch(Action::Native(NativeAction::LoadFilePreview {
            workspace_id: "ws-1".to_string(),
            path: "README.md".to_string(),
        }));
        let Some(WsCommand::SendRequest {
            request_id: stale_open_id,
            method,
            ..
        }) = state.services.emitted_ws_commands.last().cloned()
        else {
            panic!("expected document/open request");
        };
        assert_eq!(method, "cowork/workspace/document/open");
        state.dispatch(Action::Chat(ChatAction::CloseCanvasDocument));
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: stale_open_id,
            method: "cowork/workspace/document/open".to_string(),
            result: Ok(json!({
                "ok": true,
                "document": { "path": "README.md", "content": "stale", "truncated": false }
            })),
        });
        assert!(state.canvas_document.is_none());

        // Fresh open -> Ready with initial revision.
        state.dispatch(Action::Chat(ChatAction::OpenCanvasDocument {
            workspace_id: "ws-1".to_string(),
            path: "README.md".to_string(),
        }));
        let Some(WsCommand::SendRequest {
            request_id: open_id,
            ..
        }) = state.services.emitted_ws_commands.last().cloned()
        else {
            panic!("expected document/open request");
        };
        let doc_id = state.canvas_document.as_ref().unwrap().document_id.clone();
        let doc_gen = state.canvas_document.as_ref().unwrap().generation;
        let rev1 = json!({ "modifiedAtMs": 1000.0, "changeTimeMs": 1000.0, "size": 5, "fingerprint": "fp-1" });
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: open_id,
            method: "cowork/workspace/document/open".to_string(),
            result: Ok(json!({
                "ok": true,
                "document": {
                    "path": "/tmp/repo/README.md",
                    "content": "hello",
                    "truncated": false,
                    "revision": rev1,
                }
            })),
        });
        assert_eq!(
            state.canvas_document.as_ref().unwrap().status,
            CanvasDocumentStatus::Ready
        );
        assert!(!state.has_unsaved_or_busy_work());

        // Self-echo fileChanged with matching revision does NOT schedule a poll.
        let before_cmds = state.services.emitted_ws_commands.len();
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "cowork/workspace/fileChanged".to_string(),
            params: json!({
                "path": "/tmp/repo/README.md",
                "version": rev1,
            }),
        });
        assert_eq!(state.services.emitted_ws_commands.len(), before_cmds);

        // Draft edit sets dirty + schedules 0.6s debounce autosave + marks busy work.
        state.dispatch(Action::Chat(ChatAction::UpdateCanvasDraft {
            document_id: doc_id.clone(),
            generation: doc_gen,
            content: "hello world".to_string(),
        }));
        assert!(state.canvas_document.as_ref().unwrap().dirty());
        assert!(state.has_unsaved_or_busy_work());
        let wake = state.next_canvas_wake_at().expect("wake_at scheduled");
        assert!((wake - (100.0 + CANVAS_AUTOSAVE_DEBOUNCE_SECS)).abs() < 1e-6);

        state.now_secs = 100.0 + CANVAS_AUTOSAVE_DEBOUNCE_SECS;
        assert!(state.drain_events());
        let Some(WsCommand::SendRequest {
            request_id: save_id,
            method: save_method,
            ..
        }) = state.services.emitted_ws_commands.last().cloned()
        else {
            panic!("expected document/save request");
        };
        assert_eq!(save_method, "cowork/workspace/document/save");
        let rev2 = json!({ "modifiedAtMs": 2000.0, "changeTimeMs": 2000.0, "size": 11, "fingerprint": "fp-2" });
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: save_id,
            method: "cowork/workspace/document/save".to_string(),
            result: Ok(json!({
                "ok": true,
                "editRevision": 1,
                "document": {
                    "path": "/tmp/repo/README.md",
                    "content": "hello world",
                    "revision": rev2,
                }
            })),
        });
        assert!(!state.canvas_document.as_ref().unwrap().dirty());
        assert_eq!(
            state.canvas_document.as_ref().unwrap().status,
            CanvasDocumentStatus::Ready
        );

        // SaveAs switches path and triggers workspace file listing refresh.
        state.dispatch(Action::Chat(ChatAction::SaveCanvasDocumentAs {
            path: "/tmp/repo/README-copy.md".to_string(),
        }));
        let Some(WsCommand::SendRequest {
            request_id: save_as_id,
            method: save_as_method,
            ..
        }) = state.services.emitted_ws_commands.last().cloned()
        else {
            panic!("expected document/saveAs request");
        };
        assert_eq!(save_as_method, "cowork/workspace/document/saveAs");
        let rev3 = json!({ "modifiedAtMs": 3000.0, "changeTimeMs": 3000.0, "size": 11, "fingerprint": "fp-3" });
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: save_as_id,
            method: "cowork/workspace/document/saveAs".to_string(),
            result: Ok(json!({
                "ok": true,
                "editRevision": 1,
                "document": {
                    "path": "/tmp/repo/README-copy.md",
                    "content": "hello world",
                    "revision": rev3,
                }
            })),
        });
        assert_eq!(
            state.canvas_document.as_ref().unwrap().path,
            "/tmp/repo/README-copy.md"
        );

        // Revision poll at +1.5s detects external change while dirty -> Conflict.
        state.dispatch(Action::Chat(ChatAction::UpdateCanvasDraft {
            document_id: doc_id,
            generation: doc_gen,
            content: "local unsaved edit".to_string(),
        }));
        state.now_secs = 100.0 + CANVAS_AUTOSAVE_DEBOUNCE_SECS + CANVAS_REVISION_POLL_SECS + 0.1;
        // Simulate save error recovery or pre-autosave dirty conflict by setting status Ready with later dirty_since
        if let Some(doc) = state.canvas_document.as_mut() {
            doc.dirty_since_secs = Some(state.now_secs);
            doc.last_poll_secs = state.now_secs - CANVAS_REVISION_POLL_SECS;
        }
        assert!(state.drain_events());
        let Some(WsCommand::SendRequest {
            request_id: rev_id,
            method: rev_method,
            ..
        }) = state.services.emitted_ws_commands.last().cloned()
        else {
            panic!("expected document/revision request");
        };
        assert_eq!(rev_method, "cowork/workspace/document/revision");
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: rev_id,
            method: "cowork/workspace/document/revision".to_string(),
            result: Ok(json!({
                "ok": true,
                "revision": { "modifiedAtMs": 9999.0, "changeTimeMs": 9999.0, "size": 99, "fingerprint": "fp-99" }
            })),
        });
        assert!(matches!(
            state.canvas_document.as_ref().unwrap().status,
            CanvasDocumentStatus::Conflict { .. }
        ));
    }

    #[test]
    fn wave2_offline_transcript_replay_and_analytics_roundtrip() {
        let mut state = AppState {
            now_secs: 1_700_000_000.0,
            ..Default::default()
        };
        let ws = WorkspaceRecord {
            id: "ws-a".to_string(),
            name: "Alpha".to_string(),
            path: "/tmp/alpha".to_string(),
            ..Default::default()
        };
        state.apply_store_event(StoreEvent::WorkspaceAdded(ws));
        assert!(matches!(
            state.services.emitted_native_commands.last(),
            Some(NativeCommand::TrackAnalyticsEvent { name, properties })
                if name == "workspace_added"
                    && properties.get("workspaceCount") == Some(&json!(1))
                    && properties.get("eventSource") == Some(&json!("renderer"))
        ));

        state.threads.push(ThreadRecord {
            id: "t-1".to_string(),
            workspace_id: "ws-a".to_string(),
            title: "Offline thread".to_string(),
            session_id: Some("sess-1".to_string()),
            ..Default::default()
        });

        // Disconnected HydrateThread falls back to local JSONL transcript read.
        state.dispatch(Action::Chat(ChatAction::HydrateThread("t-1".to_string())));
        let req_id = match state.services.emitted_native_commands.last() {
            Some(NativeCommand::ReadLocalTranscript {
                request_id,
                thread_id,
                candidate_ids,
            }) => {
                assert_eq!(thread_id, "t-1");
                assert_eq!(
                    candidate_ids,
                    &vec!["t-1".to_string(), "sess-1".to_string()]
                );
                request_id.clone()
            }
            other => panic!("expected ReadLocalTranscript, got {other:?}"),
        };

        state.apply_store_event(StoreEvent::LocalTranscriptLoaded {
            request_id: req_id,
            thread_id: "t-1".to_string(),
            result: Ok(vec![
                TranscriptLogEntry {
                    ts: "2026-01-01T00:00:00Z".to_string(),
                    thread_id: "t-1".to_string(),
                    direction: "client".to_string(),
                    payload: json!({
                        "type": "user_message",
                        "clientMessageId": "cm-1",
                        "text": "hello offline",
                    }),
                },
                TranscriptLogEntry {
                    ts: "2026-01-01T00:00:01Z".to_string(),
                    thread_id: "t-1".to_string(),
                    direction: "server".to_string(),
                    payload: json!({
                        "type": "assistant_message",
                        "text": "cached answer",
                    }),
                },
            ]),
        });
        let rt = &state.thread_runtime_by_id["t-1"];
        assert!(rt.hydrated);
        assert!(rt.transcript_only);
        assert_eq!(rt.feed.len(), 2);

        // Live snapshot clears transcript_only.
        state.apply_thread_snapshot_response(
            "ws-a",
            &json!({ "coworkSnapshot": { "sessionId": "t-1", "title": "Live", "lastEventSeq": 1, "events": [] } }),
        );
        assert!(!state.thread_runtime_by_id["t-1"].transcript_only);

        // Analytics state updates & persists in NativeReady / SavePersistedState.
        let analytics_payload = json!({ "distinctId": "anon-1", "optedOut": false });
        state.apply_store_event(StoreEvent::ProductAnalyticsStateUpdated(Some(
            analytics_payload.clone(),
        )));
        assert_eq!(state.product_analytics, Some(analytics_payload.clone()));

        state.dispatch(Action::Native(NativeAction::RemoveWorkspace(
            "ws-a".to_string(),
        )));
        assert!(matches!(
            state
                .services
                .emitted_native_commands
                .iter()
                .rev()
                .find(|c| matches!(c, NativeCommand::TrackAnalyticsEvent { .. })),
            Some(NativeCommand::TrackAnalyticsEvent { name, properties })
                if name == "workspace_removed"
                    && properties.get("workspaceCount") == Some(&json!(0))
                    && properties.get("eventSource") == Some(&json!("renderer"))
        ));
        assert!(matches!(
            state
                .services
                .emitted_native_commands
                .iter()
                .rev()
                .find(|c| matches!(c, NativeCommand::SavePersistedState(_))),
            Some(NativeCommand::SavePersistedState(persisted))
                if persisted.product_analytics == Some(analytics_payload)
        ));
    }

    #[test]
    fn skip_and_complete_onboarding_preserve_distinct_states() {
        let mut state = AppState::default();
        state.dispatch(Action::Shell(ShellAction::CompleteOnboardingStep(
            "step-1".to_string(),
        )));
        state.dispatch(Action::Shell(ShellAction::SkipOnboarding));
        assert!(state.onboarding.dismissed);
        assert!(!state.onboarding.completed);

        state.dispatch(Action::Shell(ShellAction::CompleteOnboarding));
        assert!(state.onboarding.completed);
        assert!(!state.onboarding.dismissed);
        assert!(state.onboarding.completed_steps.contains("step-1"));
    }

    #[test]
    fn persisted_threads_hydrate_on_native_ready_and_survive_early_saves() {
        let mut state = AppState::default();
        let ws_a = WorkspaceRecord::new("ws-a", "Alpha", "/tmp/alpha", 1_700_000_000_000);
        let ws_b = WorkspaceRecord::new("ws-b", "Beta", "/tmp/beta", 1_700_000_000_000);
        let th_a = ThreadRecord {
            id: "th-a".to_string(),
            workspace_id: "ws-a".to_string(),
            title: "Alpha chat".to_string(),
            ..ThreadRecord::default()
        };
        let th_b = ThreadRecord {
            id: "th-b".to_string(),
            workspace_id: "ws-b".to_string(),
            title: "Beta archived".to_string(),
            archived: true,
            updated_at: 1_700_000_050_000,
            ..ThreadRecord::default()
        };
        let orphan = ThreadRecord {
            id: "th-orphan".to_string(),
            workspace_id: "ws-missing".to_string(),
            title: "Orphan".to_string(),
            ..ThreadRecord::default()
        };

        let persisted = PersistedDesktopState {
            workspaces: vec![ws_a, ws_b],
            threads: vec![th_a, th_b, orphan],
            active_workspace_id: Some("ws-a".to_string()),
            ..PersistedDesktopState::default()
        };
        state.apply_store_event(StoreEvent::NativeReady {
            persisted: Box::new(persisted),
            is_packaged: false,
            system_dark: None,
        });

        assert_eq!(state.threads.len(), 2);
        assert_eq!(state.archived_threads.len(), 1);
        assert_eq!(state.archived_threads[0].id, "th-b");

        // Early persist before `thread/list` returns must preserve restored threads.
        state.dispatch(Action::Shell(ShellAction::SkipOnboarding));
        let Some(saved) = state
            .services
            .emitted_native_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                NativeCommand::SavePersistedState(p) => Some(p),
                _ => None,
            })
        else {
            panic!("expected SavePersistedState");
        };
        assert_eq!(saved.threads.len(), 2);

        // Refreshing workspace A keeps workspace B's cached thread intact and persists both.
        state.apply_thread_list_response(
            "ws-a",
            &json!({ "threads": [{ "id": "th-a2", "title": "Fresh A" }] }),
        );
        assert!(state.threads.iter().any(|t| t.id == "th-a2"));
        assert!(state.threads.iter().any(|t| t.id == "th-b"));
        assert!(!state.threads.iter().any(|t| t.id == "th-a"));

        state.dispatch(Action::Native(NativeAction::RemoveWorkspace(
            "ws-b".to_string(),
        )));
        assert!(!state.threads.iter().any(|t| t.workspace_id == "ws-b"));
        assert!(state.archived_threads.is_empty());
    }

    #[test]
    fn wall_clock_timestamps_avoid_epoch_zero_while_wake_delay_stays_relative() {
        let mut state = AppState::default();
        // Even before poll_app initializes `now_secs`, timestamps use system wall clock, not 1970.
        let ms = state.wall_clock_ms();
        assert!(
            ms > 1_700_000_000_000,
            "expected Unix epoch ms > 2023, got {ms}"
        );
        let iso = state.iso_timestamp_now();
        assert!(
            !iso.starts_with("1970-"),
            "timestamp must not land on 1970-01-01: {iso}"
        );

        state.now_secs = 1_750_000_000.0;
        state.app_elapsed_secs = 12.5;
        state
            .workspace_socket_by_id
            .insert("ws-1".to_string(), WsConnectionState::Connected);
        state.canvas_document = Some(CanvasDocumentSession {
            workspace_id: "ws-1".to_string(),
            document_id: "doc-1".to_string(),
            generation: 1,
            path: "README.md".to_string(),
            disk_content: "a".to_string(),
            draft_content: "ab".to_string(),
            edit_revision: 1,
            last_saved_edit_revision: 0,
            truncated: false,
            revision: None,
            status: CanvasDocumentStatus::Ready,
            last_saved_at_secs: None,
            dirty_since_secs: Some(1_750_000_000.0),
            last_poll_secs: 1_750_000_000.0,
        });
        let due = state.next_canvas_wake_at().expect("wake scheduled");
        assert!(due > 1_750_000_000.0);
        let delay = state
            .next_canvas_wake_delay_secs()
            .expect("relative delay scheduled");
        assert!(
            (delay - CANVAS_REVISION_POLL_SECS.min(CANVAS_AUTOSAVE_DEBOUNCE_SECS)).abs() < 1e-6,
            "delay must stay small/relative for tx.wake_at: {delay}"
        );
    }

    #[test]
    fn landing_send_resolves_catalog_model_and_blocks_unconfigured_catalog() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord::new(
            "ws-1",
            "Demo",
            "/tmp/demo",
            1_700_000_000_000,
        ));
        state.active_workspace_id = Some("ws-1".to_string());

        // 1) Loaded catalog with no configured provider blocks sending and preserves text.
        state.provider_catalog = vec![ProviderSummary {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            configured: false,
            models: vec![ProviderModelSummary {
                id: "gpt-5.4".to_string(),
                name: "GPT-5.4".to_string(),
                enabled: true,
                custom: false,
                supports_reasoning: true,
                reasoning_efforts: vec![],
            }],
            ..ProviderSummary::default()
        }];
        state.composer_edit = TextEdit::new("Hello without provider");
        state.dispatch(Action::Chat(ChatAction::SendMessage {
            thread_id: None,
            text: "Hello without provider".to_string(),
            busy_policy: ThreadBusyPolicy::Steer,
            attachments: Vec::new(),
            references: Vec::new(),
        }));
        assert!(state.threads.is_empty());
        assert!(state.services.emitted_ws_commands.is_empty());
        assert_eq!(state.composer_edit.text, "Hello without provider");
        assert!(
            state
                .composer_drafts
                .get("__new__")
                .and_then(|d| d.submission_error.as_deref())
                .is_some()
        );
        assert!(state.toasts.iter().any(|t| t.key == "no-configured-model"));

        // 2) Connected provider with untouched landing draft submits the UI's resolved model.
        state.provider_catalog[0].configured = true;
        state
            .default_model_by_provider
            .insert("openai".to_string(), "gpt-5.4".to_string());
        state.dispatch(Action::Chat(ChatAction::SendMessage {
            thread_id: None,
            text: "Hello with provider".to_string(),
            busy_policy: ThreadBusyPolicy::Steer,
            attachments: Vec::new(),
            references: Vec::new(),
        }));
        let draft = state
            .threads
            .iter()
            .find(|t| t.draft)
            .expect("draft created");
        assert_eq!(draft.provider.as_deref(), Some("openai"));
        assert_eq!(draft.model.as_deref(), Some("gpt-5.4"));
        let start_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. } if method == "thread/start" => {
                    Some(params.clone())
                }
                _ => None,
            })
            .expect("thread/start emitted");
        assert_eq!(start_params.get("provider"), Some(&json!("openai")));
        assert_eq!(start_params.get("model"), Some(&json!("gpt-5.4")));
    }

    #[test]
    fn load_file_preview_non_canvas_closes_context_sidebar() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord::new(
            "ws-1",
            "Demo",
            "/tmp/demo",
            1_700_000_000_000,
        ));
        state.context_sidebar.set_open(true);
        state.shell_ui.right_overlay_open = true;

        state.dispatch(Action::Native(NativeAction::LoadFilePreview {
            workspace_id: "ws-1".to_string(),
            path: "report.pdf".to_string(),
        }));
        assert!(!state.context_sidebar.is_open());
        assert!(!state.shell_ui.right_overlay_open);
    }

    #[test]
    fn defect1_multiwindow_draft_rekey_preserves_main_nav_and_restart_hydrates_active_thread() {
        let mut main_state = AppState::default();
        let ws = WorkspaceRecord::new("ws-1", "Workspace", "/tmp/ws-1", 1);
        main_state.workspaces.push(ws.clone());
        main_state.active_workspace_id = Some("ws-1".to_string());
        main_state.provider_catalog = vec![ProviderSummary {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            configured: true,
            models: vec![ProviderModelSummary {
                id: "gpt-5.4".to_string(),
                name: "GPT-5.4".to_string(),
                enabled: true,
                custom: false,
                supports_reasoning: true,
                reasoning_efforts: vec![],
            }],
            ..ProviderSummary::default()
        }];
        main_state
            .default_model_by_provider
            .insert("openai".to_string(), "gpt-5.4".to_string());

        // Main submits from landing -> creates optimistic __draft-1 in Main.nav.
        main_state.dispatch(Action::Chat(ChatAction::SendMessage {
            thread_id: None,
            text: "Hello from landing".to_string(),
            busy_policy: ThreadBusyPolicy::Steer,
            attachments: Vec::new(),
            references: Vec::new(),
        }));
        let draft_id = main_state
            .nav
            .current()
            .active_thread_id
            .clone()
            .expect("draft active_thread_id on Main");
        assert!(draft_id.starts_with("__draft-"));
        let start_rpc_id = main_state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest {
                    request_id, method, ..
                } if method == "thread/start" => Some(*request_id),
                _ => None,
            })
            .expect("thread/start emitted");

        // Even if another window shares core during thread/start response + persist,
        // reconciling on Main must promote Main.nav to server id and keep activeThreadId persisted.
        let mut quick_state = AppState {
            window_mode: WindowMode::QuickChat,
            ..Default::default()
        };
        main_state.swap_shared_core(&mut quick_state);
        quick_state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-1".to_string(),
            request_id: start_rpc_id,
            method: "thread/start".to_string(),
            result: Ok(json!({
                "thread": {
                    "id": "th-srv-1",
                    "title": "New session"
                }
            })),
        });
        // Secondary window persist must NOT wipe persisted_active_thread_id to None.
        quick_state.dispatch(Action::Shell(ShellAction::SetTheme(ThemePreference::Dark)));
        let persisted_after_quick = quick_state
            .services
            .emitted_native_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                NativeCommand::SavePersistedState(p) => Some(p.clone()),
                _ => None,
            })
            .expect("SavePersistedState emitted");

        quick_state.swap_shared_core(&mut main_state);
        assert!(main_state.reconcile_rekeyed_thread_ids());
        assert_eq!(
            main_state.nav.current().active_thread_id.as_deref(),
            Some("th-srv-1")
        );
        assert_eq!(
            main_state.active_thread().map(|t| t.id.as_str()),
            Some("th-srv-1")
        );

        // Quick window theme persist kept None until Main persisted, now Main persists th-srv-1.
        assert_eq!(persisted_after_quick.active_thread_id, None);
        main_state.dispatch(Action::Navigate(NavAction::OpenNewChat {
            workspace_id: Some("ws-1".to_string()),
        }));
        main_state.dispatch(Action::Navigate(NavAction::OpenThread(
            "th-srv-1".to_string(),
        )));
        let persisted_after_main_open = main_state
            .services
            .emitted_native_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                NativeCommand::SavePersistedState(p) => Some(p.clone()),
                _ => None,
            })
            .expect("SavePersistedState after OpenThread");
        assert_eq!(
            persisted_after_main_open.active_thread_id.as_deref(),
            Some("th-srv-1")
        );

        // Simulated restart restores active_thread_id and triggers thread/hydrate on WsInitialized.
        let mut restarted = AppState::default();
        restarted.apply_store_event(StoreEvent::NativeReady {
            persisted: persisted_after_main_open,
            is_packaged: false,
            system_dark: None,
        });
        assert_eq!(
            restarted.nav.current().active_thread_id.as_deref(),
            Some("th-srv-1")
        );
        assert_eq!(restarted.active_workspace_id.as_deref(), Some("ws-1"));
        let init_res: InitializeResult = serde_json::from_value(json!({
            "protocolVersion": "1",
            "serverInfo": { "name": "cowork-server" },
            "capabilities": { "experimentalApi": true },
            "transport": { "type": "websocket", "protocolMode": "jsonrpc-lite" }
        }))
        .unwrap();
        restarted.apply_store_event(StoreEvent::WsStateChanged {
            workspace_id: "ws-1".to_string(),
            state: WsConnectionState::Connected,
        });
        restarted.apply_store_event(StoreEvent::WsInitialized {
            workspace_id: "ws-1".to_string(),
            result: Box::new(init_res),
        });
        assert!(restarted.services.emitted_ws_commands.iter().any(|c| {
            matches!(
                c,
                WsCommand::SendRequest { method, params, .. }
                    if method == "thread/hydrate" && params.get("threadId") == Some(&json!("th-srv-1"))
            )
        }));
    }

    #[test]
    fn defect2_creation_preflight_requeries_on_provider_catalog_model_and_workspace_changes() {
        let mut state = AppState::default();
        let mut ws_a = WorkspaceRecord::new("ws-a", "Alpha", "/tmp/alpha", 1);
        ws_a.default_provider = Some("anthropic".to_string());
        ws_a.default_model = Some("claude-sonnet-4-5".to_string());
        let ws_b = WorkspaceRecord::new("ws-b", "Beta", "/tmp/beta", 1);
        state.workspaces = vec![ws_a, ws_b];
        state.active_workspace_id = Some("ws-a".to_string());

        let init_res: InitializeResult = serde_json::from_value(json!({
            "protocolVersion": "1",
            "serverInfo": { "name": "cowork-server" },
            "capabilities": { "experimentalApi": true },
            "transport": { "type": "websocket", "protocolMode": "jsonrpc-lite" }
        }))
        .unwrap();
        state.apply_store_event(StoreEvent::WsStateChanged {
            workspace_id: "ws-a".to_string(),
            state: WsConnectionState::Connected,
        });
        state.apply_store_event(StoreEvent::WsInitialized {
            workspace_id: "ws-a".to_string(),
            result: Box::new(init_res),
        });
        let first_preflight_id = state.latest_creation_preflight_rpc_id.expect("initial rpc");

        // Catalog update marks OpenAI connected -> automatically re-queries preflight with openai!
        state.apply_provider_catalog_event(&json!({
            "connected": ["openai"],
            "default": { "openai": "gpt-5.4" },
            "all": [{
                "id": "openai",
                "name": "OpenAI",
                "models": [{ "id": "gpt-5.4", "name": "GPT-5.4", "enabled": true }]
            }]
        }));
        let second_preflight_id = state.latest_creation_preflight_rpc_id.expect("updated rpc");
        assert!(second_preflight_id > first_preflight_id);

        // Selecting a different model on landing draft re-queries with that model.
        state.dispatch(Action::Chat(ChatAction::SetComposerDraftModel {
            key: "__new__".to_string(),
            provider: "openai".to_string(),
            model: "gpt-5.4".to_string(),
        }));
        let third_preflight_id = state.latest_creation_preflight_rpc_id.expect("model rpc");
        assert!(third_preflight_id > second_preflight_id);
        let third_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest {
                    request_id,
                    method,
                    params,
                    ..
                } if method == "cowork/creation/preflight" && *request_id == third_preflight_id => {
                    Some(params.clone())
                }
                _ => None,
            })
            .expect("third preflight emitted");
        assert_eq!(third_params.get("provider"), Some(&json!("openai")));
        assert_eq!(third_params.get("model"), Some(&json!("gpt-5.4")));
        assert_eq!(third_params.get("kind"), Some(&json!("chat")));
        assert_eq!(third_params.get("cwd"), Some(&json!("/tmp/alpha")));

        // Stale response from first request must NOT overwrite newer readiness result.
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-a".to_string(),
            request_id: third_preflight_id,
            method: "cowork/creation/preflight".to_string(),
            result: Ok(json!({ "ready": true, "checks": [] })),
        });
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-a".to_string(),
            request_id: first_preflight_id,
            method: "cowork/creation/preflight".to_string(),
            result: Ok(json!({
                "ready": false,
                "checks": [{ "id": "provider_auth", "status": "blocked", "message": "Stale" }]
            })),
        });
        assert!(
            state
                .workspace_creation_preflight
                .as_ref()
                .is_some_and(|p| p.ready)
        );

        // Switching to Quick Chat landing and Task creation re-queries with expected params.
        state.dispatch(Action::Shell(ShellAction::SelectLandingQuickChat));
        let quick_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/creation/preflight" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .expect("quick preflight");
        assert!(quick_params.get("cwd").is_none() || quick_params["cwd"].is_null());

        state.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Task)));
        let task_params = state
            .services
            .emitted_ws_commands
            .iter()
            .rev()
            .find_map(|c| match c {
                WsCommand::SendRequest { method, params, .. }
                    if method == "cowork/creation/preflight" =>
                {
                    Some(params.clone())
                }
                _ => None,
            })
            .expect("task preflight");
        assert_eq!(task_params.get("kind"), Some(&json!("task")));

        // Successful provider auth mutation triggers catalog + status refresh.
        let before_cmds = state.services.emitted_ws_commands.len();
        state.apply_store_event(StoreEvent::WsResponse {
            workspace_id: "ws-a".to_string(),
            request_id: 901,
            method: "cowork/provider/auth/setApiKey".to_string(),
            result: Ok(json!({ "ok": true })),
        });
        assert!(state.services.emitted_ws_commands[before_cmds..]
            .iter()
            .any(|c| matches!(c, WsCommand::SendRequest { method, .. } if method == "cowork/provider/catalog/read")));
    }

    #[test]
    fn defect4_command_palette_toggle_and_set_open_resets_query_and_selection() {
        let mut state = AppState {
            command_palette_query: "stale query".to_string(),
            command_palette_edit: TextEdit::new("stale query"),
            ..Default::default()
        };
        state.shell_ui.command_palette_selected = 4;

        state.dispatch(Action::Shell(ShellAction::ToggleCommandPalette));
        assert!(state.command_palette_open);
        assert!(state.command_palette_query.is_empty());
        assert!(state.command_palette_edit.text.is_empty());
        assert!(state.command_palette_edit.focused);
        assert_eq!(state.shell_ui.command_palette_selected, 0);

        state.command_palette_query = "another".to_string();
        state.command_palette_edit = TextEdit::new("another");
        state.shell_ui.command_palette_selected = 2;
        state.dispatch(Action::Shell(ShellAction::SetCommandPaletteOpen(false)));
        assert!(!state.command_palette_open);
        assert!(state.command_palette_query.is_empty());
        assert!(state.command_palette_edit.text.is_empty());
        assert!(!state.command_palette_edit.focused);
        assert_eq!(state.shell_ui.command_palette_selected, 0);
    }

    #[test]
    fn defect5_live_escalation_hydration_preserves_user_order_and_parses_snapshot_tool_fields() {
        let mut state = AppState::default();
        state
            .workspaces
            .push(WorkspaceRecord::new("ws-1", "Demo", "/tmp/demo", 1));
        state.threads.push(ThreadRecord {
            id: "th-1".to_string(),
            workspace_id: "ws-1".to_string(),
            title: "Bash thread".to_string(),
            ..ThreadRecord::default()
        });
        state.provider_catalog = vec![ProviderSummary {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            configured: true,
            models: vec![ProviderModelSummary {
                id: "gpt-5.4".to_string(),
                name: "GPT-5.4".to_string(),
                enabled: true,
                custom: false,
                supports_reasoning: true,
                reasoning_efforts: vec![],
            }],
            ..ProviderSummary::default()
        }];
        state
            .default_model_by_provider
            .insert("openai".to_string(), "gpt-5.4".to_string());
        state.dispatch(Action::Navigate(NavAction::OpenThread("th-1".to_string())));

        state.dispatch(Action::Chat(ChatAction::SendMessage {
            thread_id: Some("th-1".to_string()),
            text: "Run pwd".to_string(),
            busy_policy: ThreadBusyPolicy::Steer,
            attachments: Vec::new(),
            references: Vec::new(),
        }));
        // Simulate server projector item/started without clientMessageId, followed by tool & snapshot.
        state.apply_store_event(StoreEvent::WsNotification {
            workspace_id: "ws-1".to_string(),
            method: "item/started".to_string(),
            params: json!({
                "threadId": "th-1",
                "turnId": "turn-1",
                "item": {
                    "id": "u-srv-1",
                    "type": "userMessage",
                    "content": [{ "type": "text", "text": "Run pwd" }]
                }
            }),
        });
        state.apply_thread_snapshot_response(
            "ws-1",
            &json!({
                "coworkSnapshot": {
                    "sessionId": "th-1",
                    "lastEventSeq": 0,
                    "feed": [
                        {
                            "id": "u-srv-1",
                            "kind": "message",
                            "role": "user",
                            "ts": "2026-11-15T12:00:00Z",
                            "text": "Run pwd"
                        },
                        {
                            "id": "tool-1",
                            "kind": "tool",
                            "ts": "2026-11-15T12:00:01Z",
                            "name": "bash",
                            "state": "output-available",
                            "args": { "command": "pwd" },
                            "result": { "stdout": "/tmp/demo" }
                        },
                        {
                            "id": "tool-2",
                            "kind": "tool",
                            "ts": "2026-11-15T12:00:02Z",
                            "name": "write_file",
                            "state": "approval-requested",
                            "args": { "path": "a.txt" }
                        },
                        {
                            "id": "a-srv-1",
                            "kind": "message",
                            "role": "assistant",
                            "ts": "2026-11-15T12:00:03Z",
                            "text": "/tmp/demo"
                        }
                    ]
                }
            }),
        );

        let feed = &state.thread_runtime_by_id["th-1"].feed;
        assert_eq!(feed.len(), 4, "confirmed user message must not duplicate");
        assert!(matches!(
            &feed[0],
            FeedItem::Message {
                role: FeedMessageRole::User,
                content,
                ..
            } if content == "Run pwd"
        ));
        assert!(matches!(
            &feed[1],
            FeedItem::Tool {
                tool_name,
                status: ToolRunStatus::Completed,
                streaming: false,
                input,
                output: Some(out),
                ..
            } if tool_name == "bash" && input["command"] == "pwd" && out["stdout"] == "/tmp/demo"
        ));
        assert!(matches!(
            &feed[2],
            FeedItem::Tool {
                tool_name,
                status: ToolRunStatus::Pending,
                streaming: false,
                ..
            } if tool_name == "write_file"
        ));
        assert!(matches!(
            parse_snapshot_feed_item(&json!({
                "id": "tool-err",
                "kind": "tool",
                "name": "bash",
                "state": "output-error",
                "args": { "command": "false" },
                "result": { "error": "exit 1" }
            })),
            Some(FeedItem::Tool {
                status: ToolRunStatus::Failed,
                error: Some(err),
                ..
            }) if err == "exit 1"
        ));
        assert!(matches!(
            parse_snapshot_feed_item(&json!({
                "id": "tool-den",
                "kind": "tool",
                "name": "bash",
                "state": "output-denied"
            })),
            Some(FeedItem::Tool {
                status: ToolRunStatus::Declined,
                ..
            })
        ));

        // Sending the exact same prompt a second time while an older snapshot (with only the
        // first confirmed "Run pwd") arrives must keep the unpersisted second optimistic message.
        state.dispatch(Action::Chat(ChatAction::SendMessage {
            thread_id: Some("th-1".to_string()),
            text: "Run pwd".to_string(),
            busy_policy: ThreadBusyPolicy::Steer,
            attachments: Vec::new(),
            references: Vec::new(),
        }));
        state.apply_thread_snapshot_response(
            "ws-1",
            &json!({
                "coworkSnapshot": {
                    "sessionId": "th-1",
                    "lastEventSeq": 0,
                    "feed": [
                        {
                            "id": "u-srv-1",
                            "kind": "message",
                            "role": "user",
                            "ts": "2026-11-15T12:00:00Z",
                            "text": "Run pwd"
                        },
                        {
                            "id": "a-srv-1",
                            "kind": "message",
                            "role": "assistant",
                            "ts": "2026-11-15T12:00:03Z",
                            "text": "/tmp/demo"
                        }
                    ]
                }
            }),
        );
        let feed = &state.thread_runtime_by_id["th-1"].feed;
        assert_eq!(
            feed.len(),
            3,
            "repeat optimistic user prompt must be preserved"
        );
        assert!(matches!(
            &feed[2],
            FeedItem::Message {
                id,
                role: FeedMessageRole::User,
                content,
                client_message_id: Some(_),
                ..
            } if id.starts_with("optimistic-") && content == "Run pwd"
        ));
    }

    #[test]
    fn load_presentation_preview_routes_via_rpc_handles_stale_and_file_changed() {
        let mut state = AppState::default();
        state.workspaces.push(WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Repo".to_string(),
            path: "/ws".to_string(),
            ..Default::default()
        });

        // 1) Loading a .pptx deck sets loading presentation state and emits JSON-RPC request.
        state.dispatch(Action::Native(NativeAction::LoadFilePreview {
            workspace_id: "ws-1".to_string(),
            path: "slides/deck.pptx".to_string(),
        }));
        assert!(
            state
                .services
                .emitted_native_commands
                .iter()
                .all(|cmd| !matches!(cmd, NativeCommand::ReadFilePreview { .. })),
            "presentations must not fall back to native ReadFilePreview"
        );
        let (req_1, method_1, params_1) = match state.services.emitted_ws_commands.last() {
            Some(WsCommand::SendRequest {
                request_id,
                method,
                params,
                ..
            }) => (*request_id, method.clone(), params.clone()),
            other => panic!("expected SendRequest, got {other:?}"),
        };
        assert_eq!(method_1, "cowork/workspace/presentation/preview");
        assert_eq!(
            params_1,
            json!({ "cwd": "/ws", "path": "/ws/slides/deck.pptx" })
        );
        let preview = state.active_file_preview.as_ref().expect("preview opened");
        assert_eq!(preview.title, "deck.pptx");
        assert!(preview.error.is_none());
        assert!(preview.presentation.as_ref().is_some_and(|p| p.loading));

        // 2) Switching to another .ppt deck before req_1 finishes ignores late req_1 response.
        state.dispatch(Action::Native(NativeAction::LoadFilePreview {
            workspace_id: "ws-1".to_string(),
            path: "/ws/other.ppt".to_string(),
        }));
        let req_2 = match state.services.emitted_ws_commands.last() {
            Some(WsCommand::SendRequest { request_id, .. }) => *request_id,
            other => panic!("expected second SendRequest, got {other:?}"),
        };
        assert_ne!(req_1, req_2);

        state.apply_ws_response(
            "ws-1",
            req_1,
            "cowork/workspace/presentation/preview",
            Ok(json!({
                "ok": true,
                "slides": [{ "slideIndex": 0, "pngBase64": "data:image/png;base64,AAA=" }],
                "renderingMode": "rendered",
                "warnings": []
            })),
        );
        let current = state.active_file_preview.as_ref().expect("still active");
        assert_eq!(current.path, "/ws/other.ppt");
        assert!(current.presentation.as_ref().is_some_and(|p| p.loading));

        // 3) Valid response for req_2 hydrates presentation slides cleanly.
        state.apply_ws_response(
            "ws-1",
            req_2,
            "cowork/workspace/presentation/preview",
            Ok(json!({
                "ok": true,
                "slides": [
                    { "slideIndex": 0, "title": "Intro", "pngBase64": "data:image/png;base64,BBB=" },
                    { "slideIndex": 1, "title": "End", "pngBase64": "data:image/png;base64,CCC=" }
                ],
                "renderingMode": "text",
                "warnings": ["Text-only fallback"]
            })),
        );
        let current = state.active_file_preview.as_ref().expect("still active");
        let pres = current.presentation.as_ref().expect("presentation data");
        assert!(!pres.loading);
        assert_eq!(pres.slides.len(), 2);
        assert_eq!(pres.rendering_mode.as_deref(), Some("text"));
        assert!(current.error.is_none());

        // 4) Matching cowork/workspace/fileChanged re-fetches presentation preview.
        let before_cmds = state.services.emitted_ws_commands.len();
        state.apply_workspace_file_changed("ws-1", &json!({ "path": "other.ppt" }));
        assert_eq!(state.services.emitted_ws_commands.len(), before_cmds + 1);
        let req_3 = match state.services.emitted_ws_commands.last() {
            Some(WsCommand::SendRequest {
                request_id, method, ..
            }) if method == "cowork/workspace/presentation/preview" => *request_id,
            other => panic!("expected refresh SendRequest, got {other:?}"),
        };
        assert!(
            state
                .active_file_preview
                .as_ref()
                .and_then(|p| p.presentation.as_ref())
                .is_some_and(|p| p.loading)
        );

        // 5) Offline / transport error populates presentation error without workspace/settings noise.
        state.apply_ws_response(
            "ws-1",
            req_3,
            "cowork/workspace/presentation/preview",
            Err(WsRpcError {
                code: -32000,
                message: "Workspace socket offline".to_string(),
                data: None,
            }),
        );
        let current = state.active_file_preview.as_ref().expect("preview kept");
        assert!(current.error.is_none());
        let pres = current.presentation.as_ref().expect("error presentation");
        assert!(!pres.loading);
        assert_eq!(
            pres.error_message.as_deref(),
            Some("Workspace socket offline")
        );
        assert!(state.settings_mutation_error.is_none());
        assert!(
            state
                .workspace_runtime_by_id
                .get("ws-1")
                .is_none_or(|rt| rt.last_error.is_none())
        );
    }

    #[test]
    fn show_menu_bar_defaults_true_and_menu_tx_dispatch_handles_core_commands() {
        assert!(DesktopSettings::default().show_menu_bar);

        let mut legacy_json =
            serde_json::to_value(DesktopSettings::default()).expect("serialize DesktopSettings");
        legacy_json
            .as_object_mut()
            .expect("object")
            .remove("showMenuBar");
        let legacy: DesktopSettings =
            serde_json::from_value(legacy_json).expect("legacy without showMenuBar");
        assert!(legacy.show_menu_bar);

        let mut s = AppState::default();
        let mut tx = rune::Tx::default();

        assert!(s.dispatch_menu_command_with_tx(&mut tx, "view.toggle_show_menu_bar"));
        assert!(!s.desktop_settings.show_menu_bar);
        s.dispatch(Action::Shell(ShellAction::SetShowMenuBar(true)));
        assert!(s.desktop_settings.show_menu_bar);

        assert!(s.dispatch_menu_command_with_tx(&mut tx, "file.open_skills"));
        assert_eq!(s.route().view, ViewId::Settings);
        assert_eq!(s.route().settings_page, SettingsPageId::ToolAccess);

        assert!(s.dispatch_menu_command_with_tx(&mut tx, "app.about"));
        assert!(s.toasts.iter().any(|t| t.key == "app-about"));

        assert!(s.dispatch_menu_command_with_tx(&mut tx, "help.github"));
        assert!(s.dispatch_menu_command_with_tx(&mut tx, "edit.paste"));
        assert!(s.dispatch_menu_command_with_tx(&mut tx, "edit.copy"));
        assert!(s.dispatch_menu_command_with_tx(&mut tx, "view.toggle_fullscreen"));
        assert!(s.dispatch_menu_command_with_tx(&mut tx, "window.minimize"));
        assert!(s.dispatch_menu_command_with_tx(&mut tx, "window.zoom"));
        assert!(s.dispatch_menu_command_with_tx(&mut tx, "file.close_window"));
        assert!(s.dispatch_menu_command_with_tx(&mut tx, "app.quit"));
        assert!(!s.dispatch_menu_command_with_tx(&mut tx, "unknown.command"));

        s.queue_menu_command(&mut tx, "view.toggle_show_menu_bar");
        assert_eq!(
            s.pending_menu_command.as_deref(),
            Some("view.toggle_show_menu_bar")
        );
    }
}
