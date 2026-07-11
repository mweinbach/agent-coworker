import path from "node:path";
import {
  MemoryGenerator,
  serializeTurnDelta,
  splitMessagesForMemoryBackfill,
} from "../../advancedMemory/MemoryGenerator";
import {
  AdvancedMemoryStore,
  resolveMemoriesDir,
  resolveMemoryFolderName,
} from "../../advancedMemory/store";
import type { runTurn } from "../../agent";
import type { ConnectProviderResult, connectProvider as connectModelProvider } from "../../connect";
import { closeMcpServersForSession, getOrLoadMCPToolsCached } from "../../mcp";
import type {
  EditableMCPServerConfigSource,
  MCPRegistryServer,
  MCPServerSource,
} from "../../mcp/configRegistry";
import { type MemoryScope, MemoryStore } from "../../memoryStore";
import type { loadSystemPromptWithSkills } from "../../prompt";
import type { getProviderStatuses } from "../../providerStatus";
import type { logoutProviderAuth } from "../../providers/authRegistry";
import { closePooledCodexAppServerClient } from "../../providers/codexAppServerClient";
import type { getProviderCatalog } from "../../providers/connectionCatalog";
import { deleteCustomModel, upsertCustomModel } from "../../providers/customModels";
import { resetModelPreferences, setModelPreferences } from "../../providers/modelPreferences";
import {
  SessionCostTracker,
  type SessionUsageSnapshot,
  type TurnUsage,
} from "../../session/costTracker";
import { HarnessContextStore } from "../../sessionContext/HarnessContextStore";
import type { AgentProfileCopyInput, AgentProfileUpsertInput } from "../../shared/agentProfiles";
import type {
  AgentContextMode,
  AgentInspectResult,
  AgentReasoningEffort,
  AgentRole,
  AgentSpawnContextOptions,
  PersistentAgentSummary,
} from "../../shared/agents";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import { getAiCoworkerPaths } from "../../store/connections";
import type {
  AgentConfig,
  HarnessContextPayload,
  MCPServerConfig,
  ModelMessage,
  ServerErrorCode,
  ServerErrorData,
  ServerErrorSource,
} from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";
import {
  copyAgentProfile,
  deleteAgentProfile,
  readAgentProfilesCatalog,
  setAgentProfileWorkspaceAvailability,
  upsertAgentProfile,
} from "../agents/profiles";
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
  type AgentSessionFromPersistedOptions,
  createAgentSessionFromPersisted,
} from "./AgentSessionFromPersisted";
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
  warmLazyTurnModules,
} from "./AgentSessionLazyImports";
import {
  type AgentSessionManagerHost,
  AgentSessionManagerRegistry,
} from "./AgentSessionManagerRegistry";
import {
  type AgentSessionSystemPromptState,
  ensureAgentSessionSystemPromptReady,
  refreshAgentSessionSystemPromptWithSkills,
} from "./AgentSessionSystemPrompt";
import { HistoryManager } from "./HistoryManager";
import { InteractionManager, type PendingPromptReplayEvent } from "./InteractionManager";
import type { McpManager } from "./McpManager";
import type { McpServerLookup } from "./mcp/McpServerLookup";
import { PersistenceManager } from "./PersistenceManager";
import type { ProviderAuthManager } from "./ProviderAuthManager";
import type { ProviderCatalogManager } from "./ProviderCatalogManager";
import type { SessionAdminManager } from "./SessionAdminManager";
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
import { SessionMetadataManager } from "./SessionMetadataManager";
import { SessionRuntimeSupport } from "./SessionRuntimeSupport";
import { SessionSnapshotBuilder } from "./SessionSnapshotBuilder";
import { SessionSnapshotProjector } from "./SessionSnapshotProjector";
import type { SkillManager } from "./SkillManager";
import type {
  SendUserMessageOptions,
  TurnExecutionManager,
  UserMessageIdempotencyClaim,
  UserMessageIdempotencyInput,
} from "./TurnExecutionManager";
import type { TaskLockError } from "./taskLocks";

