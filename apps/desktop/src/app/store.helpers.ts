import type { ArtifactDiff, ArtifactPreview } from "../../../../src/server/artifacts/types";
import type { PresentationPreviewResult } from "../../../../src/server/presentationPreview";
import type {
  AgentProfileCopyInput,
  AgentProfileScope,
  AgentProfileUpsertInput,
} from "../../../../src/shared/agentProfiles";
import type {
  DesktopFeatureFlagId,
  DesktopFeatureFlagOverrides,
  DesktopFeatureFlags,
} from "../../../../src/shared/featureFlags";
import type {
  SpreadsheetBatchPatchOperation,
  SpreadsheetBatchPatchResult,
  SpreadsheetFileVersion,
  SpreadsheetFileVersionResult,
  SpreadsheetWorkbookSnapshotResult,
} from "../../../../src/shared/spreadsheetPreview";
import type { TaskCreationInput } from "../../../../src/shared/tasks";
import {
  createDefaultUpdaterState,
  type UpdaterState,
  type WorkspaceServerStartupProgress,
} from "../lib/desktopApi";
import { startWorkspaceServer } from "../lib/desktopCommands";
import type { NewChatLandingTarget } from "../lib/newChatLanding";
import { fallbackAuthMethods } from "../lib/providerDisplayNames";
import type {
  CodexAppServerInstallStatus,
  ImportableItem,
  ImportableKind,
  ImportSource,
  MCPServerConfig,
  ProviderName,
  SessionEvent,
  TodoItem,
} from "../lib/wsProtocol";
import { PROVIDER_NAMES } from "../lib/wsProtocol";
import { buildContextPreamble, extractUsageStateFromTranscript } from "./store.feedMapping";
import { createControlSocketHelpers } from "./store.helpers/controlSocket";
import {
  disposeAllJsonRpcSocketState,
  disposeWorkspaceJsonRpcSocketState,
  reactivateWorkspaceJsonRpcSocketState,
} from "./store.helpers/jsonRpcSocket";
import {
  persist,
  persistNow,
  syncDesktopStateCache,
  syncDesktopStateCacheNow,
} from "./store.helpers/persistence";
import {
  beginThreadSelectionRequest,
  bumpWorkspaceJsonRpcSocketGeneration,
  bumpWorkspaceStartGeneration,
  clearPendingThreadSteers,
  clearThreadSelectionRequest,
  clearWorkspaceJsonRpcSocketGeneration,
  clearWorkspaceStartState,
  defaultThreadRuntime,
  defaultWorkspaceRuntime,
  ensureThreadRuntime,
  ensureWorkspaceRuntime,
  getWorkspaceStartGeneration,
  isCurrentThreadSelectionRequest,
  prependPendingThreadMessageWithAttachments,
  queuePendingThreadMessage,
  RUNTIME,
  shiftPendingThreadAttachments,
  shiftPendingThreadMessage,
  shiftPendingThreadReferences,
} from "./store.helpers/runtimeState";
import { createThreadEventReducer } from "./store.helpers/threadEventReducer";
import { createTranscriptBuffer } from "./store.helpers/transcriptBuffer";
import type {
  CloudSyncSettings,
  DesktopSettings,
  Notification,
  OnboardingStep,
  PersistedOnboardingState,
  PersistedPrivacyTelemetrySettings,
  PersistedProviderUiState,
  PluginManagementMode,
  PrivacyTelemetrySettings,
  PromptModalState,
  ResearchCard,
  ResearchDetail,
  ResearchSettingsState,
  SandboxApprovalPrompt,
  SettingsPageId,
  SidebarSectionKey,
  TaskArtifactDetail,
  TaskQuestionAnswerInput,
  TaskQuestionResumeStatus,
  TaskRecord,
  TaskSummary,
  ThreadBusyPolicy,
  ThreadRecord,
  ThreadRuntime,
  ThreadTitleSource,
  ViewId,
  WorkspaceDefaultsPatch,
  WorkspaceExplorerState,
  WorkspaceRecord,
  WorkspaceRuntime,
} from "./types";

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return crypto.randomUUID();
}

function basename(p: string) {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function truncateTitle(s: string, max = 34) {
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function isPlaceholderThreadTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === "new thread" || normalized === "new session" || normalized === "new conversation"
  );
}

function normalizeThreadTitleSource(source: unknown, fallbackTitle: string): ThreadTitleSource {
  if (source === "default" || source === "model" || source === "heuristic" || source === "manual") {
    return source;
  }
  return isPlaceholderThreadTitle(fallbackTitle) ? "default" : "manual";
}

