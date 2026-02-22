import type { ModelMessage } from "ai";
import fs from "node:fs/promises";
import path from "node:path";

import { isRecord } from "../utils/typeGuards";

import { connectProvider as connectModelProvider, getAiCoworkerPaths, type ConnectProviderResult } from "../connect";
import { loadMCPServers, loadMCPTools, readMCPServersSnapshot } from "../mcp";
import {
  completeMCPServerOAuth,
  readMCPServerOAuthClientInformation,
  readMCPServerOAuthPending,
  resolveMCPServerAuthState,
  setMCPServerApiKeyCredential,
  setMCPServerOAuthClientInformation,
  setMCPServerOAuthPending,
} from "../mcp/authStore";
import {
  deleteWorkspaceMCPServer,
  loadMCPConfigRegistry,
  migrateLegacyMCPServers,
  upsertWorkspaceMCPServer,
  type MCPRegistryServer,
} from "../mcp/configRegistry";
import { authorizeMCPServerOAuth, consumeCapturedOAuthCode, exchangeMCPServerOAuthCode } from "../mcp/oauthProvider";
import { getProviderCatalog } from "../providers/connectionCatalog";
import { getProviderStatuses } from "../providerStatus";
import { discoverSkills, stripSkillFrontMatter } from "../skills";
import type {
  AgentConfig,
  HarnessContextState,
  HarnessContextPayload,
  MCPServerConfig,
  ServerErrorCode,
  ServerErrorSource,
  TodoItem,
} from "../types";
import { runTurn } from "../agent";
import { createTools } from "../tools";
import { HarnessContextStore } from "../harness/contextStore";
import { emitObservabilityEvent } from "../observability/otel";
import { getObservabilityHealth } from "../observability/runtime";
import { expandCommandTemplate, listCommands as listServerCommands, resolveCommand } from "./commands";
import { normalizeModelStreamPart, reasoningModeForProvider } from "./modelStream";
import { generateSessionTitle, heuristicTitleFromQuery, type SessionTitleSource, DEFAULT_SESSION_TITLE } from "./sessionTitleService";
import { type PersistedSessionMutation, type PersistedSessionRecord, type SessionPersistenceStatus, SessionDb } from "./sessionDb";
import {
  type PersistedSessionSnapshot,
  writePersistedSessionSnapshot,
  listPersistedSessionSnapshots,
  deletePersistedSessionSnapshot,
} from "./sessionStore";

import type { ServerEvent } from "./protocol";
import {
  SessionBackupManager,
  type SessionBackupHandle,
  type SessionBackupInitOptions,
  type SessionBackupPublicState,
} from "./sessionBackup";
import { HistoryManager } from "./session/HistoryManager";
import { InteractionManager } from "./session/InteractionManager";
import { McpManager } from "./session/McpManager";
import { PersistenceManager } from "./session/PersistenceManager";
import { ProviderAuthManager } from "./session/ProviderAuthManager";
import { ProviderCatalogManager } from "./session/ProviderCatalogManager";
import { TurnExecutionManager } from "./session/TurnExecutionManager";

function makeId(): string {
  return crypto.randomUUID();
}

type SessionBackupFactory = (opts: SessionBackupInitOptions) => Promise<SessionBackupHandle>;

type PersistedModelSelection = {
  provider: AgentConfig["provider"];
  model: string;
  subAgentModel: string;
};

type PersistedProjectConfigPatch = Partial<
  Pick<AgentConfig, "provider" | "model" | "subAgentModel" | "enableMcp" | "observabilityEnabled">
>;

type SessionInfoState = Omit<Extract<ServerEvent, { type: "session_info" }>, "type" | "sessionId">;

type HydratedSessionState = {
  sessionId: string;
  sessionInfo: SessionInfoState;
  status: SessionPersistenceStatus;
  hasGeneratedTitle: boolean;
  messages: ModelMessage[];
  todos: TodoItem[];
  harnessContext: HarnessContextState | null;
};

function extractAssistantTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const partType = typeof part.type === "string" ? part.type : "";
    if (partType !== "text" && partType !== "output_text") continue;
    if (typeof part.text === "string" && part.text.length > 0) {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

function extractAssistantTextFromResponseMessages(messages: ModelMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const text = extractAssistantTextFromMessageContent(message.content).trim();
    if (!text) continue;
    chunks.push(text);
  }
  return chunks.join("\n\n");
}

/** Maximum number of message history entries before older entries are pruned. */
const MAX_MESSAGE_HISTORY = 200;
const AUTO_CHECKPOINT_MIN_INTERVAL_MS = 30_000;
const MCP_VALIDATION_TIMEOUT_MS = 3_000;

export class AgentSession {
  readonly id: string;

  private config: AgentConfig;
  private system: string;
  private discoveredSkills: Array<{ name: string; description: string }>;
  private yolo: boolean;
  private readonly emit: (evt: ServerEvent) => void;
  private readonly connectProviderImpl: typeof connectModelProvider;
  private readonly getAiCoworkerPathsImpl: typeof getAiCoworkerPaths;
  private readonly getProviderCatalogImpl: typeof getProviderCatalog;
  private readonly getProviderStatusesImpl: typeof getProviderStatuses;
  private readonly sessionBackupFactory: SessionBackupFactory;
  private readonly harnessContextStore: HarnessContextStore;
  private readonly runTurnImpl: typeof runTurn;
  private readonly persistModelSelectionImpl?: (selection: PersistedModelSelection) => Promise<void> | void;
  private readonly persistProjectConfigPatchImpl?: (patch: PersistedProjectConfigPatch) => Promise<void> | void;
  private readonly generateSessionTitleImpl: typeof generateSessionTitle;
  private readonly sessionDb: SessionDb | null;
  private readonly writePersistedSessionSnapshotImpl: typeof writePersistedSessionSnapshot;

  private messages: ModelMessage[] = [];
  private allMessages: ModelMessage[] = [];
  private running = false;
  private connecting = false;
  private abortController: AbortController | null = null;

  private currentTurnId: string | null = null;
  private currentTurnOutcome: "completed" | "cancelled" | "error" = "completed";
  private maxSteps = 100;
  private readonly historyManager: HistoryManager;
  private readonly interactionManager: InteractionManager;
  private readonly mcpManager: McpManager;
  private readonly providerAuthManager: ProviderAuthManager;
  private readonly providerCatalogManager: ProviderCatalogManager;
  private readonly turnExecutionManager: TurnExecutionManager;

