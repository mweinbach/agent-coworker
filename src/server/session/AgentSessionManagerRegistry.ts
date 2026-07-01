import type { ConnectProviderResult, connectProvider as connectModelProvider } from "../../connect";
import type { ServerErrorCode, ServerErrorData, ServerErrorSource } from "../../types";
import type { HistoryManager } from "./HistoryManager";
import type { InteractionManager } from "./InteractionManager";
import { McpManager } from "./McpManager";
import { ProviderAuthManager } from "./ProviderAuthManager";
import { ProviderCatalogManager } from "./ProviderCatalogManager";
import { SessionAdminManager } from "./SessionAdminManager";
import type { SessionBackupController } from "./SessionBackupController";
import type { SessionContext, SessionDependencies, SessionRuntimeState } from "./SessionContext";
import type { SessionMetadataManager } from "./SessionMetadataManager";
import type { SessionSnapshotProjector } from "./SessionSnapshotProjector";
import { SkillManager } from "./SkillManager";
import { TurnExecutionManager } from "./TurnExecutionManager";

export type AgentSessionManagerHost = {
  readonly id: string;
  readonly context: SessionContext;
  readonly state: SessionRuntimeState;
  readonly deps: SessionDependencies;
  readonly interactionManager: InteractionManager;
  readonly historyManager: HistoryManager;
  readonly metadataManager: SessionMetadataManager;
  readonly backupController: SessionBackupController;
  readonly sessionSnapshotProjector: SessionSnapshotProjector;
  sendUserMessage(text: string, clientMessageId?: string, displayText?: string): Promise<void>;
  flushPendingExternalSkillRefresh(): Promise<void>;
  triggerMemoryGeneration(): void;
  onAdvancedMemoryChanged(folder: string): Promise<void>;
  getGlobalAuthPaths(): ReturnType<SessionContext["getCoworkPaths"]>;
  runProviderConnect(
    opts: Parameters<typeof connectModelProvider>[0],
  ): Promise<ConnectProviderResult>;
  guardBusy(): boolean;
  emitTelemetry(
    name: string,
    status: "ok" | "error",
    attributes?: Record<string, string | number | boolean>,
    durationMs?: number,
  ): void;
  formatErrorMessage(err: unknown): string;
  log(line: string): void;
  queuePersistSessionSnapshot(reason: string): void;
  emitError(
    code: ServerErrorCode,
    source: ServerErrorSource,
    message: string,
    data?: ServerErrorData,
  ): void;
};

export class AgentSessionManagerRegistry {
  private mcpManager: McpManager | null = null;
  private providerAuthManager: ProviderAuthManager | null = null;
  private providerCatalogManager: ProviderCatalogManager | null = null;
  private turnExecutionManager: TurnExecutionManager | null = null;
  private skillManager: SkillManager | null = null;
  private adminManager: SessionAdminManager | null = null;

  constructor(private readonly host: AgentSessionManagerHost) {}

  disposeManagers(): void {
    this.mcpManager?.close();
    this.mcpManager = null;
    this.providerAuthManager = null;
    this.providerCatalogManager = null;
    this.turnExecutionManager = null;
    this.skillManager = null;
    this.adminManager = null;
  }

  getSkillManager(): SkillManager {
    if (!this.skillManager) {
      this.skillManager = new SkillManager(this.host.context, {
        sendUserMessage: (text, clientMessageId, displayText) =>
          this.host.sendUserMessage(text, clientMessageId, displayText),
      });
    }
    return this.skillManager;
  }

  getMcpManager(): McpManager {
    if (!this.mcpManager) {
      this.mcpManager = new McpManager(this.host.context);
    }
    return this.mcpManager;
  }

  getTurnExecutionManager(): TurnExecutionManager {
    if (!this.turnExecutionManager) {
      this.turnExecutionManager = new TurnExecutionManager(this.host.context, {
        interactionManager: this.host.interactionManager,
        historyManager: this.host.historyManager,
        metadataManager: this.host.metadataManager,
        backupController: this.host.backupController,
        flushPendingExternalSkillRefresh: async () =>
          await this.host.flushPendingExternalSkillRefresh(),
        triggerMemoryGeneration: () => this.host.triggerMemoryGeneration(),
        onAdvancedMemoryChanged: async (folder) => await this.host.onAdvancedMemoryChanged(folder),
      });
    }
    return this.turnExecutionManager;
  }

  getAdminManager(): SessionAdminManager {
    if (!this.adminManager) {
      this.adminManager = new SessionAdminManager(this.host.context);
    }
    return this.adminManager;
  }

  getProviderCatalogManager(): ProviderCatalogManager {
    if (!this.providerCatalogManager) {
      this.providerCatalogManager = new ProviderCatalogManager({
        sessionId: this.host.id,
        getConfig: () => this.host.state.config,
        getGlobalAuthPaths: () => this.host.getGlobalAuthPaths(),
        getProviderCatalog: this.host.deps.getProviderCatalogImpl,
        getProviderStatuses: this.host.deps.getProviderStatusesImpl,
        emit: (evt) => this.host.context.emit(evt),
        emitError: (code, source, message) => this.host.emitError(code, source, message),
        emitTelemetry: (name, status, attributes, durationMs) =>
          this.host.emitTelemetry(name, status, attributes, durationMs),
        formatError: (err) => this.host.formatErrorMessage(err),
      });
    }
    return this.providerCatalogManager;
  }

  getProviderAuthManager(): ProviderAuthManager {
    if (!this.providerAuthManager) {
      this.providerAuthManager = new ProviderAuthManager({
        sessionId: this.host.id,
        getConfig: () => this.host.state.config,
        setConfig: (next) => {
          this.host.state.config = next;
        },
        isRunning: () => this.host.state.running,
        guardBusy: () => this.host.guardBusy(),
        setConnecting: (connecting) => {
          this.host.state.connecting = connecting;
        },
        emit: (evt) => this.host.context.emit(evt),
        emitError: (code, source, message) => this.host.emitError(code, source, message),
        emitTelemetry: (name, status, attributes, durationMs) =>
          this.host.emitTelemetry(name, status, attributes, durationMs),
        formatError: (err) => this.host.formatErrorMessage(err),
        log: (line) => this.host.log(line),
        clearProviderState: () => {
          this.host.state.providerState = null;
        },
        persistModelSelection: this.host.deps.persistModelSelectionImpl,
        updateSessionInfo: (patch) => this.host.metadataManager.updateSessionInfo(patch),
        queuePersistSessionSnapshot: (reason) => this.host.queuePersistSessionSnapshot(reason),
        emitConfigUpdated: () => this.host.metadataManager.emitConfigUpdated(),
        emitProviderCatalog: async (opts) =>
          await this.getProviderCatalogManager().emitProviderCatalog(opts),
        refreshProviderStatus: async (opts) =>
          await this.getProviderCatalogManager().refreshProviderStatus(opts),
        getGlobalAuthPaths: () => this.host.getGlobalAuthPaths(),
        runProviderConnect: async (providerOpts) =>
          await this.host.runProviderConnect(providerOpts),
        logoutProviderAuth: this.host.deps.logoutProviderAuthImpl,
      });
    }
    return this.providerAuthManager;
  }
}