const MEMORY_GENERATIONS_PER_CONSOLIDATION = 5;

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
  private readonly advancedMemoryStore: AdvancedMemoryStore;
  private readonly memoryGenerator: MemoryGenerator;
  private memoryGenerationQueue: Promise<void> = Promise.resolve();
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
    getOrLoadMCPToolsCachedImpl?: typeof getOrLoadMCPToolsCached;
    getProviderCatalogImpl?: typeof getProviderCatalog;
    getProviderStatusesImpl?: typeof getProviderStatuses;
    logoutProviderAuthImpl?: typeof logoutProviderAuth;
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
    getTaskContextImpl?: SessionDependencies["getTaskContextImpl"];
    getTaskReviewMaterialImpl?: SessionDependencies["getTaskReviewMaterialImpl"];
    applyTaskDirectiveImpl?: SessionDependencies["applyTaskDirectiveImpl"];
    createTaskImpl?: SessionDependencies["createTaskImpl"];
    getLiveSessionSnapshotImpl?: SessionDependencies["getLiveSessionSnapshotImpl"];
    getLiveSessionParentIdImpl?: SessionDependencies["getLiveSessionParentIdImpl"];
    buildLegacySessionSnapshotImpl?: SessionDependencies["buildLegacySessionSnapshotImpl"];
    getSkillMutationBlockReasonImpl?: SessionDependencies["getSkillMutationBlockReasonImpl"];
    readSkillCatalogMtimeSnapshotImpl?: SessionDependencies["readSkillCatalogMtimeSnapshotImpl"];
    refreshSkillsAcrossWorkspaceSessionsImpl?: SessionDependencies["refreshSkillsAcrossWorkspaceSessionsImpl"];
    recordSkillImprovementUsageImpl?: SessionDependencies["recordSkillImprovementUsageImpl"];
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
    const hydratedMemoryGeneratedIndex =
      typeof hydrated?.lastMemoryGeneratedIndex === "number" &&
      Number.isFinite(hydrated.lastMemoryGeneratedIndex)
        ? Math.min(
            Math.max(0, Math.floor(hydrated.lastMemoryGeneratedIndex)),
            seededMessages.length,
          )
        : seededMessages.length;
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
      currentTurnMessageStartIndex: seededMessages.length,
      currentTurnSkillUsages: [],
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
        ...(opts.sessionInfoPatch?.profile ? { profile: opts.sessionInfoPatch.profile } : {}),
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
      lastMemoryGeneratedIndex: hydratedMemoryGeneratedIndex,
      memoryGenerationsSinceConsolidation: 0,
      costTracker: null,
      turnReferenceInjectionCounter: 0,
    };

    this.memoryStore = new MemoryStore(
      opts.config.projectMemoryDbPath ?? `${opts.config.projectCoworkDir}/memory.sqlite`,
      `${opts.config.userCoworkDir}/memory.sqlite`,
    );

    this.advancedMemoryStore = new AdvancedMemoryStore(resolveMemoriesDir(opts.config));
    this.memoryGenerator = new MemoryGenerator();

    this.deps = {
      connectProviderImpl: opts.connectProviderImpl ?? lazyConnectProvider,
      getAiCoworkerPathsImpl: opts.getAiCoworkerPathsImpl ?? getAiCoworkerPaths,
      loadSystemPromptWithSkillsImpl:
        opts.loadSystemPromptWithSkillsImpl ?? lazyLoadSystemPromptWithSkills,
      getOrLoadMCPToolsCachedImpl: opts.getOrLoadMCPToolsCachedImpl ?? getOrLoadMCPToolsCached,
      getProviderCatalogImpl: opts.getProviderCatalogImpl ?? lazyGetProviderCatalog,
      getProviderStatusesImpl: opts.getProviderStatusesImpl ?? lazyGetProviderStatuses,
      logoutProviderAuthImpl: opts.logoutProviderAuthImpl,
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
      getTaskContextImpl: opts.getTaskContextImpl,
      getTaskReviewMaterialImpl: opts.getTaskReviewMaterialImpl,
      applyTaskDirectiveImpl: opts.applyTaskDirectiveImpl,
      createTaskImpl: opts.createTaskImpl,
      getLiveSessionSnapshotImpl: opts.getLiveSessionSnapshotImpl,
      getLiveSessionParentIdImpl:
        opts.getLiveSessionParentIdImpl ??
        ((sessionId: string) =>
          sessionId === this.id ? (this.state.sessionInfo.parentSessionId ?? null) : null),
      buildLegacySessionSnapshotImpl: opts.buildLegacySessionSnapshotImpl,
      getSkillMutationBlockReasonImpl: opts.getSkillMutationBlockReasonImpl,
      readSkillCatalogMtimeSnapshotImpl: opts.readSkillCatalogMtimeSnapshotImpl,
      refreshSkillsAcrossWorkspaceSessionsImpl: opts.refreshSkillsAcrossWorkspaceSessionsImpl,
      recordSkillImprovementUsageImpl: opts.recordSkillImprovementUsageImpl,
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
      emitError: (code, source, message, data) => this.emitError(code, source, message, data),
      emitTelemetry: (name, status, attributes, durationMs) =>
        this.emitTelemetry(name, status, attributes, durationMs),
      formatError: (err) => this.formatErrorMessage(err),
      guardBusy: () => this.guardBusy(),
      getCoworkPaths: () => this.getCoworkPaths(),
      runProviderConnect: async (providerOpts) => await this.runProviderConnect(providerOpts),
      getMcpServerByName: async (nameRaw, lookup) => await this.getMcpServerByName(nameRaw, lookup),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      updateSessionInfo: (patch, infoOpts) =>
        this.metadataManager.updateSessionInfo(patch, infoOpts),
      emitConfigUpdated: () => this.metadataManager.emitConfigUpdated(),
      syncSessionBackupAvailability: async () => {},
      refreshProviderStatus: async (opts) =>
        await this.getProviderCatalogManager().refreshProviderStatus(opts),
      emitProviderCatalog: async (opts) =>
        await this.getProviderCatalogManager().emitProviderCatalog(opts),
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
      triggerMemoryGeneration: () => this.triggerMemoryGeneration(),
      triggerSkillImprovementUsage: () => this.triggerSkillImprovementUsage(),
      getGlobalAuthPaths: () => this.getGlobalAuthPaths(),
      runProviderConnect: async (providerOpts) => await this.runProviderConnect(providerOpts),
      onAdvancedMemoryChanged: async (folder) => await this.onAdvancedMemoryChanged(folder),
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
      if (message?.role !== "assistant") continue;
      const text = contentText(message.content);
      if (text) return text;
    }
    return undefined;
  }

  recordAgentStatus(agent: PersistentAgentSummary): void {
    this.context.emit({ type: "agent_status", sessionId: this.id, agent });
    this.queuePersistSessionSnapshot("session.agent_status");
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

  async getAgentProfilesCatalog() {
    const catalog = await readAgentProfilesCatalog(this.state.config);
    this.context.emit({
      type: "agent_profiles_catalog",
      sessionId: this.id,
      catalog,
    });
  }

  async upsertAgentProfile(input: AgentProfileUpsertInput) {
    const catalog = await upsertAgentProfile(this.state.config, input);
    this.context.emit({ type: "agent_profiles_catalog", sessionId: this.id, catalog });
    await this.refreshSystemPromptWithSkills("agent_profiles.upsert");
  }

  async deleteAgentProfile(scope: "global" | "workspace", id: string) {
    const catalog = await deleteAgentProfile(this.state.config, scope, id);
    this.context.emit({ type: "agent_profiles_catalog", sessionId: this.id, catalog });
    await this.refreshSystemPromptWithSkills("agent_profiles.delete");
  }

  async copyAgentProfile(input: AgentProfileCopyInput) {
    const catalog = await copyAgentProfile(this.state.config, input);
    this.context.emit({ type: "agent_profiles_catalog", sessionId: this.id, catalog });
    await this.refreshSystemPromptWithSkills("agent_profiles.copy");
  }

  async setAgentProfileWorkspaceAvailability(id: string, disabled: boolean) {
    const catalog = await setAgentProfileWorkspaceAvailability(this.state.config, id, disabled);
    this.context.emit({ type: "agent_profiles_catalog", sessionId: this.id, catalog });
    await this.refreshSystemPromptWithSkills("agent_profiles.workspace_availability");
  }

  async getPluginsCatalog() {
    await this.getSkillManager().getPluginsCatalog();
  }

  async listMarketplaces() {
    await this.getSkillManager().listMarketplaces();
  }

  async readMarketplaceDetail(marketplaceId: string) {
    await this.getSkillManager().readMarketplaceDetail(marketplaceId);
  }

  async addMarketplace(sourceInput: string) {
    await this.getSkillManager().addMarketplace(sourceInput);
  }

  async removeMarketplace(marketplaceId: string) {
    await this.getSkillManager().removeMarketplace(marketplaceId);
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

  async deletePlugin(pluginId: string, scope?: "workspace" | "user") {
    await this.getSkillManager().deletePlugin(pluginId, scope);
  }

  async checkPluginUpdate(pluginId: string, scope?: "workspace" | "user") {
    await this.getSkillManager().checkPluginUpdate(pluginId, scope);
  }

  async updatePlugin(pluginId: string, scope?: "workspace" | "user") {
    await this.getSkillManager().updatePlugin(pluginId, scope);
  }

  async previewPluginInstall(sourceInput: string, targetScope: "workspace" | "user") {
    await this.getSkillManager().previewPluginInstall(sourceInput, targetScope);
  }

  async installPlugins(sourceInput: string, targetScope: "workspace" | "user") {
    await this.getSkillManager().installPlugins(sourceInput, targetScope);
  }

  async listImport(
    source: import("../../import").ImportSource,
    kind: import("../../import").ImportableKind,
  ) {
    await this.getSkillManager().listImport(source, kind);
  }

  async importPlugin(
    sourcePath: string,
    conversionRequired: boolean,
    targetScope: "workspace" | "user",
  ) {
    await this.getSkillManager().importPlugin(sourcePath, conversionRequired, targetScope);
  }

  async importSkill(sourcePath: string, targetScope: "workspace" | "user") {
    await this.getSkillManager().importSkill(sourcePath, targetScope);
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

  private resolveAdvancedMemoryFolder(folder?: string): string {
    return folder?.trim() || resolveMemoryFolderName(this.state.config);
  }

  async emitAdvancedMemories(folder?: string) {
    try {
      const resolvedFolder = this.resolveAdvancedMemoryFolder(folder);
      const [folders, memories] = await Promise.all([
        this.advancedMemoryStore.listFolders(),
        this.advancedMemoryStore.listMemories(resolvedFolder),
      ]);
      this.context.emit({
        type: "advanced_memory_list",
        sessionId: this.id,
        folder: resolvedFolder,
        folders,
        memories,
      });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to list advanced memories: ${String(err)}`,
      );
    }
  }

  async upsertAdvancedMemory(
    folder: string | undefined,
    input: { slug?: string; name: string; description: string; type?: string; body: string },
  ) {
    const resolvedFolder = this.resolveAdvancedMemoryFolder(folder);
    try {
      if (input.slug) {
        // Edit: preserve the existing memory's originSessionId (and any other
        // untouched fields) instead of clobbering it. Fall back to a create if
        // the target no longer exists.
        const edited = await this.advancedMemoryStore.editMemory(resolvedFolder, input.slug, {
          name: input.name,
          description: input.description,
          type: input.type,
          body: input.body,
        });
        if (!edited) {
          await this.advancedMemoryStore.writeMemory(resolvedFolder, {
            ...input,
            originSessionId: this.id,
          });
        }
      } else {
        await this.advancedMemoryStore.writeMemory(resolvedFolder, {
          ...input,
          originSessionId: this.id,
        });
      }
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to upsert advanced memory: ${String(err)}`,
      );
      return;
    }
    await this.emitAdvancedMemories(resolvedFolder);
    await this.refreshSystemPromptWithSkills("session.advanced_memory_upsert");
  }

  async deleteAdvancedMemory(folder: string | undefined, slug: string) {
    const resolvedFolder = this.resolveAdvancedMemoryFolder(folder);
    try {
      await this.advancedMemoryStore.deleteMemory(resolvedFolder, slug);
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to delete advanced memory: ${String(err)}`,
      );
      return;
    }
    await this.emitAdvancedMemories(resolvedFolder);
    await this.refreshSystemPromptWithSkills("session.advanced_memory_delete");
  }

  async onAdvancedMemoryChanged(folder: string): Promise<void> {
    await this.emitAdvancedMemories(folder);
    await this.refreshSystemPromptWithSkills("tool.manage_memory");
  }

  async generateAdvancedMemoryForHistory(folder?: string) {
    const resolvedFolder = this.resolveAdvancedMemoryFolder(folder);
    const messages = [...this.state.allMessages];
    const shouldCheckpointAutomaticGeneration =
      resolvedFolder === resolveMemoryFolderName(this.state.config);
    this.memoryGenerationQueue = this.memoryGenerationQueue
      .then(async () => {
        const backfilled = await this.runMemoryBackfill(resolvedFolder, messages);
        if (backfilled && shouldCheckpointAutomaticGeneration) {
          const nextIndex = Math.max(this.state.lastMemoryGeneratedIndex, messages.length);
          if (nextIndex !== this.state.lastMemoryGeneratedIndex) {
            this.state.lastMemoryGeneratedIndex = nextIndex;
            this.queuePersistSessionSnapshot("session.advanced_memory_backfill_checkpoint");
          }
        }
      })
      .catch((err) => {
        // Manual generation failures are emitted as session errors and must not
        // poison the per-session generation queue.
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to generate advanced memories from this conversation: ${String(err)}`,
        );
      });
    await this.memoryGenerationQueue;
  }

  /**
   * Fire-and-forget advanced memory generation for the just-completed turn.
   * Runs are serialized on a per-session queue so overlapping turns never
   * interleave reads/writes against the same memory folder. The delta marker is
   * advanced only after a run completes successfully, so a failed run leaves its
   * messages to be reprocessed by the next turn. No-op unless advanced memory is on.
   */
  triggerMemoryGeneration(): void {
    if (!this.state.config.advancedMemory) return;
    const targetMessageIndex = this.state.allMessages.length;
    this.memoryGenerationQueue = this.memoryGenerationQueue
      .then(() => this.runMemoryGenerationOnce(targetMessageIndex))
      .catch(() => {
        // Generation failures must never affect the user-facing turn or the queue.
      });
  }

  triggerSkillImprovementUsage(): void {
    if (!this.state.config.skillImprovementEnabled) return;
    const usages = this.state.currentTurnSkillUsages;
    if (usages.length === 0) return;
    const turnId = usages[0]?.turnId ?? this.state.currentTurnId;
    if (!turnId) return;

    const messageStartIndex = Math.max(0, this.state.currentTurnMessageStartIndex);
    const messageEndIndex = this.state.allMessages.length;
    const deltaMessages = this.state.allMessages.slice(messageStartIndex, messageEndIndex);
    const transcript = serializeTurnDelta(deltaMessages);
    const payload = {
      sessionId: this.id,
      turnId,
      workingDirectory: this.state.config.workingDirectory,
      messageStartIndex,
      messageEndIndex,
      transcript,
      usages: usages.map((usage) => ({ ...usage })),
    };
    this.state.currentTurnSkillUsages = [];

    Promise.resolve(this.deps.recordSkillImprovementUsageImpl?.(payload)).catch((error) => {
      this.context.emit({
        type: "log",
        sessionId: this.id,
        line: `[skill-improvement] failed to record usage: ${String(error)}`,
      });
    });
  }

  private async runMemoryGenerationOnce(targetMessageIndex: number): Promise<void> {
    if (!this.state.config.advancedMemory) return;
    const start = this.state.lastMemoryGeneratedIndex;
    const end = Math.min(targetMessageIndex, this.state.allMessages.length);
    if (end <= start) return;
    const deltaMessages = this.state.allMessages.slice(start, end);
    const folder = resolveMemoryFolderName(this.state.config);
    const result = await this.memoryGenerator.run({
      config: this.state.config,
      sessionId: this.id,
      deltaMessages,
      folder,
      log: (line) => this.context.emit({ type: "log", sessionId: this.id, line }),
      abortSignal: undefined,
    });
    // Advance only when the generator completed its pass (including an
    // intentional no-op). On runtime failure (`ok: false`) the marker stays so
    // the delta is retried on the next turn.
    if (result.ok) {
      this.state.lastMemoryGeneratedIndex = end;
      this.queuePersistSessionSnapshot("session.advanced_memory_checkpoint");
      if (result.ran) {
        this.state.memoryGenerationsSinceConsolidation += 1;
        const consolidation = await this.maybeRunMemoryConsolidation(folder);
        await this.refreshSystemPromptWithSkills(
          consolidation.ran
            ? "session.advanced_memory_consolidated"
            : "session.advanced_memory_generated",
        );
        await this.emitAdvancedMemories(folder);
      }
    }
  }

  private async maybeRunMemoryConsolidation(
    folder = resolveMemoryFolderName(this.state.config),
  ): Promise<{ ran: boolean; ok: boolean }> {
    if (
      !this.state.config.advancedMemory ||
      this.state.memoryGenerationsSinceConsolidation < MEMORY_GENERATIONS_PER_CONSOLIDATION
    ) {
      return { ran: false, ok: true };
    }

    const result = await this.runMemoryConsolidation(folder);
    if (result.ok) {
      this.state.memoryGenerationsSinceConsolidation = 0;
    }
    return result;
  }

  private async runMemoryConsolidation(folder: string): Promise<{ ran: boolean; ok: boolean }> {
    if (!this.state.config.advancedMemory) return { ran: false, ok: true };
    return await this.memoryGenerator.consolidate({
      config: this.state.config,
      sessionId: this.id,
      folder,
      log: (line) => this.context.emit({ type: "log", sessionId: this.id, line }),
      abortSignal: undefined,
    });
  }

  private async runMemoryBackfill(folder: string, messages: ModelMessage[]): Promise<boolean> {
    if (!this.state.config.advancedMemory) {
      await this.emitAdvancedMemories(folder);
      return false;
    }

    const chunks = splitMessagesForMemoryBackfill(messages);
    if (chunks.length === 0) {
      await this.emitAdvancedMemories(folder);
      return true;
    }

    let ranAny = false;
    for (const deltaMessages of chunks) {
      const result = await this.memoryGenerator.run({
        config: this.state.config,
        sessionId: this.id,
        deltaMessages,
        folder,
        log: (line) => this.context.emit({ type: "log", sessionId: this.id, line }),
        abortSignal: undefined,
      });
      if (!result.ok) {
        this.context.emitError(
          "internal_error",
          "session",
          "Failed to generate advanced memories from this conversation.",
        );
        return false;
      }
      ranAny = ranAny || result.ran;
    }

    if (ranAny) {
      const consolidation = await this.runMemoryConsolidation(folder);
      await this.refreshSystemPromptWithSkills(
        consolidation.ran
          ? "session.advanced_memory_backfill_consolidated"
          : "session.advanced_memory_backfill",
      );
    }
    await this.emitAdvancedMemories(folder);
    return true;
  }

  private async ensureSystemPromptReady(): Promise<boolean> {
    return await ensureAgentSessionSystemPromptReady(this.createSystemPromptState());
  }

  /**
   * Fire-and-forget warm-up of the resources the first turn needs: the system
   * prompt (skills scan, workspace context, memory), the workspace MCP tool
   * cache, and the lazily imported turn modules. Kicking this off at session
   * creation overlaps the expensive first-turn setup with client round trips
   * so the first user message streams sooner. MCP warm failures are swallowed
   * here (the turn path reloads and surfaces them via onMcpLoadErrors); system
   * prompt failures surface through the normal session error channel.
   */
  warmSessionResources(): void {
    warmLazyTurnModules();
    void this.ensureSystemPromptReady().catch(() => undefined);
    if (this.getEnableMcp()) {
      void this.deps
        .getOrLoadMCPToolsCachedImpl(this.state.config, this.id, {})
        .catch(() => undefined);
    }
  }

  async refreshSystemPromptWithSkills(reason = "session.refresh_system_prompt") {
    await refreshAgentSessionSystemPromptWithSkills(this.createSystemPromptState(), reason);
  }

  async emitMcpServers() {
    await this.getMcpManager().emitMcpServers();
  }

  async upsertMcpServer(
    server: MCPServerConfig,
    previousName?: string,
    source?: EditableMCPServerConfigSource,
  ) {
    await this.getMcpManager().upsert(server, previousName, source);
  }

  async deleteMcpServer(nameRaw: string, source?: EditableMCPServerConfigSource) {
    await this.getMcpManager().delete(nameRaw, source);
  }

  async setMcpServerEnabled(opts: Parameters<McpManager["setEnabled"]>[0]) {
    await this.getMcpManager().setEnabled(opts);
  }

  async validateMcpServer(nameRaw: string, lookup?: McpServerLookup | MCPServerSource) {
    await this.getMcpManager().validate(nameRaw, lookup);
  }

  async authorizeMcpServerAuth(nameRaw: string, lookup?: McpServerLookup | MCPServerSource) {
    await this.getMcpManager().authorize(nameRaw, lookup);
  }

  async callbackMcpServerAuth(
    nameRaw: string,
    codeRaw?: string,
    lookup?: McpServerLookup | MCPServerSource,
  ) {
    await this.getMcpManager().callback(nameRaw, codeRaw, lookup);
  }

  async setMcpServerApiKey(
    nameRaw: string,
    apiKeyRaw: string,
    lookup?: McpServerLookup | MCPServerSource,
  ) {
    await this.getMcpManager().setApiKey(nameRaw, apiKeyRaw, lookup);
  }
  getHarnessContext() {
    this.metadataManager.getHarnessContext();
  }

  setHarnessContext(context: HarnessContextPayload) {
    this.metadataManager.setHarnessContext(context);
  }

  async setModel(modelIdRaw: string, providerRaw?: AgentConfig["provider"]) {
    await this.enqueueConfigMutation(async () => {
      await this.getProviderAuthManager().setModel(modelIdRaw, providerRaw);
      await this.persistenceManager.waitForIdle();
    });
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

  async emitProviderCatalog(opts: { refresh?: boolean } = {}) {
    await this.getProviderCatalogManager().emitProviderCatalog(opts);
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

  async addCustomProviderModel(providerRaw: AgentConfig["provider"], modelIdRaw: string) {
    try {
      await upsertCustomModel(this.getGlobalAuthPaths(), providerRaw, modelIdRaw);
      await this.emitProviderCatalog();
    } catch (error) {
      this.context.emitError(
        "validation_failed",
        "provider",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async deleteCustomProviderModel(providerRaw: AgentConfig["provider"], modelIdRaw: string) {
    try {
      await deleteCustomModel(this.getGlobalAuthPaths(), providerRaw, modelIdRaw);
      await this.emitProviderCatalog();
    } catch (error) {
      this.context.emitError(
        "validation_failed",
        "provider",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async setProviderModelsEnabled(
    providerRaw: AgentConfig["provider"],
    models: ReadonlyArray<{ id: string; enabled: boolean }>,
  ) {
    try {
      await setModelPreferences(this.getGlobalAuthPaths(), providerRaw, models);
      await this.emitProviderCatalog();
    } catch (error) {
      this.context.emitError(
        "validation_failed",
        "provider",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async resetProviderModelPreferences(providerRaw: AgentConfig["provider"]) {
    try {
      await resetModelPreferences(this.getGlobalAuthPaths(), providerRaw);
      await this.emitProviderCatalog();
    } catch (error) {
      this.context.emitError(
        "validation_failed",
        "provider",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async refreshProviderStatus(opts: { refreshBedrockDiscovery?: boolean } = {}) {
    await this.getProviderCatalogManager().refreshProviderStatus(opts);
  }

  handleAskResponse(requestId: string, answer: string): boolean {
    const handled = this.getTurnExecutionManager().handleAskResponse(requestId, answer);
    if (handled) {
      this.sessionSnapshotProjector.syncSessionState({ hasPendingAsk: this.hasPendingAsk });
    }
    return handled;
  }

  handleApprovalResponse(requestId: string, approved: boolean): boolean {
    const handled = this.getTurnExecutionManager().handleApprovalResponse(requestId, approved);
    if (handled) {
      this.sessionSnapshotProjector.syncSessionState({
        hasPendingApproval: this.hasPendingApproval,
      });
    }
    return handled;
  }

  cancel(opts?: { includeSubagents?: boolean }) {
    this.getTurnExecutionManager().cancel(opts);
  }

  async cancelAndWaitForSettlement(opts?: {
    includeSubagents?: boolean;
    timeoutMs?: number;
    taskLock?: TaskLockError;
  }): Promise<void> {
    await this.getTurnExecutionManager().cancelAndWaitForSettlement(opts);
  }

  async closeForHistory(opts: { closeSharedCodexClient?: boolean } = {}): Promise<void> {
    this.state.persistenceStatus = "closed";
    if (this.state.config.provider === "codex-cli" && opts.closeSharedCodexClient !== false) {
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

  dispose(reason: string, opts: { closeSharedCodexClient?: boolean } = {}) {
    this.state.abortController?.abort();
    this.interactionManager.rejectAllPending(`Session disposed (${reason})`);
    unsubscribeAgentSessionCostTracker(this.createCostTrackingHost());
    this.managers.disposeManagers();
    if (this.state.config.provider === "codex-cli" && opts.closeSharedCodexClient !== false) {
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
      profileRef?: string;
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
    },
  ) {
    await this.getAdminManager().createAgentSession(opts);
  }

  async sendAgentInput(agentId: string, message: string, interrupt?: boolean) {
    await this.getAdminManager().sendAgentInput(agentId, message, interrupt);
  }

  async waitForAgents(
    agentIds: string[],
    timeoutMs?: number,
    mode?: AgentWaitMode,
    includeFinalMessage?: boolean,
    includeReport?: boolean,
  ) {
    await this.getAdminManager().waitForAgents(
      agentIds,
      timeoutMs,
      mode,
      includeFinalMessage,
      includeReport,
    );
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
    references?: import("../../types").TurnReference[],
    opts?: SendUserMessageOptions,
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
      references,
      opts,
    );
  }

  claimUserMessage(input: UserMessageIdempotencyInput): UserMessageIdempotencyClaim | null {
    return this.getTurnExecutionManager().claimUserMessage(input);
  }

  rejectUserMessageClaim(claim: UserMessageIdempotencyClaim | null, message: string): void {
    this.getTurnExecutionManager().rejectUserMessageClaim(claim, message);
  }

  async sendSteerMessage(
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: import("../jsonrpc/routes/shared").FileAttachment[],
    inputParts?: import("../jsonrpc/routes/shared").OrderedInputPart[],
    references?: import("../../types").TurnReference[],
    steerRequestId?: string,
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
      references,
      steerRequestId,
    );
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

  private async getMcpServerByName(
    nameRaw: string,
    lookup?: McpServerLookup,
  ): Promise<MCPRegistryServer | null> {
    return await this.runtimeSupport.getMcpServerByName(nameRaw, lookup);
  }

  private waitForPromptResponse<T>(
    requestId: string,
    bucket: Map<string, PromiseWithResolvers<T>>,
  ): Promise<T> {
    return this.runtimeSupport.waitForPromptResponse(requestId, bucket);
  }

  private emitError(
    code: ServerErrorCode,
    source: ServerErrorSource,
    message: string,
    data?: ServerErrorData,
  ) {
    this.runtimeSupport.emitError(code, source, message, data);
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
