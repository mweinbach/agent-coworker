import type { connectProvider as connectModelProvider, ConnectProviderResult } from "../../connect";
import type { loadSystemPromptWithSkills } from "../../prompt";
import type { runTurn } from "../../agent";
import { HarnessContextStore } from "../../harness/contextStore";
import { SessionCostTracker, type SessionUsageSnapshot, type TurnUsage } from "../../session/costTracker";
import type { MCPRegistryServer } from "../../mcp/configRegistry";
import type { getProviderCatalog } from "../../providers/connectionCatalog";
import type { getProviderStatuses } from "../../providerStatus";
import { defaultSupportedModel, getSupportedModel } from "../../models/registry";
import { getKnownResolvedModelMetadata, isDynamicModelProvider } from "../../models/metadata";
import { MemoryStore, type MemoryScope } from "../../memoryStore";
import { getAiCoworkerPaths } from "../../store/connections";
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
import { DEFAULT_SESSION_TITLE } from "../sessionTitleService";
import type { generateSessionTitle } from "../sessionTitleService";
import type { AgentWaitMode } from "../agents/types";
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
import { A2uiSurfaceManager } from "./A2uiSurfaceManager";
import type {
  AgentInspectResult,
  AgentReasoningEffort,
  AgentRole,
  AgentSpawnContextOptions,
  AgentContextMode,
} from "../../shared/agents";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type { A2uiComponent, A2uiSurfaceState, A2uiSurfacesById } from "../../shared/a2ui";

// Packaged Bun sidecar builds need these dynamic imports because the old createRequire
// path is unavailable there, and we want to avoid eagerly loading the heavier
// connection/prompt/agent modules at startup.
let connectModulePromise: Promise<typeof import("../../connect")> | null = null;
let promptModulePromise: Promise<typeof import("../../prompt")> | null = null;
let providerCatalogModulePromise: Promise<typeof import("../../providers/connectionCatalog")> | null = null;
let providerStatusModulePromise: Promise<typeof import("../../providerStatus")> | null = null;
let agentModulePromise: Promise<typeof import("../../agent")> | null = null;
let sessionTitleServiceModulePromise: Promise<typeof import("../sessionTitleService")> | null = null;

const loadConnectModule = async (): Promise<typeof import("../../connect")> => {
  connectModulePromise ??= import("../../connect");
  return await connectModulePromise;
};

const loadPromptModule = async (): Promise<typeof import("../../prompt")> => {
  promptModulePromise ??= import("../../prompt");
  return await promptModulePromise;
};

const loadProviderCatalogModule = async (): Promise<typeof import("../../providers/connectionCatalog")> => {
  providerCatalogModulePromise ??= import("../../providers/connectionCatalog");
  return await providerCatalogModulePromise;
};

const loadProviderStatusModule = async (): Promise<typeof import("../../providerStatus")> => {
  providerStatusModulePromise ??= import("../../providerStatus");
  return await providerStatusModulePromise;
};

const loadAgentModule = async (): Promise<typeof import("../../agent")> => {
  agentModulePromise ??= import("../../agent");
  return await agentModulePromise;
};

const loadSessionTitleServiceModule = async (): Promise<typeof import("../sessionTitleService")> => {
  sessionTitleServiceModulePromise ??= import("../sessionTitleService");
  return await sessionTitleServiceModulePromise;
};

const lazyConnectProvider: typeof connectModelProvider = async (...args) =>
  await (await loadConnectModule()).connectProvider(...args);
const lazyLoadSystemPromptWithSkills: typeof loadSystemPromptWithSkills = async (...args) =>
  await (await loadPromptModule()).loadSystemPromptWithSkills(...args);
const lazyGetProviderCatalog: typeof getProviderCatalog = async (...args) =>
  await (await loadProviderCatalogModule()).getProviderCatalog(...args);
const lazyGetProviderStatuses: typeof getProviderStatuses = async (...args) =>
  await (await loadProviderStatusModule()).getProviderStatuses(...args);
