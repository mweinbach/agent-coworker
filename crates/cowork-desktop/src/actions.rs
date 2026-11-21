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
    AgentProfileUpsertInputWire, ConfirmDialogRequest, DesktopSettings, DiagnosticsBundleState,
    FilePreviewState, LmStudioStartModalState, NotificationTone, PersistedDesktopState,
    PrivacyTelemetrySettings, ReasoningEffortValue, RemoteAccessState, SubagentProfile,
    ThreadBusyPolicy, UpdaterState, WindowMode, WorkspaceFileEntry, WorkspaceRecord,
};
use crate::theme::{AccentPalette, ThemePreference};
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
    Task(TaskAction),
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
    ToggleSidebarSectionCollapsed(SidebarSectionKey),
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
    CompleteOnboarding,
    SkipOnboarding,
    OpenFilePreview(FilePreviewState),
    CloseFilePreview,
    SetLandingWorkspace(Option<String>),
    SelectLandingQuickChat,
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
    ZoomIn,
    ZoomOut,
    ResetZoom,
    OpenQuickChatWindow,
    ToggleQuickChatWindow,
    OpenUtilityWindow,
    ToggleUtilityWindow,
    SetShowMenuBar(bool),
    ToggleShowMenuBar,
    OpenAbout,
    FocusMainWindow {
        open_new_chat_workspace: Option<String>,
        open_thread_id: Option<String>,
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
    RetryFailedTurn {
        thread_id: String,
    },
    RetryComposerSubmission(String),
    DismissComposerFailure(String),
    StartLmStudioAndRetry {
        workspace_id: String,
        thread_id: String,
    },
    OpenCanvasDocument {
        workspace_id: String,
        path: String,
    },
    ReloadCanvasDocument,
    UpdateCanvasDraft {
        document_id: String,
        generation: u64,
        content: String,
    },
    SaveCanvasDocument,
    SaveCanvasDocumentAs {
        path: String,
    },
    CloseCanvasDocument,
    SendCanvasEditPrompt {
        prompt: String,
    },
}

