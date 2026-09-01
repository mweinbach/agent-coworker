import type { AgentSession } from "./AgentSession";

type SessionMethodName = {
  [Name in keyof AgentSession]: AgentSession[Name] extends (...args: never[]) => unknown
    ? Name
    : never;
}[keyof AgentSession];

type SessionMethod<Name extends SessionMethodName> = Extract<
  AgentSession[Name],
  (...args: never[]) => unknown
>;

function forward<Name extends SessionMethodName>(
  session: AgentSession,
  methodName: Name,
): SessionMethod<Name> {
  return ((...args: Parameters<SessionMethod<Name>>) =>
    Reflect.apply(
      session[methodName] as SessionMethod<Name>,
      session,
      args,
    )) as SessionMethod<Name>;
}

function createSessionSnapshotService(session: AgentSession) {
  return {
    build: forward(session, "buildSessionSnapshot"),
    peek: forward(session, "peekSessionSnapshot"),
  };
}

export type SessionSnapshotService = ReturnType<typeof createSessionSnapshotService>;

function createSessionReadModelService(session: AgentSession) {
  return {
    get info() {
      return session.getSessionInfoEvent();
    },
    get configEvent() {
      return session.getSessionConfigEvent();
    },
    get publicConfig() {
      return session.getPublicConfig();
    },
    get id() {
      return session.id;
    },
    get isBusy() {
      return session.isBusy;
    },
    get messageCount() {
      return session.messageCount;
    },
    get activeTurnId() {
      return session.activeTurnId;
    },
    get sessionKind() {
      return session.sessionKind;
    },
    get parentSessionId() {
      return session.parentSessionId;
    },
    get role() {
      return session.role;
    },
    get workingDirectory() {
      return session.getWorkingDirectory();
    },
    get enableMcp() {
      return session.getEnableMcp();
    },
    get enableMemory() {
      return session.getEnableMemory();
    },
    get memoryRequireApproval() {
      return session.getMemoryRequireApproval();
    },
    getLatestAssistantText: forward(session, "getLatestAssistantText"),
    isAgentOf: forward(session, "isAgentOf"),
    getSessionDepth: forward(session, "getSessionDepth"),
  };
}

export type SessionReadModelService = ReturnType<typeof createSessionReadModelService>;

function createSessionReplayService(session: AgentSession) {
  return {
    beginDisconnectedReplayBuffer: forward(session, "beginDisconnectedReplayBuffer"),
    ensureDisconnectedReplayBuffer: forward(session, "ensureDisconnectedReplayBuffer"),
    drainDisconnectedReplayEvents: forward(session, "drainDisconnectedReplayEvents"),
    getPendingPromptEventsForReplay: forward(session, "getPendingPromptEventsForReplay"),
  };
}

export type SessionReplayService = ReturnType<typeof createSessionReplayService>;

function createSessionTurnService(session: AgentSession) {
  return {
    get activeTurnId() {
      return session.activeTurnId;
    },
    sendUserMessage: forward(session, "sendUserMessage"),
    claimUserMessage: forward(session, "claimUserMessage"),
    rejectUserMessageClaim: forward(session, "rejectUserMessageClaim"),
    claimSteer: forward(session, "claimSteer"),
    rejectSteerClaim: forward(session, "rejectSteerClaim"),
    sendSteerMessage: forward(session, "sendSteerMessage"),
    cancel: forward(session, "cancel"),
    cancelAndWaitForSettlement: forward(session, "cancelAndWaitForSettlement"),
  };
}

export type SessionTurnService = ReturnType<typeof createSessionTurnService>;

function createSessionSettingsService(session: AgentSession) {
  return {
    get publicConfig() {
      return session.getPublicConfig();
    },
    get configEvent() {
      return session.getSessionConfigEvent();
    },
    get enableMcp() {
      return session.getEnableMcp();
    },
    get enableMemory() {
      return session.getEnableMemory();
    },
    get memoryRequireApproval() {
      return session.getMemoryRequireApproval();
    },
    get backupsEnabled() {
      return session.getBackupsEnabled();
    },
    setTitle: forward(session, "setSessionTitle"),
    setModel: forward(session, "setModel"),
    setConfig: forward(session, "setConfig"),
    applyDefaults: forward(session, "applySessionDefaults"),
    getHarnessContext: forward(session, "getHarnessContext"),
    setHarnessContext: forward(session, "setHarnessContext"),
    getSessionUsage: forward(session, "getSessionUsage"),
    setSessionUsageBudget: forward(session, "setSessionUsageBudget"),
  };
}

export type SessionSettingsService = ReturnType<typeof createSessionSettingsService>;

