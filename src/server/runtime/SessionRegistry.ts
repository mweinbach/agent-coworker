import type { runTurn as runTurnFn } from "../../agent";
import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../../connect";
import type { loadAgentPrompt as loadAgentPromptFn } from "../../prompt";
import { getProviderCatalog } from "../../providers/connectionCatalog";
import type { SessionKind } from "../../shared/agents";
import type { AgentConfig } from "../../types";
import { defaultRuntimeNameForProvider } from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";
import type { AgentControl } from "../agents/AgentControl";
import { createSessionEventCapture } from "../jsonrpc/sessionEventCapture";
import type { SessionEvent } from "../protocol";
import type { AgentSession } from "../session/AgentSession";
import type {
  SeededSessionContext,
  SessionDependencies,
  SessionInfoState,
} from "../session/SessionContext";
import type { PersistedSessionRecord, SessionDb } from "../sessionDb";
import type { SessionBinding } from "../startServer/types";
import type { WorkspaceBackupService } from "../workspaceBackups";
import {
  mergeConfigPatch,
  persistProjectConfigPatch,
  type ProjectConfigPatch,
} from "./ConfigPatchStore";
import type { ThreadJournal } from "./ThreadJournal";

let agentSessionModule: typeof import("../session/AgentSession") | null = null;
let sessionSnapshotProjectorModule: typeof import("../session/SessionSnapshotProjector") | null =
  null;

const loadAgentSessionModule = (): typeof import("../session/AgentSession") => {
  agentSessionModule ??=
    require("../session/AgentSession") as typeof import("../session/AgentSession");
  return agentSessionModule;
};

const loadSessionSnapshotProjectorModule =
  (): typeof import("../session/SessionSnapshotProjector") => {
    sessionSnapshotProjectorModule ??=
      require("../session/SessionSnapshotProjector") as typeof import("../session/SessionSnapshotProjector");
    return sessionSnapshotProjectorModule;
  };

export type SessionRegistryOptions = {
  config: AgentConfig;
  system: string;
  discoveredSkills: Array<{ name: string; description: string }>;
  yolo?: boolean;
  homedir?: string;
  connectProviderImpl?: typeof connectModelProvider;
  getAiCoworkerPathsImpl: typeof getAiCoworkerPaths;
  runTurnImpl?: typeof runTurnFn;
  sessionDb: SessionDb;
  threadJournal: ThreadJournal;
  loadAgentPrompt: typeof loadAgentPromptFn;
  setConfig: (config: AgentConfig) => void;
  refreshSkillsAcrossWorkspaceSessions: (options: {
    workingDirectory: string;
    sourceSessionId: string;
    allWorkspaces?: boolean;
  }) => Promise<void>;
};

export class SessionRegistry {
  readonly sessionBindings = new Map<string, SessionBinding>();
  readonly sessionIdleSince = new Map<string, number>();
  readonly sessionEventCapture = createSessionEventCapture({
    addBindingSink: (binding, sinkId, sink) => this.addBindingSink(binding, sinkId, sink),
    removeBindingSink: (binding, sinkId) => this.removeBindingSink(binding, sinkId),
  });

  private config: AgentConfig;
  private workspaceBackupService: WorkspaceBackupService | null = null;
  private agentControl: AgentControl | null = null;

