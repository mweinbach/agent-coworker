import path from "node:path";
import type { runTurn as runTurnFn } from "../../agent";
import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../../connect";
import { isA2uiExperimentEnabled } from "../../experimental/a2ui/flags";
import type { loadAgentPrompt as loadAgentPromptFn } from "../../prompt";
import { getProviderCatalog } from "../../providers/connectionCatalog";
import type { SessionKind } from "../../shared/agents";
import {
  type TaskCreationInput,
  type TaskCreationResult,
  type TaskQuestionResumeStatus,
  taskCreationInputSchema,
} from "../../shared/tasks";
import type { AgentConfig } from "../../types";
import { defaultRuntimeNameForProvider } from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";
import { isPathInsideOneOffChatsRoot } from "../../utils/oneOffChats";
import { sameWorkspacePath } from "../../utils/workspacePath";
import type { AgentControl } from "../agents/AgentControl";
import { createSessionEventCapture } from "../jsonrpc/sessionEventCapture";
import type { SessionEvent } from "../protocol";
import type { AgentSession } from "../session/AgentSession";
import type {
  SeededSessionContext,
  SessionDependencies,
  SessionInfoState,
} from "../session/SessionContext";
import { SessionRuntime } from "../session/SessionRuntime";
import { getSessionTaskLock } from "../session/taskLocks";
import type { PersistedSessionRecord, SessionDb } from "../sessionDb";
import type { SessionBinding } from "../startServer/types";
import { resolveTasksFeatureEnabled } from "../tasks/flags";
import type { TaskCoordinator } from "../tasks/TaskCoordinator";
import type { WorkspaceBackupService } from "../workspaceBackups";
import {
  mergeConfigPatch,
  type ProjectConfigPatch,
  persistProjectConfigPatch,
} from "./ConfigPatchStore";
import type { ThreadJournal } from "./ThreadJournal";

let agentSessionModule: typeof import("../session/AgentSession") | null = null;
let sessionSnapshotProjectorModule: typeof import("../session/SessionSnapshotProjector") | null =
  null;
let a2uiSessionAdapterModule: typeof import("../../experimental/a2ui/sessionAdapter") | null = null;

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

const loadA2uiSessionAdapterModule =
  (): typeof import("../../experimental/a2ui/sessionAdapter") => {
    a2uiSessionAdapterModule ??=
      require("../../experimental/a2ui/sessionAdapter") as typeof import("../../experimental/a2ui/sessionAdapter");
    return a2uiSessionAdapterModule;
  };

export type SessionRegistryOptions = {
  config: AgentConfig;
  env: Record<string, string | undefined>;
  system: string;
  discoveredSkills: Array<{ name: string; description: string }>;
  yolo?: boolean;
  homedir?: string;
  connectProviderImpl?: typeof connectModelProvider;
  getAiCoworkerPathsImpl: typeof getAiCoworkerPaths;
  runTurnImpl?: typeof runTurnFn;
  sessionDb: SessionDb;
  threadJournal: ThreadJournal;
  taskCoordinator: TaskCoordinator;
  loadAgentPrompt: typeof loadAgentPromptFn;
  setConfig: (config: AgentConfig) => void;
  readSkillCatalogMtimeSnapshot?: (config: AgentConfig) => Promise<string>;
  initialSkillCatalogMtimeSnapshot?: string | null;
  refreshSkillsAcrossWorkspaceSessions: (options: {
    workingDirectory: string;
    sourceSessionId: string;
    allWorkspaces?: boolean;
  }) => Promise<void>;
  onThreadListChanged?: () => void;
  onTaskCreatedFromChat?: (input: { sourceSessionId: string; workspacePath: string }) => void;
};

function shouldInvalidateThreadList(evt: SessionEvent): boolean {
  switch (evt.type) {
    case "session_info":
    case "session_busy":
    case "user_message":
    case "assistant_message":
    case "ask":
    case "approval":
    case "error":
      return true;
    default:
      return false;
  }
}