function shouldAdoptServerTitle(opts: {
  currentSource: ThreadTitleSource;
  incomingTitle: string;
  incomingSource: ThreadTitleSource;
}): boolean {
  if (!opts.incomingTitle) return false;
  if (opts.incomingSource === "manual") return true;
  if (opts.currentSource === "manual") return false;
  if (opts.currentSource === "default") return true;
  if (opts.currentSource === "heuristic" && opts.incomingSource === "model") return true;
  if (opts.currentSource === opts.incomingSource) return true;
  return false;
}

const MAX_NOTIFICATIONS = 50;

type ProviderStatusEvent = Extract<SessionEvent, { type: "provider_status" }>;
type ProviderStatus = ProviderStatusEvent["providers"][number];
type ProviderCatalogEvent = Extract<SessionEvent, { type: "provider_catalog" }>;
type ProviderCatalogEntry = ProviderCatalogEvent["all"][number];
type ProviderAuthMethodsEvent = Extract<SessionEvent, { type: "provider_auth_methods" }>;
type ProviderAuthMethod = ProviderAuthMethodsEvent["methods"][string][number];
type ProviderAuthChallengeEvent = Extract<SessionEvent, { type: "provider_auth_challenge" }>;
type ProviderAuthResultEvent = Extract<SessionEvent, { type: "provider_auth_result" }>;

function isProviderName(v: unknown): v is ProviderName {
  return typeof v === "string" && (PROVIDER_NAMES as readonly string[]).includes(v);
}

function providerAuthMethodsFor(
  state: AppStoreState,
  provider: ProviderName,
): ProviderAuthMethod[] {
  const fromState = state.providerAuthMethodsByProvider[provider];
  if (Array.isArray(fromState) && fromState.length > 0) return fromState;
  return fallbackAuthMethods(provider);
}

export type TaskLifecycleRequest = {
  action: "reopen" | "retry";
  expectedRevision: number;
  requestId: string;
};

