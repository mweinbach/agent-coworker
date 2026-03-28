import type { connectProvider as connectModelProvider, ConnectProviderResult, getAiCoworkerPaths } from "../../connect";
import type { loadSystemPromptWithSkills } from "../../prompt";
import type { SessionCostTracker, SessionUsageSnapshot } from "../../session/costTracker";
import type { runTurn } from "../../agent";
import type { HarnessContextStore } from "../../harness/contextStore";
import type { MCPRegistryServer } from "../../mcp/configRegistry";
import type { getProviderCatalog } from "../../providers/connectionCatalog";
import type { getProviderStatuses } from "../../providerStatus";
import type { OpenAiCompatibleProviderOptionsByProvider } from "../../shared/openaiCompatibleOptions";
import type { ProviderContinuationState } from "../../shared/providerContinuation";
import type { AgentReasoningEffort, PersistentAgentSummary, AgentRole } from "../../shared/agents";
import type {
  AgentConfig,
  ChildModelRoutingMode,
  HarnessContextState,
  ModelMessage,
  ServerErrorCode,
  ServerErrorSource,
  TodoItem,
} from "../../types";
import type { ServerEvent } from "../protocol";
import type {
  SessionBackupHandle,
  SessionBackupInitOptions,
  SessionBackupPublicState,
  WorkspaceBackupDeltaPreview,
  WorkspaceBackupPublicEntry,
} from "../sessionBackup";
import type { SessionDb, SessionPersistenceStatus } from "../sessionDb";
import type { generateSessionTitle, SessionTitleSource } from "../sessionTitleService";
import type { writePersistedSessionSnapshot } from "../sessionStore";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";

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
    | "observabilityEnabled"
    | "backupsEnabled"
    | "toolOutputOverflowChars"
    | "userName"
  >
> & {
  userProfile?: Partial<NonNullable<AgentConfig["userProfile"]>>;
  clearToolOutputOverflowChars?: boolean;
  providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
};

export type SessionInfoState = Omit<Extract<ServerEvent, { type: "session_info" }>, "type" | "sessionId">;

export type HydratedSessionState = {
  sessionId: string;
  sessionInfo: SessionInfoState;
  status: SessionPersistenceStatus;
  hasGeneratedTitle: boolean;
  messages: ModelMessage[];
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

export type PendingSteer = {
  text: string;
  displayText?: string;
  clientMessageId?: string;
  acceptedAt: string;
  attachments?: import("../jsonrpc/routes/shared").FileAttachment[];
  inputParts?: import("../jsonrpc/routes/shared").OrderedInputPart[];
};

export type SessionRuntimeState = {
  config: AgentConfig;
  system: string;
  discoveredSkills: Array<{ name: string; description: string }>;
  yolo: boolean;
  messages: ModelMessage[];
  allMessages: ModelMessage[];
  providerState: ProviderContinuationState | null;
  running: boolean;
  connecting: boolean;
  abortController: AbortController | null;
  currentTurnId: string | null;
  acceptingSteers: boolean;
  pendingSteers: PendingSteer[];
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
  costTracker: SessionCostTracker | null;
};

export type SessionDependencies = {
  connectProviderImpl: typeof connectModelProvider;
  getAiCoworkerPathsImpl: typeof getAiCoworkerPaths;
  loadSystemPromptWithSkillsImpl: typeof loadSystemPromptWithSkills;
  getProviderCatalogImpl: typeof getProviderCatalog;
  getProviderStatusesImpl: typeof getProviderStatuses;
  sessionBackupFactory: SessionBackupFactory;
  harnessContextStore: HarnessContextStore;
  runTurnImpl: typeof runTurn;
  persistModelSelectionImpl?: (selection: PersistedModelSelection) => Promise<void> | void;
  persistProjectConfigPatchImpl?: (patch: PersistedProjectConfigPatch) => Promise<void> | void;
  generateSessionTitleImpl: typeof generateSessionTitle;
  sessionDb: SessionDb | null;
  writePersistedSessionSnapshotImpl: typeof writePersistedSessionSnapshot;
  createAgentSessionImpl?: (opts: {
    parentSessionId: string;
    parentConfig: AgentConfig;
    message: string;
    role?: AgentRole;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
    forkContext?: boolean;
    parentDepth?: number;
  }) => Promise<PersistentAgentSummary>;
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
  }) => Promise<{ timedOut: boolean; agents: PersistentAgentSummary[] }>;
  resumeAgentImpl?: (opts: {
    parentSessionId: string;
    agentId: string;
  }) => Promise<PersistentAgentSummary>;
  closeAgentImpl?: (opts: {
    parentSessionId: string;
    agentId: string;
  }) => Promise<PersistentAgentSummary>;
  cancelAgentSessionsImpl?: (parentSessionId: string) => void;
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
  buildLegacySessionSnapshotImpl?: (record: import("../sessionDb").PersistedSessionRecord) => SessionSnapshot;
  getSkillMutationBlockReasonImpl?: (workingDirectory: string) => string | null;
  refreshSkillsAcrossWorkspaceSessionsImpl?: (workingDirectory: string) => Promise<void>;
};

export type SessionContext = {
  id: string;
  state: SessionRuntimeState;
  deps: SessionDependencies;
  emit: (evt: ServerEvent) => void;
  emitError: (code: ServerErrorCode, source: ServerErrorSource, message: string) => void;
  emitTelemetry: (
    name: string,
    status: "ok" | "error",
    attributes?: Record<string, string | number | boolean>,
    durationMs?: number
  ) => void;
  formatError: (err: unknown) => string;
  guardBusy: () => boolean;
  getCoworkPaths: () => ReturnType<typeof getAiCoworkerPaths>;
  runProviderConnect: (opts: Parameters<typeof connectModelProvider>[0]) => Promise<ConnectProviderResult>;
  getMcpServerByName: (nameRaw: string) => Promise<MCPRegistryServer | null>;
  queuePersistSessionSnapshot: (reason: string) => void;
  updateSessionInfo: (
    patch: Partial<SessionInfoState>,
    opts?: { queuePersistSessionSnapshot?: boolean },
  ) => void;
  emitConfigUpdated: () => void;
  syncSessionBackupAvailability: () => Promise<void>;
  refreshProviderStatus: () => Promise<void>;
  emitProviderCatalog: () => Promise<void>;
  getSkillMutationBlockReason: () => string | null;
  refreshSkillsAcrossWorkspaceSessions: () => Promise<void>;
};
