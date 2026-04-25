import type { MemoryScope } from "../../memoryStore";
import type {
  AgentContextMode,
  AgentInspectResult,
  AgentReasoningEffort,
  AgentRole,
  AgentSpawnContextOptions,
} from "../../shared/agents";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type { AgentConfig, HarnessContextPayload, MCPServerConfig } from "../../types";
import type { AgentWaitMode } from "../agents/types";
import type { SessionConfigPatch } from "../protocol";
import type { FileAttachment, OrderedInputPart } from "../jsonrpc/routes/shared";
import type { AgentSession } from "./AgentSession";
import type { PendingPromptReplayEvent } from "./InteractionManager";
import type { SeededSessionContext } from "./SessionContext";
import type { A2uiSurfaceManager } from "./A2uiSurfaceManager";

export class SessionSnapshotService {
  constructor(private readonly session: AgentSession) {}

  build(): SessionSnapshot {
    return this.session.buildSessionSnapshot();
  }

  peek(): SessionSnapshot {
    return this.session.peekSessionSnapshot();
  }
}

export class SessionReadModelService {
  constructor(private readonly session: AgentSession) {}

  get info() {
    return this.session.getSessionInfoEvent();
  }

  get configEvent() {
    return this.session.getSessionConfigEvent();
  }

  get publicConfig() {
    return this.session.getPublicConfig();
  }

  get id(): string {
    return this.session.id;
  }

  get isBusy(): boolean {
    return this.session.isBusy;
  }

  get messageCount(): number {
    return this.session.messageCount;
  }

  get activeTurnId(): string | null {
    return this.session.activeTurnId;
  }

  get sessionKind() {
    return this.session.sessionKind;
  }

  get parentSessionId(): string | null {
    return this.session.parentSessionId;
  }

  get role() {
    return this.session.role;
  }

  get workingDirectory(): string {
    return this.session.getWorkingDirectory();
  }

  get enableMcp(): boolean {
    return this.session.getEnableMcp();
  }

  get enableMemory(): boolean {
    return this.session.getEnableMemory();
  }

  get memoryRequireApproval(): boolean {
    return this.session.getMemoryRequireApproval();
  }

  getLatestAssistantText(): string | undefined {
    return this.session.getLatestAssistantText();
  }

  isAgentOf(parentSessionId: string): boolean {
    return this.session.isAgentOf(parentSessionId);
  }

  getSessionDepth(): number {
    return this.session.getSessionDepth();
  }
}

export class SessionReplayService {
  constructor(private readonly session: AgentSession) {}

  beginDisconnectedReplayBuffer(): void {
    this.session.beginDisconnectedReplayBuffer();
  }

  ensureDisconnectedReplayBuffer(): void {
    this.session.ensureDisconnectedReplayBuffer();
  }

  drainDisconnectedReplayEvents() {
    return this.session.drainDisconnectedReplayEvents();
  }

  getPendingPromptEventsForReplay(): ReadonlyArray<PendingPromptReplayEvent> {
    return this.session.getPendingPromptEventsForReplay();
  }
}

export class SessionTurnService {
  constructor(private readonly session: AgentSession) {}

  get activeTurnId(): string | null {
    return this.session.activeTurnId;
  }

  async sendUserMessage(
    text: string,
    clientMessageId?: string,
    displayText?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ): Promise<void> {
    await this.session.sendUserMessage(text, clientMessageId, displayText, attachments, inputParts);
  }

  async sendSteerMessage(
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ): Promise<void> {
    await this.session.sendSteerMessage(
      text,
      expectedTurnId,
      clientMessageId,
      attachments,
      inputParts,
    );
  }

  cancel(opts?: { includeSubagents?: boolean }): void {
    this.session.cancel(opts);
  }
}

export class SessionSettingsService {
  constructor(private readonly session: AgentSession) {}

  get publicConfig() {
    return this.session.getPublicConfig();
  }

  get configEvent() {
    return this.session.getSessionConfigEvent();
  }

  get enableMcp(): boolean {
    return this.session.getEnableMcp();
  }

  get enableMemory(): boolean {
    return this.session.getEnableMemory();
  }

  get memoryRequireApproval(): boolean {
    return this.session.getMemoryRequireApproval();
  }

  get backupsEnabled(): boolean {
    return this.session.getBackupsEnabled();
  }

  setTitle(title: string): void {
    this.session.setSessionTitle(title);
  }

  async setModel(modelIdRaw: string, providerRaw?: AgentConfig["provider"]): Promise<void> {
    await this.session.setModel(modelIdRaw, providerRaw);
  }

