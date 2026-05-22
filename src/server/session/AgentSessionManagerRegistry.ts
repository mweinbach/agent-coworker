import type { ConnectProviderResult, connectProvider as connectModelProvider } from "../../connect";
import type { ServerErrorCode, ServerErrorSource } from "../../types";
import type { MCPRegistryServer } from "../../mcp/configRegistry";
import type { ExperimentalA2uiManager, SessionContext, SessionDependencies, SessionRuntimeState } from "./SessionContext";
import { HistoryManager } from "./HistoryManager";
import { InteractionManager } from "./InteractionManager";
import { McpManager } from "./McpManager";
import { ProviderAuthManager } from "./ProviderAuthManager";
import { ProviderCatalogManager } from "./ProviderCatalogManager";
import { SessionAdminManager } from "./SessionAdminManager";
import { SessionBackupController } from "./SessionBackupController";
import { SessionMetadataManager } from "./SessionMetadataManager";
import { SessionSnapshotProjector } from "./SessionSnapshotProjector";
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
  sendUserMessage(
    text: string,
    clientMessageId?: string,
    displayText?: string,
  ): Promise<void>;
  flushPendingExternalSkillRefresh(): Promise<void>;
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
  emitError(code: ServerErrorCode, source: ServerErrorSource, message: string): void;
};

export class AgentSessionManagerRegistry {
  private mcpManager: McpManager | null = null;
  private providerAuthManager: ProviderAuthManager | null = null;
  private providerCatalogManager: ProviderCatalogManager | null = null;
  private turnExecutionManager: TurnExecutionManager | null = null;
  private a2uiSurfaceManager: ExperimentalA2uiManager | null = null;
  private skillManager: SkillManager | null = null;
  private adminManager: SessionAdminManager | null = null;

  constructor(private readonly host: AgentSessionManagerHost) {}

  resetLoadedA2uiSurfaceManager(): void {
    this.a2uiSurfaceManager?.reset();
  }

  disposeManagers(): void {
    this.mcpManager?.close();
    this.mcpManager = null;
    this.providerAuthManager = null;
    this.providerCatalogManager = null;
    this.turnExecutionManager = null;
    this.a2uiSurfaceManager = null;
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
        ...(this.host.deps.createA2uiSurfaceManagerImpl
          ? { getA2uiSurfaceManager: () => this.getA2uiSurfaceManager() }
          : {}),
      });
    }
    return this.turnExecutionManager;
  }

  getA2uiSurfaceManager(): ExperimentalA2uiManager {
    const createManager = this.host.deps.createA2uiSurfaceManagerImpl;
    if (!createManager) {
      throw new Error("A2UI is not enabled for this session.");
    }
    if (!this.a2uiSurfaceManager) {
      this.a2uiSurfaceManager = createManager({
        sessionId: this.host.id,
        emit: (evt) => this.host.context.emit(evt),
        log: (line) => this.host.context.emit({ type: "log", sessionId: this.host.id, line }),
      });
      this.a2uiSurfaceManager.hydrate(
        this.host.deps.deriveA2uiSurfacesFromSnapshotImpl?.(
          this.host.sessionSnapshotProjector.getSnapshot(),
        ),
      );
    }
    return this.a2uiSurfaceManager;
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
        emitProviderCatalog: async () => await this.getProviderCatalogManager().emitProviderCatalog(),
        refreshProviderStatus: async (opts) =>
          await this.getProviderCatalogManager().refreshProviderStatus(opts),
        getGlobalAuthPaths: () => this.host.getGlobalAuthPaths(),
        runProviderConnect: async (providerOpts) => await this.host.runProviderConnect(providerOpts),
      });
    }
    return this.providerAuthManager;
  }
}
