import type { runTurn } from "../../agent";
import type {
  ConnectProviderResult,
  connectProvider as connectModelProvider,
  getAiCoworkerPaths,
} from "../../connect";
import type { MCPRegistryServer } from "../../mcp/configRegistry";
import type { loadSystemPromptWithSkills } from "../../prompt";
import type { getProviderStatuses } from "../../providerStatus";
import type { logoutProviderAuth } from "../../providers/authRegistry";
import type { getProviderCatalog } from "../../providers/connectionCatalog";
import type { RuntimeSteerHandler } from "../../runtime/types";
import type { SessionCostTracker, SessionUsageSnapshot } from "../../session/costTracker";
import type { HarnessContextStore } from "../../sessionContext/HarnessContextStore";
import type {
  AgentInspectResult,
  AgentReasoningEffort,
  AgentRole,
  AgentSpawnContextOptions,
  PersistentAgentSummary,
} from "../../shared/agents";
import type { OpenAiCompatibleProviderOptionsByProvider } from "../../shared/openaiCompatibleOptions";
import type { ProviderContinuationState } from "../../shared/providerContinuation";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type {
  TaskContextSnapshot,
  TaskCreationInput,
  TaskCreationResult,
  TaskDirective,
  TaskDirectiveResult,
  TaskReviewMaterialReference,
} from "../../shared/tasks";
import type {
  AgentConfig,
  ChildModelRoutingMode,
  HarnessContextState,
  ModelMessage,
  ReferencedPluginContext,
  ServerErrorCode,
  ServerErrorData,
  ServerErrorSource,
  TodoItem,
  TurnReference,
} from "../../types";
import type { AgentWaitMode, AgentWaitResult } from "../agents/types";
import type { SessionEvent } from "../protocol";
import type {
  SessionBackupHandle,
  SessionBackupInitOptions,
  SessionBackupPublicState,
  WorkspaceBackupDeltaPreview,
  WorkspaceBackupPublicEntry,
} from "../sessionBackup";
import type { SessionDb, SessionPersistenceStatus } from "../sessionDb";
import type { writePersistedSessionSnapshot } from "../sessionStore";
import type { generateSessionTitle } from "../sessionTitleService";

export type SessionBackupFactory = (opts: SessionBackupInitOptions) => Promise<SessionBackupHandle>;

export type PersistedModelSelection = {
  provider: AgentConfig["provider"];
  model: string;
  preferredChildModel: string;
  childModelRoutingMode?: ChildModelRoutingMode;
  preferredChildModelRef?: string;
  allowedChildModelRefs?: string[];
};

export type PersistedProjectConfigPatch = Partial<
  Pick<
    AgentConfig,
    | "provider"
    | "model"
    | "preferredChildModel"
    | "childModelRoutingMode"
    | "preferredChildModelRef"
    | "allowedChildModelRefs"
    | "enableMcp"
    | "enableMemory"
    | "memoryRequireApproval"
    | "advancedMemory"
    | "memoryGenerationModel"
    | "observabilityEnabled"
    | "backupsEnabled"
    | "toolOutputOverflowChars"
    | "userName"
    | "featureFlags"
  >
> & {
  userProfile?: Partial<NonNullable<AgentConfig["userProfile"]>>;
  clearMemoryGenerationModel?: boolean;
  clearToolOutputOverflowChars?: boolean;
  providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
};

export type SessionInfoState = Omit<
  Extract<SessionEvent, { type: "session_info" }>,
  "type" | "sessionId"
>;

export type HydratedSessionState = {
  sessionId: string;
  sessionInfo: SessionInfoState;
  status: SessionPersistenceStatus;
  hasGeneratedTitle: boolean;
  messages: ModelMessage[];
  lastMemoryGeneratedIndex?: number;
  providerState: ProviderContinuationState | null;
  todos: TodoItem[];
  harnessContext: HarnessContextState | null;
  backupsEnabledOverride: boolean | null;
  costTracker: SessionUsageSnapshot | null;
  providerOptions?: AgentConfig["providerOptions"];
};

export type SeededSessionContext = {
  messages: ModelMessage[];
  todos: TodoItem[];
  harnessContext: HarnessContextState | null;
};

type PendingSteer = {
  text: string;
  displayText?: string;
  clientMessageId?: string;
  acceptedAt: string;
  attachments?: import("../jsonrpc/routes/shared").FileAttachment[];
  inputParts?: import("../jsonrpc/routes/shared").OrderedInputPart[];
  references?: TurnReference[];
};