export type AppStoreState = {
  ready: boolean;
  bootstrapPending: boolean;
  startupError: string | null;
  view: ViewId;

  settingsPage: SettingsPageId;
  lastNonSettingsView: ViewId;

  workspaces: WorkspaceRecord[];
  threads: ThreadRecord[];

  selectedWorkspaceId: string | null;
  pluginManagementWorkspaceId: string | null;
  pluginManagementMode: PluginManagementMode;
  selectedThreadId: string | null;
  selectedTaskId: string | null;
  newTaskWorkspaceId: string | null;
  newTaskWorkspaceRequestId: number;
  taskSummariesByWorkspaceId: Record<string, TaskSummary[]>;
  tasksById: Record<string, TaskRecord>;
  taskListLoadingByWorkspaceId: Record<string, boolean>;
  taskLifecycleRequestByTaskId: Record<string, TaskLifecycleRequest>;
  taskError: string | null;

  workspaceRuntimeById: Record<string, WorkspaceRuntime>;
  threadRuntimeById: Record<string, ThreadRuntime>;

  latestTodosByThreadId: Record<string, TodoItem[]>;
  workspaceExplorerById: Record<string, WorkspaceExplorerState>;
  workspaceExplorerRefreshById: Record<string, number>;

  promptModal: PromptModalState;
  /**
   * Pending sandbox-denial escalations rendered inline in the chat feed, keyed by
   * threadId. Sandbox escapes use this inline path; ordinary approvals
   * (`requires_manual_review`) still use `promptModal`.
   */
  sandboxApprovalsByThread: Record<string, SandboxApprovalPrompt[]>;
  filePreview: { path: string } | null;
  canvasActiveTab: "preview" | "edit";
  canvasShowFormattingBar: boolean;
  isCanvasMaximized: boolean;
  notifications: Notification[];

  providerStatusByName: Partial<Record<ProviderName, ProviderStatus>>;
  providerStatusLastUpdatedAt: string | null;
  providerStatusRefreshing: boolean;
  codexAppServerStatus: CodexAppServerInstallStatus | null;
  codexAppServerChecking: boolean;
  codexAppServerUpdating: boolean;
  providerCatalog: ProviderCatalogEntry[];
  providerDefaultModelByProvider: Record<string, string>;
  providerConnected: ProviderName[];
  providerAuthMethodsByProvider: Record<string, ProviderAuthMethod[]>;
  providerLastAuthChallenge: ProviderAuthChallengeEvent | null;
  providerLastAuthResult: ProviderAuthResultEvent | null;
  providerUiState: PersistedProviderUiState;

  composerText: string;
  newChatLandingTarget: NewChatLandingTarget | null;
  injectContext: boolean;
  developerMode: boolean;
  showHiddenFiles: boolean;
  perWorkspaceSettings: boolean;
  desktopSettings: DesktopSettings;
  privacyTelemetrySettings: PrivacyTelemetrySettings;
  cloudSync: CloudSyncSettings;
  desktopFeatureFlags: DesktopFeatureFlags;
  desktopFeatureFlagOverrides: DesktopFeatureFlagOverrides;
  updateState: UpdaterState;

  onboardingVisible: boolean;
  onboardingStep: OnboardingStep;
  onboardingState: PersistedOnboardingState;

  researchTransportWorkspaceId: string | null;
  researchById: Record<string, ResearchDetail>;
  researchOrder: string[];
  selectedResearchId: string | null;
  researchListLoading: boolean;
  researchListError: string | null;
  researchDraftSettings: ResearchSettingsState;
  researchSubscribedIds: string[];
  researchExportPendingIds: string[];

  sidebarCollapsed: boolean;
  sidebarWidth: number;
  contextSidebarCollapsed: boolean;
  contextSidebarWidth: number;
  canvasSidebarWidth: number;
  messageBarHeight: number;
  init: () => Promise<void>;

  openSettings: (page?: SettingsPageId) => void;
  closeSettings: () => void;
  setSettingsPage: (page: SettingsPageId) => void;

  addWorkspace: () => Promise<void>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  reorderWorkspaces: (sourceWorkspaceId: string, targetWorkspaceId: string) => Promise<void>;
  setWorkspacesOrder: (orderedIds: string[]) => Promise<void>;

  newThread: (opts?: {
    workspaceId?: string;
    scope?: "oneOff" | "project";
    titleHint?: string;
    firstMessage?: string;
    references?: import("../lib/wsProtocol").TurnReference[];
    mode?: "draft" | "session";
    attachments?: import("./store.helpers/jsonRpcSocket").FileAttachmentInput[];
    attachmentFiles?: File[];
    provider?: ProviderName;
    model?: string;
  }) => Promise<boolean>;
  openNewChatLanding: (opts?: {
    defaultTargetKind?: "project" | "oneOff";
    target?: NewChatLandingTarget;
  }) => Promise<void>;
  setNewChatLandingTarget: (target: NewChatLandingTarget) => void;
  removeThread: (threadId: string) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  restoreThread: (threadId: string) => Promise<void>;
  deleteThreadHistory: (threadId: string) => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  reconnectThread: (
    threadId: string,
    firstMessage?: string,
    opts?: {
      selectionRequestId?: number;
      skipWorkspaceSelect?: boolean;
      attachments?: import("./store.helpers/jsonRpcSocket").FileAttachmentInput[];
      references?: import("../lib/wsProtocol").TurnReference[];
      refreshSnapshot?: boolean;
    },
  ) => Promise<boolean>;
  renameThread: (threadId: string, newTitle: string) => void;

  sendMessage: (
    text: string,
    busyPolicy?: ThreadBusyPolicy,
    attachments?: import("./store.helpers/jsonRpcSocket").FileAttachmentInput[],
    references?: import("../lib/wsProtocol").TurnReference[],
  ) => Promise<boolean>;
  cancelThread: (threadId: string, opts?: { includeSubagents?: boolean }) => void;
  clearThreadUsageHardCap: (threadId: string) => void;
  dispatchA2uiAction: (opts: {
    threadId: string;
    surfaceId: string;
    componentId: string;
    eventType: string;
    payload?: Record<string, unknown>;
  }) => Promise<boolean>;
  setThreadModel: (threadId: string, provider: ProviderName, model: string) => void;
  setComposerText: (text: string) => void;
  setInjectContext: (v: boolean) => void;
  setDeveloperMode: (v: boolean) => void;
  setShowHiddenFiles: (v: boolean) => void;
  setPerWorkspaceSettings: (enabled: boolean) => void;
  setQuickChatIconEnabled: (enabled: boolean) => void;
  setArchivedChatsAutoDeleteDays: (days: number) => void;
  setQuickChatShortcutEnabled: (enabled: boolean) => void;
  setQuickChatShortcutAccelerator: (accelerator: string) => void;
  setSidebarSectionOrder: (orderedSections: SidebarSectionKey[]) => void;
  setCrashReportsEnabled: (enabled: boolean) => void;
  setProductAnalyticsEnabled: (enabled: boolean) => void;
  setAiTraceTelemetryEnabled: (enabled: boolean) => void;
  setAiTracePayloadsEnabled: (enabled: boolean) => void;
  setDiagnosticsUploadEnabled: (enabled: boolean) => void;
  setCloudSyncEnabled: (enabled: boolean) => void;
  setPrivacyTelemetrySettings: (patch: PersistedPrivacyTelemetrySettings) => void;
  setDesktopFeatureFlagOverride: (flagId: DesktopFeatureFlagId, enabled: boolean) => Promise<void>;
  setUpdateState: (state: UpdaterState) => void;
  checkForUpdates: () => Promise<void>;
  quitAndInstallUpdate: () => Promise<void>;

  openSkills: () => Promise<void>;
  openResearch: () => Promise<void>;
  openNewTask: (workspaceId?: string) => Promise<void>;
  refreshTasks: (workspaceId?: string) => Promise<void>;
  startTask: (opts: { workspaceId: string; task: TaskCreationInput }) => Promise<TaskRecord | null>;
  selectTask: (taskId: string, options?: { preserveView?: boolean }) => Promise<void>;
  selectTaskThread: (taskId: string, taskThreadId: string) => Promise<void>;
  createTaskThread: (taskId: string, title: string, workItemId?: string) => Promise<void>;
  updateTaskBrief: (
    taskId: string,
    patch: { title?: string; objective?: string },
  ) => Promise<boolean>;
  acceptTask: (taskId: string) => Promise<void>;
  requestTaskChanges: (taskId: string, feedback: string) => Promise<void>;
  cancelTask: (taskId: string, reason?: string) => Promise<void>;
  reopenTask: (taskId: string, reason?: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<boolean>;
  resolveTaskQuestions: (
    taskId: string,
    answers: TaskQuestionAnswerInput[],
  ) => Promise<TaskQuestionResumeStatus | null>;
  readTaskArtifact: (taskId: string, artifactId: string) => Promise<TaskArtifactDetail | null>;
  captureTaskArtifactVersion: (
    taskId: string,
    artifactId: string,
    changeSummary?: string,
  ) => Promise<TaskArtifactDetail | null>;
  compareTaskArtifactVersions: (
    taskId: string,
    artifactId: string,
    baseVersionId: string,
    targetVersionId: string,
  ) => Promise<ArtifactDiff | null>;
  previewTaskArtifactVersion: (
    taskId: string,
    artifactId: string,
    versionId: string,
  ) => Promise<{ versionId: string; preview: ArtifactPreview } | null>;
  restoreTaskArtifactVersion: (
    taskId: string,
    artifactId: string,
    versionId: string,
  ) => Promise<TaskArtifactDetail | null>;
  acceptTaskArtifactVersion: (
    taskId: string,
    artifactId: string,
    versionId?: string,
  ) => Promise<TaskArtifactDetail | null>;
  startTaskArtifactRevision: (
    taskId: string,
    artifactId: string,
    baseVersionId: string,
    instruction: string,
  ) => Promise<TaskArtifactDetail | null>;
  refreshSkillsCatalog: (workspaceId?: string) => Promise<void>;
  refreshAgentProfilesCatalog: (workspaceId?: string) => Promise<void>;
  upsertAgentProfile: (profile: AgentProfileUpsertInput, workspaceId?: string) => Promise<boolean>;
  deleteAgentProfile: (scope: AgentProfileScope, id: string, workspaceId?: string) => Promise<void>;
  copyAgentProfile: (copy: AgentProfileCopyInput, workspaceId?: string) => Promise<boolean>;
  refreshPluginsCatalog: () => Promise<void>;
  selectPlugin: (pluginId: string | null, scope?: "workspace" | "user" | null) => Promise<void>;
  setPluginManagementWorkspace: (workspaceId: string | null) => Promise<void>;
  previewPluginInstall: (sourceInput: string, targetScope: "workspace" | "user") => Promise<void>;
  installPlugins: (sourceInput: string, targetScope: "workspace" | "user") => Promise<void>;
  enablePlugin: (pluginId: string, scope?: "workspace" | "user") => Promise<void>;
  disablePlugin: (pluginId: string, scope?: "workspace" | "user") => Promise<void>;
  deletePlugin: (pluginId: string, scope?: "workspace" | "user") => Promise<void>;
  checkPluginUpdate: (pluginId: string, scope?: "workspace" | "user") => Promise<void>;
  updatePlugin: (pluginId: string, scope?: "workspace" | "user") => Promise<void>;
  setPluginViewMode: (mode: "plugins" | "skills") => void;
  listImportable: (source: ImportSource, kind: ImportableKind) => Promise<void>;
  importPlugin: (item: ImportableItem, targetScope: "workspace" | "user") => Promise<void>;
  importSkill: (item: ImportableItem, targetScope: "workspace" | "user") => Promise<void>;
  selectSkill: (skillName: string) => Promise<void>;
  selectSkillInstallation: (installationId: string | null) => Promise<void>;
  previewSkillInstall: (sourceInput: string, targetScope: "project" | "global") => Promise<void>;
  installSkills: (sourceInput: string, targetScope: "project" | "global") => Promise<void>;
  disableSkill: (skillName: string) => Promise<void>;
  enableSkill: (skillName: string) => Promise<void>;
  deleteSkill: (skillName: string) => Promise<void>;
  disableSkillInstallation: (installationId: string) => Promise<void>;
  enableSkillInstallation: (installationId: string) => Promise<void>;
  deleteSkillInstallation: (installationId: string) => Promise<void>;
  copySkillInstallation: (
    installationId: string,
    targetScope: "project" | "global",
  ) => Promise<void>;
  checkSkillInstallationUpdate: (installationId: string) => Promise<void>;
  updateSkillInstallation: (installationId: string) => Promise<void>;

  refreshResearchList: () => Promise<void>;
  selectResearch: (researchId: string | null) => Promise<void>;
  startResearch: (opts: {
    input: string;
    title?: string;
    files?: File[];
    settings?: Partial<ResearchSettingsState>;
  }) => Promise<ResearchCard | null>;
  cancelResearch: (researchId: string) => Promise<void>;
  renameResearch: (researchId: string, title: string) => Promise<void>;
  sendResearchFollowUp: (opts: {
    parentResearchId: string;
    input: string;
    title?: string;
    files?: File[];
    settings?: Partial<ResearchSettingsState>;
  }) => Promise<ResearchCard | null>;
  setResearchDraftSettings: (patch: Partial<ResearchSettingsState>) => void;
  exportResearch: (
    researchId: string,
    format: import("../../../../src/server/research/types").ResearchExportFormat,
  ) => Promise<string | null>;
  approveResearchPlan: (researchId: string) => Promise<ResearchCard | null>;
  refineResearchPlan: (researchId: string, input: string) => Promise<ResearchCard | null>;

  applyWorkspaceDefaultsToThread: (
    threadId: string,
    mode?: "auto" | "auto-resume" | "explicit",
    draftModelSelection?: { provider: ProviderName; model: string } | null,
    opts?: { allowBeforeHydration?: boolean },
  ) => Promise<void>;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: WorkspaceDefaultsPatch,
    opts?: { scope?: "settings" | "target" },
  ) => Promise<void>;
  restartWorkspaceServer: (workspaceId: string) => Promise<void>;
  setWorkspaceServerStartupProgress: (event: WorkspaceServerStartupProgress) => void;
  requestWorkspaceMcpServers: (workspaceId: string) => Promise<void>;
  upsertWorkspaceMcpServer: (
    workspaceId: string,
    server: {
      name: string;
      transport: MCPServerConfig["transport"];
      enabled?: boolean;
      required?: boolean;
      retries?: number;
      auth?: MCPServerConfig["auth"];
    },
    previousName?: string,
    source?: "workspace" | "user",
  ) => Promise<void>;
  deleteWorkspaceMcpServer: (
    workspaceId: string,
    name: string,
    source?: "workspace" | "user",
  ) => Promise<void>;
  setWorkspaceMcpServerEnabled: (
    workspaceId: string,
    server: {
      name: string;
      source: "workspace" | "user" | "plugin" | "system";
      enabled: boolean;
      pluginId?: string;
      pluginScope?: "workspace" | "user";
    },
  ) => Promise<void>;
  validateWorkspaceMcpServer: (workspaceId: string, name: string) => Promise<void>;
  authorizeWorkspaceMcpServerAuth: (workspaceId: string, name: string) => Promise<void>;
  callbackWorkspaceMcpServerAuth: (
    workspaceId: string,
    name: string,
    code?: string,
  ) => Promise<void>;
  setWorkspaceMcpServerApiKey: (workspaceId: string, name: string, apiKey: string) => Promise<void>;
  requestOpenAiNativeConnectors: (workspaceId: string) => Promise<void>;
  refreshOpenAiNativeConnectors: (workspaceId: string) => Promise<void>;
  setOpenAiNativeConnectorEnabled: (
    workspaceId: string,
    connectorId: string,
    enabled: boolean,
  ) => Promise<void>;
  requestWorkspaceBackups: (workspaceId: string) => Promise<void>;
  requestWorkspaceBackupDelta: (
    workspaceId: string,
    targetSessionId: string,
    checkpointId: string,
  ) => Promise<void>;
  createWorkspaceBackupCheckpoint: (workspaceId: string, targetSessionId: string) => Promise<void>;
  restoreWorkspaceBackupOriginal: (workspaceId: string, targetSessionId: string) => Promise<void>;
  restoreWorkspaceBackupCheckpoint: (
    workspaceId: string,
    targetSessionId: string,
    checkpointId: string,
  ) => Promise<void>;
  deleteWorkspaceBackupCheckpoint: (
    workspaceId: string,
    targetSessionId: string,
    checkpointId: string,
  ) => Promise<void>;
  deleteWorkspaceBackupEntry: (workspaceId: string, targetSessionId: string) => Promise<void>;
  setWorkspaceBackupSessionEnabled: (
    workspaceId: string,
    targetSessionId: string,
    enabled: boolean,
  ) => Promise<void>;

  requestWorkspaceMemories: (workspaceId: string, opts?: { cwd?: string }) => Promise<void>;
  upsertWorkspaceMemory: (
    workspaceId: string,
    scope: "workspace" | "user",
    id: string | undefined,
    content: string,
    opts?: { cwd?: string },
  ) => Promise<void>;
  deleteWorkspaceMemory: (
    workspaceId: string,
    scope: "workspace" | "user",
    id: string,
    opts?: { cwd?: string },
  ) => Promise<void>;

  requestAdvancedMemories: (
    workspaceId: string,
    opts?: { cwd?: string; folder?: string },
  ) => Promise<void>;
  upsertAdvancedMemory: (
    workspaceId: string,
    input: {
      folder?: string;
      slug?: string;
      name: string;
      description: string;
      type?: string;
      body: string;
    },
    opts?: { cwd?: string },
  ) => Promise<boolean>;
  deleteAdvancedMemory: (
    workspaceId: string,
    folder: string | undefined,
    slug: string,
    opts?: { cwd?: string },
  ) => Promise<void>;
  generateAdvancedMemoryForThread: (
    workspaceId: string,
    threadId: string,
    opts?: { cwd?: string; folder?: string },
  ) => Promise<boolean>;
  setWorkspaceAdvancedMemory: (
    workspaceId: string,
    advancedMemory: boolean,
    opts?: { cwd?: string },
  ) => Promise<void>;
  setWorkspaceMemoryGenerationModel: (
    workspaceId: string,
    model: string,
    opts?: { cwd?: string },
  ) => Promise<void>;

  connectProvider: (provider: ProviderName, apiKey?: string) => Promise<void>;
  setProviderApiKey: (provider: ProviderName, methodId: string, apiKey: string) => Promise<void>;
  setProviderConfig: (
    provider: ProviderName,
    methodId: string,
    values: Record<string, string>,
  ) => Promise<void>;
  copyProviderApiKey: (provider: ProviderName, sourceProvider: ProviderName) => Promise<void>;
  authorizeProviderAuth: (provider: ProviderName, methodId: string) => Promise<void>;
  logoutProviderAuth: (provider: ProviderName) => Promise<void>;
  callbackProviderAuth: (provider: ProviderName, methodId: string, code?: string) => Promise<void>;
  requestProviderCatalog: () => Promise<void>;
  requestProviderAuthMethods: () => Promise<void>;
  refreshProviderStatus: (opts?: {
    refreshBedrockDiscovery?: boolean;
    workspaceId?: string;
  }) => Promise<void>;
  checkCodexAppServerStatus: (opts?: { checkLatest?: boolean }) => Promise<void>;
  updateCodexAppServer: (opts?: { force?: boolean }) => Promise<void>;
  checkLibreOfficeRuntime: (opts?: {
    smoke?: boolean;
  }) => Promise<import("../lib/wsProtocol").LibreOfficeRuntimeDiagnostic | null>;
  setLmStudioEnabled: (enabled: boolean) => Promise<void>;
  setLmStudioModelVisible: (modelId: string, visible: boolean) => Promise<void>;

  loadAllThreadUsage: () => Promise<void>;

  answerAsk: (threadId: string, requestId: string, answer: string) => void;
  answerApproval: (threadId: string, requestId: string, approved: boolean) => void;
  dismissPrompt: () => void;

  startOnboarding: () => void;
  dismissOnboarding: () => void;
  completeOnboarding: () => void;
  setOnboardingStep: (step: OnboardingStep) => void;

  toggleSidebar: () => void;
  toggleContextSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setContextSidebarWidth: (width: number) => void;
  setMessageBarHeight: (height: number) => void;

  refreshWorkspaceFiles: (workspaceId: string) => Promise<void>;
  navigateWorkspaceFiles: (workspaceId: string, path: string) => Promise<void>;
  navigateWorkspaceFilesUp: (workspaceId: string) => Promise<void>;
  selectWorkspaceFile: (workspaceId: string, path: string | null) => void;
  openWorkspaceFile: (workspaceId: string, path: string, isDirectory: boolean) => Promise<void>;
  revealWorkspaceFile: (path: string) => Promise<void>;
  copyWorkspaceFilePath: (path: string) => Promise<void>;
  createWorkspaceDirectory: (
    workspaceId: string,
    parentPath: string,
    name: string,
  ) => Promise<void>;
  renameWorkspacePath: (workspaceId: string, path: string, newName: string) => Promise<void>;
  trashWorkspacePath: (workspaceId: string, path: string) => Promise<void>;

  openFilePreview: (opts: { path: string }) => void;
  closeFilePreview: () => void;
  setCanvasActiveTab: (tab: "preview" | "edit") => void;
  setCanvasShowFormattingBar: (show: boolean) => void;
  setCanvasMaximized: (maximized: boolean) => void;
  loadSpreadsheetWorkbook: (
    path: string,
    opts?: {
      sheetName?: string;
    },
  ) => Promise<SpreadsheetWorkbookSnapshotResult>;
  loadSpreadsheetFileVersion: (path: string) => Promise<SpreadsheetFileVersionResult>;
  patchSpreadsheetWorkbook: (
    path: string,
    operations: SpreadsheetBatchPatchOperation[],
    expectedFileVersion?: SpreadsheetFileVersion,
  ) => Promise<SpreadsheetBatchPatchResult>;
  loadPresentationPreview: (path: string) => Promise<PresentationPreviewResult>;

  setA2uiDockExpanded: (threadId: string, expanded: boolean) => void;
  focusA2uiSurface: (threadId: string, surfaceId: string | null) => void;
  setA2uiActiveRevision: (threadId: string, surfaceId: string, revision: number) => void;
  markA2uiSurfaceSeen: (threadId: string, surfaceId: string, revision: number) => void;
};