  async setConfig(patch: SessionConfigPatch): Promise<void> {
    await this.session.setConfig(patch);
  }

  async applyDefaults(opts: {
    provider?: AgentConfig["provider"];
    model?: string;
    enableMcp?: boolean;
    config?: SessionConfigPatch;
  }): Promise<void> {
    await this.session.applySessionDefaults(opts);
  }

  getHarnessContext(): void {
    this.session.getHarnessContext();
  }

  setHarnessContext(context: HarnessContextPayload): void {
    this.session.setHarnessContext(context);
  }

  getSessionUsage(): void {
    this.session.getSessionUsage();
  }

  setSessionUsageBudget(warnAtUsd?: number | null, stopAtUsd?: number | null): void {
    this.session.setSessionUsageBudget(warnAtUsd, stopAtUsd);
  }
}

export class SessionProviderService {
  constructor(private readonly session: AgentSession) {}

  async emitCatalog(): Promise<void> {
    await this.session.emitProviderCatalog();
  }

  emitAuthMethods(): void {
    this.session.emitProviderAuthMethods();
  }

  async refreshStatus(opts: { refreshBedrockDiscovery?: boolean } = {}): Promise<void> {
    await this.session.refreshProviderStatus(opts);
  }

  async authorizeAuth(provider: AgentConfig["provider"], methodId: string): Promise<void> {
    await this.session.authorizeProviderAuth(provider, methodId);
  }

  async logoutAuth(provider: AgentConfig["provider"]): Promise<void> {
    await this.session.logoutProviderAuth(provider);
  }

  async callbackAuth(
    provider: AgentConfig["provider"],
    methodId: string,
    code?: string,
  ): Promise<void> {
    await this.session.callbackProviderAuth(provider, methodId, code);
  }

  async setApiKey(
    provider: AgentConfig["provider"],
    methodId: string,
    apiKey: string,
  ): Promise<void> {
    await this.session.setProviderApiKey(provider, methodId, apiKey);
  }

  async setConfig(
    provider: AgentConfig["provider"],
    methodId: string,
    values: Record<string, string>,
  ): Promise<void> {
    await this.session.setProviderConfig(provider, methodId, values);
  }

  async copyApiKey(
    provider: AgentConfig["provider"],
    sourceProvider: AgentConfig["provider"],
  ): Promise<void> {
    await this.session.copyProviderApiKey(provider, sourceProvider);
  }
}

export class SessionMcpService {
  constructor(private readonly session: AgentSession) {}

  async emitServers(): Promise<void> {
    await this.session.emitMcpServers();
  }

  async upsert(server: MCPServerConfig, previousName?: string): Promise<void> {
    await this.session.upsertMcpServer(server, previousName);
  }

  async delete(name: string): Promise<void> {
    await this.session.deleteMcpServer(name);
  }

  async validate(name: string): Promise<void> {
    await this.session.validateMcpServer(name);
  }

  async authorizeAuth(name: string): Promise<void> {
    await this.session.authorizeMcpServerAuth(name);
  }

  async callbackAuth(name: string, code?: string): Promise<void> {
    await this.session.callbackMcpServerAuth(name, code);
  }

  async setApiKey(name: string, apiKey: string): Promise<void> {
    await this.session.setMcpServerApiKey(name, apiKey);
  }

  async migrateLegacyServers(scope: "workspace" | "user"): Promise<void> {
    await this.session.migrateLegacyMcpServers(scope);
  }
}

export class SessionMemoryService {
  constructor(private readonly session: AgentSession) {}

  async list(scope?: MemoryScope): Promise<void> {
    await this.session.emitMemories(scope);
  }

  async upsert(scope: MemoryScope, id: string | undefined, content: string): Promise<void> {
    await this.session.upsertMemory(scope, id, content);
  }

  async delete(scope: MemoryScope, id: string): Promise<void> {
    await this.session.deleteMemory(scope, id);
  }
}

export class SessionSkillService {
  constructor(private readonly session: AgentSession) {}

  listTools(): void {
    this.session.listTools();
  }

  async listCommands(): Promise<void> {
    await this.session.listCommands();
  }

  async executeCommand(name: string, argumentsText = "", clientMessageId?: string): Promise<void> {
    await this.session.executeCommand(name, argumentsText, clientMessageId);
  }

  async getCatalog(): Promise<void> {
    await this.session.getSkillsCatalog();
  }

  async list(): Promise<void> {
    await this.session.listSkills();
  }