function createSessionProviderService(session: AgentSession) {
  return {
    emitCatalog: (opts: { refresh?: boolean } = {}) => session.emitProviderCatalog(opts),
    emitAuthMethods: forward(session, "emitProviderAuthMethods"),
    refreshStatus: (opts: { refreshBedrockDiscovery?: boolean } = {}) =>
      session.refreshProviderStatus(opts),
    authorizeAuth: forward(session, "authorizeProviderAuth"),
    logoutAuth: forward(session, "logoutProviderAuth"),
    callbackAuth: forward(session, "callbackProviderAuth"),
    setApiKey: forward(session, "setProviderApiKey"),
    setConfig: forward(session, "setProviderConfig"),
    copyApiKey: forward(session, "copyProviderApiKey"),
    addCustomModel: forward(session, "addCustomProviderModel"),
    deleteCustomModel: forward(session, "deleteCustomProviderModel"),
    setModelsEnabled: forward(session, "setProviderModelsEnabled"),
    resetModelPreferences: forward(session, "resetProviderModelPreferences"),
  };
}

export type SessionProviderService = ReturnType<typeof createSessionProviderService>;

function createSessionMcpService(session: AgentSession) {
  return {
    emitServers: forward(session, "emitMcpServers"),
    upsert: forward(session, "upsertMcpServer"),
    delete: forward(session, "deleteMcpServer"),
    setEnabled: forward(session, "setMcpServerEnabled"),
    validate: forward(session, "validateMcpServer"),
    authorizeAuth: forward(session, "authorizeMcpServerAuth"),
    callbackAuth: forward(session, "callbackMcpServerAuth"),
    setApiKey: forward(session, "setMcpServerApiKey"),
  };
}

export type SessionMcpService = ReturnType<typeof createSessionMcpService>;

function createSessionMemoryService(session: AgentSession) {
  return {
    list: forward(session, "emitMemories"),
    upsert: forward(session, "upsertMemory"),
    delete: forward(session, "deleteMemory"),
    listAdvanced: forward(session, "emitAdvancedMemories"),
    upsertAdvanced: forward(session, "upsertAdvancedMemory"),
    deleteAdvanced: forward(session, "deleteAdvancedMemory"),
    generateAdvancedFromHistory: forward(session, "generateAdvancedMemoryForHistory"),
  };
}

export type SessionMemoryService = ReturnType<typeof createSessionMemoryService>;

function createSessionSkillService(session: AgentSession) {
  return {
    listTools: forward(session, "listTools"),
    listCommands: forward(session, "listCommands"),
    executeCommand: (name: string, argumentsText = "", clientMessageId?: string) =>
      session.executeCommand(name, argumentsText, clientMessageId),
    getCatalog: forward(session, "getSkillsCatalog"),
    list: forward(session, "listSkills"),
    read: forward(session, "readSkill"),
    disable: forward(session, "disableSkill"),
    enable: forward(session, "enableSkill"),
    delete: forward(session, "deleteSkill"),
    getInstallation: forward(session, "getSkillInstallation"),
    listMarketplaces: forward(session, "listMarketplaces"),
    readMarketplaceDetail: forward(session, "readMarketplaceDetail"),
    addMarketplace: forward(session, "addMarketplace"),
    removeMarketplace: forward(session, "removeMarketplace"),
    previewInstall: forward(session, "previewSkillInstall"),
    install: forward(session, "installSkills"),
    enableInstallation: forward(session, "enableSkillInstallation"),
    disableInstallation: forward(session, "disableSkillInstallation"),
    deleteInstallation: forward(session, "deleteSkillInstallation"),
    copyInstallation: forward(session, "copySkillInstallation"),
    checkInstallationUpdate: forward(session, "checkSkillInstallationUpdate"),
    updateInstallation: forward(session, "updateSkillInstallation"),
    refreshFromExternalMutation: forward(session, "refreshSkillStateFromExternalMutation"),
    refreshSystemPrompt: forward(session, "refreshSystemPromptWithSkills"),
  };
}

export type SessionSkillService = ReturnType<typeof createSessionSkillService>;

function createSessionAgentProfileService(session: AgentSession) {
  return {
    getCatalog: forward(session, "getAgentProfilesCatalog"),
    upsert: forward(session, "upsertAgentProfile"),
    delete: forward(session, "deleteAgentProfile"),
    copy: forward(session, "copyAgentProfile"),
    setWorkspaceAvailability: forward(session, "setAgentProfileWorkspaceAvailability"),
  };
}

export type SessionAgentProfileService = ReturnType<typeof createSessionAgentProfileService>;