  private todos: TodoItem[] = [];
  private sessionInfo: SessionInfoState;
  private persistenceStatus: SessionPersistenceStatus = "active";
  private hasGeneratedTitle = false;
  private readonly persistenceManager: PersistenceManager;
  private sessionBackup: SessionBackupHandle | null = null;
  private sessionBackupState: SessionBackupPublicState;
  private sessionBackupInit: Promise<void> | null = null;
  private backupOperationQueue: Promise<void> = Promise.resolve();
  private lastAutoCheckpointAt = 0;

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
    this.config = opts.config;
    this.system = opts.system;
    this.discoveredSkills = opts.discoveredSkills ?? [];
    this.yolo = opts.yolo === true;
    this.emit = opts.emit;
    this.connectProviderImpl = opts.connectProviderImpl ?? connectModelProvider;
    this.getAiCoworkerPathsImpl = opts.getAiCoworkerPathsImpl ?? getAiCoworkerPaths;
    this.getProviderCatalogImpl = opts.getProviderCatalogImpl ?? getProviderCatalog;
    this.getProviderStatusesImpl = opts.getProviderStatusesImpl ?? getProviderStatuses;
    this.sessionBackupFactory =
      opts.sessionBackupFactory ?? (async (factoryOpts) => await SessionBackupManager.create(factoryOpts));
    this.harnessContextStore = opts.harnessContextStore ?? new HarnessContextStore();
    this.runTurnImpl = opts.runTurnImpl ?? runTurn;
    this.persistModelSelectionImpl = opts.persistModelSelectionImpl;
    this.persistProjectConfigPatchImpl = opts.persistProjectConfigPatchImpl;
    this.generateSessionTitleImpl = opts.generateSessionTitleImpl ?? generateSessionTitle;
    this.sessionDb = opts.sessionDb ?? null;
    this.writePersistedSessionSnapshotImpl = opts.writePersistedSessionSnapshotImpl ?? writePersistedSessionSnapshot;
    this.persistenceManager = new PersistenceManager({
      sessionId: this.id,
      sessionDb: this.sessionDb,
      getCoworkPaths: () => this.getCoworkPaths(),
      writePersistedSessionSnapshot: this.writePersistedSessionSnapshotImpl,
      buildCanonicalSnapshot: (updatedAt) => this.buildCanonicalSnapshot(updatedAt),
      buildPersistedSnapshotAt: (updatedAt) => this.buildPersistedSnapshotAt(updatedAt),
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
      emitError: (message) => this.emitError("internal_error", "session", message),
      formatError: (err) => this.formatErrorMessage(err),
    });
    this.historyManager = new HistoryManager({
      refreshRuntimeMessagesFromHistory: () => this.refreshRuntimeMessagesFromHistoryImpl(),
      appendMessagesToHistory: (messages) => this.appendMessagesToHistoryImpl(messages),
    });
    this.mcpManager = new McpManager({
      setEnableMcp: (enableMcp) => this.setEnableMcpImpl(enableMcp),
      emitMcpServers: () => this.emitMcpServersImpl(),
      upsertMcpServer: (server, previousName) => this.upsertMcpServerImpl(server, previousName),
      deleteMcpServer: (nameRaw) => this.deleteMcpServerImpl(nameRaw),
      validateMcpServer: (nameRaw) => this.validateMcpServerImpl(nameRaw),
      authorizeMcpServerAuth: (nameRaw) => this.authorizeMcpServerAuthImpl(nameRaw),
      callbackMcpServerAuth: (nameRaw, codeRaw) => this.callbackMcpServerAuthImpl(nameRaw, codeRaw),
      setMcpServerApiKey: (nameRaw, apiKeyRaw) => this.setMcpServerApiKeyImpl(nameRaw, apiKeyRaw),
      migrateLegacyMcpServers: (scope) => this.migrateLegacyMcpServersImpl(scope),
    });
    this.interactionManager = new InteractionManager({
      sessionId: this.id,
      emit: (evt) => this.emit(evt),
      emitError: (code, source, message) => this.emitError(code, source, message),
      log: (line) => this.log(line),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      getConfig: () => this.config,
      isYolo: () => this.yolo,
      waitForPromptResponse: (requestId, bucket) => this.waitForPromptResponse(requestId, bucket),
    });
    this.providerCatalogManager = new ProviderCatalogManager({
      sessionId: this.id,
      getConfig: () => this.config,
      getCoworkPaths: () => this.getCoworkPaths(),
      getProviderCatalog: this.getProviderCatalogImpl,
      getProviderStatuses: this.getProviderStatusesImpl,
      emit: (evt) => this.emit(evt),
      emitError: (code, source, message) => this.emitError(code, source, message),
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
      formatError: (err) => this.formatErrorMessage(err),
    });
    this.providerAuthManager = new ProviderAuthManager({
      sessionId: this.id,
      getConfig: () => this.config,
      setConfig: (next) => {
        this.config = next;
      },
      isRunning: () => this.running,
      guardBusy: () => this.guardBusy(),
      setConnecting: (connecting) => {
        this.connecting = connecting;
      },
      emit: (evt) => this.emit(evt),
      emitError: (code, source, message) => this.emitError(code, source, message),
      emitTelemetry: (name, status, attributes, durationMs) => this.emitTelemetry(name, status, attributes, durationMs),
      formatError: (err) => this.formatErrorMessage(err),
      log: (line) => this.log(line),
      persistModelSelection: this.persistModelSelectionImpl,
      updateSessionInfo: (patch) => this.updateSessionInfo(patch),
      queuePersistSessionSnapshot: (reason) => this.queuePersistSessionSnapshot(reason),
      emitConfigUpdated: () => this.emitConfigUpdated(),
      emitProviderCatalog: async () => await this.emitProviderCatalog(),
      refreshProviderStatus: async () => await this.refreshProviderStatus(),
      getCoworkPaths: () => this.getCoworkPaths(),
      runProviderConnect: async (opts) => await this.runProviderConnect(opts),
    });
    this.turnExecutionManager = new TurnExecutionManager({
      sendUserMessage: (text, clientMessageId, displayText) =>
        this.sendUserMessageImpl(text, clientMessageId, displayText),
      handleAskResponse: (requestId, answer) => this.handleAskResponseImpl(requestId, answer),
      handleApprovalResponse: (requestId, approved) => this.handleApprovalResponseImpl(requestId, approved),
      cancel: () => this.cancelImpl(),
    });
    const now = new Date().toISOString();
    this.sessionInfo = hydrated?.sessionInfo ?? {
      title: DEFAULT_SESSION_TITLE,
      titleSource: "default",
      titleModel: null,
      createdAt: now,
      updatedAt: now,
      provider: this.config.provider,
      model: this.config.model,
    };
    this.persistenceStatus = hydrated?.status ?? "active";
    this.hasGeneratedTitle = hydrated?.hasGeneratedTitle ?? false;
    this.allMessages = [...(hydrated?.messages ?? [])];
    this.messages = [];
    this.refreshRuntimeMessagesFromHistory();
    this.todos = hydrated?.todos ?? [];
    if (hydrated?.harnessContext) {
      this.harnessContextStore.set(this.id, hydrated.harnessContext);
    }
    this.sessionBackupState = {
      status: "initializing",
      sessionId: this.id,
      workingDirectory: this.config.workingDirectory,
      backupDirectory: null,
      createdAt: now,
      originalSnapshot: { kind: "pending" },
      checkpoints: [],
    };
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

    const sessionInfo: SessionInfoState = {
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
    return {
      provider: this.config.provider,
      model: this.config.model,
      workingDirectory: this.config.workingDirectory,
      ...(this.config.outputDirectory ? { outputDirectory: this.config.outputDirectory } : {}),
    };
  }

  private emitConfigUpdated() {
    this.emit({
      type: "config_updated",
      sessionId: this.id,
      config: this.getPublicConfig(),
    });
  }

  get isBusy(): boolean {
    return this.running;
  }

  get messageCount(): number {
    return this.allMessages.length;
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
    return this.config.enableMcp ?? false;
  }

  getSessionConfigEvent(): Extract<ServerEvent, { type: "session_config" }> {
    return {
      type: "session_config",
      sessionId: this.id,
      config: {
        yolo: this.yolo,
        observabilityEnabled: this.config.observabilityEnabled ?? false,
        subAgentModel: this.config.subAgentModel,
        maxSteps: this.maxSteps,
      },
    };
  }

