import { connectProvider as connectModelProvider, getAiCoworkerPaths, type ConnectProviderResult } from "../../connect";
import { loadSystemPromptWithSkills } from "../../prompt";
import { runTurn } from "../../agent";
import { HarnessContextStore } from "../../harness/contextStore";
import { SessionCostTracker } from "../../session/costTracker";
import type { MCPRegistryServer } from "../../mcp/configRegistry";
import { getProviderCatalog } from "../../providers/connectionCatalog";
import { getProviderStatuses } from "../../providerStatus";
import { defaultSupportedModel, getSupportedModel } from "../../models/registry";
import { getKnownResolvedModelMetadata, isDynamicModelProvider } from "../../models/metadata";
import { MemoryStore, type MemoryScope } from "../../memoryStore";
import type {
  AgentConfig,
  HarnessContextPayload,
  MCPServerConfig,
  ServerErrorCode,
  ServerErrorSource,
} from "../../types";
import type { ServerEvent } from "../protocol";
import {
  SessionBackupManager,
  type SessionBackupHandle,
  type SessionBackupInitOptions,
} from "../sessionBackup";
import {
  type PersistedSessionMutation,
  type PersistedSessionRecord,
  SessionDb,
} from "../sessionDb";
import {
  type PersistedSessionSnapshot,
  writePersistedSessionSnapshot,
} from "../sessionStore";
import { DEFAULT_SESSION_TITLE, generateSessionTitle } from "../sessionTitleService";
import { HistoryManager } from "./HistoryManager";
import { InteractionManager, type PendingPromptReplayEvent } from "./InteractionManager";
import { McpManager } from "./McpManager";
import { PersistenceManager } from "./PersistenceManager";
import { ProviderAuthManager } from "./ProviderAuthManager";
import { ProviderCatalogManager } from "./ProviderCatalogManager";
import { SessionAdminManager } from "./SessionAdminManager";
import { SessionBackupController } from "./SessionBackupController";
import type {
  HydratedSessionState,
  PersistedModelSelection,
  PersistedProjectConfigPatch,
  SeededSessionContext,
  SessionBackupFactory,
  SessionContext,
  SessionDependencies,
  SessionInfoState,
  SessionRuntimeState,
} from "./SessionContext";
import type { SessionConfigPatch } from "../protocol";
import { SessionMetadataManager } from "./SessionMetadataManager";
import { SessionRuntimeSupport } from "./SessionRuntimeSupport";
import { SessionSnapshotProjector } from "./SessionSnapshotProjector";
import { SessionSnapshotBuilder } from "./SessionSnapshotBuilder";
import { SkillManager } from "./SkillManager";
import { TurnExecutionManager } from "./TurnExecutionManager";
import type { AgentReasoningEffort, AgentRole } from "../../shared/agents";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";