type AppStoreActionKeys = {
  [K in keyof AppStoreState]: AppStoreState[K] extends (...args: never[]) => unknown ? K : never;
}[keyof AppStoreState];

export type AppStoreActions = Pick<AppStoreState, AppStoreActionKeys>;
export type AppStoreDataState = Omit<AppStoreState, AppStoreActionKeys>;
export type StoreGet = () => AppStoreState;
export type StoreSet = (
  partial: Partial<AppStoreState> | ((state: AppStoreState) => Partial<AppStoreState>),
) => void;

export { createDefaultUpdaterState };

function pushNotification(notifications: Notification[], entry: Notification): Notification[] {
  const next = [...notifications, entry];
  if (next.length > MAX_NOTIFICATIONS) {
    return next.slice(next.length - MAX_NOTIFICATIONS);
  }
  return next;
}

const { appendThreadTranscript } = createTranscriptBuffer({ nowIso });
const {
  ensureControlSocket,
  disposeAllControlState,
  disposeWorkspaceControlState,
  reactivateWorkspaceControlState,
  waitForControlSession,
  requestWorkspaceSessions,
  requestSessionSnapshot,
  requestJsonRpcControl,
  requestJsonRpcControlEvent,
  __internal: __controlSocketInternal,
} = createControlSocketHelpers({
  nowIso,
  makeId,
  persist,
  pushNotification,
  isProviderName,
});
const {
  disposeAllThreadEventState,
  disposeWorkspaceThreadEventState,
  reactivateWorkspaceThreadEventState,
  ensureThreadSocket,
  sendThread,
  sendUserMessageToThread,
  __internal: __threadEventReducerInternal,
} = createThreadEventReducer({
  nowIso,
  makeId,
  persist,
  appendThreadTranscript,
  pushNotification,
  normalizeThreadTitleSource,
  shouldAdoptServerTitle,
});