const lazyRunTurn: typeof runTurn = async (...args) =>
  await (await loadAgentModule()).runTurn(...args);
const lazyGenerateSessionTitle: typeof generateSessionTitle = async (...args) =>
  await (await loadSessionTitleServiceModule()).generateSessionTitle(...args);

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
    taskType: opts.state.sessionInfo.taskType ?? null,
    targetPaths: opts.state.sessionInfo.targetPaths ?? null,
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
  "a2ui_surface",
]);

function shouldReplayDisconnectedEvent(evt: ServerEvent): boolean {
  return DISCONNECTED_REPLAY_EVENT_TYPES.has(evt.type);
}

function deriveA2uiSurfacesFromSnapshot(snapshot: SessionSnapshot | null | undefined): A2uiSurfacesById | undefined {
  if (!snapshot) return undefined;

  const surfaces: Record<string, A2uiSurfaceState> = {};
  for (const item of snapshot.feed) {
    if (item.kind !== "ui_surface") continue;
    const existing = surfaces[item.surfaceId];
    if (existing && existing.revision > item.revision) {
      continue;
    }
    surfaces[item.surfaceId] = {
      surfaceId: item.surfaceId,
      catalogId: item.catalogId,
      ...(item.theme ? { theme: structuredClone(item.theme) } : {}),
      ...(item.root ? { root: structuredClone(item.root) as A2uiComponent } : {}),
      ...(item.dataModel !== undefined ? { dataModel: structuredClone(item.dataModel) } : {}),
      revision: item.revision,
      updatedAt: item.ts,
      deleted: item.deleted,
    };
  }

  return Object.keys(surfaces).length > 0 ? surfaces : undefined;
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
  private mcpManager: McpManager | null = null;
  private providerAuthManager: ProviderAuthManager | null = null;
  private providerCatalogManager: ProviderCatalogManager | null = null;
  private turnExecutionManager: TurnExecutionManager | null = null;
  private a2uiSurfaceManager: A2uiSurfaceManager | null = null;
  private skillManager: SkillManager | null = null;
  private readonly metadataManager: SessionMetadataManager;
  private adminManager: SessionAdminManager | null = null;
  private readonly backupController: SessionBackupController;
  private pendingConfigMutation: Promise<void> = Promise.resolve();
  private readonly memoryStore: MemoryStore;
  private systemPromptLoadPromise: Promise<boolean> | null = null;
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
    refreshSkillsAcrossWorkspaceSessionsImpl?: SessionDependencies["refreshSkillsAcrossWorkspaceSessionsImpl"];
    hydratedState?: HydratedSessionState;
    initialSessionSnapshot?: SessionSnapshot;
    initialLastEventSeq?: number;
    seedContext?: SeededSessionContext;
    skipInitialPersist?: boolean;
    persistenceEnabled?: boolean;
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
      systemPromptMetadataLoaded: opts.system.trim().length > 0 && opts.discoveredSkills !== undefined,
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
        ...(opts.sessionInfoPatch?.parentSessionId ? { parentSessionId: opts.sessionInfoPatch.parentSessionId } : {}),
        ...(opts.sessionInfoPatch?.role ? { role: opts.sessionInfoPatch.role } : {}),
        ...(opts.sessionInfoPatch?.mode ? { mode: opts.sessionInfoPatch.mode } : {}),
        ...(typeof opts.sessionInfoPatch?.depth === "number" ? { depth: opts.sessionInfoPatch.depth } : {}),
        ...(opts.sessionInfoPatch?.nickname ? { nickname: opts.sessionInfoPatch.nickname } : {}),
        ...(opts.sessionInfoPatch?.taskType ? { taskType: opts.sessionInfoPatch.taskType } : {}),
        ...(opts.sessionInfoPatch?.targetPaths !== undefined ? { targetPaths: opts.sessionInfoPatch.targetPaths } : {}),
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
      connectProviderImpl: opts.connectProviderImpl ?? lazyConnectProvider,
      getAiCoworkerPathsImpl: opts.getAiCoworkerPathsImpl ?? getAiCoworkerPaths,
      loadSystemPromptWithSkillsImpl: opts.loadSystemPromptWithSkillsImpl ?? lazyLoadSystemPromptWithSkills,
      getProviderCatalogImpl: opts.getProviderCatalogImpl ?? lazyGetProviderCatalog,
      getProviderStatusesImpl: opts.getProviderStatusesImpl ?? lazyGetProviderStatuses,
      sessionBackupFactory:
        opts.sessionBackupFactory ?? (async (factoryOpts: SessionBackupInitOptions): Promise<SessionBackupHandle> => await SessionBackupManager.create(factoryOpts)),
      harnessContextStore: opts.harnessContextStore ?? new HarnessContextStore(),
      runTurnImpl: opts.runTurnImpl ?? lazyRunTurn,
      persistModelSelectionImpl: opts.persistModelSelectionImpl,
      persistProjectConfigPatchImpl: opts.persistProjectConfigPatchImpl,
      generateSessionTitleImpl: opts.generateSessionTitleImpl ?? lazyGenerateSessionTitle,
      sessionDb: opts.sessionDb ?? null,
      writePersistedSessionSnapshotImpl: opts.writePersistedSessionSnapshotImpl ?? writePersistedSessionSnapshot,
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
      refreshSkillsAcrossWorkspaceSessionsImpl: opts.refreshSkillsAcrossWorkspaceSessionsImpl,
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
      refreshProviderStatus: async (opts) => await this.getProviderCatalogManager().refreshProviderStatus(opts),
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
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
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

    if (!opts.skipInitialPersist && opts.persistenceEnabled !== false) {
      this.queuePersistSessionSnapshot("session.created");
    }
  }

  private getSkillManager(): SkillManager {
    if (!this.skillManager) {
      this.skillManager = new SkillManager(this.context, {
        sendUserMessage: (text, clientMessageId, displayText) =>
          this.sendUserMessage(text, clientMessageId, displayText),
      });
    }
    return this.skillManager;
  }

  private getMcpManager(): McpManager {
    if (!this.mcpManager) {
      this.mcpManager = new McpManager(this.context);
    }
    return this.mcpManager;
  }

  private getTurnExecutionManager(): TurnExecutionManager {
    if (!this.turnExecutionManager) {
      this.turnExecutionManager = new TurnExecutionManager(this.context, {
        interactionManager: this.interactionManager,
        historyManager: this.historyManager,
        metadataManager: this.metadataManager,
        backupController: this.backupController,
        flushPendingExternalSkillRefresh: async () => await this.flushPendingExternalSkillRefresh(),
        getA2uiSurfaceManager: () => this.getA2uiSurfaceManager(),
      });
    }
    return this.turnExecutionManager;
  }

  private getA2uiSurfaceManager(): A2uiSurfaceManager {
    if (!this.a2uiSurfaceManager) {
      this.a2uiSurfaceManager = new A2uiSurfaceManager({
        sessionId: this.id,
        emit: (evt) => this.context.emit(evt),
        log: (line) => this.context.emit({ type: "log", sessionId: this.id, line }),
      });
      this.a2uiSurfaceManager.hydrate(deriveA2uiSurfacesFromSnapshot(this.sessionSnapshotProjector.getSnapshot()));
    }
    return this.a2uiSurfaceManager;
  }

  private getAdminManager(): SessionAdminManager {
    if (!this.adminManager) {
      this.adminManager = new SessionAdminManager(this.context);
    }
    return this.adminManager;
  }

  private getProviderCatalogManager(): ProviderCatalogManager {
    if (!this.providerCatalogManager) {
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
    }
    return this.providerCatalogManager;
  }

  private getProviderAuthManager(): ProviderAuthManager {
    if (!this.providerAuthManager) {
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
        emitProviderCatalog: async () => await this.getProviderCatalogManager().emitProviderCatalog(),
        refreshProviderStatus: async (opts) => await this.getProviderCatalogManager().refreshProviderStatus(opts),
        getGlobalAuthPaths: () => this.getGlobalAuthPaths(),
        runProviderConnect: async (providerOpts) => await this.runProviderConnect(providerOpts),
      });
    }
    return this.providerAuthManager;
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
    initialSessionSnapshot?: SessionSnapshot | null;
  }): AgentSession {
    const { persisted } = opts;
    const resolvedPersistedModel = getKnownResolvedModelMetadata(persisted.provider, persisted.model);
    const resumedModel = resolvedPersistedModel ?? defaultSupportedModel(persisted.provider);
    const migratedUnsupportedModel = resolvedPersistedModel === null && !isDynamicModelProvider(persisted.provider);
    const migratedAliasedModel =
      resolvedPersistedModel !== null
      && resolvedPersistedModel.id !== persisted.model
      && !isDynamicModelProvider(persisted.provider);
    const migratedLegacyModel = migratedUnsupportedModel || migratedAliasedModel;
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
      ...(persisted.taskType ? { taskType: persisted.taskType } : {}),
      ...(persisted.targetPaths !== undefined && persisted.targetPaths !== null ? { targetPaths: persisted.targetPaths } : {}),
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
      const migrationDescriptor = migratedUnsupportedModel ? "unsupported model" : "legacy model alias";
      opts.emit({
        type: "log",
        sessionId: persisted.sessionId,
        line: `[session] Resumed legacy session using ${migrationDescriptor} "${persisted.model}" for provider ${persisted.provider}; migrated to "${resumedModel.id}".${clearedContinuationState ? " Cleared saved continuation state for the old model." : ""}`,
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
    snapshot.taskType = this.state.sessionInfo.taskType ?? null;
    snapshot.targetPaths = this.state.sessionInfo.targetPaths ?? null;
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
    snapshot.taskType = this.state.sessionInfo.taskType ?? null;
    snapshot.targetPaths = this.state.sessionInfo.targetPaths ?? null;
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

  getCompactUsageSnapshot(): SessionUsageSnapshot | null {
    return this.state.costTracker?.getCompactSnapshot() ?? null;
  }

  getLastTurnUsage(): TurnUsage | null {
    const turns = this.state.costTracker?.getCompactSnapshot(1).turns ?? [];
    const latest = turns[turns.length - 1];
    return latest ? { ...latest.usage } : null;
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
    this.a2uiSurfaceManager?.reset();
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

  private async ensureSystemPromptReady(): Promise<boolean> {
    const hasSystemPrompt = this.state.system.trim().length > 0;
    if (hasSystemPrompt && this.state.systemPromptMetadataLoaded) {
      return true;
    }
    if (this.systemPromptLoadPromise) {
      return await this.systemPromptLoadPromise;
    }

    this.systemPromptLoadPromise = (async () => {
      try {
        const result = await this.context.deps.loadSystemPromptWithSkillsImpl(this.state.config);
        if (!hasSystemPrompt) {
          this.state.system = result.prompt;
        }
        this.state.discoveredSkills = result.discoveredSkills;
        this.state.systemPromptMetadataLoaded = true;
        return true;
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to load system prompt: ${String(err)}`,
        );
        return false;
      } finally {
        this.systemPromptLoadPromise = null;
      }
    })();

    return await this.systemPromptLoadPromise;
  }

  async refreshSystemPromptWithSkills(reason = "session.refresh_system_prompt") {
    try {
      const result = await this.context.deps.loadSystemPromptWithSkillsImpl(this.state.config);
      this.state.system = result.prompt;
      this.state.discoveredSkills = result.discoveredSkills;
      this.state.systemPromptMetadataLoaded = true;
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
    await this.getMcpManager().emitMcpServers();
  }

  async upsertMcpServer(server: MCPServerConfig, previousName?: string) {
    await this.getMcpManager().upsert(server, previousName);
  }

  async deleteMcpServer(nameRaw: string) {
    await this.getMcpManager().delete(nameRaw);
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

  async migrateLegacyMcpServers(scope: "workspace" | "user") {
    await this.getMcpManager().migrate(scope);
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

      const preparedModel = opts.provider !== undefined && opts.model !== undefined
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

      const preparedEnableMcp = typeof opts.enableMcp === "boolean"
        ? this.getMcpManager().prepareEnableMcpChange(opts.enableMcp)
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

  async callbackProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string, codeRaw?: string) {
    await this.getProviderAuthManager().callbackProviderAuth(providerRaw, methodIdRaw, codeRaw);
  }

  async setProviderApiKey(providerRaw: AgentConfig["provider"], methodIdRaw: string, apiKeyRaw: string) {
    await this.getProviderAuthManager().setProviderApiKey(providerRaw, methodIdRaw, apiKeyRaw);
  }

  async setProviderConfig(
    providerRaw: AgentConfig["provider"],
    methodIdRaw: string,
    values: Record<string, string>,
  ) {
    await this.getProviderAuthManager().setProviderConfig(providerRaw, methodIdRaw, values);
  }

  async copyProviderApiKey(providerRaw: AgentConfig["provider"], sourceProviderRaw: AgentConfig["provider"]) {
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
      this.sessionSnapshotProjector.syncSessionState({ hasPendingApproval: this.hasPendingApproval });
    }
  }

  cancel(opts?: { includeSubagents?: boolean }) {
    this.getTurnExecutionManager().cancel(opts);
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
      messages: opts.contextMode === "brief" && opts.briefing
        ? [{ role: "user", content: `Parent briefing:\n${opts.briefing}` }]
        : [],
      todos: opts.includeParentTodos ? structuredClone(this.state.todos) : [],
      harnessContext: opts.includeHarnessContext ? this.deps.harnessContextStore.get(this.id) : null,
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

  async createAgentSession(opts: AgentSpawnContextOptions & {
    message: string;
    role?: AgentRole;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
  }) {
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

  // Each workspace backup method calls getSessionBackupState() first to ensure
  // the backup controller is initialized (lazy init) before the admin manager
  // accesses backup data. This is intentional coupling, not redundancy.

  async listWorkspaceBackups() {
    await this.backupController.getSessionBackupState();
    await this.getAdminManager().listWorkspaceBackups();
  }

  async createWorkspaceBackupCheckpoint(targetSessionId: string) {
    await this.backupController.getSessionBackupState();
    await this.getAdminManager().createWorkspaceBackupCheckpoint(targetSessionId);
  }

  async restoreWorkspaceBackup(targetSessionId: string, checkpointId?: string) {
    await this.backupController.getSessionBackupState();
    await this.getAdminManager().restoreWorkspaceBackup(targetSessionId, checkpointId);
  }

  async deleteWorkspaceBackupCheckpoint(targetSessionId: string, checkpointId: string) {
    await this.backupController.getSessionBackupState();
    await this.getAdminManager().deleteWorkspaceBackupCheckpoint(targetSessionId, checkpointId);
  }

  async deleteWorkspaceBackupEntry(targetSessionId: string) {
    await this.backupController.getSessionBackupState();
    await this.getAdminManager().deleteWorkspaceBackupEntry(targetSessionId);
  }

  async getWorkspaceBackupDelta(targetSessionId: string, checkpointId: string) {
    await this.backupController.getSessionBackupState();
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
    if (!await this.ensureSystemPromptReady()) {
      return;
    }
    await this.getTurnExecutionManager().sendUserMessage(text, clientMessageId, displayText, attachments, inputParts);
  }

  async sendSteerMessage(
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: import("../jsonrpc/routes/shared").FileAttachment[],
    inputParts?: import("../jsonrpc/routes/shared").OrderedInputPart[],
  ) {
    await this.pendingConfigMutation.catch(() => {});
    if (!await this.ensureSystemPromptReady()) {
      return;
    }
    await this.getTurnExecutionManager().sendSteerMessage(text, expectedTurnId, clientMessageId, attachments, inputParts);
  }

  validateA2uiAction(opts: { surfaceId: string; componentId: string }): ReturnType<A2uiSurfaceManager["validateAction"]> {
    return this.getA2uiSurfaceManager().validateAction(opts);
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