  getSessionInfoEvent(): Extract<ServerEvent, { type: "session_info" }> {
    return {
      type: "session_info",
      sessionId: this.id,
      ...this.sessionInfo,
    };
  }

  getObservabilityStatusEvent(): Extract<ServerEvent, { type: "observability_status" }> {
    const observability = this.config.observability;
    const config = observability
      ? {
          provider: observability.provider,
          baseUrl: observability.baseUrl,
          otelEndpoint: observability.otelEndpoint,
          ...(observability.tracingEnvironment ? { tracingEnvironment: observability.tracingEnvironment } : {}),
          ...(observability.release ? { release: observability.release } : {}),
          hasPublicKey: !!observability.publicKey,
          hasSecretKey: !!observability.secretKey,
          configured: !!observability.publicKey && !!observability.secretKey,
        }
      : null;

    return {
      type: "observability_status",
      sessionId: this.id,
      enabled: this.config.observabilityEnabled ?? false,
      health: getObservabilityHealth(this.config),
      config,
    };
  }

  /** Re-emit pending ask/approval events for reconnecting clients. */
  replayPendingPrompts() {
    this.interactionManager.replayPendingPrompts();
  }

  private updateSessionInfo(
    patch: Partial<{
      title: string;
      titleSource: SessionTitleSource;
      titleModel: string | null;
      provider: AgentConfig["provider"];
      model: string;
    }>
  ) {
    const next: SessionInfoState = {
      ...this.sessionInfo,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const changed =
      next.title !== this.sessionInfo.title ||
      next.titleSource !== this.sessionInfo.titleSource ||
      next.titleModel !== this.sessionInfo.titleModel ||
      next.provider !== this.sessionInfo.provider ||
      next.model !== this.sessionInfo.model;
    if (!changed) return;
    this.sessionInfo = next;
    this.emit(this.getSessionInfoEvent());
    this.queuePersistSessionSnapshot("session_info.updated");
  }

  private buildPersistedSnapshot(): PersistedSessionSnapshot {
    return this.buildPersistedSnapshotAt(new Date().toISOString());
  }

  private buildPersistedSnapshotAt(updatedAt: string): PersistedSessionSnapshot {
    return {
      version: 1,
      sessionId: this.id,
      createdAt: this.sessionInfo.createdAt,
      updatedAt,
      session: {
        title: this.sessionInfo.title,
        titleSource: this.sessionInfo.titleSource,
        titleModel: this.sessionInfo.titleModel,
        provider: this.sessionInfo.provider,
        model: this.sessionInfo.model,
      },
      config: {
        provider: this.config.provider,
        model: this.config.model,
        enableMcp: this.getEnableMcp(),
        workingDirectory: this.config.workingDirectory,
        ...(this.config.outputDirectory ? { outputDirectory: this.config.outputDirectory } : {}),
        ...(this.config.uploadsDirectory ? { uploadsDirectory: this.config.uploadsDirectory } : {}),
      },
      context: {
        system: this.system,
        messages: this.allMessages,
        todos: this.todos,
        harnessContext: this.harnessContextStore.get(this.id),
      },
    };
  }

  private buildCanonicalSnapshot(updatedAt: string): PersistedSessionMutation["snapshot"] {
    return {
      title: this.sessionInfo.title,
      titleSource: this.sessionInfo.titleSource,
      titleModel: this.sessionInfo.titleModel,
      provider: this.config.provider,
      model: this.config.model,
      workingDirectory: this.config.workingDirectory,
      ...(this.config.outputDirectory ? { outputDirectory: this.config.outputDirectory } : {}),
      ...(this.config.uploadsDirectory ? { uploadsDirectory: this.config.uploadsDirectory } : {}),
      enableMcp: this.getEnableMcp(),
      createdAt: this.sessionInfo.createdAt,
      updatedAt,
      status: this.persistenceStatus,
      hasPendingAsk: this.hasPendingAsk,
      hasPendingApproval: this.hasPendingApproval,
      systemPrompt: this.system,
      messages: this.allMessages,
      todos: this.todos,
      harnessContext: this.harnessContextStore.get(this.id),
    };
  }

  private refreshRuntimeMessagesFromHistoryImpl() {
    if (this.allMessages.length <= MAX_MESSAGE_HISTORY) {
      this.messages = [...this.allMessages];
      return;
    }
    const first = this.allMessages[0];
    this.messages = [first, ...this.allMessages.slice(-(MAX_MESSAGE_HISTORY - 1))];
  }

  private appendMessagesToHistoryImpl(messages: ModelMessage[]) {
    if (messages.length === 0) return;
    this.allMessages.push(...messages);
    this.messages.push(...messages);
    if (this.messages.length > MAX_MESSAGE_HISTORY) {
      const first = this.messages[0];
      this.messages = [first, ...this.messages.slice(-(MAX_MESSAGE_HISTORY - 1))];
    }
  }

  private refreshRuntimeMessagesFromHistory() {
    this.historyManager.refreshRuntimeMessagesFromHistory();
  }

  private appendMessagesToHistory(messages: ModelMessage[]) {
    this.historyManager.appendMessagesToHistory(messages);
  }

  private queuePersistSessionSnapshot(reason: string) {
    this.persistenceManager.queuePersistSessionSnapshot(reason);
  }

  private maybeGenerateTitleFromQuery(query: string) {
    if (this.hasGeneratedTitle) return;
    if (this.sessionInfo.titleSource === "manual") {
      this.hasGeneratedTitle = true;
      return;
    }
    this.hasGeneratedTitle = true;
    const titleConfig: AgentConfig = { ...this.config };
    const prompt = query.trim();
    if (!prompt) return;
    const heuristicTitle = heuristicTitleFromQuery(prompt);
    if (this.sessionInfo.titleSource === "default" && heuristicTitle && heuristicTitle !== DEFAULT_SESSION_TITLE) {
      this.updateSessionInfo({
        title: heuristicTitle,
        titleSource: "heuristic",
        titleModel: null,
      });
    }

    void (async () => {
      const generated = await this.generateSessionTitleImpl({
        config: titleConfig,
        query: prompt,
      });
      if (this.sessionInfo.titleSource === "manual") return;
      this.updateSessionInfo({
        title: generated.title,
        titleSource: generated.source,
        titleModel: generated.model,
      });
    })().catch((err) => {
      this.emitTelemetry("session.title.generate", "error", {
        sessionId: this.id,
        error: this.formatErrorMessage(err),
      });
    });
  }

  private getUserHomeDir(): string | undefined {
    return this.config.userAgentDir ? path.dirname(this.config.userAgentDir) : undefined;
  }

  private getCoworkPaths() {
    return this.getAiCoworkerPathsImpl({ homedir: this.getUserHomeDir() });
  }

  private async runProviderConnect(opts: Parameters<typeof connectModelProvider>[0]): Promise<ConnectProviderResult> {
    const paths = opts.paths ?? this.getCoworkPaths();
    return await this.connectProviderImpl({
      ...opts,
      cwd: opts.cwd ?? this.config.workingDirectory,
      paths,
      oauthStdioMode: opts.oauthStdioMode ?? "pipe",
    });
  }

  private emitError(code: ServerErrorCode, source: ServerErrorSource, message: string) {
    this.emit({
      type: "error",
      sessionId: this.id,
      message,
      code,
      source,
    });
  }

  private classifyTurnError(err: unknown): { code: ServerErrorCode; source: ServerErrorSource } {
    const message = this.formatErrorMessage(err);
    const m = message.toLowerCase();
    const includesAny = (...needles: string[]) => needles.some((needle) => m.includes(needle));

    if (
      includesAny(
        "blocked: path is outside",
        "blocked: canonical target resolves outside",
        "outside allowed directories",
        "outside allowed roots",
        "blocked private/internal host",
        "blocked url protocol",
        "blocked url credentials",
        "glob blocked:"
      )
    ) {
      return { code: "permission_denied", source: "permissions" };
    }

    if (includesAny("observability", "traceql", "promql", "logql")) {
      return { code: "observability_error", source: "observability" };
    }

    if (includesAny("oauth", "api key", "unsupported provider")) {
      return { code: "provider_error", source: "provider" };
    }

    if (m.includes("unknown checkpoint id")) {
      return { code: "validation_failed", source: "session" };
    }

    if (includesAny("checkpoint", "session backup")) {
      return { code: "backup_error", source: "backup" };
    }

    if (includesAny("is required", "invalid ")) {
      return { code: "validation_failed", source: "session" };
    }

    return { code: "internal_error", source: "session" };
  }

  private isAbortLikeError(err: unknown): boolean {
    if (this.abortController?.signal.aborted) return true;
    if (err instanceof DOMException && err.name === "AbortError") return true;

    const code = typeof err === "object" && err ? (err as { code?: unknown }).code : undefined;
    if (code === "ABORT_ERR") return true;

    const msg = this.formatErrorMessage(err).toLowerCase();
    return msg.includes("abort") || msg.includes("cancel");
  }

  private emitTelemetry(name: string, status: "ok" | "error", attributes?: Record<string, string | number | boolean>, durationMs?: number) {
    void (async () => {
      const result = await emitObservabilityEvent(this.config, {
        name,
        at: new Date().toISOString(),
        status,
        ...(durationMs !== undefined ? { durationMs } : {}),
        attributes,
      });

      if (result.healthChanged) {
        this.emit(this.getObservabilityStatusEvent());
      }
    })().catch(() => {
      // observability is best-effort; never fail core session flow
    });
  }

  reset() {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }
    this.messages = [];
    this.allMessages = [];
    this.todos = [];
    this.emit({ type: "todos", sessionId: this.id, todos: [] });
    this.emit({ type: "reset_done", sessionId: this.id });
    this.queuePersistSessionSnapshot("session.reset");
  }

