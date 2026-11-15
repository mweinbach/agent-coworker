//! Store actions, async store events, and native backend commands.
//!
//! All views dispatch `Action` values via `AppState::dispatch`; reducers synchronously
//! update `AppState` and emit `WsCommand` or `NativeCommand` values to worker tasks.

use std::collections::HashMap;
use std::path::PathBuf;

use cowork_protocol::{
    CreationRepairAction, InitializeResult, JsonRpcLiteId, ServerRequestReceiptResponse,
    TurnAttachmentInputPart, TurnReference,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::router::{NavigationSnapshot, SettingsPageId, ViewId};
use crate::state::{
    ConfirmDialogRequest, DesktopSettings, FilePreviewState, LmStudioStartModalState,
    NotificationTone, PersistedDesktopState, ReasoningEffortValue, SubagentProfile,
    ThreadBusyPolicy, UpdaterState, WindowMode, WorkspaceFileEntry, WorkspaceRecord,
};
use crate::theme::ThemePreference;
use crate::ws::{WsConnectionState, WsRpcError};

/// Ordered sidebar sections matching `apps/desktop/src/app/types.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SidebarSectionKey {
    Pinned,
    Tasks,
    Chats,
    Workspaces,
}

/// Top-level user and UI actions dispatched by views and shortcuts.
#[derive(Clone, Debug)]
pub enum Action {
    Navigate(NavAction),
    Shell(ShellAction),
    Chat(ChatAction),
    Settings(SettingsAction),
    Native(NativeAction),
}

#[derive(Clone, Debug)]
pub enum NavAction {
    OpenView(ViewId),
    OpenThread(String),
    OpenNewChat {
        workspace_id: Option<String>,
    },
    OpenTask(String),
    OpenSettings(Option<SettingsPageId>),
    OpenSettingsIntent {
        page: SettingsPageId,
        tab: Option<String>,
        section: Option<String>,
        new_provider: bool,
    },
    SelectWorkspace(String),
    GoBack,
    GoForward,
    Replace(NavigationSnapshot),
}

#[derive(Clone, Debug)]
pub enum ShellAction {
    SetWindowMode(WindowMode),
    ToggleSidebar,
    SetSidebarOpen(bool),
    ToggleContextSidebar,
    SetContextSidebarOpen(bool),
    SetSidebarSearch(String),
    SetSidebarSectionOrder(Vec<SidebarSectionKey>),
    ToggleWorkspaceCollapsed(String),
    ReorderWorkspaces(Vec<String>),
    ToggleCommandPalette,
    SetCommandPaletteOpen(bool),
    SetCommandPaletteQuery(String),
    ToggleQuickChat,
    SetQuickChatOpen(bool),
    SetTheme(ThemePreference),
    PushToast {
        key: String,
        title: String,
        description: Option<String>,
        tone: NotificationTone,
    },
    DismissToast(String),
    CompleteOnboardingStep(String),
    SkipOnboarding,
    OpenFilePreview(FilePreviewState),
    CloseFilePreview,
    SetLandingWorkspace(Option<String>),
    RequestExternalUrl(String),
    ConfirmExternalUrl,
    DismissExternalUrl,
    OpenLmStudioStartModal(LmStudioStartModalState),
    DismissLmStudioStartModal,
    RequestConfirmDialog(ConfirmDialogRequest),
    ResolveConfirmDialog {
        id: String,
        confirmed: bool,
    },
    RepairCreationReadiness {
        action: CreationRepairAction,
        workspace_id: Option<String>,
    },
}

#[derive(Clone, Debug)]
pub enum ChatAction {
    CreateThread {
        workspace_id: String,
        title: Option<String>,
    },
    SelectThread(String),
    HydrateThread(String),
    RenameThread {
        thread_id: String,
        title: String,
    },
    SetThreadPinned {
        thread_id: String,
        pinned: bool,
    },
    ArchiveThread(String),
    RestoreThread(String),
    DeleteThread(String),
    ForkThread {
        thread_id: String,
        turn_id: Option<String>,
    },
    SendMessage {
        thread_id: Option<String>,
        text: String,
        busy_policy: ThreadBusyPolicy,
        attachments: Vec<TurnAttachmentInputPart>,
        references: Vec<TurnReference>,
    },
    CancelTurn {
        thread_id: String,
        include_subagents: bool,
    },
    ClearThreadUsageHardCap(String),
    SetThreadModel {
        thread_id: String,
        provider: String,
        model: String,
    },
    SetThreadReasoningEffort {
        thread_id: String,
        provider: String,
        effort: ReasoningEffortValue,
    },
    SetComposerDraftText {
        key: String,
        text: String,
    },
    SetComposerDraftModel {
        key: String,
        provider: String,
        model: String,
    },
    SetComposerDraftEffort {
        key: String,
        effort: Option<ReasoningEffortValue>,
    },
    AddComposerAttachment {
        key: String,
        attachment: TurnAttachmentInputPart,
    },
    RemoveComposerAttachment {
        key: String,
        index: usize,
    },
    ClearComposerDraft(String),
    ResolveServerRequest {
        workspace_id: String,
        thread_id: String,
        id: JsonRpcLiteId,
        response: ServerRequestReceiptResponse,
    },
    SubmitUserInput {
        workspace_id: String,
        thread_id: String,
        id: JsonRpcLiteId,
        answers: HashMap<String, Value>,
    },
    OpenAgentViewer {
        agent_id: String,
        title: Option<String>,
    },
    CloseAgentViewer,
    OpenAgentThread {
        agent_id: String,
        title: Option<String>,
    },
    RetryTranscriptDelivery {
        thread_id: String,
    },
    DismissTranscriptDeliveryFailure {
        thread_id: String,
    },
}