  async read(skillName: string): Promise<void> {
    await this.session.readSkill(skillName);
  }

  async disable(skillName: string): Promise<void> {
    await this.session.disableSkill(skillName);
  }

  async enable(skillName: string): Promise<void> {
    await this.session.enableSkill(skillName);
  }

  async delete(skillName: string): Promise<void> {
    await this.session.deleteSkill(skillName);
  }

  async getInstallation(installationId: string): Promise<void> {
    await this.session.getSkillInstallation(installationId);
  }

  async previewInstall(sourceInput: string, targetScope: "project" | "global"): Promise<void> {
    await this.session.previewSkillInstall(sourceInput, targetScope);
  }

  async install(sourceInput: string, targetScope: "project" | "global"): Promise<void> {
    await this.session.installSkills(sourceInput, targetScope);
  }

  async enableInstallation(installationId: string): Promise<void> {
    await this.session.enableSkillInstallation(installationId);
  }

  async disableInstallation(installationId: string): Promise<void> {
    await this.session.disableSkillInstallation(installationId);
  }

  async deleteInstallation(installationId: string): Promise<void> {
    await this.session.deleteSkillInstallation(installationId);
  }

  async copyInstallation(installationId: string, targetScope: "project" | "global"): Promise<void> {
    await this.session.copySkillInstallation(installationId, targetScope);
  }

  async checkInstallationUpdate(installationId: string): Promise<void> {
    await this.session.checkSkillInstallationUpdate(installationId);
  }

  async updateInstallation(installationId: string): Promise<void> {
    await this.session.updateSkillInstallation(installationId);
  }

  async refreshFromExternalMutation(reason?: string): Promise<void> {
    await this.session.refreshSkillStateFromExternalMutation(reason);
  }

  async refreshSystemPrompt(reason?: string): Promise<void> {
    await this.session.refreshSystemPromptWithSkills(reason);
  }
}

export class SessionPluginService {
  constructor(private readonly session: AgentSession) {}

  async getCatalog(): Promise<void> {
    await this.session.getPluginsCatalog();
  }

  async get(pluginId: string, scope?: "workspace" | "user"): Promise<void> {
    await this.session.getPlugin(pluginId, scope);
  }

  async previewInstall(sourceInput: string, targetScope: "workspace" | "user"): Promise<void> {
    await this.session.previewPluginInstall(sourceInput, targetScope);
  }

  async install(sourceInput: string, targetScope: "workspace" | "user"): Promise<void> {
    await this.session.installPlugins(sourceInput, targetScope);
  }

  async enable(pluginId: string, scope?: "workspace" | "user"): Promise<void> {
    await this.session.enablePlugin(pluginId, scope);
  }

  async disable(pluginId: string, scope?: "workspace" | "user"): Promise<void> {
    await this.session.disablePlugin(pluginId, scope);
  }
}

export class SessionAgentService {
  constructor(private readonly session: AgentSession) {}

  async create(
    opts: AgentSpawnContextOptions & {
      message: string;
      role?: AgentRole;
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
    },
  ): Promise<void> {
    await this.session.createAgentSession(opts);
  }

  async list(): Promise<void> {
    await this.session.listAgentSessions();
  }

  async sendInput(agentId: string, message: string, interrupt?: boolean): Promise<void> {
    await this.session.sendAgentInput(agentId, message, interrupt);
  }

  async wait(agentIds: string[], timeoutMs?: number, mode?: AgentWaitMode): Promise<void> {
    await this.session.waitForAgents(agentIds, timeoutMs, mode);
  }

  async inspect(agentId: string): Promise<AgentInspectResult> {
    return await this.session.inspectAgent(agentId);
  }

  async resume(agentId: string): Promise<void> {
    await this.session.resumeAgent(agentId);
  }

  async close(agentId: string): Promise<void> {
    await this.session.closeAgent(agentId);
  }
}

export class SessionBackupService {
  constructor(private readonly session: AgentSession) {}

  async listWorkspaceBackups(): Promise<void> {
    await this.session.listWorkspaceBackups();
  }

  async createWorkspaceCheckpoint(targetSessionId: string): Promise<void> {
    await this.session.createWorkspaceBackupCheckpoint(targetSessionId);
  }

  async restoreWorkspaceBackup(targetSessionId: string, checkpointId?: string): Promise<void> {
    await this.session.restoreWorkspaceBackup(targetSessionId, checkpointId);
  }

