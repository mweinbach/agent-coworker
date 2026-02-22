import path from "node:path";

import { connectProvider as connectModelProvider, getAiCoworkerPaths, type ConnectProviderResult } from "../../connect";
import { runTurn } from "../../agent";
import { HarnessContextStore } from "../../harness/contextStore";
import { loadMCPConfigRegistry, type MCPRegistryServer } from "../../mcp/configRegistry";
import { emitObservabilityEvent } from "../../observability/otel";
import { getProviderCatalog } from "../../providers/connectionCatalog";
import { getProviderStatuses } from "../../providerStatus";
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
import { InteractionManager } from "./InteractionManager";
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
  SessionBackupFactory,
  SessionContext,
  SessionDependencies,
  SessionRuntimeState,
} from "./SessionContext";
import { SessionMetadataManager } from "./SessionMetadataManager";
import { SkillManager } from "./SkillManager";
import { TurnExecutionManager } from "./TurnExecutionManager";

function makeId(): string {
  return crypto.randomUUID();
}

export class AgentSession {
  readonly id: string;

  private readonly state: SessionRuntimeState;
  private readonly deps: SessionDependencies;
  private readonly context: SessionContext;

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

  constructor(opts: {
    config: AgentConfig;
    system: string;
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
    hydratedState?: HydratedSessionState;
    skipInitialPersist?: boolean;
  }) {
    const hydrated = opts.hydratedState;
    this.id = hydrated?.sessionId ?? makeId();

    const now = new Date().toISOString();
    this.state = {
      config: opts.config,
      system: opts.system,
      discoveredSkills: opts.discoveredSkills ?? [],
      yolo: opts.yolo === true,
      messages: [],
      allMessages: [...(hydrated?.messages ?? [])],
      running: false,
      connecting: false,
      abortController: null,
      currentTurnId: null,
      currentTurnOutcome: "completed",
      maxSteps: 100,
      todos: hydrated?.todos ?? [],
      sessionInfo: hydrated?.sessionInfo ?? {
        title: DEFAULT_SESSION_TITLE,
        titleSource: "default",
        titleModel: null,
        createdAt: now,
        updatedAt: now,
        provider: opts.config.provider,
        model: opts.config.model,
      },
      persistenceStatus: hydrated?.status ?? "active",
      hasGeneratedTitle: hydrated?.hasGeneratedTitle ?? false,
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
    };

    this.deps = {
      connectProviderImpl: opts.connectProviderImpl ?? connectModelProvider,
      getAiCoworkerPathsImpl: opts.getAiCoworkerPathsImpl ?? getAiCoworkerPaths,
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
    };

    if (hydrated?.harnessContext) {
      this.deps.harnessContextStore.set(this.id, hydrated.harnessContext);
    }

    this.context = {
      id: this.id,
      state: this.state,
      deps: this.deps,
      emit: (evt) => opts.emit(evt),
      emitError: (code, source, message) => this.emitError(code, source, message),
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
      formatError: (err) => this.formatErrorMessage(err),
      guardBusy: () => this.guardBusy(),
      getCoworkPaths: () => this.getCoworkPaths(),
      runProviderConnect: async (providerOpts) => await this.runProviderConnect(providerOpts),
      getMcpServerByName: async (nameRaw) => await this.getMcpServerByName(nameRaw),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      updateSessionInfo: (patch) => this.metadataManager.updateSessionInfo(patch),
      emitConfigUpdated: () => this.metadataManager.emitConfigUpdated(),
      refreshProviderStatus: async () => await this.providerCatalogManager.refreshProviderStatus(),
      emitProviderCatalog: async () => await this.providerCatalogManager.emitProviderCatalog(),
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
    this.persistenceManager = new PersistenceManager({
      sessionId: this.id,
      sessionDb: this.deps.sessionDb,
      getCoworkPaths: () => this.getCoworkPaths(),
      writePersistedSessionSnapshot: this.deps.writePersistedSessionSnapshotImpl,
      buildCanonicalSnapshot: (updatedAt) => this.buildCanonicalSnapshot(updatedAt),
      buildPersistedSnapshotAt: (updatedAt) => this.buildPersistedSnapshotAt(updatedAt),
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
      emitError: (message) => this.emitError("internal_error", "session", message),
      formatError: (err) => this.formatErrorMessage(err),
    });
    this.backupController = new SessionBackupController(this.context);
    this.skillManager = new SkillManager(this.context, {
      sendUserMessage: (text, clientMessageId, displayText) => this.sendUserMessage(text, clientMessageId, displayText),
    });
    this.mcpManager = new McpManager(this.context);
    this.providerCatalogManager = new ProviderCatalogManager({
      sessionId: this.id,
      getConfig: () => this.state.config,
      getCoworkPaths: () => this.getCoworkPaths(),
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
      persistModelSelection: this.deps.persistModelSelectionImpl,
      updateSessionInfo: (patch) => this.metadataManager.updateSessionInfo(patch),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      emitConfigUpdated: () => this.metadataManager.emitConfigUpdated(),
      emitProviderCatalog: async () => await this.providerCatalogManager.emitProviderCatalog(),
      refreshProviderStatus: async () => await this.providerCatalogManager.refreshProviderStatus(),
      getCoworkPaths: () => this.getCoworkPaths(),
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
  }): AgentSession {
    const { persisted } = opts;
    const config: AgentConfig = {
      ...opts.baseConfig,
      provider: persisted.provider,
      model: persisted.model,
      workingDirectory: persisted.workingDirectory,
      enableMcp: persisted.enableMcp,
      outputDirectory: persisted.outputDirectory,
      uploadsDirectory: persisted.uploadsDirectory,
    };

    const sessionInfo = {
      title: persisted.title,
      titleSource: persisted.titleSource,
      titleModel: persisted.titleModel,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      provider: persisted.provider,
      model: persisted.model,
    };

    return new AgentSession({
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
      hydratedState: {
        sessionId: persisted.sessionId,
        sessionInfo,
        status: "active",
        hasGeneratedTitle: persisted.titleSource !== "default" || persisted.messageCount > 0,
        messages: persisted.messages,
        todos: persisted.todos,
        harnessContext: persisted.harnessContext,
      },
      skipInitialPersist: true,
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

  getSessionConfigEvent() {
    return this.metadataManager.getSessionConfigEvent();
  }

  getSessionInfoEvent() {
    return this.metadataManager.getSessionInfoEvent();
  }

  getObservabilityStatusEvent() {
    return this.metadataManager.getObservabilityStatusEvent();
  }

  replayPendingPrompts() {
    this.interactionManager.replayPendingPrompts();
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

  async setEnableMcp(enableMcp: boolean) {
    await this.mcpManager.setEnableMcp(enableMcp);
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

  async emitProviderCatalog() {
    await this.providerCatalogManager.emitProviderCatalog();
  }

  emitProviderAuthMethods() {
    this.providerCatalogManager.emitProviderAuthMethods();
  }

  async authorizeProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string) {
    await this.providerAuthManager.authorizeProviderAuth(providerRaw, methodIdRaw);
  }

  async callbackProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string, codeRaw?: string) {
    await this.providerAuthManager.callbackProviderAuth(providerRaw, methodIdRaw, codeRaw);
  }

  async setProviderApiKey(providerRaw: AgentConfig["provider"], methodIdRaw: string, apiKeyRaw: string) {
    await this.providerAuthManager.setProviderApiKey(providerRaw, methodIdRaw, apiKeyRaw);
  }

  async refreshProviderStatus() {
    await this.providerCatalogManager.refreshProviderStatus();
  }

  handleAskResponse(requestId: string, answer: string) {
    this.turnExecutionManager.handleAskResponse(requestId, answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean) {
    this.turnExecutionManager.handleApprovalResponse(requestId, approved);
  }

  cancel() {
    this.turnExecutionManager.cancel();
  }

  async closeForHistory(): Promise<void> {
    this.state.persistenceStatus = "closed";
    this.queuePersistSessionSnapshot("session.closed");
    await this.persistenceManager.waitForIdle();
  }

  dispose(reason: string) {
    this.state.abortController?.abort();
    this.interactionManager.rejectAllPending(`Session disposed (${reason})`);
    this.deps.harnessContextStore.clear(this.id);
    void this.backupController.closeSessionBackup();
  }

  getMessages(offset = 0, limit = 100) {
    this.adminManager.getMessages(offset, limit);
  }

  setSessionTitle(title: string) {
    this.metadataManager.setSessionTitle(title);
  }

  async listSessions() {
    await this.adminManager.listSessions();
  }

  async deleteSession(targetSessionId: string) {
    await this.adminManager.deleteSession(targetSessionId);
  }

  setConfig(patch: {
    yolo?: boolean;
    observabilityEnabled?: boolean;
    subAgentModel?: string;
    maxSteps?: number;
  }) {
    this.metadataManager.setConfig(patch);
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

  async sendUserMessage(text: string, clientMessageId?: string, displayText?: string) {
    await this.turnExecutionManager.sendUserMessage(text, clientMessageId, displayText);
  }

  private buildPersistedSnapshotAt(updatedAt: string): PersistedSessionSnapshot {
    return {
      version: 1,
      sessionId: this.id,
      createdAt: this.state.sessionInfo.createdAt,
      updatedAt,
      session: {
        title: this.state.sessionInfo.title,
        titleSource: this.state.sessionInfo.titleSource,
        titleModel: this.state.sessionInfo.titleModel,
        provider: this.state.sessionInfo.provider,
        model: this.state.sessionInfo.model,
      },
      config: {
        provider: this.state.config.provider,
        model: this.state.config.model,
        enableMcp: this.getEnableMcp(),
        workingDirectory: this.state.config.workingDirectory,
        ...(this.state.config.outputDirectory ? { outputDirectory: this.state.config.outputDirectory } : {}),
        ...(this.state.config.uploadsDirectory ? { uploadsDirectory: this.state.config.uploadsDirectory } : {}),
      },
      context: {
        system: this.state.system,
        messages: this.state.allMessages,
        todos: this.state.todos,
        harnessContext: this.deps.harnessContextStore.get(this.id),
      },
    };
  }

  private buildCanonicalSnapshot(updatedAt: string): PersistedSessionMutation["snapshot"] {
    return {
      title: this.state.sessionInfo.title,
      titleSource: this.state.sessionInfo.titleSource,
      titleModel: this.state.sessionInfo.titleModel,
      provider: this.state.config.provider,
      model: this.state.config.model,
      workingDirectory: this.state.config.workingDirectory,
      ...(this.state.config.outputDirectory ? { outputDirectory: this.state.config.outputDirectory } : {}),
      ...(this.state.config.uploadsDirectory ? { uploadsDirectory: this.state.config.uploadsDirectory } : {}),
      enableMcp: this.getEnableMcp(),
      createdAt: this.state.sessionInfo.createdAt,
      updatedAt,
      status: this.state.persistenceStatus,
      hasPendingAsk: this.hasPendingAsk,
      hasPendingApproval: this.hasPendingApproval,
      systemPrompt: this.state.system,
      messages: this.state.allMessages,
      todos: this.state.todos,
      harnessContext: this.deps.harnessContextStore.get(this.id),
    };
  }

  private queuePersistSessionSnapshot(reason: string) {
    this.persistenceManager.queuePersistSessionSnapshot(reason);
  }

  private getUserHomeDir(): string | undefined {
    return this.state.config.userAgentDir ? path.dirname(this.state.config.userAgentDir) : undefined;
  }

  private getCoworkPaths() {
    return this.deps.getAiCoworkerPathsImpl({ homedir: this.getUserHomeDir() });
  }

  private async runProviderConnect(opts: Parameters<typeof connectModelProvider>[0]): Promise<ConnectProviderResult> {
    const paths = opts.paths ?? this.getCoworkPaths();
    return await this.deps.connectProviderImpl({
      ...opts,
      cwd: opts.cwd ?? this.state.config.workingDirectory,
      paths,
      oauthStdioMode: opts.oauthStdioMode ?? "pipe",
    });
  }

  private async getMcpServerByName(nameRaw: string): Promise<MCPRegistryServer | null> {
    const name = nameRaw.trim();
    if (!name) {
      this.emitError("validation_failed", "session", "MCP server name is required");
      return null;
    }

    const registry = await loadMCPConfigRegistry(this.state.config);
    const server = registry.servers.find((entry) => entry.name === name) ?? null;
    if (!server) {
      this.emitError("validation_failed", "session", `MCP server \"${name}\" not found.`);
      return null;
    }
    return server;
  }

  private waitForPromptResponse<T>(requestId: string, bucket: Map<string, PromiseWithResolvers<T>>): Promise<T> {
    const entry = bucket.get(requestId);
    if (!entry) return Promise.reject(new Error(`Unknown prompt request: ${requestId}`));
    return entry.promise;
  }

  private emitError(code: ServerErrorCode, source: ServerErrorSource, message: string) {
    this.context.emit({
      type: "error",
      sessionId: this.id,
      message,
      code,
      source,
    });
  }

  private guardBusy(): boolean {
    if (this.state.running) {
      this.emitError("busy", "session", "Agent is busy");
      return false;
    }
    if (this.state.connecting) {
      this.emitError("busy", "session", "Connection flow already running");
      return false;
    }
    return true;
  }

  private formatErrorMessage(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return String(err);
  }

  private log(line: string) {
    this.context.emit({ type: "log", sessionId: this.id, line });
  }

  private emitTelemetry(name: string, status: "ok" | "error", attributes?: Record<string, string | number | boolean>, durationMs?: number) {
    void (async () => {
      const result = await emitObservabilityEvent(this.state.config, {
        name,
        at: new Date().toISOString(),
        status,
        ...(durationMs !== undefined ? { durationMs } : {}),
        attributes,
      });

      if (result.healthChanged) {
        this.context.emit(this.metadataManager.getObservabilityStatusEvent());
      }
    })().catch(() => {
      // observability is best-effort; never fail core session flow
    });
  }
}