export type SessionRuntimeState = {
  config: AgentConfig;
  system: string;
  discoveredSkills: Array<{ name: string; description: string }>;
  systemPromptMetadataLoaded: boolean;
  yolo: boolean;
  messages: ModelMessage[];
  allMessages: ModelMessage[];
  providerState: ProviderContinuationState | null;
  running: boolean;
  connecting: boolean;
  abortController: AbortController | null;
  currentTurnId: string | null;
  acceptingSteers: boolean;
  activeSteerHandler: RuntimeSteerHandler | null;
  pendingSteers: PendingSteer[];
  pendingExternalSkillRefreshReason: string | null;
  currentTurnOutcome: "completed" | "cancelled" | "error";
  maxSteps: number;
  todos: TodoItem[];
  sessionInfo: SessionInfoState;
  persistenceStatus: SessionPersistenceStatus;
  hasGeneratedTitle: boolean;
  backupsEnabledOverride: boolean | null;
  sessionBackup: SessionBackupHandle | null;
  sessionBackupState: SessionBackupPublicState;
  sessionBackupInit: Promise<void> | null;
  backupOperationQueue: Promise<void>;
  lastAutoCheckpointAt: number;
  /**
   * Index into `allMessages` marking how far advanced-memory generation has
   * consumed. After each completed turn the generator processes the slice from
   * here to the end, then advances this marker. Reading from the untrimmed
   * `allMessages` keeps generation correct across runtime-view trimming.
   */
  lastMemoryGeneratedIndex: number;
  /**
   * Successful automatic advanced-memory generation passes since the last
   * successful folder consolidation. In-memory only; resets when a live session
   * is recreated.
   */
  memoryGenerationsSinceConsolidation: number;
  costTracker: SessionCostTracker | null;
  /**
   * Monotonic counter for synthetic referenced-skill tool calls within the active
   * turn. Reset at turn start so late steers cannot reuse IDs from the initial
   * turn reference injection.
   */
  turnReferenceInjectionCounter: number;
  /**
   * Plugins the user @-mentioned for the active turn, resolved against the plugin
   * catalog. Turn-scoped (set before the run loop, cleared when the turn settles)
   * and read by `runTurnInvocation` to render the soft-awareness system block.
   */
  turnReferencedPlugins?: ReferencedPluginContext[];
};