export function shouldMirrorHarnessLogsToTerminal(
  env: Record<string, string | undefined>,
): boolean {
  const value = env.COWORK_HARNESS_TERMINAL_LOGS?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function formatHarnessTerminalLogLine(
  event: Extract<SessionEvent, { type: "log" }>,
): string {
  return `[cowork-harness:${event.sessionId}] ${event.line}`;
}

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
    if (binding.runtime && !sinkId.startsWith("journal:")) {
      this.sessionIdleSince.delete(binding.runtime.id);
    }
  }

  removeBindingSink(binding: SessionBinding, sinkId: string): void {
    binding.sinks.delete(sinkId);
    if (binding.runtime && binding.sinks.size === 0) {
      this.sessionIdleSince.set(binding.runtime.id, Date.now());
    }
  }

  countLiveConnectionSinks(binding: SessionBinding): number {
    return [...binding.sinks.keys()].filter((sinkId) => !sinkId.startsWith("journal:")).length;
  }

  disposeBinding(
    binding: SessionBinding,
    reason: string,
    opts: { closeSharedCodexClient?: boolean } = {},
  ): void {
    if (!binding.runtime) return;
    try {
      binding.runtime.turns.cancel();
    } catch {
      // ignore
    }
    try {
      binding.runtime.lifecycle.dispose(reason, opts);
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
  ): SessionRuntime {
    const binding: SessionBinding = {
      session: null,
      runtime: null,
      socket: null,
      sinks: new Map(),
    };
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
    binding.runtime = built.runtime;
    this.options.threadJournal.ensureSink(binding, built.session.id, (sinkBinding, sinkId, sink) =>
      this.addBindingSink(sinkBinding, sinkId, sink),
    );
    this.sessionBindings.set(built.runtime.id, binding);
    return built.runtime;
  }

  loadThreadBinding(threadId: string): SessionBinding | null {
    const existing = this.sessionBindings.get(threadId);
    if (existing?.runtime) {
      this.options.threadJournal.ensureSink(existing, threadId, (binding, sinkId, sink) =>
        this.addBindingSink(binding, sinkId, sink),
      );
      return existing;
    }
    const persisted = this.options.sessionDb.getSessionRecord(threadId);
    if (!persisted) return null;
    const binding: SessionBinding = {
      session: null,
      runtime: null,
      socket: null,
      sinks: new Map(),
    };
    const built = this.buildSession(binding, threadId);
    binding.session = built.session;
    binding.runtime = built.runtime;
    this.options.threadJournal.ensureSink(binding, built.session.id, (sinkBinding, sinkId, sink) =>
      this.addBindingSink(sinkBinding, sinkId, sink),
    );
    this.sessionBindings.set(built.session.id, binding);
    return binding;
  }

  async dispatchTaskContinuation(input: {
    sessionId: string;
    prompt: string;
    displayText: string;
    onFailure: (error: unknown) => Promise<void>;
  }): Promise<Exclude<TaskQuestionResumeStatus, "not_needed">> {
    const binding = this.loadThreadBinding(input.sessionId);
    const runtime = binding?.runtime;
    if (!runtime) {
      await input.onFailure(new Error("Task continuation thread could not be loaded"));
      return "failed";
    }
    const activeTurnId = runtime.turns.activeTurnId;
    if (activeTurnId) {
      try {
        await runtime.turns.sendSteerMessage(input.prompt, activeTurnId);
        return "steered";
      } catch (error) {
        await input.onFailure(error);
        return "failed";
      }
    }
    void runtime.turns
      .sendUserMessage(input.prompt, undefined, input.displayText)
      .catch((error) => void input.onFailure(error).catch(() => undefined));
    return "queued";
  }

  async cancelAgentSessions(parentSessionId: string, opts?: { timeoutMs?: number }): Promise<void> {
    await this.getAgentControl().cancelAll(parentSessionId, opts);
  }

  async createTaskFromChat(
    sourceSessionId: string,
    rawInput: TaskCreationInput,
  ): Promise<TaskCreationResult> {
    // Defense-in-depth: reject task creation when the Tasks feature is disabled,
    // even if a tool somehow reached this handler.
    if (!resolveTasksFeatureEnabled(this.getConfig())) {
      throw new Error("Tasks feature is disabled");
    }
    const creation = taskCreationInputSchema.parse(rawInput);
    const sourceBinding = this.loadThreadBinding(sourceSessionId);
    const sourceRuntime = sourceBinding?.runtime;
    if (sourceRuntime?.read.sessionKind !== "root") {
      throw new Error("Tasks can be created only from a root chat");
    }
    if (this.options.taskCoordinator.isTaskThread(sourceSessionId)) {
      throw new Error("Task mode is already active for this thread");
    }
    const cwd = sourceRuntime.read.workingDirectory;
    const existing = this.options.sessionDb.getTaskByCreationKey(creation.idempotencyKey, {
      sourceSessionId,
      workspacePath: cwd,
    });
    if (existing) {
      return {
        task: existing,
        workspaceDisposition: isPathInsideOneOffChatsRoot(
          existing.workspacePath,
          this.options.homedir,
        )
          ? "promote_one_off"
          : "existing_project",
      };
    }
    const active = this.options.sessionDb.getActiveTaskForSourceSession(sourceSessionId);
    if (active) throw new Error(`This chat is locked by active task ${active.id}`);
    const workspaceDisposition = isPathInsideOneOffChatsRoot(cwd, this.options.homedir)
      ? "promote_one_off"
      : "existing_project";
    const taskRuntime = this.createJsonRpcThreadSession(
      cwd,
      sourceRuntime.read.publicConfig.provider,
      sourceRuntime.read.publicConfig.model,
    );
    await taskRuntime.lifecycle.waitForPersistenceIdle();
    try {
      this.options.onTaskCreatedFromChat?.({ sourceSessionId, workspacePath: cwd });
      const result = await this.options.taskCoordinator.createPlanned({
        workspacePath: cwd,
        sessionId: taskRuntime.id,
        sourceSessionId,
        creationOrigin: "chat_tool",
        workspaceDisposition,
        creation,
      });
      const kickoff = [
        `Execute the task "${result.task.title}" using the existing task brief and work graph.`,
        "Start with the first unblocked work item. Maintain task state with taskUpdate and ask only at material decision boundaries.",
      ].join("\n\n");
      void taskRuntime.turns
        .sendUserMessage(kickoff, undefined, `Start task: ${result.task.title}`)
        .catch((error) =>
          this.options.taskCoordinator
            .handleThreadOutcome(taskRuntime.id, "error", error)
            .catch(() => undefined),
        );
      return result;
    } catch (error) {
      const failedBinding = this.sessionBindings.get(taskRuntime.id);
      if (failedBinding) this.disposeBinding(failedBinding, "task creation failed");
      this.sessionBindings.delete(taskRuntime.id);
      this.sessionIdleSince.delete(taskRuntime.id);
      await this.options.sessionDb.deleteSession(taskRuntime.id).catch(() => undefined);
      throw error;
    }
  }

  readThreadSnapshot(threadId: string): ReturnType<SessionRuntime["snapshot"]["build"]> | null {
    const liveSnapshot = this.sessionBindings.get(threadId)?.runtime?.snapshot.peek() ?? null;
    if (liveSnapshot) return liveSnapshot;
    const persisted = this.options.sessionDb.getSessionRecord(threadId);
    if (!persisted) return null;
    return this.loadInitialSessionSnapshot(persisted);
  }

  listLiveRoot(options: { cwd?: string } = {}): SessionRuntime[] {
    return [...this.sessionBindings.values()]
      .flatMap((binding) => (binding.runtime ? [binding.runtime] : []))
      .filter(
        (runtime) =>
          runtime.read.sessionKind === "root" &&
          (!options.cwd || runtime.read.workingDirectory === options.cwd),
      );
  }

  createWorkspaceControlBinding(controlConfig: AgentConfig): SessionBinding {
    const binding: SessionBinding = {
      session: null,
      runtime: null,
      socket: null,
      sinks: new Map(),
    };
    const built = this.buildSession(binding, undefined, {
      config: controlConfig,
      persistenceEnabled: false,
    });
    binding.session = built.session;
    binding.runtime = built.runtime;
    return binding;
  }

  evictIdleSessionBindings(idleTimeoutMs: number): void {
    const now = Date.now();
    for (const [sessionId, binding] of this.sessionBindings) {
      if (binding.runtime && binding.sinks.size === 0 && !binding.runtime.read.isBusy) {
        const idleSince = this.sessionIdleSince.get(sessionId) ?? 0;
        if (idleSince > 0 && now - idleSince > idleTimeoutMs) {
          binding.runtime.lifecycle.dispose("idle eviction");
          this.sessionBindings.delete(sessionId);
          this.sessionIdleSince.delete(sessionId);
        }
      }
    }
  }

  async disposeAll(reason: string): Promise<void> {
    const persistenceFlushes: Promise<void>[] = [];
    for (const [id, binding] of this.sessionBindings) {
      if (!binding.runtime) {
        this.sessionBindings.delete(id);
        this.sessionIdleSince.delete(id);
        continue;
      }
      try {
        binding.runtime.lifecycle.dispose(reason);
      } catch {
        // ignore
      }
      try {
        persistenceFlushes.push(binding.runtime.lifecycle.waitForPersistenceIdle());
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
      if (sessionKind === "root" && shouldInvalidateThreadList(evt)) {
        this.options.onThreadListChanged?.();
      }
      if (evt.type === "log" && shouldMirrorHarnessLogsToTerminal(this.options.env)) {
        try {
          process.stderr.write(`${formatHarnessTerminalLogLine(evt)}\n`);
        } catch {
          // Terminal debug logging must never affect session delivery.
        }
      }
      for (const sink of binding.sinks.values()) {
        try {
          sink(evt);
        } catch {
          // ignore individual sink failures
        }
      }
      if (evt.type === "session_busy" && evt.busy === false) {
        const outcome = evt.outcome ?? "completed";
        void this.options.taskCoordinator
          .handleThreadOutcome(evt.sessionId, outcome)
          .catch(() => null)
          .then(() =>
            this.options.taskCoordinator.checkpointThread(evt.sessionId, `turn ${outcome}`),
          )
          .catch(() => {
            // Task revision finalization and checkpointing must not affect turn delivery.
          });
      }
    };
    const a2uiSessionAdapter = isA2uiExperimentEnabled(this.options.env)
      ? loadA2uiSessionAdapterModule()
      : null;
    const globalConfigDir = path.join(currentConfig.userCoworkDir, "config");

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
                currentConfig.projectCoworkDir,
                selection,
                currentConfig.providerOptions,
                {
                  a2uiExperimentEnabled: currentConfig.experimentalFeatures?.a2ui === true,
                  globalConfigDir,
                },
              );
              currentConfig = mergeConfigPatch(currentConfig, selection);
              syncConfig(currentConfig);
            }
          : undefined,
      persistProjectConfigPatchImpl:
        sessionKind === "root"
          ? async (patch: ProjectConfigPatch) => {
              await persistProjectConfigPatch(
                currentConfig.projectCoworkDir,
                patch,
                currentConfig.providerOptions,
                {
                  a2uiExperimentEnabled: currentConfig.experimentalFeatures?.a2ui === true,
                  globalConfigDir,
                },
              );
              currentConfig = mergeConfigPatch(currentConfig, patch);
              syncConfig(currentConfig);
            }
          : undefined,
      sessionDb: this.options.sessionDb,
      toolEnv: this.options.env,
      getTaskContextImpl: (sessionId) =>
        this.options.taskCoordinator.getContextForThread(sessionId),
      getTaskReviewMaterialImpl: async (sessionId) =>
        await this.options.taskCoordinator.getReviewMaterialForThread(sessionId),
      applyTaskDirectiveImpl: async (sessionId, directive) =>
        await this.options.taskCoordinator.applyDirective(sessionId, directive),
      createTaskImpl: async (sessionId, input) => await this.createTaskFromChat(sessionId, input),
      emit,
      createAgentSessionImpl: async (agentOpts) => await this.getAgentControl().spawn(agentOpts),
      listAgentSessionsImpl: async (parentSessionId) =>
        await this.getAgentControl().list(parentSessionId),
      sendAgentInputImpl: async (agentOpts) => await this.getAgentControl().sendInput(agentOpts),
      waitForAgentImpl: async (agentOpts) => await this.getAgentControl().wait(agentOpts),
      inspectAgentImpl: async (agentOpts) => await this.getAgentControl().inspect(agentOpts),
      resumeAgentImpl: async (agentOpts) => await this.getAgentControl().resume(agentOpts),
      closeAgentImpl: async (agentOpts) => await this.getAgentControl().close(agentOpts),
      cancelAgentSessionsImpl: async (parentSessionId, cancelOpts) =>
        await this.getAgentControl().cancelAll(parentSessionId, cancelOpts),
      deleteSessionImpl: async (opts) => {
        if (this.options.taskCoordinator.isTaskThread(opts.targetSessionId)) {
          throw new Error("Task threads must be managed through the task lifecycle");
        }
        const activeSourceTask = this.options.sessionDb.getActiveTaskForSourceSession(
          opts.targetSessionId,
        );
        if (activeSourceTask) {
          throw new Error(`Chat is locked by active task ${activeSourceTask.id}`);
        }
        const requesterWorkingDirectory =
          this.sessionBindings.get(opts.requesterSessionId)?.runtime?.read.workingDirectory ??
          this.options.sessionDb.getSessionRecord(opts.requesterSessionId)?.workingDirectory ??
          null;
        const targetRecord = this.options.sessionDb.getSessionRecord(opts.targetSessionId);
        const targetWorkingDirectory =
          this.sessionBindings.get(opts.targetSessionId)?.runtime?.read.workingDirectory ??
          targetRecord?.workingDirectory ??
          null;
        if (
          requesterWorkingDirectory &&
          targetWorkingDirectory &&
          !sameWorkspacePath(requesterWorkingDirectory, targetWorkingDirectory)
        ) {
          throw new Error("Target session is outside the active workspace");
        }

        const liveChildIds = [...this.sessionBindings.values()]
          .map((childBinding) => childBinding.runtime)
          .filter(
            (runtime): runtime is SessionRuntime =>
              !!runtime && runtime.read.isAgentOf(opts.targetSessionId),
          )
          .map((runtime) => runtime.id);
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
          if (!candidateBinding?.runtime) continue;
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
        this.sessionBindings.get(sessionId)?.runtime?.snapshot.peek() ?? null,
      getLiveSessionWorkingDirectoryImpl: (sessionId) =>
        this.sessionBindings.get(sessionId)?.runtime?.read.workingDirectory ?? null,
      getLiveSessionParentIdImpl: (sessionId) =>
        this.sessionBindings.get(sessionId)?.runtime?.read.parentSessionId ?? null,
      buildLegacySessionSnapshotImpl: (record: PersistedSessionRecord) =>
        loadSessionSnapshotProjectorModule().createLegacySessionSnapshot(record),
      readSkillCatalogMtimeSnapshotImpl: this.options.readSkillCatalogMtimeSnapshot,
      getSkillMutationBlockReasonImpl: (workingDirectory) => {
        const busyRuntime = [...this.sessionBindings.values()]
          .map((candidate) => candidate.runtime)
          .find(
            (candidate): candidate is SessionRuntime =>
              !!candidate &&
              candidate.read.workingDirectory === workingDirectory &&
              candidate.read.isBusy,
          );
        if (!busyRuntime) {
          return null;
        }
        return "Skill mutations are blocked while another session in this workspace is running.";
      },
      refreshSkillsAcrossWorkspaceSessionsImpl: this.options.refreshSkillsAcrossWorkspaceSessions,
      ...(a2uiSessionAdapter
        ? {
            createA2uiSurfaceManagerImpl: a2uiSessionAdapter.createExperimentalA2uiSurfaceManager,
            deriveA2uiSurfacesFromSnapshotImpl: a2uiSessionAdapter.deriveA2uiSurfacesFromSnapshot,
          }
        : {}),
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
    runtime: SessionRuntime;
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
        return {
          session,
          runtime: new SessionRuntime(session),
          isResume: true,
          resumedFromStorage: true,
        };
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
      initialSkillCatalogMtimeSnapshot:
        overrides?.config || overrides?.system
          ? null
          : this.options.initialSkillCatalogMtimeSnapshot,
      persistenceEnabled: overrides?.persistenceEnabled,
      ...(overrides?.seedContext ? { seedContext: overrides.seedContext } : {}),
      ...(overrides?.sessionInfoPatch ? { sessionInfoPatch: overrides.sessionInfoPatch } : {}),
      ...common,
    });
    return {
      session,
      runtime: new SessionRuntime(session),
      isResume: false,
      resumedFromStorage: false,
    };
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
      getParentTaskLock: (parentSessionId) =>
        getSessionTaskLock(
          {
            getTaskForThread: (sessionId) => this.options.taskCoordinator.getForThread(sessionId),
            getActiveTaskForSourceSession: (sessionId) =>
              this.options.taskCoordinator.getActiveForSourceSession(sessionId),
            getSessionRecord: (sessionId) => {
              const liveParentSessionId =
                this.sessionBindings.get(sessionId)?.runtime?.read.parentSessionId ?? null;
              if (liveParentSessionId) return { parentSessionId: liveParentSessionId };
              const persisted = this.options.sessionDb.getSessionRecord(sessionId);
              return persisted ? { parentSessionId: persisted.parentSessionId } : null;
            },
          },
          parentSessionId,
        ),
      disposeBinding: (binding, reason) => this.disposeBinding(binding, reason),
      emitParentAgentStatus: (parentSessionId, agent) => {
        const parentBinding = this.sessionBindings.get(parentSessionId);
        if (!parentBinding) return;
        if (parentBinding.session) {
          parentBinding.session.recordAgentStatus(agent);
          return;
        }
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
        const runtime = this.sessionBindings.get(sessionId)?.runtime;
        if (!runtime) return null;
        const info = runtime.read.info;
        return {
          sessionId: runtime.id,
          title: info.title,
          provider: info.provider,
          model: info.model,
          updatedAt: info.updatedAt,
          status: runtime.session.persistenceStatus,
          busy: runtime.read.isBusy,
          setBackupsEnabledOverride: async (enabled) => {
            await runtime.session.setBackupsEnabledOverride(enabled);
          },
          reloadBackupStateFromDisk: async () => {
            await runtime.backups.reloadStateFromDisk();
          },
        };
      },
    });
    return this.workspaceBackupService;
  }
}