function disposeWorkspaceJsonRpcState(get: StoreGet, workspaceId: string) {
  disposeWorkspaceControlState(workspaceId);
  disposeWorkspaceThreadEventState(workspaceId, get);
  disposeWorkspaceJsonRpcSocketState(workspaceId);
}

function reactivateWorkspaceJsonRpcState(workspaceId: string) {
  reactivateWorkspaceControlState(workspaceId);
  reactivateWorkspaceThreadEventState(workspaceId);
  reactivateWorkspaceJsonRpcSocketState(workspaceId);
}

function disposeAllJsonRpcState() {
  for (const socket of [...RUNTIME.jsonRpcSockets.values()]) {
    try {
      socket.close?.();
    } catch {
      // ignore shutdown cleanup failures
    }
  }
  RUNTIME.jsonRpcSockets.clear();
  for (const workspaceId of [...RUNTIME.workspaceJsonRpcSocketGenerations.keys()]) {
    clearWorkspaceJsonRpcSocketGeneration(workspaceId);
  }
  disposeAllControlState();
  disposeAllThreadEventState();
  disposeAllJsonRpcSocketState();
}

async function ensureServerRunning(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  workspaceId: string,
) {
  const ws = get().workspaces.find((workspace) => workspace.id === workspaceId);
  if (!ws) return;
  ensureWorkspaceRuntime(get, set, workspaceId);
  reactivateWorkspaceJsonRpcState(workspaceId);
  const rt = get().workspaceRuntimeById[workspaceId];
  if (!rt) return;
  if (rt.serverUrl && !rt.error) return;

  const inFlight = RUNTIME.workspaceStartPromises.get(workspaceId);
  const generation = getWorkspaceStartGeneration(workspaceId);
  if (inFlight && inFlight.generation === generation) {
    await inFlight.promise;
    return;
  }

  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        starting: true,
        startupProgress: null,
        error: null,
      },
    },
  }));

  const startPromise = (async () => {
    try {
      const res = await startWorkspaceServer({
        workspaceId,
        workspacePath: ws.path,
        yolo: ws.yolo,
        featureFlags: get().desktopFeatureFlags,
        privacyTelemetrySettings: get().privacyTelemetrySettings,
      });
      if (getWorkspaceStartGeneration(workspaceId) !== generation) {
        return;
      }
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            serverUrl: res.url,
            starting: false,
            startupProgress: null,
            error: null,
          },
        },
      }));
    } catch (err) {
      if (getWorkspaceStartGeneration(workspaceId) !== generation) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Workspace server unavailable",
          detail: message,
        }),
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            starting: false,
            startupProgress: null,
            error: message,
          },
        },
      }));
    }
  })();

  RUNTIME.workspaceStartPromises.set(workspaceId, { generation, promise: startPromise });
  try {
    await startPromise;
  } finally {
    const active = RUNTIME.workspaceStartPromises.get(workspaceId);
    if (active?.generation === generation && active.promise === startPromise) {
      RUNTIME.workspaceStartPromises.delete(workspaceId);
    }
  }
}