export type SessionDependencies = {
  connectProviderImpl: typeof connectModelProvider;
  getAiCoworkerPathsImpl: typeof getAiCoworkerPaths;
  loadSystemPromptWithSkillsImpl: typeof loadSystemPromptWithSkills;
  getProviderCatalogImpl: typeof getProviderCatalog;
  getProviderStatusesImpl: typeof getProviderStatuses;
  logoutProviderAuthImpl?: typeof logoutProviderAuth;
  sessionBackupFactory: SessionBackupFactory;
  harnessContextStore: HarnessContextStore;
  runTurnImpl: typeof runTurn;
  persistModelSelectionImpl?: (selection: PersistedModelSelection) => Promise<void> | void;
  persistProjectConfigPatchImpl?: (patch: PersistedProjectConfigPatch) => Promise<void> | void;
  generateSessionTitleImpl: typeof generateSessionTitle;
  sessionDb: SessionDb | null;
  toolEnv?: Record<string, string | undefined>;
  getTaskContextImpl?: (sessionId: string) => TaskContextSnapshot | null;
  getTaskReviewMaterialImpl?: (sessionId: string) => Promise<TaskReviewMaterialReference | null>;
  applyTaskDirectiveImpl?: (
    sessionId: string,
    directive: TaskDirective,
  ) => Promise<TaskDirectiveResult>;
  createTaskImpl?: (sessionId: string, input: TaskCreationInput) => Promise<TaskCreationResult>;
  writePersistedSessionSnapshotImpl: typeof writePersistedSessionSnapshot;
  createAgentSessionImpl?: (
    opts: AgentSpawnContextOptions & {
      parentSessionId: string;
      parentConfig: AgentConfig;
      message: string;
      role?: AgentRole;
      profileRef?: string;
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
      parentDepth?: number;
    },
  ) => Promise<PersistentAgentSummary>;
  listAgentSessionsImpl?: (parentSessionId: string) => Promise<PersistentAgentSummary[]>;
  sendAgentInputImpl?: (opts: {
    parentSessionId: string;
    agentId: string;
    message: string;
    interrupt?: boolean;
  }) => Promise<void>;
  waitForAgentImpl?: (opts: {
    parentSessionId: string;
    agentIds: string[];
    timeoutMs?: number;
    mode?: AgentWaitMode;
    includeFinalMessage?: boolean;
    includeReport?: boolean;
  }) => Promise<AgentWaitResult>;
  inspectAgentImpl?: (opts: {
    parentSessionId: string;
    agentId: string;
  }) => Promise<AgentInspectResult>;
  resumeAgentImpl?: (opts: {
    parentSessionId: string;
    agentId: string;
  }) => Promise<PersistentAgentSummary>;
  closeAgentImpl?: (opts: {
    parentSessionId: string;
    agentId: string;
  }) => Promise<PersistentAgentSummary>;
  cancelAgentSessionsImpl?: (
    parentSessionId: string,
    opts?: { timeoutMs?: number },
  ) => void | Promise<void>;
  deleteSessionImpl?: (opts: {
    requesterSessionId: string;
    targetSessionId: string;
  }) => Promise<void>;
  listWorkspaceBackupsImpl?: (opts: {
    requesterSessionId: string;
    workingDirectory: string;
  }) => Promise<WorkspaceBackupPublicEntry[]>;
  createWorkspaceBackupCheckpointImpl?: (opts: {
    requesterSessionId: string;
    workingDirectory: string;
    targetSessionId: string;
  }) => Promise<WorkspaceBackupPublicEntry[]>;
  restoreWorkspaceBackupImpl?: (opts: {
    requesterSessionId: string;
    workingDirectory: string;
    targetSessionId: string;
    checkpointId?: string;
  }) => Promise<WorkspaceBackupPublicEntry[]>;
  deleteWorkspaceBackupCheckpointImpl?: (opts: {
    requesterSessionId: string;
    workingDirectory: string;
    targetSessionId: string;
    checkpointId: string;
  }) => Promise<WorkspaceBackupPublicEntry[]>;
  deleteWorkspaceBackupEntryImpl?: (opts: {
    requesterSessionId: string;
    workingDirectory: string;
    targetSessionId: string;
  }) => Promise<WorkspaceBackupPublicEntry[]>;
  getWorkspaceBackupDeltaImpl?: (opts: {
    requesterSessionId: string;
    workingDirectory: string;
    targetSessionId: string;
    checkpointId: string;
  }) => Promise<WorkspaceBackupDeltaPreview>;
  getLiveSessionSnapshotImpl?: (sessionId: string) => SessionSnapshot | null;
  getLiveSessionWorkingDirectoryImpl?: (sessionId: string) => string | null;
  getLiveSessionParentIdImpl?: (sessionId: string) => string | null;
  buildLegacySessionSnapshotImpl?: (
    record: import("../sessionDb").PersistedSessionRecord,
  ) => SessionSnapshot;
  getSkillMutationBlockReasonImpl?: (workingDirectory: string) => string | null;
  readSkillCatalogMtimeSnapshotImpl?: (config: AgentConfig) => Promise<string>;
  refreshSkillsAcrossWorkspaceSessionsImpl?: (opts: {
    workingDirectory: string;
    sourceSessionId: string;
    allWorkspaces?: boolean;
  }) => Promise<void>;
};

export type SessionContext = {
  id: string;
  state: SessionRuntimeState;
  deps: SessionDependencies;
  emit: (evt: SessionEvent) => void;
  emitError: (
    code: ServerErrorCode,
    source: ServerErrorSource,
    message: string,
    data?: ServerErrorData,
  ) => void;
  emitTelemetry: (
    name: string,
    status: "ok" | "error",
    attributes?: Record<string, string | number | boolean>,
    durationMs?: number,
  ) => void;
  formatError: (err: unknown) => string;
  guardBusy: () => boolean;
  getCoworkPaths: () => ReturnType<typeof getAiCoworkerPaths>;
  runProviderConnect: (
    opts: Parameters<typeof connectModelProvider>[0],
  ) => Promise<ConnectProviderResult>;
  getMcpServerByName: (nameRaw: string) => Promise<MCPRegistryServer | null>;
  queuePersistSessionSnapshot: (reason: string) => void;
  updateSessionInfo: (
    patch: Partial<SessionInfoState>,
    opts?: { queuePersistSessionSnapshot?: boolean },
  ) => void;
  emitConfigUpdated: () => void;
  syncSessionBackupAvailability: () => Promise<void>;
  refreshProviderStatus: (opts?: { refreshBedrockDiscovery?: boolean }) => Promise<void>;
  emitProviderCatalog: (opts?: { refresh?: boolean }) => Promise<void>;
  emitMcpServers?: () => Promise<void>;
  getSkillMutationBlockReason: () => string | null;
  refreshSkillsAcrossWorkspaceSessions: (opts?: { allWorkspaces?: boolean }) => Promise<void>;
};