function makeId(): string {
  return crypto.randomUUID();
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
      if (typeof record.inputText === "string" && record.inputText.trim()) return record.inputText.trim();
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeHydratedExecutionState(
  sessionKind: SessionInfoState["sessionKind"] | undefined,
  executionState: SessionInfoState["executionState"],
  status: HydratedSessionState["status"] | undefined,
): SessionInfoState["executionState"] {
  if ((sessionKind ?? "root") !== "agent") {
    return executionState;
  }
  if (status === "closed") {
    return "closed";
  }
  if (!executionState || executionState === "completed" || executionState === "errored" || executionState === "closed") {
    return executionState;
  }
  return "completed";
}

function normalizeHydratedSessionInfo(hydrated?: HydratedSessionState): SessionInfoState | undefined {
  if (!hydrated) {
    return undefined;
  }
  const executionState = normalizeHydratedExecutionState(
    hydrated.sessionInfo.sessionKind,
    hydrated.sessionInfo.executionState,
    hydrated.status,
  );
  if (executionState === hydrated.sessionInfo.executionState) {
    return hydrated.sessionInfo;
  }
  return {
    ...hydrated.sessionInfo,
    executionState,
  };
}

function initialCurrentTurnOutcome(hydrated?: HydratedSessionState): SessionRuntimeState["currentTurnOutcome"] {
  if (
    normalizeHydratedExecutionState(
      hydrated?.sessionInfo.sessionKind,
      hydrated?.sessionInfo.executionState,
      hydrated?.status,
    ) === "errored"
  ) {
    return "error";
  }
  return "completed";
}

function buildInitialSessionSnapshot(opts: {
  sessionId: string;
  state: SessionRuntimeState;
  lastEventSeq: number;
  hasPendingAsk: boolean;
  hasPendingApproval: boolean;
}): SessionSnapshot {
  return {
    sessionId: opts.sessionId,
    title: opts.state.sessionInfo.title,
    titleSource: opts.state.sessionInfo.titleSource,
    titleModel: opts.state.sessionInfo.titleModel,
    provider: opts.state.sessionInfo.provider,
    model: opts.state.sessionInfo.model,
    sessionKind: opts.state.sessionInfo.sessionKind ?? "root",
    parentSessionId: opts.state.sessionInfo.parentSessionId ?? null,
    role: opts.state.sessionInfo.role ?? null,
    mode: opts.state.sessionInfo.mode ?? null,
    depth: typeof opts.state.sessionInfo.depth === "number" ? opts.state.sessionInfo.depth : null,
    nickname: opts.state.sessionInfo.nickname ?? null,
    requestedModel: opts.state.sessionInfo.requestedModel ?? null,
    effectiveModel: opts.state.sessionInfo.effectiveModel ?? null,
    requestedReasoningEffort: opts.state.sessionInfo.requestedReasoningEffort ?? null,
    effectiveReasoningEffort: opts.state.sessionInfo.effectiveReasoningEffort ?? null,
    executionState: opts.state.sessionInfo.executionState ?? null,
    lastMessagePreview: opts.state.sessionInfo.lastMessagePreview ?? null,
    createdAt: opts.state.sessionInfo.createdAt,
    updatedAt: opts.state.sessionInfo.updatedAt,
    messageCount: opts.state.allMessages.length,
    lastEventSeq: opts.lastEventSeq,
    feed: [],
    agents: [],
    todos: structuredClone(opts.state.todos),
    sessionUsage: opts.state.costTracker?.getSnapshot() ?? null,
    lastTurnUsage: null,
    hasPendingAsk: opts.hasPendingAsk,
    hasPendingApproval: opts.hasPendingApproval,
  };
}

const MAX_DISCONNECTED_REPLAY_EVENTS = 256;
const DISCONNECTED_REPLAY_EVENT_TYPES = new Set<ServerEvent["type"]>([
  "user_message",
  "session_busy",
  "model_stream_chunk",
  "model_stream_raw",
  "assistant_message",
  "reasoning",
  "log",
  "todos",
  "reset_done",
  "ask",
  "approval",
  "provider_auth_challenge",
  "provider_auth_result",
  "mcp_server_validation",
  "mcp_server_auth_challenge",
  "mcp_server_auth_result",
  "error",
  "file_uploaded",
  "turn_usage",
  "session_usage",
  "budget_warning",
  "budget_exceeded",
  "config_updated",
]);

function shouldReplayDisconnectedEvent(evt: ServerEvent): boolean {
  return DISCONNECTED_REPLAY_EVENT_TYPES.has(evt.type);
}

export class AgentSession {
  readonly id: string;

  private readonly state: SessionRuntimeState;
  private readonly deps: SessionDependencies;
  private readonly context: SessionContext;
  private readonly runtimeSupport: SessionRuntimeSupport;
  private readonly snapshotBuilder: SessionSnapshotBuilder;
  private readonly sessionSnapshotProjector: SessionSnapshotProjector;

  private readonly persistenceManager: PersistenceManager;
  private readonly historyManager: HistoryManager;
  private readonly interactionManager: InteractionManager;
  private readonly mcpManager: McpManager;
  private readonly providerAuthManager: ProviderAuthManager;
  private readonly providerCatalogManager: ProviderCatalogManager;
  private readonly turnExecutionManager: TurnExecutionManager;
  private readonly skillManager: SkillManager;
  private readonly metadataManager: SessionMetadataManager;
  private readonly adminManager: SessionAdminManager;
  private readonly backupController: SessionBackupController;
  private pendingConfigMutation: Promise<void> = Promise.resolve();
  private readonly memoryStore: MemoryStore;
  private bufferDisconnectedEvents = false;
  private disconnectedReplayEvents: ServerEvent[] = [];
  private persistedLastEventSeq: number;

  constructor(opts: {
    config: AgentConfig;
    system: string;
    sessionInfoPatch?: Partial<SessionInfoState>;
    discoveredSkills?: Array<{ name: string; description: string }>;
    yolo?: boolean;
    emit: (evt: ServerEvent) => void;
    connectProviderImpl?: typeof connectModelProvider;
    getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
    loadSystemPromptWithSkillsImpl?: typeof loadSystemPromptWithSkills;
    getProviderCatalogImpl?: typeof getProviderCatalog;
    getProviderStatusesImpl?: typeof getProviderStatuses;
    sessionBackupFactory?: SessionBackupFactory;
    harnessContextStore?: HarnessContextStore;
    runTurnImpl?: typeof runTurn;
    persistModelSelectionImpl?: (selection: PersistedModelSelection) => Promise<void> | void;
    persistProjectConfigPatchImpl?: (patch: PersistedProjectConfigPatch) => Promise<void> | void;
    generateSessionTitleImpl?: typeof generateSessionTitle;
    sessionDb?: SessionDb | null;
    writePersistedSessionSnapshotImpl?: typeof writePersistedSessionSnapshot;
    createAgentSessionImpl?: SessionDependencies["createAgentSessionImpl"];
    listAgentSessionsImpl?: SessionDependencies["listAgentSessionsImpl"];
    sendAgentInputImpl?: SessionDependencies["sendAgentInputImpl"];
    waitForAgentImpl?: SessionDependencies["waitForAgentImpl"];
    resumeAgentImpl?: SessionDependencies["resumeAgentImpl"];
    closeAgentImpl?: SessionDependencies["closeAgentImpl"];
    cancelAgentSessionsImpl?: SessionDependencies["cancelAgentSessionsImpl"];
    deleteSessionImpl?: SessionDependencies["deleteSessionImpl"];
    listWorkspaceBackupsImpl?: SessionDependencies["listWorkspaceBackupsImpl"];
    createWorkspaceBackupCheckpointImpl?: SessionDependencies["createWorkspaceBackupCheckpointImpl"];
    restoreWorkspaceBackupImpl?: SessionDependencies["restoreWorkspaceBackupImpl"];
    deleteWorkspaceBackupCheckpointImpl?: SessionDependencies["deleteWorkspaceBackupCheckpointImpl"];
    deleteWorkspaceBackupEntryImpl?: SessionDependencies["deleteWorkspaceBackupEntryImpl"];
    getWorkspaceBackupDeltaImpl?: SessionDependencies["getWorkspaceBackupDeltaImpl"];
    getLiveSessionSnapshotImpl?: SessionDependencies["getLiveSessionSnapshotImpl"];
    buildLegacySessionSnapshotImpl?: SessionDependencies["buildLegacySessionSnapshotImpl"];
    hydratedState?: HydratedSessionState;
    initialSessionSnapshot?: SessionSnapshot;
    initialLastEventSeq?: number;
    seedContext?: SeededSessionContext;
    skipInitialPersist?: boolean;
  }) {
    const hydrated = opts.hydratedState;
    const hydratedSessionInfo = normalizeHydratedSessionInfo(hydrated);
    const seededMessages = hydrated?.messages ?? (opts.seedContext ? structuredClone(opts.seedContext.messages) : []);
    const seededTodos = hydrated?.todos ?? (opts.seedContext ? structuredClone(opts.seedContext.todos) : []);
    const seededHarnessContext = hydrated?.harnessContext
      ?? (opts.seedContext?.harnessContext ? structuredClone(opts.seedContext.harnessContext) : null);
    this.id = hydrated?.sessionId ?? makeId();
    this.persistedLastEventSeq = Math.max(0, Math.floor(opts.initialLastEventSeq ?? opts.initialSessionSnapshot?.lastEventSeq ?? 0));

    const now = new Date().toISOString();
    this.state = {
      config: opts.config,
      system: opts.system,
      discoveredSkills: opts.discoveredSkills ?? [],
      yolo: opts.yolo === true,
      messages: [],
      allMessages: [...seededMessages],
      providerState: hydrated?.providerState ?? null,
      running: false,
      connecting: false,
      abortController: null,
      currentTurnId: null,
      acceptingSteers: false,
      pendingSteers: [],
      currentTurnOutcome: initialCurrentTurnOutcome(hydrated),
      maxSteps: 100,
      todos: seededTodos,
      sessionInfo: hydratedSessionInfo ?? {
        title: DEFAULT_SESSION_TITLE,
        titleSource: "default",
        titleModel: null,
        createdAt: now,
        updatedAt: now,
        provider: opts.config.provider,
        model: opts.config.model,
        sessionKind: opts.sessionInfoPatch?.sessionKind ?? "root",
        ...(opts.sessionInfoPatch?.parentSessionId ? { parentSessionId: opts.sessionInfoPatch.parentSessionId } : {}),
        ...(opts.sessionInfoPatch?.role ? { role: opts.sessionInfoPatch.role } : {}),
        ...(opts.sessionInfoPatch?.mode ? { mode: opts.sessionInfoPatch.mode } : {}),
        ...(typeof opts.sessionInfoPatch?.depth === "number" ? { depth: opts.sessionInfoPatch.depth } : {}),
        ...(opts.sessionInfoPatch?.nickname ? { nickname: opts.sessionInfoPatch.nickname } : {}),
        ...(opts.sessionInfoPatch?.requestedModel ? { requestedModel: opts.sessionInfoPatch.requestedModel } : {}),
        ...(opts.sessionInfoPatch?.effectiveModel ? { effectiveModel: opts.sessionInfoPatch.effectiveModel } : {}),
        ...(opts.sessionInfoPatch?.requestedReasoningEffort
          ? { requestedReasoningEffort: opts.sessionInfoPatch.requestedReasoningEffort }
          : {}),
        ...(opts.sessionInfoPatch?.effectiveReasoningEffort
          ? { effectiveReasoningEffort: opts.sessionInfoPatch.effectiveReasoningEffort }
          : {}),
        ...(opts.sessionInfoPatch?.executionState ? { executionState: opts.sessionInfoPatch.executionState } : {}),
        ...(opts.sessionInfoPatch?.lastMessagePreview ? { lastMessagePreview: opts.sessionInfoPatch.lastMessagePreview } : {}),
      },
      persistenceStatus: hydrated?.status ?? "active",
      hasGeneratedTitle: hydrated?.hasGeneratedTitle ?? false,
      backupsEnabledOverride: hydrated?.backupsEnabledOverride ?? null,
      sessionBackup: null,
      sessionBackupState: {
        status: "initializing",
        sessionId: this.id,
        workingDirectory: opts.config.workingDirectory,
        backupDirectory: null,
        createdAt: now,
        originalSnapshot: { kind: "pending" },
        checkpoints: [],
      },
      sessionBackupInit: null,
      backupOperationQueue: Promise.resolve(),
      lastAutoCheckpointAt: 0,
      costTracker: null,
    };

    this.memoryStore = new MemoryStore(`${opts.config.projectAgentDir}/memory.sqlite`, `${opts.config.userAgentDir}/memory.sqlite`);

    this.deps = {
      connectProviderImpl: opts.connectProviderImpl ?? connectModelProvider,
      getAiCoworkerPathsImpl: opts.getAiCoworkerPathsImpl ?? getAiCoworkerPaths,
      loadSystemPromptWithSkillsImpl: opts.loadSystemPromptWithSkillsImpl ?? loadSystemPromptWithSkills,
      getProviderCatalogImpl: opts.getProviderCatalogImpl ?? getProviderCatalog,
      getProviderStatusesImpl: opts.getProviderStatusesImpl ?? getProviderStatuses,
      sessionBackupFactory:
        opts.sessionBackupFactory ?? (async (factoryOpts: SessionBackupInitOptions): Promise<SessionBackupHandle> => await SessionBackupManager.create(factoryOpts)),
      harnessContextStore: opts.harnessContextStore ?? new HarnessContextStore(),
      runTurnImpl: opts.runTurnImpl ?? runTurn,
      persistModelSelectionImpl: opts.persistModelSelectionImpl,
      persistProjectConfigPatchImpl: opts.persistProjectConfigPatchImpl,
      generateSessionTitleImpl: opts.generateSessionTitleImpl ?? generateSessionTitle,
      sessionDb: opts.sessionDb ?? null,
      writePersistedSessionSnapshotImpl: opts.writePersistedSessionSnapshotImpl ?? writePersistedSessionSnapshot,
      createAgentSessionImpl: opts.createAgentSessionImpl,
      listAgentSessionsImpl: opts.listAgentSessionsImpl,
      sendAgentInputImpl: opts.sendAgentInputImpl,
      waitForAgentImpl: opts.waitForAgentImpl,
      resumeAgentImpl: opts.resumeAgentImpl,
      closeAgentImpl: opts.closeAgentImpl,
      cancelAgentSessionsImpl: opts.cancelAgentSessionsImpl,
      deleteSessionImpl: opts.deleteSessionImpl,
      listWorkspaceBackupsImpl: opts.listWorkspaceBackupsImpl,
      createWorkspaceBackupCheckpointImpl: opts.createWorkspaceBackupCheckpointImpl,
      restoreWorkspaceBackupImpl: opts.restoreWorkspaceBackupImpl,
      deleteWorkspaceBackupCheckpointImpl: opts.deleteWorkspaceBackupCheckpointImpl,
      deleteWorkspaceBackupEntryImpl: opts.deleteWorkspaceBackupEntryImpl,
      getWorkspaceBackupDeltaImpl: opts.getWorkspaceBackupDeltaImpl,
      getLiveSessionSnapshotImpl: opts.getLiveSessionSnapshotImpl,
      buildLegacySessionSnapshotImpl: opts.buildLegacySessionSnapshotImpl,
    };

    if (seededHarnessContext) {
      this.deps.harnessContextStore.set(this.id, seededHarnessContext);
    }

    const emit = (evt: ServerEvent) => {
      if (this.bufferDisconnectedEvents && shouldReplayDisconnectedEvent(evt)) {
        this.disconnectedReplayEvents.push(evt);
        if (this.disconnectedReplayEvents.length > MAX_DISCONNECTED_REPLAY_EVENTS) {
          this.disconnectedReplayEvents.splice(0, this.disconnectedReplayEvents.length - MAX_DISCONNECTED_REPLAY_EVENTS);
        }
      }
      this.sessionSnapshotProjector?.applyEvent(evt);
      opts.emit(evt);
    };

    this.runtimeSupport = new SessionRuntimeSupport({
      sessionId: this.id,
      state: this.state,
      deps: this.deps,
      emit,
      emitObservabilityStatusChanged: () => {
        emit(this.metadataManager.getObservabilityStatusEvent());
      },
    });

    this.context = {
      id: this.id,
      state: this.state,
      deps: this.deps,
      emit,
      emitError: (code, source, message) => this.emitError(code, source, message),
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
      formatError: (err) => this.formatErrorMessage(err),
      guardBusy: () => this.guardBusy(),
      getCoworkPaths: () => this.getCoworkPaths(),
      runProviderConnect: async (providerOpts) => await this.runProviderConnect(providerOpts),
      getMcpServerByName: async (nameRaw) => await this.getMcpServerByName(nameRaw),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      updateSessionInfo: (patch, infoOpts) => this.metadataManager.updateSessionInfo(patch, infoOpts),
      emitConfigUpdated: () => this.metadataManager.emitConfigUpdated(),
      syncSessionBackupAvailability: async () => {},
      refreshProviderStatus: async () => await this.providerCatalogManager.refreshProviderStatus(),
      emitProviderCatalog: async () => await this.providerCatalogManager.emitProviderCatalog(),
      getSkillMutationBlockReason: () =>
        this.deps.getSkillMutationBlockReasonImpl?.(this.state.config.workingDirectory) ?? null,
      refreshSkillsAcrossWorkspaceSessions: async () => {
        await this.deps.refreshSkillsAcrossWorkspaceSessionsImpl?.(this.state.config.workingDirectory);
      },
    };

    this.historyManager = new HistoryManager(this.context);
    this.interactionManager = new InteractionManager({
      sessionId: this.id,
      emit: (evt) => this.context.emit(evt),
      emitError: (code, source, message) => this.context.emitError(code, source, message),
      log: (line) => this.log(line),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      getConfig: () => this.state.config,
      isYolo: () => this.state.yolo,
      waitForPromptResponse: (requestId, bucket) => this.waitForPromptResponse(requestId, bucket),
    });
    this.metadataManager = new SessionMetadataManager(this.context);
    this.snapshotBuilder = new SessionSnapshotBuilder({
      sessionId: this.id,
      state: this.state,
      harnessContextStore: this.deps.harnessContextStore,
      getEnableMcp: () => this.getEnableMcp(),
      hasPendingAsk: () => this.hasPendingAsk,
      hasPendingApproval: () => this.hasPendingApproval,
    });
    this.persistenceManager = new PersistenceManager({
      sessionId: this.id,
      sessionDb: this.deps.sessionDb,
      getCoworkPaths: () => this.getCoworkPaths(),
      writePersistedSessionSnapshot: this.deps.writePersistedSessionSnapshotImpl,
      buildCanonicalSnapshot: (updatedAt) => this.buildCanonicalSnapshot(updatedAt),
      buildPersistedSnapshotAt: (updatedAt) => this.buildPersistedSnapshotAt(updatedAt),
      buildSessionSnapshotAt: (updatedAt, lastEventSeq) => {
        const snapshot = this.buildSessionSnapshot();
        snapshot.updatedAt = updatedAt;
        snapshot.lastEventSeq = lastEventSeq;
        return snapshot;
      },
      onPersistedLastEventSeq: (lastEventSeq) => {
        this.persistedLastEventSeq = lastEventSeq;
      },
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
      emitError: (message) => this.emitError("internal_error", "session", message),
      formatError: (err) => this.formatErrorMessage(err),
    });
    this.backupController = new SessionBackupController(this.context);
    this.context.syncSessionBackupAvailability = async () => {
      await this.backupController.syncSessionBackupAvailability();
    };
    this.skillManager = new SkillManager(this.context, {
      sendUserMessage: (text, clientMessageId, displayText) => this.sendUserMessage(text, clientMessageId, displayText),
    });
    this.mcpManager = new McpManager(this.context);
    this.providerCatalogManager = new ProviderCatalogManager({
      sessionId: this.id,
      getConfig: () => this.state.config,
      getGlobalAuthPaths: () => this.getGlobalAuthPaths(),
      getProviderCatalog: this.deps.getProviderCatalogImpl,
      getProviderStatuses: this.deps.getProviderStatusesImpl,
      emit: (evt) => this.context.emit(evt),
      emitError: (code, source, message) => this.context.emitError(code, source, message),
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
      formatError: (err) => this.formatErrorMessage(err),
    });
    this.providerAuthManager = new ProviderAuthManager({
      sessionId: this.id,
      getConfig: () => this.state.config,
      setConfig: (next) => {
        this.state.config = next;
      },
      isRunning: () => this.state.running,
      guardBusy: () => this.guardBusy(),
      setConnecting: (connecting) => {
        this.state.connecting = connecting;
      },
      emit: (evt) => this.context.emit(evt),
      emitError: (code, source, message) => this.context.emitError(code, source, message),
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
      formatError: (err) => this.formatErrorMessage(err),
      log: (line) => this.log(line),
      clearProviderState: () => {
        this.state.providerState = null;
      },
      persistModelSelection: this.deps.persistModelSelectionImpl,
      updateSessionInfo: (patch) => this.metadataManager.updateSessionInfo(patch),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      emitConfigUpdated: () => this.metadataManager.emitConfigUpdated(),
      emitProviderCatalog: async () => await this.providerCatalogManager.emitProviderCatalog(),
      refreshProviderStatus: async () => await this.providerCatalogManager.refreshProviderStatus(),
      getGlobalAuthPaths: () => this.getGlobalAuthPaths(),
      runProviderConnect: async (providerOpts) => await this.runProviderConnect(providerOpts),
    });
    this.turnExecutionManager = new TurnExecutionManager(this.context, {
      interactionManager: this.interactionManager,
      historyManager: this.historyManager,
      metadataManager: this.metadataManager,
      backupController: this.backupController,
    });
    this.adminManager = new SessionAdminManager(this.context);

    this.historyManager.refreshRuntimeMessagesFromHistory();

    // Initialize cost tracker for this session.
    const costTracker = hydrated?.costTracker
      ? SessionCostTracker.fromSnapshot(hydrated.costTracker)
      : new SessionCostTracker(this.id);
    this.attachCostTrackerListeners(costTracker);
    this.state.costTracker = costTracker;

    const initialSnapshot = opts.initialSessionSnapshot
      ? structuredClone(opts.initialSessionSnapshot)
      : buildInitialSessionSnapshot({
          sessionId: this.id,
          state: this.state,
          lastEventSeq: this.persistedLastEventSeq,
          hasPendingAsk: this.hasPendingAsk,
          hasPendingApproval: this.hasPendingApproval,
        });
    this.sessionSnapshotProjector = new SessionSnapshotProjector(initialSnapshot);

    if (!opts.skipInitialPersist) {
      this.queuePersistSessionSnapshot("session.created");
    }
  }

  static fromPersisted(opts: {
    persisted: PersistedSessionRecord;
    baseConfig: AgentConfig;
    discoveredSkills?: Array<{ name: string; description: string }>;
    yolo?: boolean;
    emit: (evt: ServerEvent) => void;
    connectProviderImpl?: typeof connectModelProvider;
    getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
    getProviderCatalogImpl?: typeof getProviderCatalog;
    getProviderStatusesImpl?: typeof getProviderStatuses;
    sessionBackupFactory?: SessionBackupFactory;
    harnessContextStore?: HarnessContextStore;
    runTurnImpl?: typeof runTurn;
    persistModelSelectionImpl?: (selection: PersistedModelSelection) => Promise<void> | void;
    persistProjectConfigPatchImpl?: (patch: PersistedProjectConfigPatch) => Promise<void> | void;
    generateSessionTitleImpl?: typeof generateSessionTitle;
    sessionDb?: SessionDb | null;
    writePersistedSessionSnapshotImpl?: typeof writePersistedSessionSnapshot;
    createAgentSessionImpl?: SessionDependencies["createAgentSessionImpl"];
    listAgentSessionsImpl?: SessionDependencies["listAgentSessionsImpl"];
    sendAgentInputImpl?: SessionDependencies["sendAgentInputImpl"];
    waitForAgentImpl?: SessionDependencies["waitForAgentImpl"];
    resumeAgentImpl?: SessionDependencies["resumeAgentImpl"];
    closeAgentImpl?: SessionDependencies["closeAgentImpl"];
    cancelAgentSessionsImpl?: SessionDependencies["cancelAgentSessionsImpl"];
    deleteSessionImpl?: SessionDependencies["deleteSessionImpl"];
    listWorkspaceBackupsImpl?: SessionDependencies["listWorkspaceBackupsImpl"];
    createWorkspaceBackupCheckpointImpl?: SessionDependencies["createWorkspaceBackupCheckpointImpl"];
    restoreWorkspaceBackupImpl?: SessionDependencies["restoreWorkspaceBackupImpl"];
    deleteWorkspaceBackupCheckpointImpl?: SessionDependencies["deleteWorkspaceBackupCheckpointImpl"];
    deleteWorkspaceBackupEntryImpl?: SessionDependencies["deleteWorkspaceBackupEntryImpl"];
    getWorkspaceBackupDeltaImpl?: SessionDependencies["getWorkspaceBackupDeltaImpl"];
    initialSessionSnapshot?: SessionSnapshot | null;
  }): AgentSession {
    const { persisted } = opts;
    const resolvedPersistedModel = getKnownResolvedModelMetadata(persisted.provider, persisted.model);
    const resumedModel = resolvedPersistedModel ?? defaultSupportedModel(persisted.provider);
    const migratedLegacyModel = resolvedPersistedModel === null && !isDynamicModelProvider(persisted.provider);
    const clearedContinuationState = migratedLegacyModel && persisted.providerState !== null;
    const config: AgentConfig = {
      ...opts.baseConfig,
      provider: persisted.provider,
      model: resumedModel.id,
      workingDirectory: persisted.workingDirectory,
      enableMcp: persisted.enableMcp,
      outputDirectory: persisted.outputDirectory,
      uploadsDirectory: persisted.uploadsDirectory,
      ...(persisted.providerOptions !== undefined ? { providerOptions: structuredClone(persisted.providerOptions) } : {}),
    };

    const sessionInfo = {
      title: persisted.title,
      titleSource: persisted.titleSource,
      titleModel: persisted.titleModel,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      provider: persisted.provider,
      model: resumedModel.id,
      sessionKind: persisted.sessionKind,
      ...(persisted.parentSessionId ? { parentSessionId: persisted.parentSessionId } : {}),
      ...(persisted.role ? { role: persisted.role } : {}),
      ...(persisted.mode ? { mode: persisted.mode } : {}),
      ...(typeof persisted.depth === "number" ? { depth: persisted.depth } : {}),
      ...(persisted.nickname ? { nickname: persisted.nickname } : {}),
      ...(persisted.requestedModel ? { requestedModel: persisted.requestedModel } : {}),
      ...(persisted.effectiveModel ? { effectiveModel: persisted.effectiveModel } : {}),
      ...(persisted.requestedReasoningEffort ? { requestedReasoningEffort: persisted.requestedReasoningEffort } : {}),
      ...(persisted.effectiveReasoningEffort ? { effectiveReasoningEffort: persisted.effectiveReasoningEffort } : {}),
      ...(persisted.executionState ? { executionState: persisted.executionState } : {}),
      ...(persisted.lastMessagePreview ? { lastMessagePreview: persisted.lastMessagePreview } : {}),
    };

    const session = new AgentSession({
      config,
      system: persisted.systemPrompt,
      discoveredSkills: opts.discoveredSkills,
      yolo: opts.yolo,
      emit: opts.emit,
      connectProviderImpl: opts.connectProviderImpl,
      getAiCoworkerPathsImpl: opts.getAiCoworkerPathsImpl,
      getProviderCatalogImpl: opts.getProviderCatalogImpl,
      getProviderStatusesImpl: opts.getProviderStatusesImpl,
      sessionBackupFactory: opts.sessionBackupFactory,
      harnessContextStore: opts.harnessContextStore,
      runTurnImpl: opts.runTurnImpl,
      persistModelSelectionImpl: opts.persistModelSelectionImpl,
      persistProjectConfigPatchImpl: opts.persistProjectConfigPatchImpl,
      generateSessionTitleImpl: opts.generateSessionTitleImpl,
      sessionDb: opts.sessionDb,
      writePersistedSessionSnapshotImpl: opts.writePersistedSessionSnapshotImpl,
      createAgentSessionImpl: opts.createAgentSessionImpl,
      listAgentSessionsImpl: opts.listAgentSessionsImpl,
      sendAgentInputImpl: opts.sendAgentInputImpl,
      waitForAgentImpl: opts.waitForAgentImpl,
      resumeAgentImpl: opts.resumeAgentImpl,
      closeAgentImpl: opts.closeAgentImpl,
      cancelAgentSessionsImpl: opts.cancelAgentSessionsImpl,
      deleteSessionImpl: opts.deleteSessionImpl,
      listWorkspaceBackupsImpl: opts.listWorkspaceBackupsImpl,
      createWorkspaceBackupCheckpointImpl: opts.createWorkspaceBackupCheckpointImpl,
      restoreWorkspaceBackupImpl: opts.restoreWorkspaceBackupImpl,
      deleteWorkspaceBackupCheckpointImpl: opts.deleteWorkspaceBackupCheckpointImpl,
      deleteWorkspaceBackupEntryImpl: opts.deleteWorkspaceBackupEntryImpl,
      getWorkspaceBackupDeltaImpl: opts.getWorkspaceBackupDeltaImpl,
      ...(opts.initialSessionSnapshot ? { initialSessionSnapshot: opts.initialSessionSnapshot } : {}),
      initialLastEventSeq: persisted.lastEventSeq,
      hydratedState: {
        sessionId: persisted.sessionId,
        sessionInfo,
        status: persisted.status,
        hasGeneratedTitle: persisted.titleSource !== "default" || persisted.messageCount > 0,
        messages: persisted.messages,
        providerState: migratedLegacyModel ? null : persisted.providerState,
        todos: persisted.todos,
        harnessContext: persisted.harnessContext,
        backupsEnabledOverride: persisted.backupsEnabledOverride,
        costTracker: persisted.costTracker,
      },
      skipInitialPersist: !migratedLegacyModel,
    });

    if (migratedLegacyModel) {
      opts.emit({
        type: "log",
        sessionId: persisted.sessionId,
        line: `[session] Resumed legacy session using unsupported model "${persisted.model}" for provider ${persisted.provider}; migrated to "${resumedModel.id}".${clearedContinuationState ? " Cleared saved continuation state for the old model." : ""}`,
      });
    }

    return session;
  }

  buildSessionSnapshot(): SessionSnapshot {
    const snapshot = this.sessionSnapshotProjector.getSnapshot();
    snapshot.title = this.state.sessionInfo.title;
    snapshot.titleSource = this.state.sessionInfo.titleSource;
    snapshot.titleModel = this.state.sessionInfo.titleModel;
    snapshot.provider = this.state.sessionInfo.provider;
    snapshot.model = this.state.sessionInfo.model;
    snapshot.sessionKind = this.state.sessionInfo.sessionKind ?? "root";
    snapshot.parentSessionId = this.state.sessionInfo.parentSessionId ?? null;
    snapshot.role = this.state.sessionInfo.role ?? null;
    snapshot.mode = this.state.sessionInfo.mode ?? null;
    snapshot.depth = typeof this.state.sessionInfo.depth === "number" ? this.state.sessionInfo.depth : null;
    snapshot.nickname = this.state.sessionInfo.nickname ?? null;
    snapshot.requestedModel = this.state.sessionInfo.requestedModel ?? null;
    snapshot.effectiveModel = this.state.sessionInfo.effectiveModel ?? null;
    snapshot.requestedReasoningEffort = this.state.sessionInfo.requestedReasoningEffort ?? null;
    snapshot.effectiveReasoningEffort = this.state.sessionInfo.effectiveReasoningEffort ?? null;
    snapshot.executionState = this.state.sessionInfo.executionState ?? null;
    snapshot.lastMessagePreview = this.state.sessionInfo.lastMessagePreview ?? null;
    snapshot.createdAt = this.state.sessionInfo.createdAt;
    snapshot.updatedAt = this.state.sessionInfo.updatedAt;
    snapshot.messageCount = this.state.allMessages.length;
    snapshot.lastEventSeq = this.persistenceManager.getProjectedLastEventSeq(this.persistedLastEventSeq);
    snapshot.todos = structuredClone(this.state.todos);
    snapshot.sessionUsage = this.state.costTracker?.getSnapshot() ?? null;
    snapshot.lastTurnUsage = snapshot.sessionUsage?.turns?.length
      ? {
          turnId: snapshot.sessionUsage.turns[snapshot.sessionUsage.turns.length - 1]!.turnId,
          usage: { ...snapshot.sessionUsage.turns[snapshot.sessionUsage.turns.length - 1]!.usage },
        }
      : snapshot.lastTurnUsage;
    snapshot.hasPendingAsk = this.hasPendingAsk;
    snapshot.hasPendingApproval = this.hasPendingApproval;
    return snapshot;
  }

  peekSessionSnapshot(): SessionSnapshot {
    const snapshot = this.sessionSnapshotProjector.peekSnapshot();
    snapshot.title = this.state.sessionInfo.title;
    snapshot.titleSource = this.state.sessionInfo.titleSource;
    snapshot.titleModel = this.state.sessionInfo.titleModel;
    snapshot.provider = this.state.sessionInfo.provider;
    snapshot.model = this.state.sessionInfo.model;
    snapshot.sessionKind = this.state.sessionInfo.sessionKind ?? "root";
    snapshot.parentSessionId = this.state.sessionInfo.parentSessionId ?? null;
    snapshot.role = this.state.sessionInfo.role ?? null;
    snapshot.mode = this.state.sessionInfo.mode ?? null;
    snapshot.depth = typeof this.state.sessionInfo.depth === "number" ? this.state.sessionInfo.depth : null;
    snapshot.nickname = this.state.sessionInfo.nickname ?? null;
    snapshot.requestedModel = this.state.sessionInfo.requestedModel ?? null;
    snapshot.effectiveModel = this.state.sessionInfo.effectiveModel ?? null;
    snapshot.requestedReasoningEffort = this.state.sessionInfo.requestedReasoningEffort ?? null;
    snapshot.effectiveReasoningEffort = this.state.sessionInfo.effectiveReasoningEffort ?? null;
    snapshot.executionState = this.state.sessionInfo.executionState ?? null;
    snapshot.lastMessagePreview = this.state.sessionInfo.lastMessagePreview ?? null;
    snapshot.createdAt = this.state.sessionInfo.createdAt;
    snapshot.updatedAt = this.state.sessionInfo.updatedAt;
    snapshot.messageCount = this.state.allMessages.length;
    snapshot.lastEventSeq = this.persistenceManager.getProjectedLastEventSeq(this.persistedLastEventSeq);
    snapshot.todos = structuredClone(this.state.todos);
    snapshot.sessionUsage = this.state.costTracker?.getSnapshot() ?? null;
    snapshot.lastTurnUsage = snapshot.sessionUsage?.turns?.length
      ? {
          turnId: snapshot.sessionUsage.turns[snapshot.sessionUsage.turns.length - 1]!.turnId,
          usage: { ...snapshot.sessionUsage.turns[snapshot.sessionUsage.turns.length - 1]!.usage },
        }
      : snapshot.lastTurnUsage;
    snapshot.hasPendingAsk = this.hasPendingAsk;
    snapshot.hasPendingApproval = this.hasPendingApproval;
    return snapshot;
  }

  getPublicConfig() {
    return this.metadataManager.getPublicConfig();
  }

  get isBusy(): boolean {
    return this.state.running;
  }

  get messageCount(): number {
    return this.state.allMessages.length;
  }

  get currentTurnOutcome(): "completed" | "cancelled" | "error" {
    return this.state.currentTurnOutcome;
  }

  get activeTurnId(): string | null {
    return this.state.currentTurnId;
  }

  get persistenceStatus() {
    return this.state.persistenceStatus;
  }

  get sessionKind() {
    return this.state.sessionInfo.sessionKind ?? "root";
  }

  get parentSessionId() {
    return this.state.sessionInfo.parentSessionId ?? null;
  }

  get role() {
    return this.state.sessionInfo.role ?? null;
  }

  get hasPendingAsk(): boolean {
    return this.interactionManager.hasPendingAsk;
  }

  get hasPendingApproval(): boolean {
    return this.interactionManager.hasPendingApproval;
  }

  private get pendingAskEvents() {
    return this.interactionManager.pendingAskEventsForReplay;
  }

  private get pendingApprovalEvents() {
    return this.interactionManager.pendingApprovalEventsForReplay;
  }

  getEnableMcp() {
    return this.state.config.enableMcp ?? false;
  }

  getEnableMemory() {
    return this.state.config.enableMemory ?? true;
  }

  getMemoryRequireApproval() {
    return this.state.config.memoryRequireApproval ?? false;
  }

  getBackupsEnabled() {
    return this.state.backupsEnabledOverride ?? this.state.config.backupsEnabled ?? true;
  }

  getSessionConfigEvent() {
    return this.metadataManager.getSessionConfigEvent();
  }

  getSessionInfoEvent() {
    return this.metadataManager.getSessionInfoEvent();
  }

  isAgentOf(parentSessionId: string): boolean {
    return this.sessionKind === "agent" && this.parentSessionId === parentSessionId;
  }

  getSessionDepth(): number {
    const depth = this.state.sessionInfo.depth;
    return typeof depth === "number" ? depth : 0;
  }

  getLatestAssistantText(): string | undefined {
    for (let i = this.state.allMessages.length - 1; i >= 0; i -= 1) {
      const message = this.state.allMessages[i];
      if (!message || message.role !== "assistant") continue;
      const text = contentText(message.content);
      if (text) return text;
    }
    return undefined;
  }

  getObservabilityStatusEvent() {
    return this.metadataManager.getObservabilityStatusEvent();
  }

  getWorkingDirectory(): string {
    return this.state.config.workingDirectory;
  }

  replayPendingPrompts() {
    this.interactionManager.replayPendingPrompts();
  }

  getPendingPromptEventsForReplay(): ReadonlyArray<PendingPromptReplayEvent> {
    return this.interactionManager.getPendingPromptEventsForReplay();
  }

  beginDisconnectedReplayBuffer() {
    this.bufferDisconnectedEvents = true;
    this.disconnectedReplayEvents = [];
  }

  ensureDisconnectedReplayBuffer() {
    this.bufferDisconnectedEvents = true;
  }

  drainDisconnectedReplayEvents(): ServerEvent[] {
    this.bufferDisconnectedEvents = false;
    const drained = this.disconnectedReplayEvents;
    this.disconnectedReplayEvents = [];
    return drained;
  }

  reset() {
    this.adminManager.reset();
  }

  listTools() {
    this.skillManager.listTools();
  }

  async listCommands() {
    await this.skillManager.listCommands();
  }

  async executeCommand(nameRaw: string, argumentsText = "", clientMessageId?: string) {
    await this.skillManager.executeCommand(nameRaw, argumentsText, clientMessageId);
  }

  async listSkills() {
    await this.skillManager.listSkills();
  }

  async readSkill(skillNameRaw: string) {
    await this.skillManager.readSkill(skillNameRaw);
  }

  async disableSkill(skillNameRaw: string) {
    await this.skillManager.disableSkill(skillNameRaw);
  }

  async enableSkill(skillNameRaw: string) {
    await this.skillManager.enableSkill(skillNameRaw);
  }

  async deleteSkill(skillNameRaw: string) {
    await this.skillManager.deleteSkill(skillNameRaw);
  }

  async getSkillsCatalog() {
    await this.skillManager.getSkillsCatalog();
  }

  async getSkillInstallation(installationId: string) {
    await this.skillManager.getSkillInstallation(installationId);
  }

  async previewSkillInstall(sourceInput: string, targetScope: "project" | "global") {
    await this.skillManager.previewSkillInstall(sourceInput, targetScope);
  }

  async installSkills(sourceInput: string, targetScope: "project" | "global") {
    await this.skillManager.installSkills(sourceInput, targetScope);
  }

  async enableSkillInstallation(installationId: string) {
    await this.skillManager.enableSkillInstallation(installationId);
  }

  async disableSkillInstallation(installationId: string) {
    await this.skillManager.disableSkillInstallation(installationId);
  }

  async deleteSkillInstallation(installationId: string) {
    await this.skillManager.deleteSkillInstallation(installationId);
  }

  async copySkillInstallation(installationId: string, targetScope: "project" | "global") {
    await this.skillManager.copySkillInstallation(installationId, targetScope);
  }

  async checkSkillInstallationUpdate(installationId: string) {
    await this.skillManager.checkSkillInstallationUpdate(installationId);
  }

  async updateSkillInstallation(installationId: string) {
    await this.skillManager.updateSkillInstallation(installationId);
  }

  async setEnableMcp(enableMcp: boolean) {
    await this.mcpManager.setEnableMcp(enableMcp);
  }

  async setEnableMemory(enableMemory: boolean) {
    this.state.config = { ...this.state.config, enableMemory };
    if (this.deps.persistProjectConfigPatchImpl) {
      await this.deps.persistProjectConfigPatchImpl({ enableMemory });
    }
    this.context.emit({ type: "session_settings", sessionId: this.id, enableMcp: this.getEnableMcp(), enableMemory: this.getEnableMemory(), memoryRequireApproval: this.getMemoryRequireApproval() });
    this.queuePersistSessionSnapshot("session.enable_memory");
    await this.refreshSystemPromptWithSkills("session.enable_memory");
  }

  async setMemoryRequireApproval(memoryRequireApproval: boolean) {
    this.state.config = { ...this.state.config, memoryRequireApproval };
    if (this.deps.persistProjectConfigPatchImpl) {
      await this.deps.persistProjectConfigPatchImpl({ memoryRequireApproval });
    }
    this.context.emit({ type: "session_settings", sessionId: this.id, enableMcp: this.getEnableMcp(), enableMemory: this.getEnableMemory(), memoryRequireApproval: this.getMemoryRequireApproval() });
    this.queuePersistSessionSnapshot("session.memory_require_approval");
  }

  async emitMemories(scope?: MemoryScope) {
    try {
      const memories = await this.memoryStore.list(scope);
      this.context.emit({ type: "memory_list", sessionId: this.id, memories });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list memories: ${String(err)}`);
    }
  }

  async upsertMemory(scope: MemoryScope, id: string | undefined, content: string) {
    try {
      await this.memoryStore.upsert(scope, { id, content });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to upsert memory: ${String(err)}`);
      return;
    }
    await this.emitMemories();
    await this.refreshSystemPromptWithSkills("session.memory_upsert");
  }

  async deleteMemory(scope: MemoryScope, id: string) {
    try {
      await this.memoryStore.remove(scope, id);
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to delete memory: ${String(err)}`);
      return;
    }
    await this.emitMemories();
    await this.refreshSystemPromptWithSkills("session.memory_delete");
  }

  async refreshSystemPromptWithSkills(reason = "session.refresh_system_prompt") {
    try {
      const result = await this.context.deps.loadSystemPromptWithSkillsImpl(this.state.config);
      this.state.system = result.prompt;
      this.state.discoveredSkills = result.discoveredSkills;
      this.queuePersistSessionSnapshot(reason);
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to refresh system prompt: ${String(err)}`,
      );
    }
  }

  async emitMcpServers() {
    await this.mcpManager.emitMcpServers();
  }

  async upsertMcpServer(server: MCPServerConfig, previousName?: string) {
    await this.mcpManager.upsert(server, previousName);
  }

  async deleteMcpServer(nameRaw: string) {
    await this.mcpManager.delete(nameRaw);
  }

  async validateMcpServer(nameRaw: string) {
    await this.mcpManager.validate(nameRaw);
  }

  async authorizeMcpServerAuth(nameRaw: string) {
    await this.mcpManager.authorize(nameRaw);
  }

  async callbackMcpServerAuth(nameRaw: string, codeRaw?: string) {
    await this.mcpManager.callback(nameRaw, codeRaw);
  }

  async setMcpServerApiKey(nameRaw: string, apiKeyRaw: string) {
    await this.mcpManager.setApiKey(nameRaw, apiKeyRaw);
  }

  async migrateLegacyMcpServers(scope: "workspace" | "user") {
    await this.mcpManager.migrate(scope);
  }

  getHarnessContext() {
    this.metadataManager.getHarnessContext();
  }

  setHarnessContext(context: HarnessContextPayload) {
    this.metadataManager.setHarnessContext(context);
  }

  async setModel(modelIdRaw: string, providerRaw?: AgentConfig["provider"]) {
    await this.providerAuthManager.setModel(modelIdRaw, providerRaw);
  }

  async applySessionDefaults(opts: {
    provider?: AgentConfig["provider"];
    model?: string;
    enableMcp?: boolean;
    config?: SessionConfigPatch;
  }) {
    await this.enqueueConfigMutation(async () => {
      if ((opts.provider === undefined) !== (opts.model === undefined)) {
        this.context.emitError(
          "validation_failed",
          "session",
          "provider and model must be supplied together",
        );
        return;
      }
      if (this.state.running) {
        this.context.emitError("busy", "session", "Agent is busy");
        return;
      }

      const preparedModel = opts.provider !== undefined && opts.model !== undefined
        ? await this.providerAuthManager.prepareModelSelection(opts.model, opts.provider)
        : null;
      if (opts.provider !== undefined && opts.model !== undefined && !preparedModel) {
        return;
      }

      const preparedConfig = opts.config
        ? await this.metadataManager.prepareConfigUpdate(opts.config, {
            baseConfig: preparedModel?.nextConfig ?? this.state.config,
            baseYolo: this.state.yolo,
            baseMaxSteps: this.state.maxSteps,
          })
        : null;
      if (opts.config && !preparedConfig) {
        return;
      }

      const preparedEnableMcp = typeof opts.enableMcp === "boolean"
        ? this.mcpManager.prepareEnableMcpChange(opts.enableMcp)
        : null;

      const changed =
        (preparedModel?.changed ?? false)
        || (preparedConfig?.changed ?? false)
        || (preparedEnableMcp?.changed ?? false);
      if (!changed) {
        this.emitTelemetry("session.defaults.noop", "ok", {
          sessionId: this.id,
          operation: "apply_session_defaults",
        });
        return;
      }

      const combinedPersistPatch: PersistedProjectConfigPatch = {};
      if (preparedModel?.changed) {
        Object.assign(combinedPersistPatch, preparedModel.persistSelection);
      }
      if (preparedConfig?.changed) {
        Object.assign(combinedPersistPatch, preparedConfig.persistPatch);
      }
      if (preparedEnableMcp?.changed) {
        combinedPersistPatch.enableMcp = preparedEnableMcp.enableMcp;
      }

      let persistError: unknown = null;
      if (Object.keys(combinedPersistPatch).length > 0 && this.deps.persistProjectConfigPatchImpl) {
        try {
          await this.deps.persistProjectConfigPatchImpl(combinedPersistPatch);
        } catch (error) {
          persistError = error;
        }
      }

      if (preparedModel?.changed) {
        await this.providerAuthManager.applyPreparedModelSelection(preparedModel, {
          persistSelection: false,
          queuePersistSessionSnapshot: false,
        });
      }
      if (preparedConfig?.changed) {
        await this.metadataManager.applyPreparedConfigUpdate(preparedConfig, {
          persistDefaults: false,
          queuePersistSessionSnapshot: false,
        });
      }
      if (preparedEnableMcp?.changed) {
        await this.mcpManager.applyPreparedEnableMcpChange(preparedEnableMcp, {
          persistDefaults: false,
          queuePersistSessionSnapshot: false,
        });
      }

      this.queuePersistSessionSnapshot("session.defaults_applied");
      this.emitTelemetry("session.defaults.apply", "ok", {
        sessionId: this.id,
        modelChanged: preparedModel?.changed ?? false,
        configChanged: preparedConfig?.changed ?? false,
        enableMcpChanged: preparedEnableMcp?.changed ?? false,
      });

      if (persistError) {
        this.context.emitError(
          "internal_error",
          "session",
          `Session defaults updated for this session, but failed to persist defaults: ${String(persistError)}`,
        );
      }
    });
  }

  async emitProviderCatalog() {
    await this.providerCatalogManager.emitProviderCatalog();
  }

  emitProviderAuthMethods() {
    this.providerCatalogManager.emitProviderAuthMethods();
  }

  async authorizeProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string) {
    await this.providerAuthManager.authorizeProviderAuth(providerRaw, methodIdRaw);
  }

  async logoutProviderAuth(providerRaw: AgentConfig["provider"]) {
    await this.providerAuthManager.logoutProviderAuth(providerRaw);
  }

  async callbackProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string, codeRaw?: string) {
    await this.providerAuthManager.callbackProviderAuth(providerRaw, methodIdRaw, codeRaw);
  }

  async setProviderApiKey(providerRaw: AgentConfig["provider"], methodIdRaw: string, apiKeyRaw: string) {
    await this.providerAuthManager.setProviderApiKey(providerRaw, methodIdRaw, apiKeyRaw);
  }

  async copyProviderApiKey(providerRaw: AgentConfig["provider"], sourceProviderRaw: AgentConfig["provider"]) {
    await this.providerAuthManager.copyProviderApiKey(providerRaw, sourceProviderRaw);
  }

  async refreshProviderStatus() {
    await this.providerCatalogManager.refreshProviderStatus();
  }

  handleAskResponse(requestId: string, answer: string) {
    const handled = this.turnExecutionManager.handleAskResponse(requestId, answer);
    if (handled) {
      this.sessionSnapshotProjector.syncSessionState({ hasPendingAsk: this.hasPendingAsk });
    }
  }

  handleApprovalResponse(requestId: string, approved: boolean) {
    const handled = this.turnExecutionManager.handleApprovalResponse(requestId, approved);
    if (handled) {
      this.sessionSnapshotProjector.syncSessionState({ hasPendingApproval: this.hasPendingApproval });
    }
  }

  cancel(opts?: { includeSubagents?: boolean }) {
    this.turnExecutionManager.cancel(opts);
  }

  async closeForHistory(): Promise<void> {
    this.state.persistenceStatus = "closed";
    this.queuePersistSessionSnapshot("session.closed");
    await this.persistenceManager.waitForIdle();
  }

  async waitForPersistenceIdle(): Promise<void> {
    await this.persistenceManager.waitForIdle();
  }

  reopenForHistory() {
    if (this.state.persistenceStatus === "active") return;
    this.state.persistenceStatus = "active";
    if (
      (this.state.sessionInfo.sessionKind ?? "root") === "agent"
      && this.state.sessionInfo.executionState === "closed"
    ) {
      this.metadataManager.updateSessionInfo({
        executionState: this.currentTurnOutcome === "error" ? "errored" : "completed",
      });
    }
    this.queuePersistSessionSnapshot("session.reopened");
  }

  dispose(reason: string) {
    this.state.abortController?.abort();
    this.interactionManager.rejectAllPending(`Session disposed (${reason})`);
    void this.waitForPersistenceIdle().finally(() => {
      this.deps.harnessContextStore.clear(this.id);
    });
    void this.backupController.closeSessionBackup();
  }

  getMessages(offset = 0, limit = 100) {
    this.adminManager.getMessages(offset, limit);
  }

  buildForkContextSeed(): SeededSessionContext {
    return {
      messages: structuredClone(this.state.allMessages),
      todos: structuredClone(this.state.todos),
      harnessContext: this.deps.harnessContextStore.get(this.id),
    };
  }

  setSessionTitle(title: string) {
    this.metadataManager.setSessionTitle(title);
  }

  async listSessions(scope: "all" | "workspace" = "all") {
    await this.adminManager.listSessions(scope);
  }

  async getSessionSnapshot(targetSessionId: string) {
    await this.adminManager.getSessionSnapshot(targetSessionId);
  }

  async listAgentSessions() {
    await this.adminManager.listAgentSessions();
  }

  async createAgentSession(opts: {
    message: string;
    role?: AgentRole;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
    forkContext?: boolean;
  }) {
    await this.adminManager.createAgentSession(opts);
  }

  async sendAgentInput(agentId: string, message: string, interrupt?: boolean) {
    await this.adminManager.sendAgentInput(agentId, message, interrupt);
  }

  async waitForAgents(agentIds: string[], timeoutMs?: number) {
    await this.adminManager.waitForAgents(agentIds, timeoutMs);
  }

  async resumeAgent(agentId: string) {
    await this.adminManager.resumeAgent(agentId);
  }

  async closeAgent(agentId: string) {
    await this.adminManager.closeAgent(agentId);
  }

  async deleteSession(targetSessionId: string) {
    await this.adminManager.deleteSession(targetSessionId);
  }

  // Each workspace backup method calls getSessionBackupState() first to ensure
  // the backup controller is initialized (lazy init) before the admin manager
  // accesses backup data. This is intentional coupling, not redundancy.

  async listWorkspaceBackups() {
    await this.backupController.getSessionBackupState();
    await this.adminManager.listWorkspaceBackups();
  }

  async createWorkspaceBackupCheckpoint(targetSessionId: string) {
    await this.backupController.getSessionBackupState();
    await this.adminManager.createWorkspaceBackupCheckpoint(targetSessionId);
  }

  async restoreWorkspaceBackup(targetSessionId: string, checkpointId?: string) {
    await this.backupController.getSessionBackupState();
    await this.adminManager.restoreWorkspaceBackup(targetSessionId, checkpointId);
  }

  async deleteWorkspaceBackupCheckpoint(targetSessionId: string, checkpointId: string) {
    await this.backupController.getSessionBackupState();
    await this.adminManager.deleteWorkspaceBackupCheckpoint(targetSessionId, checkpointId);
  }

  async deleteWorkspaceBackupEntry(targetSessionId: string) {
    await this.backupController.getSessionBackupState();
    await this.adminManager.deleteWorkspaceBackupEntry(targetSessionId);
  }

  async getWorkspaceBackupDelta(targetSessionId: string, checkpointId: string) {
    await this.backupController.getSessionBackupState();
    await this.adminManager.getWorkspaceBackupDelta(targetSessionId, checkpointId);
  }

  async setConfig(patch: SessionConfigPatch) {
    await this.enqueueConfigMutation(async () => {
      await this.metadataManager.setConfig(patch);
    });
  }

  async setBackupsEnabledOverride(backupsEnabledOverride: boolean | null) {
    await this.metadataManager.setBackupsEnabledOverride(backupsEnabledOverride);
  }

  async uploadFile(filename: string, contentBase64: string) {
    await this.adminManager.uploadFile(filename, contentBase64);
  }

  async getSessionBackupState() {
    await this.backupController.getSessionBackupState();
  }

  async createManualSessionCheckpoint() {
    await this.backupController.createManualSessionCheckpoint();
  }

  async restoreSessionBackup(checkpointId?: string) {
    await this.backupController.restoreSessionBackup(checkpointId);
  }

  async deleteSessionCheckpoint(checkpointId: string) {
    await this.backupController.deleteSessionCheckpoint(checkpointId);
  }

  async reloadSessionBackupStateFromDisk() {
    await this.backupController.reloadSessionBackupStateFromDisk();
  }

  async sendUserMessage(
    text: string,
    clientMessageId?: string,
    displayText?: string,
    attachments?: import("../jsonrpc/routes/shared").FileAttachment[],
    inputParts?: import("../jsonrpc/routes/shared").OrderedInputPart[],
  ) {
    await this.pendingConfigMutation.catch(() => {});
    await this.turnExecutionManager.sendUserMessage(text, clientMessageId, displayText, attachments, inputParts);
  }

  async sendSteerMessage(
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: import("../jsonrpc/routes/shared").FileAttachment[],
    inputParts?: import("../jsonrpc/routes/shared").OrderedInputPart[],
  ) {
    await this.pendingConfigMutation.catch(() => {});
    await this.turnExecutionManager.sendSteerMessage(text, expectedTurnId, clientMessageId, attachments, inputParts);
  }

  getSessionUsage() {
    const tracker = this.state.costTracker;
    if (!tracker) {
      this.context.emit({
        type: "session_usage",
        sessionId: this.id,
        usage: null,
      });
      return;
    }
    this.context.emit({
      type: "session_usage",
      sessionId: this.id,
      usage: tracker.getCompactSnapshot(),
    });
  }

  setSessionUsageBudget(warnAtUsd?: number | null, stopAtUsd?: number | null) {
    const tracker = this.state.costTracker;
    if (!tracker) {
      this.context.emit({
        type: "session_usage",
        sessionId: this.id,
        usage: null,
      });
      return;
    }

    try {
      tracker.updateBudget({ warnAtUsd, stopAtUsd });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.emitError("validation_failed", "session", message);
      return;
    }

    this.context.emit({
      type: "session_usage",
      sessionId: this.id,
      usage: tracker.getCompactSnapshot(),
    });
    this.queuePersistSessionSnapshot("session.usage_budget_updated");
  }

  private buildPersistedSnapshotAt(updatedAt: string): PersistedSessionSnapshot {
    return this.snapshotBuilder.buildPersistedSnapshotAt(updatedAt);
  }

  private buildCanonicalSnapshot(updatedAt: string): PersistedSessionMutation["snapshot"] {
    return this.snapshotBuilder.buildCanonicalSnapshot(updatedAt);
  }

  private queuePersistSessionSnapshot(reason: string) {
    this.persistenceManager.queuePersistSessionSnapshot(reason);
  }

  private enqueueConfigMutation(task: () => Promise<void>): Promise<void> {
    const mutation = this.pendingConfigMutation.catch(() => {}).then(task);
    this.pendingConfigMutation = mutation;
    return mutation;
  }

  private getCoworkPaths() {
    return this.runtimeSupport.getCoworkPaths();
  }

  private getGlobalAuthPaths() {
    return this.runtimeSupport.getGlobalAuthPaths();
  }

  private async runProviderConnect(opts: Parameters<typeof connectModelProvider>[0]): Promise<ConnectProviderResult> {
    return await this.runtimeSupport.runProviderConnect(opts);
  }

  private async getMcpServerByName(nameRaw: string): Promise<MCPRegistryServer | null> {
    return await this.runtimeSupport.getMcpServerByName(nameRaw);
  }

  private waitForPromptResponse<T>(requestId: string, bucket: Map<string, PromiseWithResolvers<T>>): Promise<T> {
    return this.runtimeSupport.waitForPromptResponse(requestId, bucket);
  }

  private emitError(code: ServerErrorCode, source: ServerErrorSource, message: string) {
    this.runtimeSupport.emitError(code, source, message);
  }

  private guardBusy(): boolean {
    return this.runtimeSupport.guardBusy();
  }

  private formatErrorMessage(err: unknown): string {
    return this.runtimeSupport.formatError(err);
  }

  private log(line: string) {
    this.runtimeSupport.log(line);
  }

  private attachCostTrackerListeners(tracker: SessionCostTracker) {
    tracker.addListener((event) => {
      if (event.type === "budget_warning") {
        this.context.emit({
          type: "budget_warning",
          sessionId: this.id,
          currentCostUsd: event.currentCostUsd,
          thresholdUsd: event.thresholdUsd,
          message: event.message,
        });
        this.log(`[cost] ${event.message}`);
        return;
      }

      if (event.type === "budget_exceeded") {
        this.context.emit({
          type: "budget_exceeded",
          sessionId: this.id,
          currentCostUsd: event.currentCostUsd,
          thresholdUsd: event.thresholdUsd,
          message: event.message,
        });
        this.log(`[cost] ${event.message}`);
      }
    });
  }

  private emitTelemetry(name: string, status: "ok" | "error", attributes?: Record<string, string | number | boolean>, durationMs?: number) {
    this.runtimeSupport.emitTelemetry(name, status, attributes, durationMs);
  }
}