export {
  __controlSocketInternal,
  __threadEventReducerInternal,
  appendThreadTranscript,
  basename,
  beginThreadSelectionRequest,
  buildContextPreamble,
  bumpWorkspaceJsonRpcSocketGeneration,
  bumpWorkspaceStartGeneration,
  clearPendingThreadSteers,
  clearThreadSelectionRequest,
  clearWorkspaceJsonRpcSocketGeneration,
  clearWorkspaceStartState,
  defaultThreadRuntime,
  defaultWorkspaceRuntime,
  disposeAllJsonRpcState,
  disposeWorkspaceJsonRpcState,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  extractUsageStateFromTranscript,
  isCurrentThreadSelectionRequest,
  isProviderName,
  makeId,
  normalizeThreadTitleSource,
  nowIso,
  persistNow,
  prependPendingThreadMessageWithAttachments,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  RUNTIME,
  reactivateWorkspaceJsonRpcState,
  requestJsonRpcControl,
  requestJsonRpcControlEvent,
  requestSessionSnapshot,
  requestWorkspaceSessions,
  sendThread,
  sendUserMessageToThread,
  shiftPendingThreadAttachments,
  shiftPendingThreadMessage,
  shiftPendingThreadReferences,
  syncDesktopStateCache,
  syncDesktopStateCacheNow,
  truncateTitle,
  waitForControlSession,
};
