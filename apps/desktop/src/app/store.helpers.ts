import type { ArtifactDiff, ArtifactPreview } from "../../../../src/server/artifacts/types";
import type { PresentationPreviewResult } from "../../../../src/server/presentationPreview";
import type {
  AgentProfileCopyInput,
  AgentProfileScope,
  AgentProfileUpsertInput,
} from "../../../../src/shared/agentProfiles";
import type {
  CanvasDocumentCloseResult,
  CanvasDocumentOpenResult,
  CanvasDocumentRevisionResult,
  CanvasDocumentSaveResult,
} from "../../../../src/shared/canvasDocument";
import type {
  CreationPreflightParams,
  CreationPreflightResult,
  CreationRepairAction,
} from "../../../../src/shared/creationReadiness";
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
  type MobileRelayBridgeState,
  type MobileRelayForgetTrustedPhoneInput,
  type MobileRelayUpdateTrustedPhonePermissionsInput,
  type UpdaterState,
  type WorkspaceServerExitedEvent,
  type WorkspaceServerStartupProgress,
} from "../lib/desktopApi";
import {
  getWorkspaceServerStatus,
  startWorkspaceServer,
  stopWorkspaceServer,
} from "../lib/desktopCommands";
import type { NewChatLandingTarget } from "../lib/newChatLanding";
import { fallbackAuthMethods } from "../lib/providerDisplayNames";
import type {
  CodexAppServerInstallStatus,
  ConversationImportSource,
  ConversationPreviewItem,
  ConversationSourceCandidate,
  ConversationSourceRequest,
  ConversationWorkspaceMappingInput,
  ConversationWorkspaceMappingsValidateResult,
  ImportableItem,
  ImportableKind,
  ImportSource,
  MCPServerConfig,
  ProviderName,
  SessionEvent,
  TodoItem,
  TurnReference,
} from "../lib/wsProtocol";
import { PROVIDER_NAMES } from "../lib/wsProtocol";
import type {
  ComposerDraft,
  ComposerDraftAttachment,
  ComposerDraftRevision,
  ComposerDraftRevisionFloor,
  ComposerDraftsByKey,
} from "./composerDrafts";
import type { ComposerSubmissionRequest, ComposerSubmissionsByKey } from "./composerSubmission";
import type { CreationDraftError, TaskCreationDraft } from "./creationDrafts";
import type { ReasoningEffortValue } from "./openaiCompatibleProviderOptions";
import { buildContextPreamble, extractUsageStateFromTranscript } from "./store.feedMapping";
import { createControlSocketHelpers } from "./store.helpers/controlSocket";
import {
  disposeAllJsonRpcSocketState,
  disposeWorkspaceJsonRpcSocketState,
  reactivateWorkspaceJsonRpcSocketState,
} from "./store.helpers/jsonRpcSocket";
import type {
  CreationOperationControl,
  CreationOperationIntent,
} from "./store.helpers/operationIntent";
import { throwIfOperationAborted, waitForOperation } from "./store.helpers/operationIntent";
import { operationError, operationKey, runAcknowledgedOperation } from "./store.helpers/operations";
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
  clearWorkspaceServerRestartStabilityTimer,
  clearWorkspaceStartState,
  type DraftModelSelection,
  defaultThreadRuntime,
  defaultWorkspaceRuntime,
  ensureThreadRuntime,
  ensureWorkspaceRuntime,
  getEffectiveThreadLastEventSeq,
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
  ChatInteraction,
  CloudSyncSettings,
  DesktopSettings,
  LmStudioStartModalState,
  Notification,
  OnboardingStep,
  OperationResult,
  OperationState,
  PersistedOnboardingState,
  PersistedPrivacyTelemetrySettings,
  PersistedProviderUiState,
  PrivacyTelemetrySettings,
  ResearchCard,
  ResearchDetail,
  ResearchSettingsState,
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
const WORKSPACE_SERVER_RESTART_STABLE_DEFAULT_MS = 10_000;
const WORKSPACE_SERVER_RESTART_BACKOFF_BASE_MS = 250;
const WORKSPACE_SERVER_RESTART_BACKOFF_MAX_MS = 5_000;

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

export type BootstrapPhase = "idle" | "loading" | "ready" | "error";
export type BootstrapStage = "restoring-workspace" | "checking-services" | "reconnecting-sessions";
export type AbortableActionOptions = {
  signal?: AbortSignal;
};