  async deleteWorkspaceCheckpoint(targetSessionId: string, checkpointId: string): Promise<void> {
    await this.session.deleteWorkspaceBackupCheckpoint(targetSessionId, checkpointId);
  }

  async deleteWorkspaceEntry(targetSessionId: string): Promise<void> {
    await this.session.deleteWorkspaceBackupEntry(targetSessionId);
  }

  async getWorkspaceDelta(targetSessionId: string, checkpointId: string): Promise<void> {
    await this.session.getWorkspaceBackupDelta(targetSessionId, checkpointId);
  }

  async getState(): Promise<void> {
    await this.session.getSessionBackupState();
  }

  async createManualCheckpoint(): Promise<void> {
    await this.session.createManualSessionCheckpoint();
  }

  async restoreSession(checkpointId?: string): Promise<void> {
    await this.session.restoreSessionBackup(checkpointId);
  }

  async deleteSessionCheckpoint(checkpointId: string): Promise<void> {
    await this.session.deleteSessionCheckpoint(checkpointId);
  }

  async reloadStateFromDisk(): Promise<void> {
    await this.session.reloadSessionBackupStateFromDisk();
  }
}

export class SessionA2uiService {
  constructor(private readonly session: AgentSession) {}

  get enabled(): boolean {
    return this.session.getSessionConfigEvent().config.enableA2ui === true;
  }

  validateAction(opts: {
    surfaceId: string;
    componentId: string;
  }): ReturnType<A2uiSurfaceManager["validateAction"]> {
    return this.session.validateA2uiAction(opts);
  }
}

export class SessionFileService {
  constructor(private readonly session: AgentSession) {}

  async upload(filename: string, contentBase64: string): Promise<void> {
    await this.session.uploadFile(filename, contentBase64);
  }
}

export class SessionLifecycleService {
  constructor(private readonly session: AgentSession) {}

  reset(): void {
    this.session.reset();
  }

  async delete(targetSessionId: string): Promise<void> {
    await this.session.deleteSession(targetSessionId);
  }

  handleAskResponse(requestId: string, answer: string): void {
    this.session.handleAskResponse(requestId, answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean): void {
    this.session.handleApprovalResponse(requestId, approved);
  }

  async closeForHistory(): Promise<void> {
    await this.session.closeForHistory();
  }

  async waitForPersistenceIdle(): Promise<void> {
    await this.session.waitForPersistenceIdle();
  }

  reopenForHistory(): void {
    this.session.reopenForHistory();
  }

  dispose(reason: string): void {
    this.session.dispose(reason);
  }

  getMessages(offset = 0, limit = 100): void {
    this.session.getMessages(offset, limit);
  }

  buildForkContextSeed(): SeededSessionContext {
    return this.session.buildForkContextSeed();
  }

  buildContextSeed(opts: {
    contextMode: Exclude<AgentContextMode, "full">;
    briefing?: string;
    includeParentTodos?: boolean;
    includeHarnessContext?: boolean;
  }): SeededSessionContext {
    return this.session.buildContextSeed(opts);
  }
}

export class SessionRuntime {
  readonly snapshot: SessionSnapshotService;
  readonly read: SessionReadModelService;
  readonly replay: SessionReplayService;
  readonly turns: SessionTurnService;
  readonly settings: SessionSettingsService;
  readonly provider: SessionProviderService;
  readonly mcp: SessionMcpService;
  readonly memory: SessionMemoryService;
  readonly skills: SessionSkillService;
  readonly plugins: SessionPluginService;
  readonly agents: SessionAgentService;
  readonly backups: SessionBackupService;
  readonly a2ui: SessionA2uiService;
  readonly files: SessionFileService;
  readonly lifecycle: SessionLifecycleService;

  constructor(readonly session: AgentSession) {
    this.snapshot = new SessionSnapshotService(session);
    this.read = new SessionReadModelService(session);
    this.replay = new SessionReplayService(session);
    this.turns = new SessionTurnService(session);
    this.settings = new SessionSettingsService(session);
    this.provider = new SessionProviderService(session);
    this.mcp = new SessionMcpService(session);
    this.memory = new SessionMemoryService(session);
    this.skills = new SessionSkillService(session);
    this.plugins = new SessionPluginService(session);
    this.agents = new SessionAgentService(session);
    this.backups = new SessionBackupService(session);
    this.a2ui = new SessionA2uiService(session);
    this.files = new SessionFileService(session);
    this.lifecycle = new SessionLifecycleService(session);
  }

  get id(): string {
    return this.session.id;
  }
}