#[derive(Clone, Debug)]
pub enum SettingsAction {
    UpdateDesktopSettings(DesktopSettings),
    RefreshProviderCatalog {
        workspace_id: String,
    },
    SetProviderApiKey {
        workspace_id: String,
        provider: String,
        api_key: String,
    },
    StartProviderAuth {
        workspace_id: String,
        provider: String,
    },
    LogoutProvider {
        workspace_id: String,
        provider: String,
    },
    SetModelEnabled {
        workspace_id: String,
        provider: String,
        model: String,
        enabled: bool,
    },
    UpsertMcpServer {
        workspace_id: String,
        name: String,
        config: Value,
    },
    DeleteMcpServer {
        workspace_id: String,
        name: String,
    },
    UpsertSubagent {
        workspace_id: String,
        profile: SubagentProfile,
    },
    DeleteSubagent {
        workspace_id: String,
        id: String,
    },
    UpsertMemory {
        workspace_id: String,
        key: String,
        content: String,
    },
    DeleteMemory {
        workspace_id: String,
        key: String,
    },
    SetFeatureFlag {
        flag_id: String,
        enabled: bool,
    },
    RefreshDiagnostics {
        workspace_id: String,
    },
    CheckUpdates,
    QuitAndInstallUpdate,
    ListArchivedThreads {
        workspace_id: String,
    },
    ListBackups {
        workspace_id: String,
    },
    RestoreBackup {
        workspace_id: String,
        backup_id: String,
    },
    ForgetTrustedPhone {
        phone_id: String,
    },
    ExportDiagnosticsBundle,
}

#[derive(Clone, Debug)]
pub enum NativeAction {
    PickWorkspaceFolder,
    AddWorkspace { path: PathBuf, name: Option<String> },
    RemoveWorkspace(String),
    RestartWorkspaceServer(String),
    StopWorkspaceServer(String),
    ListWorkspaceFiles { workspace_id: String, dir: String },
    LoadFilePreview { workspace_id: String, path: String },
    FetchImageBytes { request_id: String, url: String },
    OpenExternalUrl(String),
    RevealInOs(String),
    OpenInDefaultApp(String),
    TrashPath(String),
}

/// Commands emitted from the core store to the `native/` worker.
#[derive(Clone, Debug, PartialEq)]
pub enum NativeCommand {
    StartWorkspaceServer {
        workspace_id: String,
        path: String,
        yolo: bool,
    },
    StopWorkspaceServer {
        workspace_id: String,
    },
    SavePersistedState(Box<PersistedDesktopState>),
    PickFolder {
        request_id: String,
    },
    PickFiles {
        request_id: String,
        allow_multiple: bool,
    },
    ListWorkspaceFiles {
        request_id: String,
        workspace_id: String,
        workspace_root: String,
        dir: String,
        show_hidden: bool,
    },
    ReadFilePreview {
        request_id: String,
        workspace_id: String,
        workspace_root: String,
        path: String,
    },
    FetchImageBytes {
        request_id: String,
        url: String,
    },
    OpenExternalUrl(String),
    RevealInOs(String),
    OpenInDefaultApp(String),
    TrashPath(String),
    ShowDesktopNotification {
        title: String,
        body: String,
    },
    ExportDiagnosticsBundle,
    CheckForUpdates,
    QuitAndInstallUpdate,
    Shutdown,
}

/// Asynchronous events pushed by `ws/` or `native/` back into `AppState::poll`.
#[derive(Clone, Debug)]
pub enum StoreEvent {
    NativeReady {
        persisted: Box<PersistedDesktopState>,
        is_packaged: bool,
        system_dark: Option<bool>,
    },
    SystemAppearanceChanged {
        system_dark: bool,
    },
    FolderPicked {
        request_id: String,
        path: Option<PathBuf>,
    },
    FilesPicked {
        request_id: String,
        paths: Vec<PathBuf>,
    },
    WorkspaceAdded(WorkspaceRecord),
    WorkspaceFilesListed {
        workspace_id: String,
        dir: String,
        entries: Vec<WorkspaceFileEntry>,
    },
    FilePreviewLoaded {
        workspace_id: String,
        path: String,
        result: Result<FilePreviewState, String>,
    },
    ImageBytesLoaded {
        request_id: String,
        mime_type: Option<String>,
        result: Result<Vec<u8>, String>,
    },
    ServerStarting {
        workspace_id: String,
        stage: String,
        message: String,
    },
    ServerListening {
        workspace_id: String,
        ws_url: String,
        port: u16,
        browser_access_token: Option<String>,
    },
    ServerExited {
        workspace_id: String,
        code: Option<i32>,
        message: Option<String>,
    },
    WsStateChanged {
        workspace_id: String,
        state: WsConnectionState,
    },
    WsInitialized {
        workspace_id: String,
        result: Box<InitializeResult>,
    },
    WsNotification {
        workspace_id: String,
        method: String,
        params: Value,
    },
    WsServerRequest {
        workspace_id: String,
        id: JsonRpcLiteId,
        method: String,
        params: Value,
    },
    WsResponse {
        workspace_id: String,
        request_id: u64,
        method: String,
        result: Result<Value, WsRpcError>,
    },
    WsInvalidMessage {
        workspace_id: String,
        message: String,
    },
    UpdaterChanged(UpdaterState),
    MenuInvoked(String),
    QuickChatToggled,
    DeepLink(String),
}