  listTools() {
    const toolMap = createTools({
      config: this.config,
      log: () => {},
      askUser: async () => "",
      approveCommand: async () => false,
    });
    // Note: MCP tools are loaded dynamically during turns and not included here.
    const tools = Object.entries(toolMap)
      .map(([name, def]) => {
        const raw = typeof def?.description === "string" ? def.description : "";
        const description = raw.split("\n")[0] || name;
        return { name, description };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    this.emit({ type: "tools", sessionId: this.id, tools });
  }

  async listCommands() {
    try {
      const commands = await listServerCommands(this.config);
      this.emit({ type: "commands", sessionId: this.id, commands });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to list commands: ${String(err)}`);
    }
  }

  async executeCommand(nameRaw: string, argumentsText = "", clientMessageId?: string) {
    const name = nameRaw.trim();
    if (!name) {
      this.emitError("validation_failed", "session", "Command name is required");
      return;
    }

    const resolved = await resolveCommand(this.config, name);
    if (!resolved) {
      this.emitError("validation_failed", "session", `Unknown command: ${name}`);
      return;
    }

    const expanded = expandCommandTemplate(resolved.template, argumentsText);
    if (!expanded.trim()) {
      this.emitError("validation_failed", "session", `Command "${name}" expanded to empty prompt`);
      return;
    }

    const trimmedArgs = argumentsText.trim();
    const slashText = `/${resolved.name}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
    await this.sendUserMessage(expanded, clientMessageId, slashText);
  }

  async listSkills() {
    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      this.emit({ type: "skills_list", sessionId: this.id, skills });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to list skills: ${String(err)}`);
    }
  }

  async readSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emitError("validation_failed", "session", "Skill name is required");
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }

      const content = await fs.readFile(skill.path, "utf-8");
      this.emit({ type: "skill_content", sessionId: this.id, skill, content: stripSkillFrontMatter(content) });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to read skill: ${String(err)}`);
    }
  }

  private globalSkillsDirs(): { enabledDir: string | null; disabledDir: string | null } {
    const enabledDir = this.config.skillsDirs.length >= 2 ? this.config.skillsDirs[1]! : null;
    if (!enabledDir) return { enabledDir: null, disabledDir: null };
    return { enabledDir, disabledDir: path.join(path.dirname(enabledDir), "disabled-skills") };
  }

  private async refreshSkillsList() {
    const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
    // Keep the cached metadata used by skill tool descriptions in sync with the
    // current enabled set so subsequent turns don't advertise stale skills.
    this.discoveredSkills = skills
      .filter((s) => s.enabled)
      .map((s) => ({ name: s.name, description: s.description }));
    this.emit({ type: "skills_list", sessionId: this.id, skills });
    await this.listCommands();
  }

  async disableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const { enabledDir, disabledDir } = this.globalSkillsDirs();
    if (!enabledDir || !disabledDir) {
      this.emitError("validation_failed", "session", "Global skills directory is not configured.");
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }
      if (skill.source !== "global") {
        this.emitError("validation_failed", "session", "Only global skills can be disabled in v1.");
        return;
      }
      if (!skill.enabled) {
        await this.refreshSkillsList();
        return;
      }

      await fs.mkdir(disabledDir, { recursive: true });
      const from = path.join(enabledDir, skillName);
      const to = path.join(disabledDir, skillName);
      await fs.rename(from, to);
      await this.refreshSkillsList();
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to disable skill: ${String(err)}`);
    }
  }

  async enableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const { enabledDir, disabledDir } = this.globalSkillsDirs();
    if (!enabledDir || !disabledDir) {
      this.emitError("validation_failed", "session", "Global skills directory is not configured.");
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }
      if (skill.source !== "global") {
        this.emitError("validation_failed", "session", "Only global skills can be enabled in v1.");
        return;
      }
      if (skill.enabled) {
        await this.refreshSkillsList();
        return;
      }

      await fs.mkdir(enabledDir, { recursive: true });
      const from = path.join(disabledDir, skillName);
      const to = path.join(enabledDir, skillName);
      await fs.rename(from, to);
      await this.refreshSkillsList();
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to enable skill: ${String(err)}`);
    }
  }

  async deleteSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    try {
      const skills = await discoverSkills(this.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }
      if (skill.source !== "global") {
        this.emitError("validation_failed", "session", "Only global skills can be deleted in v1.");
        return;
      }

      // Delete the containing directory (skill.path points at SKILL.md).
      const skillDir = path.dirname(skill.path);
      await fs.rm(skillDir, { recursive: true, force: true });
      await this.refreshSkillsList();
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to delete skill: ${String(err)}`);
    }
  }

  private async setEnableMcpImpl(enableMcp: boolean) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    this.config = { ...this.config, enableMcp };
    this.emit({ type: "session_settings", sessionId: this.id, enableMcp });
    let persistDefaultsError: string | null = null;
    if (this.persistProjectConfigPatchImpl) {
      try {
        await this.persistProjectConfigPatchImpl({ enableMcp });
      } catch (err) {
        persistDefaultsError = String(err);
      }
    }
    if (persistDefaultsError) {
      this.emitError(
        "internal_error",
        "session",
        `MCP setting updated for this session, but persisting defaults failed: ${persistDefaultsError}`
      );
    }
    this.queuePersistSessionSnapshot("session.enable_mcp");
  }

  private async emitMcpServersImpl() {
    try {
      const payload = await readMCPServersSnapshot(this.config);
      this.emit({
        type: "mcp_servers",
        sessionId: this.id,
        servers: payload.servers,
        legacy: payload.legacy,
        files: payload.files,
        ...(payload.warnings.length > 0 ? { warnings: payload.warnings } : {}),
      });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to read MCP servers: ${String(err)}`);
    }
  }

  async setEnableMcp(enableMcp: boolean) {
    await this.mcpManager.setEnableMcp(enableMcp);
  }

  async emitMcpServers() {
    await this.mcpManager.emitMcpServers();
  }

  private async getMcpServerByName(nameRaw: string): Promise<MCPRegistryServer | null> {
    const name = nameRaw.trim();
    if (!name) {
      this.emitError("validation_failed", "session", "MCP server name is required");
      return null;
    }

    const registry = await loadMCPConfigRegistry(this.config);
    const server = registry.servers.find((entry) => entry.name === name) ?? null;
    if (!server) {
      this.emitError("validation_failed", "session", `MCP server \"${name}\" not found.`);
      return null;
    }
    return server;
  }

  private async upsertMcpServerImpl(server: MCPServerConfig, previousName?: string) {
    if (!this.guardBusy()) return;
    try {
      await upsertWorkspaceMCPServer(this.config, server, previousName);
    } catch (err) {
      const message = String(err);
      if (message.toLowerCase().includes("mcp-servers.json")) {
        this.emitError("validation_failed", "session", message);
        return;
      }
      this.emitError("internal_error", "session", `Failed to upsert MCP server: ${message}`);
      return;
    }
    await this.emitMcpServersImpl();
    void this.validateMcpServerImpl(server.name);
  }

  private async deleteMcpServerImpl(nameRaw: string) {
    if (!this.guardBusy()) return;
    try {
      await deleteWorkspaceMCPServer(this.config, nameRaw);
    } catch (err) {
      const message = String(err);
      if (message.toLowerCase().includes("mcp-servers.json") || message.toLowerCase().includes("server name")) {
        this.emitError("validation_failed", "session", message);
        return;
      }
      this.emitError("internal_error", "session", `Failed to delete MCP server: ${message}`);
      return;
    }
    await this.emitMcpServersImpl();
  }

  private async validateMcpServerImpl(nameRaw: string) {
    const name = nameRaw.trim();
    if (!name) {
      this.emitError("validation_failed", "session", "MCP server name is required");
      return;
    }
    if (!this.guardBusy()) return;

    this.connecting = true;
    try {
      const server = await this.getMcpServerByName(name);
      if (!server) {
        this.emit({
          type: "mcp_server_validation",
          sessionId: this.id,
          name,
          ok: false,
          mode: "error",
          message: `MCP server \"${name}\" not found.`,
        });
        return;
      }

      const authState = await resolveMCPServerAuthState(this.config, server);
      if (authState.mode === "missing" || authState.mode === "oauth_pending" || authState.mode === "error") {
        this.emit({
          type: "mcp_server_validation",
          sessionId: this.id,
          name: server.name,
          ok: false,
          mode: authState.mode,
          message: authState.message,
        });
        return;
      }

      const runtimeServers = await loadMCPServers(this.config);
      const runtimeServer = runtimeServers.find((entry) => entry.name === server.name);
      if (!runtimeServer) {
        this.emit({
          type: "mcp_server_validation",
          sessionId: this.id,
          name: server.name,
          ok: false,
          mode: "error",
          message: "Server is not active in current MCP layering.",
        });
        return;
      }

      const startedAt = Date.now();
      const loadPromise = loadMCPTools([runtimeServer], { log: (line) => this.log(line) });
      let loadTimeout: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      try {
        const loaded = await Promise.race([
          loadPromise,
          new Promise<never>((_, reject) => {
            loadTimeout = setTimeout(() => {
              timedOut = true;
              reject(new Error(`MCP server validation timed out after ${MCP_VALIDATION_TIMEOUT_MS}ms.`));
            }, MCP_VALIDATION_TIMEOUT_MS);
          }),
        ]);
        const toolCount = Object.keys(loaded.tools).length;
        const latencyMs = Date.now() - startedAt;

        const ok = loaded.errors.length === 0;
        const message = ok ? "MCP server validation succeeded." : loaded.errors[0] ?? "MCP server validation failed.";
        this.emit({
          type: "mcp_server_validation",
          sessionId: this.id,
          name: server.name,
          ok,
          mode: authState.mode,
          message,
          toolCount,
          latencyMs,
        });
        await loaded.close();
      } catch (err) {
        if (timedOut) {
          void loadPromise
            .then(async (loaded) => {
              try {
                await loaded.close();
              } catch {
                // ignore
              }
            })
            .catch(() => {
              // ignore
            });
        }
        this.emit({
          type: "mcp_server_validation",
          sessionId: this.id,
          name: server.name,
          ok: false,
          mode: authState.mode,
          message: String(err),
          latencyMs: Date.now() - startedAt,
        });
      } finally {
        if (loadTimeout) clearTimeout(loadTimeout);
      }
    } finally {
      this.connecting = false;
    }
  }

  private async authorizeMcpServerAuthImpl(nameRaw: string) {
    if (!this.guardBusy()) return;

    const server = await this.getMcpServerByName(nameRaw);
    if (!server) return;

    if (!server.auth || server.auth.type !== "oauth") {
      this.emit({
        type: "mcp_server_auth_result",
        sessionId: this.id,
        name: server.name,
        ok: false,
        mode: "missing",
        message: `MCP server \"${server.name}\" does not support OAuth authorization.`,
      });
      return;
    }

    this.connecting = true;
    try {
      // Read any previously stored client credentials (from dynamic registration).
      const storedClientState = await readMCPServerOAuthClientInformation({
        config: this.config,
        server,
      });

      const result = await authorizeMCPServerOAuth(server, storedClientState.clientInformation);

      // Persist newly registered client information if dynamic registration occurred.
      if (result.clientInformation) {
        await setMCPServerOAuthClientInformation({
          config: this.config,
          server,
          clientInformation: result.clientInformation,
        });
      }

      await setMCPServerOAuthPending({
        config: this.config,
        server,
        pending: result.pending,
      });
      this.emit({
        type: "mcp_server_auth_challenge",
        sessionId: this.id,
        name: server.name,
        challenge: result.challenge,
      });
      await this.emitMcpServersImpl();
    } catch (err) {
      this.emit({
        type: "mcp_server_auth_result",
        sessionId: this.id,
        name: server.name,
        ok: false,
        mode: "error",
        message: `MCP OAuth authorization failed: ${String(err)}`,
      });
    } finally {
      this.connecting = false;
    }
  }

  private async callbackMcpServerAuthImpl(nameRaw: string, codeRaw?: string) {
    if (!this.guardBusy()) return;

    const server = await this.getMcpServerByName(nameRaw);
    if (!server) return;

    if (!server.auth || server.auth.type !== "oauth") {
      this.emit({
        type: "mcp_server_auth_result",
        sessionId: this.id,
        name: server.name,
        ok: false,
        mode: "missing",
        message: `MCP server \"${server.name}\" does not support OAuth authorization.`,
      });
      return;
    }

    this.connecting = true;
    let validateName: string | null = null;
    try {
      const pendingState = await readMCPServerOAuthPending({ config: this.config, server });
      const pending = pendingState.pending;
      if (!pending) {
        this.emit({
          type: "mcp_server_auth_result",
          sessionId: this.id,
          name: server.name,
          ok: false,
          mode: "missing",
          message: "No pending OAuth challenge found. Start authorization first.",
        });
        return;
      }

      let code = codeRaw?.trim() || undefined;
      if (!code) {
        code = await consumeCapturedOAuthCode(pending.challengeId);
      }
      if (!code) {
        this.emit({
          type: "mcp_server_auth_result",
          sessionId: this.id,
          name: server.name,
          ok: true,
          mode: "oauth_pending",
          message: "OAuth callback is still pending. Paste a code to continue manually.",
        });
        return;
      }

      // Read stored client credentials to pass through to token exchange.
      const storedClientState = await readMCPServerOAuthClientInformation({
        config: this.config,
        server,
      });
      const exchange = await exchangeMCPServerOAuthCode({
        server,
        code,
        pending,
        storedClientInfo: storedClientState.clientInformation,
      });
      await completeMCPServerOAuth({
        config: this.config,
        server,
        tokens: exchange.tokens,
        clearPending: true,
      });

      this.emit({
        type: "mcp_server_auth_result",
        sessionId: this.id,
        name: server.name,
        ok: true,
        mode: "oauth",
        message: exchange.message,
      });
      await this.emitMcpServersImpl();
      validateName = server.name;
    } catch (err) {
      this.emit({
        type: "mcp_server_auth_result",
        sessionId: this.id,
        name: server.name,
        ok: false,
        mode: "error",
        message: `MCP OAuth callback failed: ${String(err)}`,
      });
    } finally {
      this.connecting = false;
      if (validateName) {
        void this.validateMcpServerImpl(validateName);
      }
    }
  }

  private async setMcpServerApiKeyImpl(nameRaw: string, apiKeyRaw: string) {
    if (!this.guardBusy()) return;

    const server = await this.getMcpServerByName(nameRaw);
    if (!server) return;

    if (!server.auth || server.auth.type !== "api_key") {
      this.emit({
        type: "mcp_server_auth_result",
        sessionId: this.id,
        name: server.name,
        ok: false,
        mode: "missing",
        message: `MCP server \"${server.name}\" is not configured for API key auth.`,
      });
      return;
    }

    this.connecting = true;
    let validateName: string | null = null;
    try {
      const result = await setMCPServerApiKeyCredential({
        config: this.config,
        server,
        apiKey: apiKeyRaw,
        keyId: server.auth.keyId,
      });
      this.emit({
        type: "mcp_server_auth_result",
        sessionId: this.id,
        name: server.name,
        ok: true,
        mode: "api_key",
        message: `API key saved (${result.maskedApiKey}) to ${result.scope} auth store.`,
      });
      await this.emitMcpServersImpl();
      validateName = server.name;
    } catch (err) {
      this.emit({
        type: "mcp_server_auth_result",
        sessionId: this.id,
        name: server.name,
        ok: false,
        mode: "error",
        message: `Setting MCP API key failed: ${String(err)}`,
      });
    } finally {
      this.connecting = false;
      if (validateName) {
        void this.validateMcpServerImpl(validateName);
      }
    }
  }

  private async migrateLegacyMcpServersImpl(scope: "workspace" | "user") {
    if (!this.guardBusy()) return;
    try {
      const result = await migrateLegacyMCPServers(this.config, scope);
      this.emit({
        type: "assistant_message",
        sessionId: this.id,
        text:
          `Legacy MCP migration (${scope}) complete: imported ${result.imported}, ` +
          `skipped ${result.skippedConflicts}.` +
          (result.archivedPath ? ` Archived legacy file to ${result.archivedPath}.` : ""),
      });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to migrate legacy MCP servers: ${String(err)}`);
      return;
    }
    await this.emitMcpServersImpl();
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
    this.emit({
      type: "harness_context",
      sessionId: this.id,
      context: this.harnessContextStore.get(this.id),
    });
  }

  setHarnessContext(context: HarnessContextPayload) {
    const next = this.harnessContextStore.set(this.id, context);
    this.emit({ type: "harness_context", sessionId: this.id, context: next });
    this.emitTelemetry("harness.context.set", "ok", {
      sessionId: this.id,
      runId: context.runId,
      objectiveLength: context.objective.length,
    });
    this.queuePersistSessionSnapshot("session.harness_context");
  }

  /** Returns true when the session is free to start a new blocking operation. */
  private guardBusy(): boolean {
    if (this.running) { this.emitError("busy", "session", "Agent is busy"); return false; }
    if (this.connecting) { this.emitError("busy", "session", "Connection flow already running"); return false; }
    return true;
  }

  private formatErrorMessage(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return String(err);
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

  private handleAskResponseImpl(requestId: string, answer: string) {
    this.interactionManager.handleAskResponse(requestId, answer);
  }

  private handleApprovalResponseImpl(requestId: string, approved: boolean) {
    this.interactionManager.handleApprovalResponse(requestId, approved);
  }

  /** Cancel the currently running agent turn. */
  private cancelImpl() {
    if (!this.running) return;
    if (this.abortController) {
      this.abortController.abort();
    }
    // Reject any pending ask/approval so the turn unblocks.
    this.interactionManager.rejectAllPending("Cancelled by user");
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
    this.persistenceStatus = "closed";
    this.queuePersistSessionSnapshot("session.closed");
    await this.persistenceManager.waitForIdle();
  }

  dispose(reason: string) {
    this.abortController?.abort();
    this.interactionManager.rejectAllPending(`Session disposed (${reason})`);
    this.harnessContextStore.clear(this.id);

    void this.closeSessionBackup();
  }

  private log(line: string) {
    this.emit({ type: "log", sessionId: this.id, line });
  }

  private waitForPromptResponse<T>(
    requestId: string,
    bucket: Map<string, PromiseWithResolvers<T>>,
  ): Promise<T> {
    const entry = bucket.get(requestId);
    if (!entry) return Promise.reject(new Error(`Unknown prompt request: ${requestId}`));
    return entry.promise;
  }

  private async runInBackupQueue<T>(op: () => Promise<T>): Promise<T> {
    const prior = this.backupOperationQueue;
    let release!: () => void;
    this.backupOperationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prior.catch(() => {});
    try {
      return await op();
    } finally {
      release();
    }
  }

  private async ensureSessionBackupInitialized() {
    if (!this.sessionBackupInit) {
      this.sessionBackupInit = this.initializeSessionBackup();
    }
    await this.sessionBackupInit;
  }

  private async askUser(question: string, options?: string[]) {
    return await this.interactionManager.askUser(question, options);
  }

  private async approveCommand(command: string) {
    return await this.interactionManager.approveCommand(command);
  }

  private updateTodos = (todos: TodoItem[]) => {
    this.todos = todos;
    this.emit({ type: "todos", sessionId: this.id, todos });
    this.queuePersistSessionSnapshot("session.todos_updated");
  };

  getMessages(offset = 0, limit = 100) {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.floor(limit));
    let total = this.allMessages.length;
    let slice = this.allMessages.slice(safeOffset, safeOffset + safeLimit);
    if (this.sessionDb) {
      const persisted = this.sessionDb.getMessages(this.id, safeOffset, safeLimit);
      total = persisted.total;
      slice = persisted.messages;
    }
    this.emit({
      type: "messages",
      sessionId: this.id,
      messages: slice,
      total,
      offset: safeOffset,
      limit: safeLimit,
    });
  }

  setSessionTitle(title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      this.emitError("validation_failed", "session", "Title must be non-empty");
      return;
    }
    this.hasGeneratedTitle = true;
    this.updateSessionInfo({
      title: trimmed,
      titleSource: "manual",
      titleModel: null,
    });
  }

  async listSessions() {
    try {
      const sessions = this.sessionDb
        ? this.sessionDb.listSessions()
        : await listPersistedSessionSnapshots(this.getCoworkPaths());
      this.emit({ type: "sessions", sessionId: this.id, sessions });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to list sessions: ${String(err)}`);
    }
  }

  async deleteSession(targetSessionId: string) {
    if (targetSessionId === this.id) {
      this.emitError("validation_failed", "session", "Cannot delete the active session");
      return;
    }
    try {
      if (this.sessionDb) {
        this.sessionDb.deleteSession(targetSessionId);
      } else {
        const paths = this.getCoworkPaths();
        await deletePersistedSessionSnapshot(paths, targetSessionId);
      }
      this.emit({ type: "session_deleted", sessionId: this.id, targetSessionId });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to delete session: ${String(err)}`);
    }
  }

  setConfig(patch: {
    yolo?: boolean;
    observabilityEnabled?: boolean;
    subAgentModel?: string;
    maxSteps?: number;
  }) {
    if (patch.yolo !== undefined) this.yolo = patch.yolo;
    if (patch.observabilityEnabled !== undefined) {
      this.config = { ...this.config, observabilityEnabled: patch.observabilityEnabled };
      this.emit(this.getObservabilityStatusEvent());
    }
    if (patch.subAgentModel !== undefined) {
      this.config = { ...this.config, subAgentModel: patch.subAgentModel };
    }
    if (patch.maxSteps !== undefined) this.maxSteps = patch.maxSteps;

    this.emit(this.getSessionConfigEvent());
    this.queuePersistSessionSnapshot("session.config_updated");

    const persistPatch: PersistedProjectConfigPatch = {};
    if (patch.subAgentModel !== undefined) {
      persistPatch.subAgentModel = patch.subAgentModel;
    }
    if (patch.observabilityEnabled !== undefined) {
      persistPatch.observabilityEnabled = patch.observabilityEnabled;
    }
    if (Object.keys(persistPatch).length > 0 && this.persistProjectConfigPatchImpl) {
      void Promise.resolve(this.persistProjectConfigPatchImpl(persistPatch)).catch((err) => {
        this.emitError(
          "internal_error",
          "session",
          `Config updated for this session, but persisting defaults failed: ${String(err)}`
        );
      });
    }
  }

  async uploadFile(filename: string, contentBase64: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const safeName = path.basename(filename);
    if (!safeName || safeName === "." || safeName === "..") {
      this.emitError("validation_failed", "session", "Invalid filename");
      return;
    }

    const MAX_BASE64_SIZE = 10 * 1024 * 1024; // ~7.5MB decoded
    if (contentBase64.length > MAX_BASE64_SIZE) {
      this.emitError("validation_failed", "session", "File too large (max ~7.5MB)");
      return;
    }

    const uploadsDir = this.config.uploadsDirectory ?? this.config.workingDirectory;
    const filePath = path.resolve(uploadsDir, safeName);
    // Prevent path traversal
    if (!filePath.startsWith(path.resolve(uploadsDir))) {
      this.emitError("validation_failed", "session", "Invalid filename (path traversal)");
      return;
    }

    try {
      const decoded = Buffer.from(contentBase64, "base64");
      // Only create the directory if a custom uploads path is configured
      if (this.config.uploadsDirectory) {
        await fs.mkdir(uploadsDir, { recursive: true });
      }
      await fs.writeFile(filePath, decoded);
      this.emit({ type: "file_uploaded", sessionId: this.id, filename: safeName, path: filePath });
    } catch (err) {
      this.emitError("internal_error", "session", `Failed to upload file: ${String(err)}`);
    }
  }

  async getSessionBackupState() {
    await this.ensureSessionBackupInitialized();
    this.emitSessionBackupState("requested");
    this.emitTelemetry("session.backup.state_requested", "ok", { sessionId: this.id });
  }

  async createManualSessionCheckpoint() {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }
    const startedAt = Date.now();
    try {
      const didCheckpoint = await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) {
          const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
          this.emitError("backup_error", "backup", reason);
          return false;
        }
        await this.sessionBackup.createCheckpoint("manual");
        this.sessionBackupState = this.sessionBackup.getPublicState();
        this.emitSessionBackupState("manual_checkpoint");
        return true;
      });
      if (!didCheckpoint) return;
      this.emitTelemetry("session.backup.checkpoint.manual", "ok", { sessionId: this.id }, Date.now() - startedAt);
    } catch (err) {
      this.emitError("backup_error", "backup", `manual checkpoint failed: ${String(err)}`);
      this.emitTelemetry("session.backup.checkpoint.manual", "error", { sessionId: this.id }, Date.now() - startedAt);
    }
  }

  async restoreSessionBackup(checkpointId?: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const startedAt = Date.now();
    try {
      const didRestore = await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) {
          const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
          this.emitError("backup_error", "backup", reason);
          return false;
        }
        if (checkpointId) {
          await this.sessionBackup.restoreCheckpoint(checkpointId);
        } else {
          await this.sessionBackup.restoreOriginal();
        }
        this.sessionBackupState = this.sessionBackup.getPublicState();
        this.emitSessionBackupState("restore");
        return true;
      });
      if (!didRestore) return;
      this.emitTelemetry("session.backup.restore", "ok", { sessionId: this.id }, Date.now() - startedAt);
    } catch (err) {
      this.emitError("backup_error", "backup", `restore failed: ${String(err)}`);
      this.emitTelemetry("session.backup.restore", "error", { sessionId: this.id }, Date.now() - startedAt);
    }
  }

  async deleteSessionCheckpoint(checkpointId: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    const startedAt = Date.now();
    try {
      const didDelete = await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) {
          const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
          this.emitError("backup_error", "backup", reason);
          return false;
        }
        const removed = await this.sessionBackup.deleteCheckpoint(checkpointId);
        if (!removed) {
          this.emitError("validation_failed", "backup", `Unknown checkpoint id: ${checkpointId}`);
          return false;
        }
        this.sessionBackupState = this.sessionBackup.getPublicState();
        this.emitSessionBackupState("delete");
        return true;
      });
      if (!didDelete) return;
      this.emitTelemetry("session.backup.checkpoint.delete", "ok", { sessionId: this.id }, Date.now() - startedAt);
    } catch (err) {
      this.emitError("backup_error", "backup", `delete checkpoint failed: ${String(err)}`);
      this.emitTelemetry("session.backup.checkpoint.delete", "error", { sessionId: this.id }, Date.now() - startedAt);
    }
  }

  private async sendUserMessageImpl(text: string, clientMessageId?: string, displayText?: string) {
    if (this.running) {
      this.emitError("busy", "session", "Agent is busy");
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    const turnStartedAt = Date.now();
    const turnId = makeId();
    this.currentTurnId = turnId;
    this.currentTurnOutcome = "completed";
    const cause: "user_message" | "command" = displayText?.startsWith("/") ? "command" : "user_message";
    try {
      this.emit({ type: "user_message", sessionId: this.id, text: displayText ?? text, clientMessageId });
      this.emit({ type: "session_busy", sessionId: this.id, busy: true, turnId, cause });
      this.emitTelemetry("agent.turn.started", "ok", {
        sessionId: this.id,
        provider: this.config.provider,
        model: this.config.model,
      });
      this.appendMessagesToHistory([{ role: "user", content: text }]);
      this.maybeGenerateTitleFromQuery(text);
      this.queuePersistSessionSnapshot("session.user_message");

      let streamPartIndex = 0;
      const res = await this.runTurnImpl({
        config: this.config,
        system: this.system,
        messages: this.messages,
        log: (line) => this.log(line),
        askUser: (q, opts) => this.askUser(q, opts),
        approveCommand: (cmd) => this.approveCommand(cmd),
        updateTodos: (todos) => this.updateTodos(todos),
        discoveredSkills: this.discoveredSkills,
        maxSteps: this.maxSteps,
        enableMcp: this.config.enableMcp,
        spawnDepth: 0,
        telemetryContext: {
          functionId: "session.turn",
          metadata: {
            sessionId: this.id,
            turnId,
          },
        },
        abortSignal: this.abortController.signal,
        includeRawChunks: true,
        onModelError: async (error) => {
          this.emitTelemetry("agent.stream.error", "error", {
            sessionId: this.id,
            provider: this.config.provider,
            model: this.config.model,
            error: this.formatErrorMessage(error),
          });
        },
        onModelAbort: async () => {
          this.emitTelemetry("agent.stream.aborted", "ok", {
            sessionId: this.id,
            provider: this.config.provider,
            model: this.config.model,
          });
        },
        onModelStreamPart: async (rawPart) => {
          const normalized = normalizeModelStreamPart(rawPart, {
            provider: this.config.provider,
            includeRawPart: true,
          });
          this.emit({
            type: "model_stream_chunk",
            sessionId: this.id,
            turnId,
            index: streamPartIndex++,
            provider: this.config.provider,
            model: this.config.model,
            partType: normalized.partType,
            part: normalized.part,
            ...(normalized.rawPart !== undefined ? { rawPart: normalized.rawPart } : {}),
          });
        },
      });

      this.appendMessagesToHistory(res.responseMessages);
      this.queuePersistSessionSnapshot("session.turn_response");

      const reasoning = (res.reasoningText || "").trim();
      if (reasoning) {
        const kind = reasoningModeForProvider(this.config.provider);
        this.emit({ type: "reasoning", sessionId: this.id, kind, text: reasoning });
      }

      const out =
        (res.text || "").trim() ||
        extractAssistantTextFromResponseMessages(res.responseMessages);
      if (out) this.emit({ type: "assistant_message", sessionId: this.id, text: out });

      if (res.usage) {
        this.emit({ type: "turn_usage", sessionId: this.id, turnId, usage: res.usage });
      }

      this.emitTelemetry(
        "agent.turn.completed",
        "ok",
        {
          sessionId: this.id,
          provider: this.config.provider,
          model: this.config.model,
        },
        Date.now() - turnStartedAt
      );
    } catch (err) {
      const msg = this.formatErrorMessage(err);
      if (!this.isAbortLikeError(err)) {
        this.currentTurnOutcome = "error";
        const classified = this.classifyTurnError(err);
        this.emitError(classified.code, classified.source, msg);
        this.emitTelemetry(
          "agent.turn.failed",
          "error",
          {
            sessionId: this.id,
            provider: this.config.provider,
            model: this.config.model,
            error: msg,
          },
          Date.now() - turnStartedAt
        );
      } else {
        this.currentTurnOutcome = "cancelled";
        this.emitTelemetry(
          "agent.turn.aborted",
          "ok",
          {
            sessionId: this.id,
            provider: this.config.provider,
            model: this.config.model,
          },
          Date.now() - turnStartedAt
        );
      }
    } finally {
      this.emit({
        type: "session_busy",
        sessionId: this.id,
        busy: false,
        turnId,
        outcome: this.currentTurnOutcome,
      });
      this.running = false;
      this.abortController = null;
      this.currentTurnId = null;
      // Auto-checkpointing is best-effort and must never block follow-up prompts.
      void this.takeAutomaticSessionCheckpoint().catch(() => {
        // takeAutomaticSessionCheckpoint already emits backup errors/telemetry.
      });
    }
  }

  async sendUserMessage(text: string, clientMessageId?: string, displayText?: string) {
    await this.turnExecutionManager.sendUserMessage(text, clientMessageId, displayText);
  }

  private emitSessionBackupState(
    reason: "requested" | "auto_checkpoint" | "manual_checkpoint" | "restore" | "delete"
  ) {
    this.emit({
      type: "session_backup_state",
      sessionId: this.id,
      reason,
      backup: this.sessionBackupState,
    });
  }

  private async initializeSessionBackup() {
    const userHome = this.config.userAgentDir ? path.dirname(this.config.userAgentDir) : undefined;
    const startedAt = Date.now();

    try {
      this.sessionBackup = await this.sessionBackupFactory({
        sessionId: this.id,
        workingDirectory: this.config.workingDirectory,
        homedir: userHome,
      });
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitTelemetry("session.backup.initialize", "ok", { sessionId: this.id }, Date.now() - startedAt);
    } catch (err) {
      const reason = `session backup initialization failed: ${String(err)}`;
      this.sessionBackup = null;
      this.sessionBackupState = {
        ...this.sessionBackupState,
        status: "failed",
        failureReason: reason,
        originalSnapshot: { kind: "pending" },
      };
      this.emitTelemetry(
        "session.backup.initialize",
        "error",
        { sessionId: this.id, error: reason },
        Date.now() - startedAt
      );
    }
  }

  private async takeAutomaticSessionCheckpoint() {
    if (Date.now() - this.lastAutoCheckpointAt < AUTO_CHECKPOINT_MIN_INTERVAL_MS) return;

    try {
      const didCheckpoint = await this.runInBackupQueue(async () => {
        if (Date.now() - this.lastAutoCheckpointAt < AUTO_CHECKPOINT_MIN_INTERVAL_MS) return;
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) return false;
        await this.sessionBackup.createCheckpoint("auto");
        this.sessionBackupState = this.sessionBackup.getPublicState();
        this.emitSessionBackupState("auto_checkpoint");
        this.lastAutoCheckpointAt = Date.now();
        return true;
      });
      if (!didCheckpoint) return;
    } catch (err) {
      this.emitError("backup_error", "backup", `automatic checkpoint failed: ${String(err)}`);
      this.emitTelemetry("session.backup.checkpoint.auto", "error", {
        sessionId: this.id,
        error: this.formatErrorMessage(err),
      });
      return;
    }

    this.emitTelemetry("session.backup.checkpoint.auto", "ok", { sessionId: this.id });
  }

  private async closeSessionBackup() {
    if (!this.sessionBackupInit) return;
    try {
      await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.sessionBackup) return;
        await this.sessionBackup.close();
        this.sessionBackupState = this.sessionBackup.getPublicState();
      });
      this.emitTelemetry("session.backup.close", "ok", { sessionId: this.id });
    } catch {
      // best-effort close
      this.emitTelemetry("session.backup.close", "error", { sessionId: this.id });
    }
  }
}
