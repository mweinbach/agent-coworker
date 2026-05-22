import path from "node:path";

import type { runTurn } from "../../agent";
import type { ConnectProviderResult, connectProvider as connectModelProvider } from "../../connect";
import { closeMcpServersForSession } from "../../mcp";
import type { MCPRegistryServer } from "../../mcp/configRegistry";
import { MemoryStore, type MemoryScope } from "../../memoryStore";
import type { loadSystemPromptWithSkills } from "../../prompt";
import type { getProviderStatuses } from "../../providerStatus";
import { closePooledCodexAppServerClient } from "../../providers/codexAppServerClient";
import type { getProviderCatalog } from "../../providers/connectionCatalog";
import {
  SessionCostTracker,
  type SessionUsageSnapshot,
  type TurnUsage,
} from "../../session/costTracker";
import { HarnessContextStore } from "../../sessionContext/HarnessContextStore";
import type {
  AgentContextMode,
  AgentInspectResult,
  AgentReasoningEffort,
  AgentRole,
  AgentSpawnContextOptions,
} from "../../shared/agents";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import { getAiCoworkerPaths } from "../../store/connections";
import type {
  AgentConfig,
  HarnessContextPayload,
  MCPServerConfig,
  ServerErrorCode,
  ServerErrorSource,
} from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";
import type { AgentWaitMode } from "../agents/types";
import type { SessionConfigPatch, SessionEvent } from "../protocol";
import {
  type SessionBackupHandle,
  type SessionBackupInitOptions,
  SessionBackupManager,
} from "../sessionBackup";
import type { PersistedSessionMutation, SessionDb } from "../sessionDb";
import { type PersistedSessionSnapshot, writePersistedSessionSnapshot } from "../sessionStore";
import type { generateSessionTitle } from "../sessionTitleService";
import { DEFAULT_SESSION_TITLE } from "../sessionTitleService";
import {
  attachAgentSessionCostTrackerListeners,
  emitAgentSessionUsage,
  setAgentSessionUsageBudget,
  unsubscribeAgentSessionCostTracker,
} from "./AgentSessionCostTracking";
import {
  createAgentSessionFromPersisted,
  type AgentSessionFromPersistedOptions,
} from "./AgentSessionFromPersisted";
import {
  AgentSessionManagerRegistry,
  type AgentSessionManagerHost,
} from "./AgentSessionManagerRegistry";
import {
  ensureAgentSessionSystemPromptReady,
  refreshAgentSessionSystemPromptWithSkills,
  type AgentSessionSystemPromptState,
} from "./AgentSessionSystemPrompt";
import { HistoryManager } from "./HistoryManager";
import { InteractionManager, type PendingPromptReplayEvent } from "./InteractionManager";
import { McpManager } from "./McpManager";
import { PersistenceManager } from "./PersistenceManager";
import { ProviderAuthManager } from "./ProviderAuthManager";
import { ProviderCatalogManager } from "./ProviderCatalogManager";
import { SessionAdminManager } from "./SessionAdminManager";
import { SessionBackupController } from "./SessionBackupController";
import type {
  ExperimentalA2uiManager,
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
import { SessionMetadataManager } from "./SessionMetadataManager";
import { SessionRuntimeSupport } from "./SessionRuntimeSupport";
import { SessionSnapshotBuilder } from "./SessionSnapshotBuilder";
import { SessionSnapshotProjector } from "./SessionSnapshotProjector";
import { SkillManager } from "./SkillManager";
import { TurnExecutionManager } from "./TurnExecutionManager";
import {
  buildInitialSessionSnapshot,
  contentText,
  decorateSessionSnapshot,
  initialCurrentTurnOutcome,
  MAX_DISCONNECTED_REPLAY_EVENTS,
  normalizeHydratedSessionInfo,
  shouldReplayDisconnectedEvent,
} from "./AgentSessionHydration";
import {
  lazyConnectProvider,
  lazyGenerateSessionTitle,
  lazyGetProviderCatalog,
  lazyGetProviderStatuses,
  lazyLoadSystemPromptWithSkills,
  lazyRunTurn,
} from "./AgentSessionLazyImports";

function makeId(): string {
  return crypto.randomUUID();
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
  private readonly metadataManager: SessionMetadataManager;
  private readonly managers: AgentSessionManagerRegistry;
  private readonly backupController: SessionBackupController;
  private pendingConfigMutation: Promise<void> = Promise.resolve();
  private readonly memoryStore: MemoryStore;
  private systemPromptLoadPromise: Promise<boolean> | null = null;
  private skillCatalogMtimeSnapshot: string | null = null;
  private bufferDisconnectedEvents = false;
  private disconnectedReplayEvents: SessionEvent[] = [];
  private persistedLastEventSeq: number;
  private costTrackerUnsubscribe?: () => void;

  constructor(opts: {
    config: AgentConfig;
    system: string;
    sessionInfoPatch?: Partial<SessionInfoState>;
    discoveredSkills?: Array<{ name: string; description: string }>;
    yolo?: boolean;
    emit: (evt: SessionEvent) => void;
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
    inspectAgentImpl?: SessionDependencies["inspectAgentImpl"];
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
    getSkillMutationBlockReasonImpl?: SessionDependencies["getSkillMutationBlockReasonImpl"];
    readSkillCatalogMtimeSnapshotImpl?: SessionDependencies["readSkillCatalogMtimeSnapshotImpl"];
    refreshSkillsAcrossWorkspaceSessionsImpl?: SessionDependencies["refreshSkillsAcrossWorkspaceSessionsImpl"];
    createA2uiSurfaceManagerImpl?: SessionDependencies["createA2uiSurfaceManagerImpl"];
    deriveA2uiSurfacesFromSnapshotImpl?: SessionDependencies["deriveA2uiSurfacesFromSnapshotImpl"];
    initialSkillCatalogMtimeSnapshot?: string | null;
    hydratedState?: HydratedSessionState;
    initialSessionSnapshot?: SessionSnapshot;
    initialLastEventSeq?: number;
    seedContext?: SeededSessionContext;
    skipInitialPersist?: boolean;
    persistenceEnabled?: boolean;
  }) {
    const hydrated = opts.hydratedState;
    const hydratedSessionInfo = normalizeHydratedSessionInfo(hydrated);
    const seededMessages =
      hydrated?.messages ?? (opts.seedContext ? structuredClone(opts.seedContext.messages) : []);
    const seededTodos =
      hydrated?.todos ?? (opts.seedContext ? structuredClone(opts.seedContext.todos) : []);
    const seededHarnessContext =
      hydrated?.harnessContext ??
      (opts.seedContext?.harnessContext ? structuredClone(opts.seedContext.harnessContext) : null);
    this.id = hydrated?.sessionId ?? makeId();
    this.persistedLastEventSeq = Math.max(
      0,
      Math.floor(opts.initialLastEventSeq ?? opts.initialSessionSnapshot?.lastEventSeq ?? 0),
    );
    this.skillCatalogMtimeSnapshot = opts.initialSkillCatalogMtimeSnapshot ?? null;

    const now = new Date().toISOString();
    const initialBackupsEnabled =
      hydrated?.backupsEnabledOverride ?? opts.config.backupsEnabled ?? false;

    this.state = {
      config: opts.config,
      system: opts.system,
      discoveredSkills: opts.discoveredSkills ?? [],
      systemPromptMetadataLoaded:
        opts.system.trim().length > 0 && opts.discoveredSkills !== undefined,
      yolo: opts.yolo === true,
      messages: [],
      allMessages: [...seededMessages],
      providerState: hydrated?.providerState ?? null,
      running: false,
      connecting: false,
      abortController: null,
      currentTurnId: null,
      acceptingSteers: false,
      activeSteerHandler: null,
      pendingSteers: [],
      pendingExternalSkillRefreshReason: null,
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
        ...(opts.sessionInfoPatch?.parentSessionId
          ? { parentSessionId: opts.sessionInfoPatch.parentSessionId }
          : {}),
        ...(opts.sessionInfoPatch?.role ? { role: opts.sessionInfoPatch.role } : {}),
        ...(opts.sessionInfoPatch?.mode ? { mode: opts.sessionInfoPatch.mode } : {}),
        ...(typeof opts.sessionInfoPatch?.depth === "number"
          ? { depth: opts.sessionInfoPatch.depth }
          : {}),
        ...(opts.sessionInfoPatch?.nickname ? { nickname: opts.sessionInfoPatch.nickname } : {}),
        ...(opts.sessionInfoPatch?.taskType ? { taskType: opts.sessionInfoPatch.taskType } : {}),
        ...(opts.sessionInfoPatch?.targetPaths !== undefined
          ? { targetPaths: opts.sessionInfoPatch.targetPaths }
          : {}),
        ...(opts.sessionInfoPatch?.requestedModel
          ? { requestedModel: opts.sessionInfoPatch.requestedModel }
          : {}),
        ...(opts.sessionInfoPatch?.effectiveModel
          ? { effectiveModel: opts.sessionInfoPatch.effectiveModel }
          : {}),
        ...(opts.sessionInfoPatch?.requestedReasoningEffort
          ? { requestedReasoningEffort: opts.sessionInfoPatch.requestedReasoningEffort }
          : {}),
        ...(opts.sessionInfoPatch?.effectiveReasoningEffort
          ? { effectiveReasoningEffort: opts.sessionInfoPatch.effectiveReasoningEffort }
          : {}),
        ...(opts.sessionInfoPatch?.executionState
          ? { executionState: opts.sessionInfoPatch.executionState }
          : {}),
        ...(opts.sessionInfoPatch?.lastMessagePreview
          ? { lastMessagePreview: opts.sessionInfoPatch.lastMessagePreview }
          : {}),
      },
      persistenceStatus: hydrated?.status ?? "active",
      hasGeneratedTitle: hydrated?.hasGeneratedTitle ?? false,
      backupsEnabledOverride: hydrated?.backupsEnabledOverride ?? null,
      sessionBackup: null,
      sessionBackupState: {
        status: initialBackupsEnabled ? "initializing" : "disabled",
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

    this.memoryStore = new MemoryStore(
      `${opts.config.projectCoworkDir}/memory.sqlite`,
      `${opts.config.userCoworkDir}/memory.sqlite`,
    );

    this.deps = {
      connectProviderImpl: opts.connectProviderImpl ?? lazyConnectProvider,
      getAiCoworkerPathsImpl: opts.getAiCoworkerPathsImpl ?? getAiCoworkerPaths,
      loadSystemPromptWithSkillsImpl:
        opts.loadSystemPromptWithSkillsImpl ?? lazyLoadSystemPromptWithSkills,
      getProviderCatalogImpl: opts.getProviderCatalogImpl ?? lazyGetProviderCatalog,
      getProviderStatusesImpl: opts.getProviderStatusesImpl ?? lazyGetProviderStatuses,
      sessionBackupFactory:
        opts.sessionBackupFactory ??
        (async (factoryOpts: SessionBackupInitOptions): Promise<SessionBackupHandle> =>
          await SessionBackupManager.create(factoryOpts)),
      harnessContextStore: opts.harnessContextStore ?? new HarnessContextStore(),
      runTurnImpl: opts.runTurnImpl ?? lazyRunTurn,
      persistModelSelectionImpl: opts.persistModelSelectionImpl,
      persistProjectConfigPatchImpl: opts.persistProjectConfigPatchImpl,
      generateSessionTitleImpl: opts.generateSessionTitleImpl ?? lazyGenerateSessionTitle,
      sessionDb: opts.sessionDb ?? null,
      writePersistedSessionSnapshotImpl:
        opts.writePersistedSessionSnapshotImpl ?? writePersistedSessionSnapshot,
      createAgentSessionImpl: opts.createAgentSessionImpl,
      listAgentSessionsImpl: opts.listAgentSessionsImpl,
      sendAgentInputImpl: opts.sendAgentInputImpl,
      waitForAgentImpl: opts.waitForAgentImpl,
      inspectAgentImpl: opts.inspectAgentImpl,
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
      getSkillMutationBlockReasonImpl: opts.getSkillMutationBlockReasonImpl,
      readSkillCatalogMtimeSnapshotImpl: opts.readSkillCatalogMtimeSnapshotImpl,
      refreshSkillsAcrossWorkspaceSessionsImpl: opts.refreshSkillsAcrossWorkspaceSessionsImpl,
      createA2uiSurfaceManagerImpl: opts.createA2uiSurfaceManagerImpl,
      deriveA2uiSurfacesFromSnapshotImpl: opts.deriveA2uiSurfacesFromSnapshotImpl,
    };

    if (seededHarnessContext) {
      this.deps.harnessContextStore.set(this.id, seededHarnessContext);
    }

    const emit = (evt: SessionEvent) => {
      if (this.bufferDisconnectedEvents && shouldReplayDisconnectedEvent(evt)) {
        this.disconnectedReplayEvents.push(evt);
        if (this.disconnectedReplayEvents.length > MAX_DISCONNECTED_REPLAY_EVENTS) {
          this.disconnectedReplayEvents.splice(
            0,
            this.disconnectedReplayEvents.length - MAX_DISCONNECTED_REPLAY_EVENTS,
          );
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
      emitTelemetry: (name, status, attributes, durationMs) =>
        this.emitTelemetry(name, status, attributes, durationMs),
      formatError: (err) => this.formatErrorMessage(err),
      guardBusy: () => this.guardBusy(),
      getCoworkPaths: () => this.getCoworkPaths(),
      runProviderConnect: async (providerOpts) => await this.runProviderConnect(providerOpts),
      getMcpServerByName: async (nameRaw) => await this.getMcpServerByName(nameRaw),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      updateSessionInfo: (patch, infoOpts) =>
        this.metadataManager.updateSessionInfo(patch, infoOpts),
      emitConfigUpdated: () => this.metadataManager.emitConfigUpdated(),
      syncSessionBackupAvailability: async () => {},
      refreshProviderStatus: async (opts) =>
        await this.getProviderCatalogManager().refreshProviderStatus(opts),
      emitProviderCatalog: async () => await this.getProviderCatalogManager().emitProviderCatalog(),
      emitMcpServers: async () => await this.getMcpManager().emitMcpServers(),
      getSkillMutationBlockReason: () =>
        this.deps.getSkillMutationBlockReasonImpl?.(this.state.config.workingDirectory) ?? null,
      refreshSkillsAcrossWorkspaceSessions: async (refreshOpts) => {
        await this.deps.refreshSkillsAcrossWorkspaceSessionsImpl?.({
          workingDirectory: this.state.config.workingDirectory,
          sourceSessionId: this.id,
          ...(refreshOpts?.allWorkspaces ? { allWorkspaces: true } : {}),
        });
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
      persistenceEnabled: opts.persistenceEnabled !== false,
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
      emitTelemetry: (name, status, attributes, durationMs) =>
        this.emitTelemetry(name, status, attributes, durationMs),
      emitError: (message) => this.emitError("internal_error", "session", message),
      formatError: (err) => this.formatErrorMessage(err),
    });
    this.backupController = new SessionBackupController(this.context);
    this.context.syncSessionBackupAvailability = async () => {
      await this.backupController.syncSessionBackupAvailability();
    };
    this.historyManager.refreshRuntimeMessagesFromHistory();

    // Initialize cost tracker for this session.
    const costTracker = hydrated?.costTracker
      ? SessionCostTracker.fromSnapshot(hydrated.costTracker)
      : new SessionCostTracker(this.id);
    attachAgentSessionCostTrackerListeners(this.createCostTrackingHost(), costTracker);
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

    if (!opts.skipInitialPersist && opts.persistenceEnabled !== false) {
      this.queuePersistSessionSnapshot("session.created");
    }

    this.managers = new AgentSessionManagerRegistry(this.createManagerHost());
  }

  private createManagerHost(): AgentSessionManagerHost {
    return {
      id: this.id,
      context: this.context,
      state: this.state,
      deps: this.deps,
      interactionManager: this.interactionManager,
      historyManager: this.historyManager,
      metadataManager: this.metadataManager,
      backupController: this.backupController,
      sessionSnapshotProjector: this.sessionSnapshotProjector,
      sendUserMessage: (text, clientMessageId, displayText) =>
        this.sendUserMessage(text, clientMessageId, displayText),
      flushPendingExternalSkillRefresh: async () => await this.flushPendingExternalSkillRefresh(),
      getGlobalAuthPaths: () => this.getGlobalAuthPaths(),
      runProviderConnect: async (providerOpts) => await this.runProviderConnect(providerOpts),
      guardBusy: () => this.guardBusy(),
      emitTelemetry: (name, status, attributes, durationMs) =>
        this.emitTelemetry(name, status, attributes, durationMs),
      formatErrorMessage: (err) => this.formatErrorMessage(err),
      log: (line) => this.log(line),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      emitError: (code, source, message) => this.emitError(code, source, message),
    };
  }

  private createSystemPromptState(): AgentSessionSystemPromptState {
    return {
      state: this.state,
      deps: this.deps,
      context: this.context,
      getSkillCatalogMtimeSnapshot: () => this.skillCatalogMtimeSnapshot,
      setSkillCatalogMtimeSnapshot: (value) => {
        this.skillCatalogMtimeSnapshot = value;
      },
      getSystemPromptLoadPromise: () => this.systemPromptLoadPromise,
      setSystemPromptLoadPromise: (value) => {
        this.systemPromptLoadPromise = value;
      },
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
    };
  }

  private getSkillManager(): SkillManager {
    return this.managers.getSkillManager();
  }

  private getMcpManager(): McpManager {
    return this.managers.getMcpManager();
  }

  private getTurnExecutionManager(): TurnExecutionManager {
    return this.managers.getTurnExecutionManager();
  }

  private getA2uiSurfaceManager(): ExperimentalA2uiManager {
    return this.managers.getA2uiSurfaceManager();
  }

  private getAdminManager(): SessionAdminManager {
    return this.managers.getAdminManager();
  }

  private getProviderCatalogManager(): ProviderCatalogManager {
    return this.managers.getProviderCatalogManager();
  }

  private getProviderAuthManager(): ProviderAuthManager {
    return this.managers.getProviderAuthManager();
  }

  private createCostTrackingHost() {
    return {
      id: this.id,
      context: this.context,
      state: this.state,
      log: (line: string) => this.log(line),
      queuePersistSessionSnapshot: (reason: string) => this.queuePersistSessionSnapshot(reason),
      emitError: (code: "validation_failed", source: "session", message: string) =>
        this.emitError(code, source, message),
      getCostTrackerUnsubscribe: () => this.costTrackerUnsubscribe,
      setCostTrackerUnsubscribe: (value: (() => void) | undefined) => {
        this.costTrackerUnsubscribe = value;
      },
    };
  }

  static fromPersisted(opts: AgentSessionFromPersistedOptions): AgentSession {
    return createAgentSessionFromPersisted(opts);
  }

  buildSessionSnapshot(): SessionSnapshot {
    return decorateSessionSnapshot(this.sessionSnapshotProjector.getSnapshot(), {
      state: this.state,
      lastEventSeq: this.persistenceManager.getProjectedLastEventSeq(this.persistedLastEventSeq),
      hasPendingAsk: this.hasPendingAsk,
      hasPendingApproval: this.hasPendingApproval,
    });
  }

  peekSessionSnapshot(): SessionSnapshot {
    return decorateSessionSnapshot(this.sessionSnapshotProjector.peekSnapshot(), {
      state: this.state,
      lastEventSeq: this.persistenceManager.getProjectedLastEventSeq(this.persistedLastEventSeq),
      hasPendingAsk: this.hasPendingAsk,
      hasPendingApproval: this.hasPendingApproval,
    });
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
    return this.state.backupsEnabledOverride ?? this.state.config.backupsEnabled ?? false;
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

  getCompactUsageSnapshot(): SessionUsageSnapshot | null {
    return this.state.costTracker?.getCompactSnapshot() ?? null;
  }

  getLastTurnUsage(): TurnUsage | null {
    const turns = this.state.costTracker?.getCompactSnapshot(1).turns ?? [];
    const latest = turns[turns.length - 1];
    return latest
      ? {
          ...latest.usage,
          ...(latest.estimatedCostUsd !== null
            ? { estimatedCostUsd: latest.estimatedCostUsd }
            : {}),
        }
      : null;
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

  drainDisconnectedReplayEvents(): SessionEvent[] {
    this.bufferDisconnectedEvents = false;
    const drained = this.disconnectedReplayEvents;
    this.disconnectedReplayEvents = [];
    return drained;
  }

  reset() {
    this.managers.resetLoadedA2uiSurfaceManager();
    this.getAdminManager().reset();
  }

  listTools() {
    this.getSkillManager().listTools();
  }

  async listCommands() {
    await this.getSkillManager().listCommands();
  }

  async executeCommand(nameRaw: string, argumentsText = "", clientMessageId?: string) {
    await this.getSkillManager().executeCommand(nameRaw, argumentsText, clientMessageId);
  }

  async listSkills() {
    await this.getSkillManager().listSkills();
  }

  async readSkill(skillNameRaw: string) {
    await this.getSkillManager().readSkill(skillNameRaw);
  }

  async disableSkill(skillNameRaw: string) {
    await this.getSkillManager().disableSkill(skillNameRaw);
  }

  async enableSkill(skillNameRaw: string) {
    await this.getSkillManager().enableSkill(skillNameRaw);
  }

  async deleteSkill(skillNameRaw: string) {
    await this.getSkillManager().deleteSkill(skillNameRaw);
  }

  async getSkillsCatalog() {
    await this.getSkillManager().getSkillsCatalog();
  }

  async getPluginsCatalog() {
    await this.getSkillManager().getPluginsCatalog();
  }

  private async runExternalSkillRefresh(reason: string) {
    await this.refreshSystemPromptWithSkills(reason);
    await this.listSkills();
    await this.listCommands();
    await this.getSkillsCatalog();
    await this.getPluginsCatalog();
    await this.emitMcpServers();
  }

  async refreshSkillStateFromExternalMutation(reason = "skills.external_refresh") {
    if (this.state.running) {
      this.state.pendingExternalSkillRefreshReason = reason;
      return;
    }
    await this.runExternalSkillRefresh(reason);
  }

  async flushPendingExternalSkillRefresh() {
    const reason = this.state.pendingExternalSkillRefreshReason;
    if (!reason || this.state.running) {
      return;
    }
    this.state.pendingExternalSkillRefreshReason = null;
    await this.runExternalSkillRefresh(reason);
  }

  async getPlugin(pluginId: string, scope?: "workspace" | "user") {
    await this.getSkillManager().getPlugin(pluginId, scope);
  }

  async enablePlugin(pluginId: string, scope?: "workspace" | "user") {
    await this.getSkillManager().enablePlugin(pluginId, scope);
  }

  async disablePlugin(pluginId: string, scope?: "workspace" | "user") {
    await this.getSkillManager().disablePlugin(pluginId, scope);
  }

  async previewPluginInstall(sourceInput: string, targetScope: "workspace" | "user") {
    await this.getSkillManager().previewPluginInstall(sourceInput, targetScope);
  }

  async installPlugins(sourceInput: string, targetScope: "workspace" | "user") {
    await this.getSkillManager().installPlugins(sourceInput, targetScope);
  }

  async getSkillInstallation(installationId: string) {
    await this.getSkillManager().getSkillInstallation(installationId);
  }

  async previewSkillInstall(sourceInput: string, targetScope: "project" | "global") {
    await this.getSkillManager().previewSkillInstall(sourceInput, targetScope);
  }

  async installSkills(sourceInput: string, targetScope: "project" | "global") {
    await this.getSkillManager().installSkills(sourceInput, targetScope);
  }

  async enableSkillInstallation(installationId: string) {
    await this.getSkillManager().enableSkillInstallation(installationId);
  }

  async disableSkillInstallation(installationId: string) {
    await this.getSkillManager().disableSkillInstallation(installationId);
  }

  async deleteSkillInstallation(installationId: string) {
    await this.getSkillManager().deleteSkillInstallation(installationId);
  }

  async copySkillInstallation(installationId: string, targetScope: "project" | "global") {
    await this.getSkillManager().copySkillInstallation(installationId, targetScope);
  }

  async checkSkillInstallationUpdate(installationId: string) {
    await this.getSkillManager().checkSkillInstallationUpdate(installationId);
  }

  async updateSkillInstallation(installationId: string) {
    await this.getSkillManager().updateSkillInstallation(installationId);
  }

  async setEnableMcp(enableMcp: boolean) {
    await this.getMcpManager().setEnableMcp(enableMcp);
  }

  async setEnableMemory(enableMemory: boolean) {
    this.state.config = { ...this.state.config, enableMemory };
    if (this.deps.persistProjectConfigPatchImpl) {
      await this.deps.persistProjectConfigPatchImpl({ enableMemory });
    }
    this.context.emit({
      type: "session_settings",
      sessionId: this.id,
      enableMcp: this.getEnableMcp(),
      enableMemory: this.getEnableMemory(),
      memoryRequireApproval: this.getMemoryRequireApproval(),
    });
    this.queuePersistSessionSnapshot("session.enable_memory");
    await this.refreshSystemPromptWithSkills("session.enable_memory");
  }

  async setMemoryRequireApproval(memoryRequireApproval: boolean) {
    this.state.config = { ...this.state.config, memoryRequireApproval };
    if (this.deps.persistProjectConfigPatchImpl) {
      await this.deps.persistProjectConfigPatchImpl({ memoryRequireApproval });
    }
    this.context.emit({
      type: "session_settings",
      sessionId: this.id,
      enableMcp: this.getEnableMcp(),
      enableMemory: this.getEnableMemory(),
      memoryRequireApproval: this.getMemoryRequireApproval(),
    });
    this.queuePersistSessionSnapshot("session.memory_require_approval");
  }

  async emitMemories(scope?: MemoryScope) {
    try {
      const memories = await this.memoryStore.list(scope);
      this.context.emit({ type: "memory_list", sessionId: this.id, memories });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to list memories: ${String(err)}`,
      );
    }
  }

  async upsertMemory(scope: MemoryScope, id: string | undefined, content: string) {
    try {
      await this.memoryStore.upsert(scope, { id, content });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to upsert memory: ${String(err)}`,
      );
      return;
    }
    await this.emitMemories();
    await this.refreshSystemPromptWithSkills("session.memory_upsert");
  }

  async deleteMemory(scope: MemoryScope, id: string) {
    try {
      await this.memoryStore.remove(scope, id);
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to delete memory: ${String(err)}`,
      );
      return;
    }
    await this.emitMemories();
    await this.refreshSystemPromptWithSkills("session.memory_delete");
  }

  private async ensureSystemPromptReady(): Promise<boolean> {
    return await ensureAgentSessionSystemPromptReady(this.createSystemPromptState());
  }

  async refreshSystemPromptWithSkills(reason = "session.refresh_system_prompt") {
    await refreshAgentSessionSystemPromptWithSkills(this.createSystemPromptState(), reason);
  }

  async emitMcpServers() {
    await this.getMcpManager().emitMcpServers();
  }

  async upsertMcpServer(server: MCPServerConfig, previousName?: string) {
    await this.getMcpManager().upsert(server, previousName);
  }

  async deleteMcpServer(nameRaw: string) {
    await this.getMcpManager().delete(nameRaw);
  }

  async setMcpServerEnabled(opts: Parameters<McpManager["setEnabled"]>[0]) {
    await this.getMcpManager().setEnabled(opts);
  }

  async validateMcpServer(nameRaw: string) {
    await this.getMcpManager().validate(nameRaw);
  }

  async authorizeMcpServerAuth(nameRaw: string) {
    await this.getMcpManager().authorize(nameRaw);
  }

  async callbackMcpServerAuth(nameRaw: string, codeRaw?: string) {
    await this.getMcpManager().callback(nameRaw, codeRaw);
  }

  async setMcpServerApiKey(nameRaw: string, apiKeyRaw: string) {
    await this.getMcpManager().setApiKey(nameRaw, apiKeyRaw);
  }
  getHarnessContext() {
    this.metadataManager.getHarnessContext();
  }

  setHarnessContext(context: HarnessContextPayload) {
    this.metadataManager.setHarnessContext(context);
  }

  async setModel(modelIdRaw: string, providerRaw?: AgentConfig["provider"]) {
    await this.getProviderAuthManager().setModel(modelIdRaw, providerRaw);
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

      const preparedModel =
        opts.provider !== undefined && opts.model !== undefined
          ? await this.getProviderAuthManager().prepareModelSelection(opts.model, opts.provider)
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

      const preparedEnableMcp =
        typeof opts.enableMcp === "boolean"
          ? this.getMcpManager().prepareEnableMcpChange(opts.enableMcp)
          : null;

      const changed =
        (preparedModel?.changed ?? false) ||
        (preparedConfig?.changed ?? false) ||
        (preparedEnableMcp?.changed ?? false);
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
        await this.getProviderAuthManager().applyPreparedModelSelection(preparedModel, {
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
        await this.getMcpManager().applyPreparedEnableMcpChange(preparedEnableMcp, {
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
    await this.getProviderCatalogManager().emitProviderCatalog();
  }

  emitProviderAuthMethods() {
    this.getProviderCatalogManager().emitProviderAuthMethods();
  }

  async authorizeProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string) {
    await this.getProviderAuthManager().authorizeProviderAuth(providerRaw, methodIdRaw);
  }

  async logoutProviderAuth(providerRaw: AgentConfig["provider"]) {
    await this.getProviderAuthManager().logoutProviderAuth(providerRaw);
  }

  async callbackProviderAuth(
    providerRaw: AgentConfig["provider"],
    methodIdRaw: string,
    codeRaw?: string,
  ) {
    await this.getProviderAuthManager().callbackProviderAuth(providerRaw, methodIdRaw, codeRaw);
  }

  async setProviderApiKey(
    providerRaw: AgentConfig["provider"],
    methodIdRaw: string,
    apiKeyRaw: string,
  ) {
    await this.getProviderAuthManager().setProviderApiKey(providerRaw, methodIdRaw, apiKeyRaw);
  }

  async setProviderConfig(
    providerRaw: AgentConfig["provider"],
    methodIdRaw: string,
    values: Record<string, string>,
  ) {
    await this.getProviderAuthManager().setProviderConfig(providerRaw, methodIdRaw, values);
  }

  async copyProviderApiKey(
    providerRaw: AgentConfig["provider"],
    sourceProviderRaw: AgentConfig["provider"],
  ) {
    await this.getProviderAuthManager().copyProviderApiKey(providerRaw, sourceProviderRaw);
  }

  async refreshProviderStatus(opts: { refreshBedrockDiscovery?: boolean } = {}) {
    await this.getProviderCatalogManager().refreshProviderStatus(opts);
  }

  handleAskResponse(requestId: string, answer: string) {
    const handled = this.getTurnExecutionManager().handleAskResponse(requestId, answer);
    if (handled) {
      this.sessionSnapshotProjector.syncSessionState({ hasPendingAsk: this.hasPendingAsk });
    }
  }

  handleApprovalResponse(requestId: string, approved: boolean) {
    const handled = this.getTurnExecutionManager().handleApprovalResponse(requestId, approved);
    if (handled) {
      this.sessionSnapshotProjector.syncSessionState({
        hasPendingApproval: this.hasPendingApproval,
      });
    }
  }

  cancel(opts?: { includeSubagents?: boolean }) {
    this.getTurnExecutionManager().cancel(opts);
  }

  async closeForHistory(): Promise<void> {
    this.state.persistenceStatus = "closed";
    if (this.state.config.provider === "codex-cli") {
      await closePooledCodexAppServerClient(
        this.state.config.workingDirectory,
        path.join(resolveAuthHomeDir(this.state.config), ".cowork", "auth", "codex-cli"),
      );
    }
    await closeMcpServersForSession(this.id);
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
      (this.state.sessionInfo.sessionKind ?? "root") === "agent" &&
      this.state.sessionInfo.executionState === "closed"
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
    unsubscribeAgentSessionCostTracker(this.createCostTrackingHost());
    this.managers.disposeManagers();
    if (this.state.config.provider === "codex-cli") {
      void closePooledCodexAppServerClient(
        this.state.config.workingDirectory,
        path.join(resolveAuthHomeDir(this.state.config), ".cowork", "auth", "codex-cli"),
      ).catch(() => {});
    }
    void closeMcpServersForSession(this.id);

    void this.waitForPersistenceIdle().finally(() => {
      this.deps.harnessContextStore.clear(this.id);
    });
    void this.backupController.closeSessionBackup();
  }

  getMessages(offset = 0, limit = 100) {
    this.getAdminManager().getMessages(offset, limit);
  }

  buildForkContextSeed(): SeededSessionContext {
    return {
      messages: structuredClone(this.state.allMessages),
      todos: structuredClone(this.state.todos),
      harnessContext: this.deps.harnessContextStore.get(this.id),
    };
  }

  buildContextSeed(opts: {
    contextMode: Exclude<AgentContextMode, "full">;
    briefing?: string;
    includeParentTodos?: boolean;
    includeHarnessContext?: boolean;
  }): SeededSessionContext {
    return {
      messages:
        opts.contextMode === "brief" && opts.briefing
          ? [{ role: "user", content: `Parent briefing:\n${opts.briefing}` }]
          : [],
      todos: opts.includeParentTodos ? structuredClone(this.state.todos) : [],
      harnessContext: opts.includeHarnessContext
        ? this.deps.harnessContextStore.get(this.id)
        : null,
    };
  }

  setSessionTitle(title: string) {
    this.metadataManager.setSessionTitle(title);
  }

  async listSessions(scope: "all" | "workspace" = "all") {
    await this.getAdminManager().listSessions(scope);
  }

  async getSessionSnapshot(targetSessionId: string) {
    await this.getAdminManager().getSessionSnapshot(targetSessionId);
  }

  async listAgentSessions() {
    await this.getAdminManager().listAgentSessions();
  }

  async createAgentSession(
    opts: AgentSpawnContextOptions & {
      message: string;
      role?: AgentRole;
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
    },
  ) {
    await this.getAdminManager().createAgentSession(opts);
  }

  async sendAgentInput(agentId: string, message: string, interrupt?: boolean) {
    await this.getAdminManager().sendAgentInput(agentId, message, interrupt);
  }

  async waitForAgents(agentIds: string[], timeoutMs?: number, mode?: AgentWaitMode) {
    await this.getAdminManager().waitForAgents(agentIds, timeoutMs, mode);
  }

  async inspectAgent(agentId: string): Promise<AgentInspectResult> {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      throw new Error("Only root sessions can inspect child agents");
    }
    if (!this.context.deps.inspectAgentImpl) {
      throw new Error("Child-agent inspection is unavailable");
    }
    return await this.context.deps.inspectAgentImpl({
      parentSessionId: this.context.id,
      agentId,
    });
  }

  async resumeAgent(agentId: string) {
    await this.getAdminManager().resumeAgent(agentId);
  }

  async closeAgent(agentId: string) {
    await this.getAdminManager().closeAgent(agentId);
  }

  async deleteSession(targetSessionId: string) {
    await this.getAdminManager().deleteSession(targetSessionId);
  }

  async listWorkspaceBackups() {
    await this.getAdminManager().listWorkspaceBackups();
  }

  async createWorkspaceBackupCheckpoint(targetSessionId: string) {
    await this.getAdminManager().createWorkspaceBackupCheckpoint(targetSessionId);
  }

  async restoreWorkspaceBackup(targetSessionId: string, checkpointId?: string) {
    await this.getAdminManager().restoreWorkspaceBackup(targetSessionId, checkpointId);
  }

  async deleteWorkspaceBackupCheckpoint(targetSessionId: string, checkpointId: string) {
    await this.getAdminManager().deleteWorkspaceBackupCheckpoint(targetSessionId, checkpointId);
  }

  async deleteWorkspaceBackupEntry(targetSessionId: string) {
    await this.getAdminManager().deleteWorkspaceBackupEntry(targetSessionId);
  }

  async getWorkspaceBackupDelta(targetSessionId: string, checkpointId: string) {
    await this.getAdminManager().getWorkspaceBackupDelta(targetSessionId, checkpointId);
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
    await this.getAdminManager().uploadFile(filename, contentBase64);
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
    if (!(await this.ensureSystemPromptReady())) {
      return;
    }
    await this.getTurnExecutionManager().sendUserMessage(
      text,
      clientMessageId,
      displayText,
      attachments,
      inputParts,
    );
  }

  async sendSteerMessage(
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: import("../jsonrpc/routes/shared").FileAttachment[],
    inputParts?: import("../jsonrpc/routes/shared").OrderedInputPart[],
  ) {
    await this.pendingConfigMutation.catch(() => {});
    if (!(await this.ensureSystemPromptReady())) {
      return;
    }
    await this.getTurnExecutionManager().sendSteerMessage(
      text,
      expectedTurnId,
      clientMessageId,
      attachments,
      inputParts,
    );
  }

  validateA2uiAction(opts: {
    surfaceId: string;
    componentId: string;
  }): ReturnType<ExperimentalA2uiManager["validateAction"]> {
    return this.getA2uiSurfaceManager().validateAction(opts);
  }

  getSessionUsage() {
    emitAgentSessionUsage(this.createCostTrackingHost());
  }

  setSessionUsageBudget(warnAtUsd?: number | null, stopAtUsd?: number | null) {
    setAgentSessionUsageBudget(this.createCostTrackingHost(), warnAtUsd, stopAtUsd);
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

  private async runProviderConnect(
    opts: Parameters<typeof connectModelProvider>[0],
  ): Promise<ConnectProviderResult> {
    return await this.runtimeSupport.runProviderConnect(opts);
  }

  private async getMcpServerByName(nameRaw: string): Promise<MCPRegistryServer | null> {
    return await this.runtimeSupport.getMcpServerByName(nameRaw);
  }

  private waitForPromptResponse<T>(
    requestId: string,
    bucket: Map<string, PromiseWithResolvers<T>>,
  ): Promise<T> {
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

  private emitTelemetry(
    name: string,
    status: "ok" | "error",
    attributes?: Record<string, string | number | boolean>,
    durationMs?: number,
  ) {
    this.runtimeSupport.emitTelemetry(name, status, attributes, durationMs);
  }
}