function createSessionPluginService(session: AgentSession) {
  return {
    getCatalog: forward(session, "getPluginsCatalog"),
    get: forward(session, "getPlugin"),
    previewInstall: forward(session, "previewPluginInstall"),
    install: forward(session, "installPlugins"),
    checkUpdate: forward(session, "checkPluginUpdate"),
    update: forward(session, "updatePlugin"),
    enable: forward(session, "enablePlugin"),
    disable: forward(session, "disablePlugin"),
    delete: forward(session, "deletePlugin"),
  };
}

export type SessionPluginService = ReturnType<typeof createSessionPluginService>;

function createSessionImportService(session: AgentSession) {
  return {
    list: forward(session, "listImport"),
    plugin: forward(session, "importPlugin"),
    skill: forward(session, "importSkill"),
  };
}

export type SessionImportService = ReturnType<typeof createSessionImportService>;

function createSessionAgentService(session: AgentSession) {
  return {
    create: forward(session, "createAgentSession"),
    list: forward(session, "listAgentSessions"),
    sendInput: forward(session, "sendAgentInput"),
    wait: forward(session, "waitForAgents"),
    inspect: forward(session, "inspectAgent"),
    resume: forward(session, "resumeAgent"),
    close: forward(session, "closeAgent"),
  };
}

export type SessionAgentService = ReturnType<typeof createSessionAgentService>;

function createSessionBackupService(session: AgentSession) {
  return {
    listWorkspaceBackups: forward(session, "listWorkspaceBackups"),
    createWorkspaceCheckpoint: forward(session, "createWorkspaceBackupCheckpoint"),
    restoreWorkspaceBackup: forward(session, "restoreWorkspaceBackup"),
    deleteWorkspaceCheckpoint: forward(session, "deleteWorkspaceBackupCheckpoint"),
    deleteWorkspaceEntry: forward(session, "deleteWorkspaceBackupEntry"),
    getWorkspaceDelta: forward(session, "getWorkspaceBackupDelta"),
    getState: forward(session, "getSessionBackupState"),
    createManualCheckpoint: forward(session, "createManualSessionCheckpoint"),
    restoreSession: forward(session, "restoreSessionBackup"),
    deleteSessionCheckpoint: forward(session, "deleteSessionCheckpoint"),
    reloadStateFromDisk: forward(session, "reloadSessionBackupStateFromDisk"),
  };
}

export type SessionBackupService = ReturnType<typeof createSessionBackupService>;

function createSessionFileService(session: AgentSession) {
  return {
    upload: forward(session, "uploadFile"),
  };
}

export type SessionFileService = ReturnType<typeof createSessionFileService>;

function createSessionLifecycleService(session: AgentSession) {
  return {
    reset: forward(session, "reset"),
    delete: forward(session, "deleteSession"),
    handleAskResponse: forward(session, "handleAskResponse"),
    handleApprovalResponse: forward(session, "handleApprovalResponse"),
    closeForHistory: (opts: { closeSharedCodexClient?: boolean } = {}) =>
      session.closeForHistory(opts),
    waitForPersistenceIdle: () => session.waitForPersistenceIdle(),
    reopenForHistory: forward(session, "reopenForHistory"),
    releaseTurnResources: forward(session, "releaseTurnResources"),
    dispose: (reason: string, opts: { closeSharedCodexClient?: boolean } = {}) =>
      session.dispose(reason, opts),
    getMessages: (offset = 0, limit = 100) => session.getMessages(offset, limit),
    buildForkContextSeed: forward(session, "buildForkContextSeed"),
    buildContextSeed: forward(session, "buildContextSeed"),
  };
}

export type SessionLifecycleService = ReturnType<typeof createSessionLifecycleService>;

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
  readonly agentProfiles: SessionAgentProfileService;
  readonly plugins: SessionPluginService;
  readonly import: SessionImportService;
  readonly agents: SessionAgentService;
  readonly backups: SessionBackupService;
  readonly files: SessionFileService;
  readonly lifecycle: SessionLifecycleService;

  constructor(readonly session: AgentSession) {
    this.snapshot = createSessionSnapshotService(session);
    this.read = createSessionReadModelService(session);
    this.replay = createSessionReplayService(session);
    this.turns = createSessionTurnService(session);
    this.settings = createSessionSettingsService(session);
    this.provider = createSessionProviderService(session);
    this.mcp = createSessionMcpService(session);
    this.memory = createSessionMemoryService(session);
    this.skills = createSessionSkillService(session);
    this.agentProfiles = createSessionAgentProfileService(session);
    this.plugins = createSessionPluginService(session);
    this.import = createSessionImportService(session);
    this.agents = createSessionAgentService(session);
    this.backups = createSessionBackupService(session);
    this.files = createSessionFileService(session);
    this.lifecycle = createSessionLifecycleService(session);
  }

  get id(): string {
    return this.session.id;
  }
}