  constructor(private readonly options: SessionRegistryOptions) {
    this.config = options.config;
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  syncConfig(config: AgentConfig): void {
    this.config = config;
    this.options.setConfig(config);
  }

  addBindingSink(binding: SessionBinding, sinkId: string, sink: (evt: SessionEvent) => void): void {
    binding.sinks.set(sinkId, sink);
    if (binding.session && !sinkId.startsWith("journal:")) {
      this.sessionIdleSince.delete(binding.session.id);
    }
  }

  removeBindingSink(binding: SessionBinding, sinkId: string): void {
    binding.sinks.delete(sinkId);
    if (binding.session && binding.sinks.size === 0) {
      this.sessionIdleSince.set(binding.session.id, Date.now());
    }
  }

  countLiveConnectionSinks(binding: SessionBinding): number {
    return [...binding.sinks.keys()].filter((sinkId) => !sinkId.startsWith("journal:")).length;
  }

  disposeBinding(binding: SessionBinding, reason: string): void {
    if (!binding.session) return;
    try {
      binding.session.cancel();
    } catch {
      // ignore
    }
    try {
      binding.session.dispose(reason);
    } catch {
      // ignore
    }
    try {
      binding.socket?.close();
    } catch {
      // ignore
    }
  }

  createJsonRpcThreadSession(
    cwd: string,
    provider?: AgentConfig["provider"],
    model?: string,
  ): AgentSession {
    const binding: SessionBinding = { session: null, socket: null, sinks: new Map() };
    const threadConfig: AgentConfig = {
      ...this.config,
      workingDirectory: cwd,
      ...(provider ? { provider, runtime: defaultRuntimeNameForProvider(provider) } : {}),
      ...(model ? { model } : {}),
    };
    const built = this.buildSession(binding, undefined, {
      config: threadConfig,
    });
    binding.session = built.session;
    this.options.threadJournal.ensureSink(binding, built.session.id, (sinkBinding, sinkId, sink) =>
      this.addBindingSink(sinkBinding, sinkId, sink),
    );
    this.sessionBindings.set(built.session.id, binding);
    return built.session;
  }

  loadThreadBinding(threadId: string): SessionBinding | null {
    const existing = this.sessionBindings.get(threadId);
    if (existing?.session) {
      this.options.threadJournal.ensureSink(existing, threadId, (binding, sinkId, sink) =>
        this.addBindingSink(binding, sinkId, sink),
      );
      return existing;
    }
    const persisted = this.options.sessionDb.getSessionRecord(threadId);
    if (!persisted) return null;
    const binding: SessionBinding = { session: null, socket: null, sinks: new Map() };
    const built = this.buildSession(binding, threadId);
    binding.session = built.session;
    this.options.threadJournal.ensureSink(binding, built.session.id, (sinkBinding, sinkId, sink) =>
      this.addBindingSink(sinkBinding, sinkId, sink),
    );
    this.sessionBindings.set(built.session.id, binding);
    return binding;
  }

  readThreadSnapshot(threadId: string): ReturnType<AgentSession["buildSessionSnapshot"]> | null {
    const liveSnapshot = this.sessionBindings.get(threadId)?.session?.peekSessionSnapshot() ?? null;
    if (liveSnapshot) return liveSnapshot;
    const persisted = this.options.sessionDb.getSessionRecord(threadId);
    if (!persisted) return null;
    return this.loadInitialSessionSnapshot(persisted);
  }

  listLiveRoot(options: { cwd?: string } = {}): AgentSession[] {
    return [...this.sessionBindings.values()]
      .flatMap((binding) => (binding.session ? [binding.session] : []))
      .filter(
        (session) =>
          session.sessionKind === "root" &&
          (!options.cwd || session.getWorkingDirectory() === options.cwd),
      );
  }

  createWorkspaceControlBinding(controlConfig: AgentConfig): SessionBinding {
    const binding: SessionBinding = {
      session: null,
      socket: null,
      sinks: new Map(),
    };
    const built = this.buildSession(binding, undefined, {
      config: controlConfig,
      persistenceEnabled: false,
    });
    binding.session = built.session;
    return binding;
  }

  evictIdleSessionBindings(idleTimeoutMs: number): void {
    const now = Date.now();
    for (const [sessionId, binding] of this.sessionBindings) {
      if (binding.session && binding.sinks.size === 0 && !binding.session.isBusy) {
        const idleSince = this.sessionIdleSince.get(sessionId) ?? 0;
        if (idleSince > 0 && now - idleSince > idleTimeoutMs) {
          binding.session.dispose("idle eviction");
          this.sessionBindings.delete(sessionId);
          this.sessionIdleSince.delete(sessionId);
        }
      }
    }
  }

  async disposeAll(reason: string): Promise<void> {
    const persistenceFlushes: Promise<void>[] = [];
    for (const [id, binding] of this.sessionBindings) {
      if (!binding.session) {
        this.sessionBindings.delete(id);
        this.sessionIdleSince.delete(id);
        continue;
      }
      try {
        binding.session.dispose(reason);
      } catch {
        // ignore
      }
      try {
        persistenceFlushes.push(binding.session.waitForPersistenceIdle());
      } catch {
        // ignore
      }
      try {
        binding.socket?.close();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.allSettled(persistenceFlushes);
    this.sessionBindings.clear();
    this.sessionIdleSince.clear();
  }

  private buildSessionCommon(
    binding: SessionBinding,
    sessionKind: SessionKind = "root",
    currentConfig: AgentConfig = this.config,
    syncConfig: (nextConfig: AgentConfig) => void = (nextConfig) => {
      this.syncConfig(nextConfig);
    },
  ): Partial<SessionDependencies> & {
    discoveredSkills: Array<{ name: string; description: string }>;
    yolo?: boolean;
    sessionDb: SessionDb;
    emit: (evt: SessionEvent) => void;
  } {
    const emit = (evt: SessionEvent) => {
      for (const sink of binding.sinks.values()) {
        try {
          sink(evt);
        } catch {
          // ignore individual sink failures
        }
      }
    };

    return {
      discoveredSkills: this.options.discoveredSkills,
      yolo: this.options.yolo,
      connectProviderImpl: this.options.connectProviderImpl,
      getAiCoworkerPathsImpl: this.options.getAiCoworkerPathsImpl,
      runTurnImpl: this.options.runTurnImpl,
      persistModelSelectionImpl:
        sessionKind === "root"
          ? async (selection) => {
              await persistProjectConfigPatch(
                currentConfig.projectAgentDir,
                selection,
                currentConfig.providerOptions,
              );
              currentConfig = mergeConfigPatch(currentConfig, selection);
              syncConfig(currentConfig);
            }
          : undefined,
      persistProjectConfigPatchImpl:
        sessionKind === "root"
          ? async (patch: ProjectConfigPatch) => {
              await persistProjectConfigPatch(
                currentConfig.projectAgentDir,
                patch,
                currentConfig.providerOptions,
              );
              currentConfig = mergeConfigPatch(currentConfig, patch);
              syncConfig(currentConfig);
            }
          : undefined,
      sessionDb: this.options.sessionDb,
      emit,
      createAgentSessionImpl: async (agentOpts) => await this.getAgentControl().spawn(agentOpts),
      listAgentSessionsImpl: async (parentSessionId) =>
        await this.getAgentControl().list(parentSessionId),
      sendAgentInputImpl: async (agentOpts) => await this.getAgentControl().sendInput(agentOpts),
      waitForAgentImpl: async (agentOpts) => await this.getAgentControl().wait(agentOpts),
      inspectAgentImpl: async (agentOpts) => await this.getAgentControl().inspect(agentOpts),
      resumeAgentImpl: async (agentOpts) => await this.getAgentControl().resume(agentOpts),
      closeAgentImpl: async (agentOpts) => await this.getAgentControl().close(agentOpts),
      cancelAgentSessionsImpl: (parentSessionId) =>
        this.getAgentControl().cancelAll(parentSessionId),
      deleteSessionImpl: async (opts) => {
        void opts.requesterSessionId;
        const liveChildIds = [...this.sessionBindings.values()]
          .map((childBinding) => childBinding.session)
          .filter(
            (session): session is AgentSession =>
              !!session && session.isAgentOf(opts.targetSessionId),
          )
          .map((session) => session.id);
        const persistedChildIds = this.options.sessionDb
          .listAgentSessions(opts.targetSessionId)
          .map((summary) => summary.agentId);
        const sessionIdsToDispose = new Set([
          opts.targetSessionId,
          ...persistedChildIds,
          ...liveChildIds,
        ]);

        for (const sessionId of sessionIdsToDispose) {
          const candidateBinding = this.sessionBindings.get(sessionId);
          if (!candidateBinding?.session) continue;
          this.disposeBinding(candidateBinding, `session ${opts.targetSessionId} deleted`);
          this.sessionBindings.delete(sessionId);
          this.sessionIdleSince.delete(sessionId);
        }

        await this.options.sessionDb.deleteSession(opts.targetSessionId);
      },
      listWorkspaceBackupsImpl: async (opts) =>
        await this.getWorkspaceBackupService().listWorkspaceBackups(opts.workingDirectory),
      createWorkspaceBackupCheckpointImpl: async (opts) =>
        await this.getWorkspaceBackupService().createCheckpoint(
          opts.workingDirectory,
          opts.targetSessionId,
        ),
      restoreWorkspaceBackupImpl: async (opts) =>
        await this.getWorkspaceBackupService().restoreBackup(
          opts.workingDirectory,
          opts.targetSessionId,
          opts.checkpointId,
        ),
      deleteWorkspaceBackupCheckpointImpl: async (opts) =>
        await this.getWorkspaceBackupService().deleteCheckpoint(
          opts.workingDirectory,
          opts.targetSessionId,
          opts.checkpointId,
        ),
      deleteWorkspaceBackupEntryImpl: async (opts) =>
        await this.getWorkspaceBackupService().deleteEntry(
          opts.workingDirectory,
          opts.targetSessionId,
        ),
      getWorkspaceBackupDeltaImpl: async (opts) =>
        await this.getWorkspaceBackupService().getCheckpointDelta(
          opts.workingDirectory,
          opts.targetSessionId,
          opts.checkpointId,
        ),
      getLiveSessionSnapshotImpl: (sessionId) =>
        this.sessionBindings.get(sessionId)?.session?.peekSessionSnapshot() ?? null,
      getLiveSessionWorkingDirectoryImpl: (sessionId) =>
        this.sessionBindings.get(sessionId)?.session?.getWorkingDirectory() ?? null,
      buildLegacySessionSnapshotImpl: (record: PersistedSessionRecord) =>
        loadSessionSnapshotProjectorModule().createLegacySessionSnapshot(record),
      getSkillMutationBlockReasonImpl: (workingDirectory) => {
        const busySession = [...this.sessionBindings.values()]
          .map((candidate) => candidate.session)
          .find(
            (candidate): candidate is AgentSession =>
              !!candidate &&
              candidate.getWorkingDirectory() === workingDirectory &&
              candidate.isBusy,
          );
        if (!busySession) {
          return null;
        }
        return "Skill mutations are blocked while another session in this workspace is running.";
      },
      refreshSkillsAcrossWorkspaceSessionsImpl: this.options.refreshSkillsAcrossWorkspaceSessions,
    };
  }

  private buildSession(
    binding: SessionBinding,
    persistedSessionId?: string,
    overrides?: {
      config?: AgentConfig;
      persistenceEnabled?: boolean;
      system?: string;
      seedContext?: SeededSessionContext;
      sessionInfoPatch?: Partial<SessionInfoState>;
    },
  ): Partial<SessionDependencies> & {
    session: AgentSession;
    isResume: boolean;
    resumedFromStorage: boolean;
  } {
    if (persistedSessionId) {
      const persisted = this.options.sessionDb.getSessionRecord(persistedSessionId);
      if (persisted) {
        const common = this.buildSessionCommon(binding, persisted.sessionKind);
        const { AgentSession } = loadAgentSessionModule();
        const session = AgentSession.fromPersisted({
          persisted,
          initialSessionSnapshot: this.loadInitialSessionSnapshot(persisted),
          baseConfig: { ...this.config },
          ...common,
        });
        return { session, isResume: true, resumedFromStorage: true };
      }
    }

    const sessionKind = overrides?.sessionInfoPatch?.sessionKind ?? "root";
    let sessionConfig = { ...(overrides?.config ?? this.config) };
    const common = this.buildSessionCommon(binding, sessionKind, sessionConfig, (nextConfig) => {
      sessionConfig = nextConfig;
    });
    const { AgentSession } = loadAgentSessionModule();
    const session = new AgentSession({
      config: sessionConfig,
      system: overrides?.system ?? this.options.system,
      persistenceEnabled: overrides?.persistenceEnabled,
      ...(overrides?.seedContext ? { seedContext: overrides.seedContext } : {}),
      ...(overrides?.sessionInfoPatch ? { sessionInfoPatch: overrides.sessionInfoPatch } : {}),
      ...common,
    });
    return { session, isResume: false, resumedFromStorage: false };
  }

  private loadInitialSessionSnapshot(persisted: PersistedSessionRecord) {
    try {
      const snapshot = this.options.sessionDb.getSessionSnapshot(persisted.sessionId);
      if (!snapshot) {
        return loadSessionSnapshotProjectorModule().createLegacySessionSnapshot(persisted);
      }
      if (snapshot.lastEventSeq < persisted.lastEventSeq) {
        return loadSessionSnapshotProjectorModule().createLegacySessionSnapshot(persisted);
      }
      return snapshot;
    } catch {
      return loadSessionSnapshotProjectorModule().createLegacySessionSnapshot(persisted);
    }
  }

  private async getConnectedProviders(
    parentConfig: AgentConfig,
  ): Promise<AgentConfig["provider"][]> {
    return (
      await getProviderCatalog({ homedir: resolveAuthHomeDir(parentConfig, this.options.homedir) })
    ).connected as AgentConfig["provider"][];
  }

  private getAgentControl(): AgentControl {
    if (this.agentControl) {
      return this.agentControl;
    }
    const { AgentControl } =
      require("../agents/AgentControl") as typeof import("../agents/AgentControl");
    this.agentControl = new AgentControl({
      sessionBindings: this.sessionBindings,
      sessionDb: this.options.sessionDb,
      getConnectedProviders: async (parentConfig) => await this.getConnectedProviders(parentConfig),
      buildSession: (binding, persistedSessionId, overrides) =>
        this.buildSession(binding, persistedSessionId, overrides),
      loadAgentPrompt: this.options.loadAgentPrompt,
      disposeBinding: (binding, reason) => this.disposeBinding(binding, reason),
      emitParentAgentStatus: (parentSessionId, agent) => {
        const parentBinding = this.sessionBindings.get(parentSessionId);
        if (!parentBinding) return;
        for (const sink of parentBinding.sinks.values()) {
          try {
            sink({ type: "agent_status", sessionId: parentSessionId, agent });
          } catch {
            // ignore
          }
        }
      },
      emitParentLog: (parentSessionId, line) => {
        const parentBinding = this.sessionBindings.get(parentSessionId);
        if (!parentBinding) return;
        for (const sink of parentBinding.sinks.values()) {
          try {
            sink({ type: "log", sessionId: parentSessionId, line });
          } catch {
            // ignore
          }
        }
      },
    });
    return this.agentControl;
  }

  private getWorkspaceBackupService(): WorkspaceBackupService {
    if (this.workspaceBackupService) {
      return this.workspaceBackupService;
    }
    const { WorkspaceBackupService } =
      require("../workspaceBackups") as typeof import("../workspaceBackups");
    this.workspaceBackupService = new WorkspaceBackupService({
      homedir: this.options.homedir,
      sessionDb: this.options.sessionDb,
      getLiveSession: (sessionId) => {
        const session = this.sessionBindings.get(sessionId)?.session;
        if (!session) return null;
        const info = session.getSessionInfoEvent();
        return {
          sessionId: session.id,
          title: info.title,
          provider: info.provider,
          model: info.model,
          updatedAt: info.updatedAt,
          status: session.persistenceStatus,
          busy: session.isBusy,
          setBackupsEnabledOverride: async (enabled) => {
            await session.setBackupsEnabledOverride(enabled);
          },
          reloadBackupStateFromDisk: async () => {
            await session.reloadSessionBackupStateFromDisk();
          },
        };
      },
    });
    return this.workspaceBackupService;
  }
}