#[derive(Clone, Debug)]
pub enum SettingsAction {
    UpdateDesktopSettings(DesktopSettings),
    SetAccentPalette(AccentPalette),
    RefreshProviderCatalog {
        workspace_id: String,
    },
    SetProviderApiKey {
        workspace_id: String,
        provider: String,
        api_key: String,
    },
    SetProviderApiKeyForMethod {
        workspace_id: String,
        provider: String,
        method_id: String,
        api_key: String,
    },
    SetProviderConfigForMethod {
        workspace_id: String,
        provider: String,
        method_id: String,
        values: std::collections::HashMap<String, String>,
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
    UpsertScopedMcpServer {
        workspace_id: String,
        name: String,
        source: String,
        previous_name: Option<String>,
        server: Value,
    },
    DeleteScopedMcpServer {
        workspace_id: String,
        name: String,
        source: String,
    },
    UpsertSubagent {
        workspace_id: String,
        profile: SubagentProfile,
    },
    DeleteSubagent {
        workspace_id: String,
        id: String,
    },
    ReadAgentProfilesCatalog {
        workspace_id: String,
    },
    UpsertAgentProfile {
        workspace_id: String,
        input: AgentProfileUpsertInputWire,
    },
    DeleteAgentProfile {
        workspace_id: String,
        scope: String,
        id: String,
    },
    SetAgentProfileWorkspaceAvailability {
        workspace_id: String,
        id: String,
        disabled: bool,
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
    ReadMemories {
        workspace_id: String,
        scope: Option<String>,
    },
    UpsertScopedMemory {
        workspace_id: String,
        scope: String,
        id: Option<String>,
        content: String,
        mode: Option<String>,
    },
    DeleteScopedMemory {
        workspace_id: String,
        scope: String,
        id: String,
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
    RestoreBackupCheckpoint {
        workspace_id: String,
        target_session_id: String,
        checkpoint_id: Option<String>,
    },
    ForgetTrustedPhone {
        phone_id: String,
    },
    RevokeAllTrustedPhones,
    ExportDiagnosticsBundle,
    OpenLogsFolder,
    RevealDiagnosticsBundle {
        path: Option<String>,
    },
    UploadDiagnosticsBundle {
        path: Option<String>,
        confirmed: bool,
    },
    CompleteProviderAuthCallback {
        workspace_id: String,
        provider: String,
        method_id: String,
        callback_input: String,
    },
    SetProviderConfig {
        workspace_id: String,
        provider: String,
        config: Value,
    },
    AddCustomModel {
        workspace_id: String,
        provider: String,
        model_id: String,
        display_name: Option<String>,
    },
    DeleteCustomModel {
        workspace_id: String,
        provider: String,
        model_id: String,
    },
    ResetProviderModelPreferences {
        workspace_id: String,
        provider: String,
    },
    CheckLmStudioStatus {
        workspace_id: String,
        base_url: Option<String>,
    },
    StartLmStudio {
        workspace_id: String,
        base_url: Option<String>,
    },
    SetLmStudioEnabled {
        workspace_id: String,
        enabled: bool,
    },
    SetLmStudioModelVisible {
        workspace_id: String,
        model: String,
        visible: bool,
    },
    CheckCodexAppServer {
        workspace_id: String,
    },
    UpdateCodexAppServer {
        workspace_id: String,
        force: bool,
    },
    UpdateWorkspaceDefaults {
        workspace_id: String,
        defaults: Value,
    },
    SetMcpServerEnabled {
        workspace_id: String,
        name: String,
        source: String,
        enabled: bool,
    },
    SetMcpServerApiKey {
        workspace_id: String,
        name: String,
        source: String,
        api_key: String,
    },
    ValidateMcpServer {
        workspace_id: String,
        name: String,
        source: String,
    },
    AuthorizeMcpOAuth {
        workspace_id: String,
        name: String,
        source: String,
    },
    CompleteMcpOAuthCallback {
        workspace_id: String,
        name: String,
        source: String,
        callback_url: String,
    },
    CopyAgentProfile {
        workspace_id: String,
        id: String,
        target_scope: String,
    },
    CopyAgentProfileNamed {
        workspace_id: String,
        source_ref: String,
        target_scope: String,
        target_id: Option<String>,
        target_display_name: Option<String>,
    },
    UpsertAdvancedMemory {
        workspace_id: String,
        entry: Value,
    },
    DeleteAdvancedMemory {
        workspace_id: String,
        id: String,
    },
    RefreshSkillImprovementStatus {
        workspace_id: String,
    },
    RunSkillImprovement {
        workspace_id: String,
    },
    RestoreSkillImprovement {
        workspace_id: String,
        skill_name: String,
    },
    RefreshPluginsAndSkills {
        workspace_id: String,
    },
    InstallPlugin {
        workspace_id: String,
        params: Value,
    },
    SetPluginEnabled {
        workspace_id: String,
        id: String,
        enabled: bool,
    },
    SetPluginEnabledScoped {
        workspace_id: String,
        id: String,
        scope: Option<String>,
        enabled: bool,
    },
    DeletePlugin {
        workspace_id: String,
        id: String,
    },
    DeletePluginScoped {
        workspace_id: String,
        id: String,
        scope: Option<String>,
    },
    UpdatePlugin {
        workspace_id: String,
        id: String,
    },
    UpdatePluginScoped {
        workspace_id: String,
        id: String,
        scope: Option<String>,
    },
    InstallSkill {
        workspace_id: String,
        params: Value,
    },
    SetSkillEnabled {
        workspace_id: String,
        name: String,
        enabled: bool,
    },
    DeleteSkill {
        workspace_id: String,
        name: String,
    },
    SetSkillInstallationEnabled {
        workspace_id: String,
        installation_id: String,
        enabled: bool,
    },
    DeleteSkillInstallation {
        workspace_id: String,
        installation_id: String,
    },
    UpdateSkillInstallation {
        workspace_id: String,
        installation_id: String,
    },
    AddMarketplace {
        workspace_id: String,
        url: String,
    },
    RemoveMarketplace {
        workspace_id: String,
        id: String,
    },
    RefreshOpenAiNativeConnectors {
        workspace_id: String,
    },
    SetOpenAiNativeConnectorEnabled {
        workspace_id: String,
        connector_id: String,
        enabled: bool,
    },
    DismissSettingsMutationError,
    CreateBackup {
        workspace_id: String,
        target_session_id: String,
    },
    InspectBackup {
        workspace_id: String,
        target_session_id: String,
        checkpoint_id: String,
    },
    DeleteBackup {
        workspace_id: String,
        target_session_id: String,
        checkpoint_id: String,
    },
    DeleteBackupEntry {
        workspace_id: String,
        target_session_id: String,
    },
    PreviewConversationImport,
    ExecuteConversationImport,
    SetRemoteAccessEnabled(bool),
    RotateRemoteAccessSession,
    RefreshRemoteAccess,
    UpdateTrustedPhonePermissions {
        phone_id: String,
        permissions: String,
    },
    UpdatePrivacyTelemetry(PrivacyTelemetrySettings),
    RefreshTelemetryStatus,
    DownloadUpdate,
    CheckLibreOfficeRuntime {
        workspace_id: String,
    },
    RestartOnboarding,
}

#[derive(Clone, Debug)]
pub enum NativeAction {
    PickWorkspaceFolder,
    PickFiles {
        allow_multiple: bool,
    },
    PickComposerAttachments {
        key: String,
    },
    IngestDroppedFiles {
        key: String,
        paths: Vec<PathBuf>,
    },
    PasteClipboardImage {
        key: String,
        bytes: Vec<u8>,
        mime_type: String,
        filename: Option<String>,
    },
    AddWorkspace {
        path: PathBuf,
        name: Option<String>,
    },
    RemoveWorkspace(String),
    RestartWorkspaceServer(String),
    StopWorkspaceServer(String),
    ListWorkspaceFiles {
        workspace_id: String,
        dir: String,
    },
    LoadFilePreview {
        workspace_id: String,
        path: String,
    },
    FetchImageBytes {
        request_id: String,
        url: String,
    },
    CopyText(String),
    OpenExternalUrl(String),
    RevealInOs(String),
    OpenInDefaultApp(String),
    TrashPath(String),
    RenameWorkspaceEntry {
        workspace_id: String,
        path: String,
        new_name: String,
    },
}

/// Answer entry for `task/questions/resolve` (`questionId` + either `optionId` or `text`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuestionAnswerParam {
    pub question_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Interactive task mode actions dispatched to `task/*` JSON-RPC methods.
#[derive(Clone, Debug)]
pub enum TaskAction {
    ListTasks {
        workspace_id: String,
    },
    ReadTask {
        workspace_id: String,
        task_id: String,
    },
    CreateTask {
        workspace_id: String,
        title: String,
        objective: String,
        context: Option<String>,
        review_required: Option<bool>,
        provider: Option<String>,
        model: Option<String>,
        idempotency_key: Option<String>,
        requirements: Vec<Value>,
        work_items: Vec<Value>,
    },
    UpdateBrief {
        workspace_id: String,
        task_id: String,
        expected_revision: i64,
        title: Option<String>,
        objective: Option<String>,
    },
    ResolveQuestions {
        workspace_id: String,
        task_id: String,
        expected_revision: i64,
        answers: Vec<TaskQuestionAnswerParam>,
    },
    ReadArtifact {
        workspace_id: String,
        task_id: String,
        artifact_id: String,
    },
    AcceptArtifactVersion {
        workspace_id: String,
        task_id: String,
        artifact_id: String,
        version_id: Option<String>,
        expected_revision: i64,
    },
    RestoreArtifactVersion {
        workspace_id: String,
        task_id: String,
        artifact_id: String,
        version_id: String,
        expected_revision: i64,
        change_summary: Option<String>,
    },
    CreateTaskThread {
        workspace_id: String,
        task_id: String,
        expected_revision: i64,
        title: String,
        work_item_id: Option<String>,
        provider: Option<String>,
        model: Option<String>,
    },
    AcceptTask {
        workspace_id: String,
        task_id: String,
        expected_revision: i64,
    },
    RequestChanges {
        workspace_id: String,
        task_id: String,
        expected_revision: i64,
        feedback: String,
    },
    CancelTask {
        workspace_id: String,
        task_id: String,
        expected_revision: i64,
        reason: Option<String>,
    },
    ReopenTask {
        workspace_id: String,
        task_id: String,
        expected_revision: i64,
        reason: Option<String>,
    },
    RetryTask {
        workspace_id: String,
        task_id: String,
        expected_revision: i64,
    },
}

/// Wire/disk shape matching a JSONL line in local thread transcripts (`TranscriptEvent`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLogEntry {
    pub ts: String,
    pub thread_id: String,
    pub direction: String,
    #[serde(default)]
    pub payload: Value,
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
    LoadImportedWorkspaces(Vec<String>),
    PickFolder {
        request_id: String,
    },
    PickFiles {
        request_id: String,
        allow_multiple: bool,
    },
    StageComposerUpload {
        key: String,
        workspace_id: String,
        workspace_root: String,
        uploads_directory: Option<String>,
        source_path: PathBuf,
        filename: String,
        mime_type: String,
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
    OpenInDefaultApp {
        path: String,
        confirmed: bool,
    },
    TrashPath(String),
    CopyText(String),
    SetRemoteAccessEnabled(bool),
    RotateRemoteAccessSession,
    RefreshRemoteAccessTrustedDevices,
    UpdateTrustedPhonePermissions {
        phone_id: String,
        permissions: String,
    },
    ForgetTrustedPhone(String),
    RevokeAllTrustedPhones,
    RefreshTelemetryStatus,
    DownloadUpdate,
    ShowDesktopNotification {
        title: String,
        body: String,
    },
    ExportDiagnosticsBundle,
    OpenLogsFolder,
    RevealDiagnosticsBundle(Option<String>),
    UploadDiagnosticsBundle {
        path: Option<String>,
        confirmed: bool,
    },
    CheckForUpdates,
    QuitAndInstallUpdate,
    RenameWorkspaceEntry {
        request_id: String,
        workspace_id: String,
        workspace_root: String,
        path: String,
        new_name: String,
    },
    ResolveWindowClose {
        window_id: String,
        request_id: String,
        confirmed: bool,
    },
    ReadLocalTranscript {
        request_id: String,
        thread_id: String,
        candidate_ids: Vec<String>,
    },
    DeleteLocalTranscripts {
        thread_ids: Vec<String>,
    },
    AppendTranscriptEvent(TranscriptLogEntry),
    TrackAnalyticsEvent {
        name: String,
        properties: Value,
    },
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
    ComposerUploadStaged {
        key: String,
        filename: String,
        mime_type: String,
        result: Result<PathBuf, String>,
    },
    WorkspaceAdded(WorkspaceRecord),
    ImportedWorkspacesLoaded(Vec<WorkspaceRecord>),
    WorkspaceFilesListed {
        workspace_id: String,
        dir: String,
        entries: Vec<WorkspaceFileEntry>,
    },
    FilePreviewLoaded {
        request_id: String,
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
    WsServerResponseResult {
        workspace_id: String,
        request_id: JsonRpcLiteId,
        ok: bool,
        error: Option<String>,
    },
    WsInvalidMessage {
        workspace_id: String,
        message: String,
    },
    DiagnosticsBundleUpdated(Option<DiagnosticsBundleState>),
    UpdaterChanged(UpdaterState),
    RemoteAccessChanged(RemoteAccessState),
    TelemetryStatusChanged(Value),
    QuickChatShortcutStatus {
        error: Option<String>,
    },
    Toast {
        key: String,
        title: String,
        description: Option<String>,
        tone: NotificationTone,
    },
    MenuInvoked(String),
    QuickChatToggled,
    DeepLink(String),
    WorkspaceEntryRenamed {
        workspace_id: String,
        old_path: String,
        new_path: String,
    },
    WorkspaceEntryRenameFailed {
        workspace_id: String,
        path: String,
        error: String,
    },
    LaunchableFileConfirmRequired {
        path: String,
        file_name: String,
    },
    ConfirmWindowClose {
        window_id: String,
        request_id: String,
        title: String,
        message: String,
    },
    LocalTranscriptLoaded {
        request_id: String,
        thread_id: String,
        result: Result<Vec<TranscriptLogEntry>, String>,
    },
    ProductAnalyticsStateUpdated(Option<Value>),
}