export type AppStoreState = {
  ready: boolean;
  bootstrapPhase: BootstrapPhase;
  bootstrapStage: BootstrapStage | null;
  startupError: string | null;
  view: ViewId;

  settingsPage: SettingsPageId;
  lastNonSettingsView: ViewId;

  workspaces: WorkspaceRecord[];
  threads: ThreadRecord[];

  selectedWorkspaceId: string | null;
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

  interactionsByThread: Record<string, ChatInteraction[]>;
  lmStudioStartModal: LmStudioStartModalState | null;
  filePreview: { path: string } | null;
  canvasActiveTab: "preview" | "edit";
  canvasShowFormattingBar: boolean;
  isCanvasMaximized: boolean;
  notifications: Notification[];
  operationsByKey: Record<string, OperationState>;

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

  composerDraftsByKey: ComposerDraftsByKey;
  composerDraftRevisionFloorByKey: Record<string, ComposerDraftRevisionFloor>;
  composerAttachmentIngestionCountByKey: Record<string, number>;
  composerSubmissionsByKey: ComposerSubmissionsByKey;
  newChatLandingTarget: NewChatLandingTarget | null;
  quickChatPreparedWorkspaceId: string | null;
  researchCreationDraft: ComposerDraft;
  researchCreationError: CreationDraftError | null;
  taskCreationDraft: TaskCreationDraft;
  taskCreationError: CreationDraftError | null;
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
  invalidateBootstrap: () => void;
  drainBootstrap: () => Promise<void>;

  openSettings: (page?: SettingsPageId) => void;
  closeSettings: () => void;
  setSettingsPage: (page: SettingsPageId) => void;

  addWorkspace: (options?: { intent?: CreationOperationIntent }) => Promise<void>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  selectWorkspace: (
    workspaceId: string,
    options?: AbortableActionOptions & { intent?: CreationOperationIntent },
  ) => Promise<void>;
  reorderWorkspaces: (sourceWorkspaceId: string, targetWorkspaceId: string) => Promise<void>;
  setWorkspacesOrder: (orderedIds: string[]) => Promise<void>;

  newThread: (
    opts?: {
      workspaceId?: string;
      scope?: "oneOff" | "project";
      titleHint?: string;
      firstMessage?: string;
      references?: import("../lib/wsProtocol").TurnReference[];
      mode?: "draft" | "session";
      attachments?: import("./store.helpers/jsonRpcSocket").FileAttachmentInput[];
      attachmentFiles?: File[];
      draftAttachments?: ComposerDraftAttachment[];
      provider?: ProviderName;
      model?: string;
      reasoningEffort?: ReasoningEffortValue;
      draftSubmission?: ComposerDraftRevision;
      clientMessageId?: string;
    } & CreationOperationControl,
  ) => Promise<boolean>;
  openNewChatLanding: (opts?: {
    defaultTargetKind?: "project" | "oneOff";
    target?: NewChatLandingTarget;
  }) => Promise<void>;
  setNewChatLandingTarget: (target: NewChatLandingTarget) => void;
  preflightCreation: (
    request: CreationPreflightParams & { workspaceId?: string },
    options?: AbortableActionOptions,
  ) => Promise<CreationPreflightResult>;
  repairCreationReadiness: (action: CreationRepairAction, workspaceId?: string) => Promise<void>;
  releasePreparedQuickChatWorkspace: () => Promise<void>;
  removeThread: (threadId: string) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  restoreThread: (threadId: string) => Promise<void>;
  deleteThreadHistory: (threadId: string) => Promise<void>;
  selectThread: (threadId: string, options?: AbortableActionOptions) => Promise<void>;
  reconnectThread: (
    threadId: string,
    firstMessage?: string,
    opts?: {
      selectionRequestId?: number;
      skipWorkspaceSelect?: boolean;
      attachments?: import("./store.helpers/jsonRpcSocket").FileAttachmentInput[];
      references?: import("../lib/wsProtocol").TurnReference[];
      refreshSnapshot?: boolean;
      signal?: AbortSignal;
      draftSubmission?: ComposerDraftRevision;
      clientMessageId?: string;
    },
  ) => Promise<boolean>;
  reconnectThreadWithFeedback: (threadId: string) => Promise<OperationResult<void>>;
  renameThread: (threadId: string, newTitle: string) => void;

  sendMessage: (
    text: string,
    busyPolicy?: ThreadBusyPolicy,
    attachments?: import("./store.helpers/jsonRpcSocket").FileAttachmentInput[],
    references?: import("../lib/wsProtocol").TurnReference[],
    options?: {
      targetThreadId?: string;
      draftSubmission?: ComposerDraftRevision;
      clientMessageId?: string;
      retryToolItemIds?: string[];
    },
  ) => Promise<boolean>;
  submitComposerDraft: (
    request: ComposerSubmissionRequest,
    control?: CreationOperationControl,
  ) => boolean;
  retryComposerSubmission: (key?: string, control?: CreationOperationControl) => boolean;
  cancelComposerSubmission: (key?: string) => boolean;
  editAcceptedComposerSubmission: (key?: string) => boolean;
  dismissComposerSubmission: (key?: string) => void;
  completeComposerSubmission: (owner: ComposerDraftRevision) => void;
  failComposerSubmission: (submissionId: string, error: unknown) => void;
  cancelThread: (threadId: string, opts?: { includeSubagents?: boolean }) => boolean;
  clearThreadUsageHardCap: (threadId: string) => void;
  setThreadModel: (threadId: string, provider: ProviderName, model: string) => void;
  setThreadReasoningEffort: (
    threadId: string,
    provider: ProviderName,
    effort: ReasoningEffortValue,
  ) => void;
  setComposerText: (text: string, references?: TurnReference[]) => void;
  addComposerAttachments: (files: File[]) => Promise<void>;
  removeComposerAttachment: (index: number) => void;
  setComposerDraftModel: (provider: ProviderName, model: string) => void;
  setComposerDraftReasoningEffort: (effort: ReasoningEffortValue | null) => void;
  clearComposerDraft: (owner: ComposerDraftRevision) => boolean;
  discardComposerDraft: (key?: string) => boolean;
  pruneComposerDrafts: (nowMs?: number, maxAgeMs?: number) => void;
  setInjectContext: (v: boolean) => void;
  setDeveloperMode: (v: boolean) => void;
  setShowHiddenFiles: (v: boolean) => void;
  setPerWorkspaceSettings: (enabled: boolean) => void;
  setQuickChatIconEnabled: (enabled: boolean) => void;
  setArchivedChatsAutoDeleteDays: (days: number) => void;
  setQuickChatShortcutEnabled: (enabled: boolean) => void;
  setQuickChatShortcutAccelerator: (accelerator: string) => void;
  setSidebarSectionOrder: (orderedSections: SidebarSectionKey[]) => void;
  setCrashReportsEnabled: (enabled: boolean) => Promise<OperationResult>;
  setProductAnalyticsEnabled: (enabled: boolean) => Promise<OperationResult>;
  setAiTraceTelemetryEnabled: (enabled: boolean) => Promise<OperationResult>;
  setAiTracePayloadsEnabled: (enabled: boolean) => Promise<OperationResult>;
  setDiagnosticsUploadEnabled: (enabled: boolean) => Promise<OperationResult>;
  setCloudSyncEnabled: (enabled: boolean) => Promise<OperationResult>;
  setPrivacyTelemetrySettings: (
    patch: PersistedPrivacyTelemetrySettings,
  ) => Promise<OperationResult>;
  forgetRemoteAccessTrustedPhones: (
    input: MobileRelayForgetTrustedPhoneInput,
  ) => Promise<OperationResult<MobileRelayBridgeState>>;
  updateRemoteAccessTrustedPhonePermissions: (
    input: MobileRelayUpdateTrustedPhonePermissionsInput,
  ) => Promise<OperationResult<MobileRelayBridgeState>>;
  setDesktopFeatureFlagOverride: (flagId: DesktopFeatureFlagId, enabled: boolean) => Promise<void>;
  setUpdateState: (state: UpdaterState) => void;
  checkForUpdates: () => Promise<void>;
  quitAndInstallUpdate: () => Promise<void>;

  openSkills: () => Promise<void>;
  openResearch: () => Promise<void>;
  listConversationImportSources: (params?: {
    sources?: ConversationSourceRequest[];
    includeCodex?: boolean;
    includeClaudeCode?: boolean;
    includeCowork?: boolean;
    explicitPaths?: string[];
  }) => Promise<{ sources: ConversationSourceCandidate[] }>;
  previewConversationImports: (params?: {
    sources?: ConversationSourceRequest[];
    includeCodex?: boolean;
    includeClaudeCode?: boolean;
    includeCowork?: boolean;
    explicitPaths?: string[];
    limit?: number;
    includeArchived?: boolean;
  }) => Promise<{ conversations: ConversationPreviewItem[] }>;
  validateConversationWorkspaceMappings: (params: {
    mappings: Record<string, ConversationWorkspaceMappingInput>;
  }) => Promise<ConversationWorkspaceMappingsValidateResult>;
  importConversations: (params: {
    sources?: ConversationSourceRequest[];
    includeCodex?: boolean;
    includeClaudeCode?: boolean;
    includeCowork?: boolean;
    explicitPaths?: string[];
    selected: Array<{ source: ConversationImportSource; fingerprint: string }>;
    mappings?: Record<string, ConversationWorkspaceMappingInput>;
    defaultProvider?: ProviderName;
    defaultModel?: string;
    mode?: "skip-existing";
    includeArchived?: boolean;
  }) => Promise<{
    imported: Array<{
      source: ConversationImportSource;
      fingerprint: string;
      threadId: string;
      workspaceId: string | null;
      workspacePath: string;
      title: string;
    }>;
    skipped: Array<{
      source: ConversationImportSource;
      fingerprint: string;
      existingThreadId: string;
      reason: "already_imported";
    }>;
    failed: Array<{ source: ConversationImportSource; fingerprint: string; message: string }>;
    createdWorkspaces: Array<{ workspaceId: string; path: string; name: string }>;
  }>;
  openNewTask: (workspaceId?: string) => Promise<void>;
  refreshTasks: (workspaceId?: string, options?: AbortableActionOptions) => Promise<void>;
  startTask: (
    opts: {
      workspaceId: string;
      task: TaskCreationInput;
      draftRevision?: number;
    } & CreationOperationControl,
  ) => Promise<OperationResult<TaskRecord>>;
  setTaskCreationDraft: (
    patch: Partial<Omit<TaskCreationDraft, "revision" | "updatedAt" | "idempotencyKey">>,
  ) => void;
  setTaskCreationError: (revision: number, message: string | null) => boolean;
  clearTaskCreationDraft: (revision: number) => boolean;
  selectTask: (
    taskId: string,
    options?: AbortableActionOptions & { preserveView?: boolean },
  ) => Promise<void>;
  selectTaskThread: (taskId: string, taskThreadId: string) => Promise<void>;
  createTaskThread: (
    taskId: string,
    title: string,
    workItemId?: string,
    options?: CreationOperationControl,
  ) => Promise<OperationResult>;
  updateTaskBrief: (
    taskId: string,
    patch: { title?: string; objective?: string },
  ) => Promise<OperationResult>;
  acceptTask: (taskId: string) => Promise<OperationResult>;
  requestTaskChanges: (taskId: string, feedback: string) => Promise<OperationResult>;
  cancelTask: (taskId: string, reason?: string) => Promise<OperationResult>;
  reopenTask: (taskId: string, reason?: string) => Promise<OperationResult>;
  retryTask: (taskId: string) => Promise<OperationResult>;
  resolveTaskQuestions: (
    taskId: string,
    answers: TaskQuestionAnswerInput[],
  ) => Promise<OperationResult<TaskQuestionResumeStatus>>;
  readTaskArtifact: (taskId: string, artifactId: string) => Promise<TaskArtifactDetail | null>;
  captureTaskArtifactVersion: (
    taskId: string,
    artifactId: string,
    changeSummary?: string,
  ) => Promise<OperationResult<TaskArtifactDetail>>;
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
  ) => Promise<OperationResult<TaskArtifactDetail>>;
  acceptTaskArtifactVersion: (
    taskId: string,
    artifactId: string,
    versionId?: string,
  ) => Promise<OperationResult<TaskArtifactDetail>>;
  startTaskArtifactRevision: (
    taskId: string,
    artifactId: string,
    baseVersionId: string,
    instruction: string,
  ) => Promise<OperationResult<TaskArtifactDetail>>;
  refreshSkillsCatalog: (workspaceId?: string) => Promise<void>;
  refreshAgentProfilesCatalog: (workspaceId?: string) => Promise<void>;
  upsertAgentProfile: (
    profile: AgentProfileUpsertInput,
    workspaceId?: string,
  ) => Promise<OperationResult>;
  deleteAgentProfile: (
    scope: AgentProfileScope,
    id: string,
    workspaceId?: string,
  ) => Promise<OperationResult>;
  copyAgentProfile: (copy: AgentProfileCopyInput, workspaceId?: string) => Promise<OperationResult>;
  setAgentProfileWorkspaceAvailability: (
    id: string,
    disabled: boolean,
    workspaceId?: string,
  ) => Promise<OperationResult>;
  refreshPluginsCatalog: () => Promise<void>;
  selectPlugin: (pluginId: string | null, scope?: "workspace" | "user" | null) => Promise<void>;
  previewPluginInstall: (sourceInput: string, targetScope: "workspace" | "user") => Promise<void>;
  installPlugins: (
    sourceInput: string,
    targetScope: "workspace" | "user",
  ) => Promise<OperationResult>;
  enablePlugin: (pluginId: string, scope?: "workspace" | "user") => Promise<OperationResult>;
  disablePlugin: (pluginId: string, scope?: "workspace" | "user") => Promise<OperationResult>;
  deletePlugin: (pluginId: string, scope?: "workspace" | "user") => Promise<OperationResult>;
  checkPluginUpdate: (pluginId: string, scope?: "workspace" | "user") => Promise<void>;
  updatePlugin: (pluginId: string, scope?: "workspace" | "user") => Promise<OperationResult>;
  dismissPluginMutationError: (workspaceId?: string) => void;
  listImportable: (source: ImportSource, kind: ImportableKind) => Promise<void>;
  importPlugin: (
    item: ImportableItem,
    targetScope: "workspace" | "user",
  ) => Promise<OperationResult>;
  importSkill: (
    item: ImportableItem,
    targetScope: "workspace" | "user",
  ) => Promise<OperationResult>;
  selectSkill: (skillName: string) => Promise<void>;
  selectSkillInstallation: (installationId: string | null) => Promise<void>;
  previewSkillInstall: (sourceInput: string, targetScope: "project" | "global") => Promise<void>;
  installSkills: (
    sourceInput: string,
    targetScope: "project" | "global",
  ) => Promise<OperationResult>;
  disableSkill: (skillName: string) => Promise<OperationResult>;
  enableSkill: (skillName: string) => Promise<OperationResult>;
  deleteSkill: (skillName: string) => Promise<OperationResult>;
  disableSkillInstallation: (installationId: string) => Promise<OperationResult>;
  enableSkillInstallation: (installationId: string) => Promise<OperationResult>;
  deleteSkillInstallation: (installationId: string) => Promise<OperationResult>;
  copySkillInstallation: (
    installationId: string,
    targetScope: "project" | "global",
  ) => Promise<OperationResult>;
  checkSkillInstallationUpdate: (installationId: string) => Promise<void>;
  updateSkillInstallation: (installationId: string) => Promise<OperationResult>;
  dismissSkillMutationError: (workspaceId?: string) => void;
  refreshMarketplaces: (workspaceId?: string) => Promise<void>;
  selectMarketplace: (id: string | null) => Promise<void>;
  readMarketplaceDetail: (id: string, workspaceId?: string) => Promise<void>;
  addMarketplace: (sourceInput: string) => Promise<OperationResult>;
  removeMarketplace: (id: string) => Promise<OperationResult>;
  dismissMarketplaceMutationError: (workspaceId?: string) => void;

  refreshResearchList: () => Promise<void>;
  selectResearch: (researchId: string | null) => Promise<void>;
  startResearch: (
    opts: {
      input: string;
      title?: string;
      files?: File[];
      settings?: Partial<ResearchSettingsState>;
      draftRevision?: number;
      clientResearchId?: string;
    } & CreationOperationControl,
  ) => Promise<OperationResult<ResearchCard>>;
  setResearchCreationInput: (input: string) => void;
  addResearchCreationAttachments: (files: File[]) => Promise<void>;
  removeResearchCreationAttachment: (index: number) => void;
  setResearchCreationError: (revision: number, message: string | null) => boolean;
  clearResearchCreationDraft: (revision: number) => boolean;
  cancelResearch: (researchId: string) => Promise<OperationResult>;
  renameResearch: (researchId: string, title: string) => Promise<OperationResult>;
  deleteResearch: (researchId: string) => Promise<OperationResult>;
  sendResearchFollowUp: (opts: {
    parentResearchId: string;
    input: string;
    title?: string;
    files?: File[];
    settings?: Partial<ResearchSettingsState>;
  }) => Promise<OperationResult<ResearchCard>>;
  setResearchDraftSettings: (patch: Partial<ResearchSettingsState>) => void;
  exportResearch: (
    researchId: string,
    format: import("../../../../src/server/research/types").ResearchExportFormat,
  ) => Promise<OperationResult<string | null>>;
  approveResearchPlan: (researchId: string) => Promise<OperationResult<ResearchCard>>;
  refineResearchPlan: (researchId: string, input: string) => Promise<OperationResult<ResearchCard>>;

  applyWorkspaceDefaultsToThread: (
    threadId: string,
    mode?: "auto" | "auto-resume" | "explicit",
    draftModelSelection?: DraftModelSelection | null,
    opts?: { allowBeforeHydration?: boolean },
  ) => Promise<void>;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: WorkspaceDefaultsPatch,
    opts?: { scope?: "settings" | "target" },
  ) => Promise<OperationResult>;
  restartWorkspaceServer: (workspaceId: string) => Promise<void>;
  handleWorkspaceServerExited: (event: WorkspaceServerExitedEvent) => void;
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
  ) => Promise<OperationResult>;
  deleteWorkspaceMcpServer: (
    workspaceId: string,
    name: string,
    source?: "workspace" | "user",
  ) => Promise<OperationResult>;
  setWorkspaceMcpServerEnabled: (
    workspaceId: string,
    server: {
      name: string;
      source: "workspace" | "user" | "plugin" | "system";
      enabled: boolean;
      pluginId?: string;
      pluginScope?: "workspace" | "user";
    },
  ) => Promise<OperationResult>;
  validateWorkspaceMcpServer: (
    workspaceId: string,
    name: string,
    source?: "workspace" | "user" | "plugin" | "system",
    plugin?: { pluginId?: string; pluginScope?: "workspace" | "user" },
  ) => Promise<OperationResult>;
  authorizeWorkspaceMcpServerAuth: (
    workspaceId: string,
    name: string,
    source?: "workspace" | "user" | "plugin" | "system",
    plugin?: { pluginId?: string; pluginScope?: "workspace" | "user" },
  ) => Promise<OperationResult>;
  callbackWorkspaceMcpServerAuth: (
    workspaceId: string,
    name: string,
    code?: string,
    source?: "workspace" | "user" | "plugin" | "system",
    plugin?: { pluginId?: string; pluginScope?: "workspace" | "user" },
  ) => Promise<OperationResult>;
  setWorkspaceMcpServerApiKey: (
    workspaceId: string,
    name: string,
    apiKey: string,
    source?: "workspace" | "user" | "plugin" | "system",
    plugin?: { pluginId?: string; pluginScope?: "workspace" | "user" },
  ) => Promise<OperationResult>;
  requestOpenAiNativeConnectors: (workspaceId: string) => Promise<void>;
  refreshOpenAiNativeConnectors: (workspaceId: string) => Promise<void>;
  setOpenAiNativeConnectorEnabled: (
    workspaceId: string,
    connectorId: string,
    enabled: boolean,
  ) => Promise<OperationResult>;
  requestWorkspaceBackups: (workspaceId: string) => Promise<void>;
  requestWorkspaceBackupDelta: (
    workspaceId: string,
    targetSessionId: string,
    checkpointId: string,
  ) => Promise<void>;
  createWorkspaceBackupCheckpoint: (
    workspaceId: string,
    targetSessionId: string,
  ) => Promise<OperationResult>;
  restoreWorkspaceBackupOriginal: (
    workspaceId: string,
    targetSessionId: string,
  ) => Promise<OperationResult>;
  restoreWorkspaceBackupCheckpoint: (
    workspaceId: string,
    targetSessionId: string,
    checkpointId: string,
  ) => Promise<OperationResult>;
  deleteWorkspaceBackupCheckpoint: (
    workspaceId: string,
    targetSessionId: string,
    checkpointId: string,
  ) => Promise<OperationResult>;
  deleteWorkspaceBackupEntry: (
    workspaceId: string,
    targetSessionId: string,
  ) => Promise<OperationResult>;
  setWorkspaceBackupSessionEnabled: (
    workspaceId: string,
    targetSessionId: string,
    enabled: boolean,
  ) => Promise<OperationResult>;

  requestWorkspaceMemories: (workspaceId: string, opts?: { cwd?: string }) => Promise<void>;
  upsertWorkspaceMemory: (
    workspaceId: string,
    scope: "workspace" | "user",
    id: string | undefined,
    content: string,
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;
  deleteWorkspaceMemory: (
    workspaceId: string,
    scope: "workspace" | "user",
    id: string,
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;

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
  ) => Promise<OperationResult>;
  deleteAdvancedMemory: (
    workspaceId: string,
    folder: string | undefined,
    slug: string,
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;
  generateAdvancedMemoryForThread: (
    workspaceId: string,
    threadId: string,
    opts?: { cwd?: string; folder?: string },
  ) => Promise<OperationResult>;
  setWorkspaceAdvancedMemory: (
    workspaceId: string,
    advancedMemory: boolean,
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;
  setWorkspaceMemoryGenerationModel: (
    workspaceId: string,
    model: string,
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;
  requestSkillImprovementStatus: (workspaceId: string, opts?: { cwd?: string }) => Promise<void>;
  runSkillImprovement: (
    workspaceId: string,
    skillName?: string,
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;
  restoreSkillImprovement: (
    workspaceId: string,
    skillName: string,
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;
  setWorkspaceSkillImprovementEnabled: (
    workspaceId: string,
    enabled: boolean,
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;
  setWorkspaceSkillImprovementModel: (
    workspaceId: string,
    model: string,
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;
  setWorkspaceSkillImprovementScope: (
    workspaceId: string,
    scope: "user" | "all",
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;
  setWorkspaceSkillImprovementExcludedSkills: (
    workspaceId: string,
    excludedSkills: string[],
    opts?: { cwd?: string },
  ) => Promise<OperationResult>;

  connectProvider: (provider: ProviderName, apiKey?: string) => Promise<OperationResult>;
  setProviderApiKey: (
    provider: ProviderName,
    methodId: string,
    apiKey: string,
  ) => Promise<OperationResult>;
  setProviderConfig: (
    provider: ProviderName,
    methodId: string,
    values: Record<string, string>,
  ) => Promise<OperationResult>;
  copyProviderApiKey: (
    provider: ProviderName,
    sourceProvider: ProviderName,
  ) => Promise<OperationResult>;
  authorizeProviderAuth: (provider: ProviderName, methodId: string) => Promise<OperationResult>;
  logoutProviderAuth: (provider: ProviderName) => Promise<OperationResult>;
  callbackProviderAuth: (
    provider: ProviderName,
    methodId: string,
    code?: string,
  ) => Promise<OperationResult>;
  requestProviderCatalog: () => Promise<void>;
  requestProviderAuthMethods: () => Promise<void>;
  addCustomProviderModel: (provider: ProviderName, modelId: string) => Promise<OperationResult>;
  deleteCustomProviderModel: (provider: ProviderName, modelId: string) => Promise<OperationResult>;
  setProviderModelsEnabled: (
    provider: ProviderName,
    models: ReadonlyArray<{ id: string; enabled: boolean }>,
  ) => Promise<OperationResult>;
  resetProviderModelPreferences: (provider: ProviderName) => Promise<OperationResult>;
  refreshProviderStatus: (opts?: {
    refreshBedrockDiscovery?: boolean;
    workspaceId?: string;
  }) => Promise<void>;
  checkCodexAppServerStatus: (opts?: { checkLatest?: boolean }) => Promise<void>;
  updateCodexAppServer: (opts?: { force?: boolean }) => Promise<void>;
  checkLibreOfficeRuntime: (opts?: {
    smoke?: boolean;
  }) => Promise<import("../lib/wsProtocol").LibreOfficeRuntimeDiagnostic | null>;
  setLmStudioEnabled: (enabled: boolean) => Promise<OperationResult>;
  setLmStudioModelVisible: (modelId: string, visible: boolean) => Promise<OperationResult>;
  startLmStudioServerAndRetry: () => Promise<void>;
  dismissLmStudioStartModal: () => void;

  loadAllThreadUsage: () => Promise<void>;

  answerAsk: (threadId: string, requestId: string, answer: string) => boolean;
  answerApproval: (threadId: string, requestId: string, approved: boolean) => boolean;
  dismissPrompt: () => void;
  retryInteractionResponse: (threadId: string, requestId: string) => boolean;

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

  openFilePreview: (opts: { path: string }) => Promise<boolean>;
  closeFilePreview: () => Promise<boolean>;
  setCanvasActiveTab: (tab: "preview" | "edit") => void;
  setCanvasShowFormattingBar: (show: boolean) => void;
  setCanvasMaximized: (maximized: boolean) => void;
  openCanvasDocument: (
    workspaceId: string,
    input: {
      path: string;
      documentId: string;
      generation: number;
      maxBytes?: number;
    },
  ) => Promise<CanvasDocumentOpenResult>;
  readCanvasDocumentRevision: (
    workspaceId: string,
    input: { documentId: string; generation: number },
  ) => Promise<CanvasDocumentRevisionResult>;
  saveCanvasDocument: (
    workspaceId: string,
    input: {
      documentId: string;
      generation: number;
      editRevision: number;
      content: string;
    },
  ) => Promise<CanvasDocumentSaveResult>;
  saveCanvasDocumentAs: (
    workspaceId: string,
    input: {
      documentId: string;
      generation: number;
      editRevision: number;
      content: string;
      path: string;
    },
  ) => Promise<CanvasDocumentSaveResult>;
  closeCanvasDocument: (
    workspaceId: string,
    input: { documentId: string; generation: number },
  ) => Promise<CanvasDocumentCloseResult>;
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
  markWorkspaceThreadsDisconnected,
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

function closeWorkspaceJsonRpcSocket(workspaceId: string) {
  const jsonRpcSocket = RUNTIME.jsonRpcSockets.get(workspaceId);
  try {
    jsonRpcSocket?.close?.();
  } catch {
    // ignore stale socket cleanup failures
  }
  RUNTIME.jsonRpcSockets.delete(workspaceId);
}

function markWorkspaceServerStale(
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  message?: string,
) {
  markWorkspaceThreadsDisconnected(get, set, workspaceId);
  bumpWorkspaceJsonRpcSocketGeneration(workspaceId);
  closeWorkspaceJsonRpcSocket(workspaceId);
  disposeWorkspaceJsonRpcState(get, workspaceId);
  set((s) => {
    const runtime = s.workspaceRuntimeById[workspaceId];
    if (!runtime) return {};
    return {
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...runtime,
          serverUrl: null,
          startupProgress: null,
          error: message ?? null,
          controlSessionId: null,
          controlConfig: null,
          controlSessionConfig: null,
        },
      },
    };
  });
}

function syncWorkspaceServerRunningUrl(
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  serverUrl: string | null,
) {
  if (!serverUrl) {
    return;
  }
  const runtime = get().workspaceRuntimeById[workspaceId];
  if (!runtime || runtime.serverUrl === serverUrl) {
    return;
  }
  markWorkspaceThreadsDisconnected(get, set, workspaceId);
  bumpWorkspaceJsonRpcSocketGeneration(workspaceId);
  closeWorkspaceJsonRpcSocket(workspaceId);
  set((s) => {
    const current = s.workspaceRuntimeById[workspaceId];
    if (!current || current.serverUrl === serverUrl) return {};
    return {
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...current,
          serverUrl,
          starting: false,
          startupProgress: null,
          error: null,
          controlSessionId: null,
        },
      },
    };
  });
}

function workspaceServerRestartStableMs(): number {
  const raw =
    typeof process !== "undefined"
      ? process.env.COWORK_WORKSPACE_SERVER_RESTART_STABLE_MS
      : undefined;
  if (!raw) {
    return WORKSPACE_SERVER_RESTART_STABLE_DEFAULT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : WORKSPACE_SERVER_RESTART_STABLE_DEFAULT_MS;
}

function nextWorkspaceServerRestartBackoffMs(workspaceId: string): number {
  clearWorkspaceServerRestartStabilityTimer(workspaceId);
  const attempts = (RUNTIME.workspaceServerRestartAttempts.get(workspaceId) ?? 0) + 1;
  RUNTIME.workspaceServerRestartAttempts.set(workspaceId, attempts);
  return Math.min(
    WORKSPACE_SERVER_RESTART_BACKOFF_MAX_MS,
    WORKSPACE_SERVER_RESTART_BACKOFF_BASE_MS * 2 ** (attempts - 1),
  );
}

function scheduleWorkspaceServerRestartBackoffReset(workspaceId: string): void {
  if (!RUNTIME.workspaceServerRestartAttempts.has(workspaceId)) {
    return;
  }
  clearWorkspaceServerRestartStabilityTimer(workspaceId);
  const timer = setTimeout(() => {
    RUNTIME.workspaceServerRestartAttempts.delete(workspaceId);
    RUNTIME.workspaceServerRestartStabilityTimers.delete(workspaceId);
  }, workspaceServerRestartStableMs());
  RUNTIME.workspaceServerRestartStabilityTimers.set(workspaceId, timer);
}

async function waitForWorkspaceServerRestartBackoff(workspaceId: string): Promise<void> {
  const delayMs = nextWorkspaceServerRestartBackoffMs(workspaceId);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function reactivateWorkspaceJsonRpcState(workspaceId: string) {
  reactivateWorkspaceControlState(workspaceId);
  reactivateWorkspaceThreadEventState(workspaceId);
  reactivateWorkspaceJsonRpcSocketState(workspaceId);
}

let jsonRpcLifecycleGeneration = 0;

function disposeAllJsonRpcState() {
  jsonRpcLifecycleGeneration += 1;
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
  set: StoreSet,
  workspaceId: string,
  options: AbortableActionOptions = {},
) {
  const lifecycleGeneration = jsonRpcLifecycleGeneration;
  const isCurrent = () => jsonRpcLifecycleGeneration === lifecycleGeneration;
  throwIfOperationAborted(options.signal);
  if (!isCurrent()) return;
  const ws = get().workspaces.find((workspace) => workspace.id === workspaceId);
  if (!ws) return;
  if (!isCurrent()) return;
  ensureWorkspaceRuntime(get, set, workspaceId);
  if (!isCurrent()) return;
  reactivateWorkspaceJsonRpcState(workspaceId);
  const rt = get().workspaceRuntimeById[workspaceId];
  if (!rt) return;
  let forceRestart = false;
  if (rt.serverUrl && !rt.error) {
    if (!isCurrent()) return;
    const status = await waitForOperation(
      getWorkspaceServerStatus({ workspaceId }).catch((error) => ({
        workspaceId,
        running: false as const,
        url: rt.serverUrl,
        reason: "health_failed" as const,
        error: error instanceof Error ? error.message : String(error),
      })),
      options.signal,
    );
    if (!isCurrent()) return;
    if (status.running) {
      syncWorkspaceServerRunningUrl(get, set, workspaceId, status.url);
      if (!isCurrent()) return;
      scheduleWorkspaceServerRestartBackoffReset(workspaceId);
      return;
    }
    if (status.reason === "starting") {
      return;
    }
    const message =
      status.reason === "health_failed" && status.error
        ? `Workspace server health check failed: ${status.error}`
        : "Workspace server exited";
    markWorkspaceServerStale(get, set, workspaceId, message);
    bumpWorkspaceStartGeneration(workspaceId);
    if (status.reason === "health_failed") {
      if (!isCurrent()) return;
      try {
        await waitForOperation(stopWorkspaceServer({ workspaceId }), options.signal);
      } catch {
        throwIfOperationAborted(options.signal);
        // ignore; startup below will surface persistent failures
      }
      if (!isCurrent()) return;
    }
    if (!isCurrent()) return;
    await waitForOperation(waitForWorkspaceServerRestartBackoff(workspaceId), options.signal);
    if (!isCurrent()) return;
    reactivateWorkspaceJsonRpcState(workspaceId);
    forceRestart = status.reason === "health_failed";
  }

  if (!isCurrent()) return;
  const inFlight = RUNTIME.workspaceStartPromises.get(workspaceId);
  const generation = getWorkspaceStartGeneration(workspaceId);
  if (inFlight && inFlight.generation === generation) {
    await waitForOperation(inFlight.promise, options.signal);
    return;
  }

  if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      const res = await startWorkspaceServer({
        workspaceId,
        workspacePath: ws.path,
        yolo: ws.yolo,
        forceRestart,
        preserveMobileRelay: true,
        featureFlags: get().desktopFeatureFlags,
        privacyTelemetrySettings: get().privacyTelemetrySettings,
      });
      if (!isCurrent() || getWorkspaceStartGeneration(workspaceId) !== generation) {
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
      if (!isCurrent()) return;
      scheduleWorkspaceServerRestartBackoffReset(workspaceId);
    } catch (err) {
      if (!isCurrent() || getWorkspaceStartGeneration(workspaceId) !== generation) {
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
  const clearStartPromise = () => {
    const active = RUNTIME.workspaceStartPromises.get(workspaceId);
    if (active?.generation === generation && active.promise === startPromise) {
      RUNTIME.workspaceStartPromises.delete(workspaceId);
    }
  };
  void startPromise.then(clearStartPromise, clearStartPromise);
  await waitForOperation(startPromise, options.signal);
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
  getEffectiveThreadLastEventSeq,
  isCurrentThreadSelectionRequest,
  isProviderName,
  makeId,
  markWorkspaceServerStale,
  normalizeThreadTitleSource,
  nowIso,
  operationError,
  operationKey,
  persist,
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
  runAcknowledgedOperation,
  sendThread,
  sendUserMessageToThread,
  shiftPendingThreadAttachments,
  shiftPendingThreadMessage,
  shiftPendingThreadReferences,
  syncDesktopStateCache,
  syncDesktopStateCacheNow,
  truncateTitle,
  waitForControlSession,
  waitForWorkspaceServerRestartBackoff,
};
