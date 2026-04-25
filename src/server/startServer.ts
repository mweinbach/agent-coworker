import fs from "node:fs/promises";
import { z } from "zod";
import type { runTurn as runTurnFn } from "../agent";
import { loadConfig } from "../config";
import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../connect";
import { getAiCoworkerPaths as getAiCoworkerPathsDefault } from "../connect";
import type { emitObservabilityEvent as emitObservabilityEventFn } from "../observability/otel";
import type {
  loadAgentPrompt as loadAgentPromptFn,
  loadSystemPromptWithSkills as loadSystemPromptWithSkillsFn,
} from "../prompt";
import { getProviderCatalog } from "../providers/connectionCatalog";
import type { SessionKind } from "../shared/agents";
import { ensureDefaultGlobalSkillsReady } from "../skills/defaultGlobalSkills";
import { type AgentConfig, defaultRuntimeNameForProvider } from "../types";
import { resolveAuthHomeDir } from "../utils/authHome";

import type { AgentControl } from "./agents/AgentControl";
import { decodeJsonRpcMessage } from "./jsonrpc/decodeJsonRpcMessage";
import { buildJsonRpcErrorResponse, buildJsonRpcResultResponse } from "./jsonrpc/protocol";
import { createJsonRpcRequestRouter } from "./jsonrpc/routes";
import {
  buildControlSessionStateEvents,
  buildJsonRpcThreadFromRecord,
  buildJsonRpcThreadFromSession,
  extractJsonRpcInput,
  extractJsonRpcTextInput,
  isJsonRpcSessionError,
  requireWorkspacePath,
  shouldIncludeJsonRpcThreadSummary,
} from "./jsonrpc/routes/shared";
import { createSessionEventCapture } from "./jsonrpc/sessionEventCapture";
import { createJsonRpcTransportAdapter } from "./jsonrpc/transportAdapter";
import type { ServerEvent } from "./protocol";
import { ResearchService } from "./research/ResearchService";
import {
  deepMerge,
  isPlainObject,
  mergeConfigPatch,
  type ProjectConfigPatch,
  persistProjectConfigPatch,
} from "./runtime/ConfigPatchStore";
import type { ServerRuntime } from "./runtime/ServerRuntime";
import { SessionRegistry } from "./runtime/SessionRegistry";
import { SkillMutationBus } from "./runtime/SkillMutationBus";
import { SocketSendQueue } from "./runtime/SocketSendQueue";
import { ThreadJournal } from "./runtime/ThreadJournal";
import { WorkspaceControl } from "./runtime/WorkspaceControl";
import type { AgentSession } from "./session/AgentSession";
import type {
  SeededSessionContext,
  SessionDependencies,
  SessionInfoState,
} from "./session/SessionContext";
import { type PersistedSessionRecord, SessionDb } from "./sessionDb";
import { refreshSessionsForSkillMutation } from "./skillMutationRefresh";
import type { SessionBinding, StartServerSocketData } from "./startServer/types";
import { handleWebDesktopRoute } from "./webDesktopRoutes";
import { WebDesktopService } from "./webDesktopService";
import type { WorkspaceBackupService } from "./workspaceBackups";
import {
  parseWsProtocolDefault,
  resolveWsProtocol,
  splitWebSocketSubprotocolHeader,
} from "./wsProtocol/negotiation";

const errorWithCodeSchema = z
  .object({
    code: z.string().optional(),
  })
  .passthrough();
let observabilityOtelModulePromise: Promise<typeof import("../observability/otel")> | null = null;
let promptModulePromise: Promise<typeof import("../prompt")> | null = null;
let agentSessionModule: typeof import("./session/AgentSession") | null = null;
let sessionSnapshotProjectorModule: typeof import("./session/SessionSnapshotProjector") | null =
  null;

const lazyEmitObservabilityEvent: typeof emitObservabilityEventFn = async (...args) => {
  observabilityOtelModulePromise ??= import("../observability/otel");
  return await (await observabilityOtelModulePromise).emitObservabilityEvent(...args);
};

const loadPromptModule = async (): Promise<typeof import("../prompt")> => {
  promptModulePromise ??= import("../prompt");
  return await promptModulePromise;
};

const loadAgentSessionModule = (): typeof import("./session/AgentSession") => {
  agentSessionModule ??=
    require("./session/AgentSession") as typeof import("./session/AgentSession");
  return agentSessionModule;
};

const loadSessionSnapshotProjectorModule =
  (): typeof import("./session/SessionSnapshotProjector") => {
    sessionSnapshotProjectorModule ??=
      require("./session/SessionSnapshotProjector") as typeof import("./session/SessionSnapshotProjector");
    return sessionSnapshotProjectorModule;
  };

const lazyLoadAgentPrompt: typeof loadAgentPromptFn = async (...args) =>
  await (await loadPromptModule()).loadAgentPrompt(...args);

const lazyLoadSystemPromptWithSkills: typeof loadSystemPromptWithSkillsFn = async (...args) =>
  await (await loadPromptModule()).loadSystemPromptWithSkills(...args);

export interface StartAgentServerOptions {
  cwd: string;
  hostname?: string;
  port?: number;
  env?: Record<string, string | undefined>;
  providerOptions?: Record<string, any>;
  yolo?: boolean;
  homedir?: string;
  connectProviderImpl?: typeof connectModelProvider;
  getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
  runTurnImpl?: typeof runTurnFn;
  wsProtocolDefault?: "jsonrpc";
  preloadSystemPrompt?: boolean;
}

export async function startAgentServer(opts: StartAgentServerOptions): Promise<{
  server: ReturnType<typeof Bun.serve>;
  config: AgentConfig;
  system: string;
  url: string;
}> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const rawEnv = opts.env ?? { ...process.env, AGENT_WORKING_DIR: opts.cwd };
  const env: Record<string, string | undefined> & {
    COWORK_BUILTIN_DIR?: string;
  } = { ...rawEnv };
  const wsProtocolDefault =
    opts.wsProtocolDefault ?? parseWsProtocolDefault(env.COWORK_WS_DEFAULT_PROTOCOL);
  const parsedJsonRpcMaxPendingRequests = Number(
    env.COWORK_WS_JSONRPC_MAX_PENDING_REQUESTS ?? "128",
  );
  const jsonRpcMaxPendingRequests = Math.max(
    0,
    Number.isFinite(parsedJsonRpcMaxPendingRequests)
      ? Math.floor(parsedJsonRpcMaxPendingRequests)
      : 128,
  );

  await ensureDefaultGlobalSkillsReady({
    homedir: opts.homedir,
    env,
    log: (line) => {
      console.warn(`[default-skills] ${line}`);
    },
  });

  const builtInDir =
    typeof env.COWORK_BUILTIN_DIR === "string" && env.COWORK_BUILTIN_DIR.trim()
      ? env.COWORK_BUILTIN_DIR
      : undefined;
  let config = await loadConfig({ cwd: opts.cwd, env, homedir: opts.homedir, builtInDir });
  const mergedProviderOptions =
    isPlainObject(opts.providerOptions) && isPlainObject(config.providerOptions)
      ? deepMerge(
          opts.providerOptions as Record<string, unknown>,
          config.providerOptions as Record<string, unknown>,
        )
      : isPlainObject(config.providerOptions)
        ? config.providerOptions
        : isPlainObject(opts.providerOptions)
          ? opts.providerOptions
          : undefined;
  if (mergedProviderOptions) config.providerOptions = mergedProviderOptions;

  await fs.mkdir(config.projectAgentDir, { recursive: true });

  let system = "";
  let discoveredSkills: Array<{ name: string; description: string }> = [];
  if (opts.preloadSystemPrompt !== false) {
    const loadedSystemPrompt = await lazyLoadSystemPromptWithSkills(config);
    system = loadedSystemPrompt.prompt;
    discoveredSkills = loadedSystemPrompt.discoveredSkills;
  }
  const getAiCoworkerPathsImpl = opts.getAiCoworkerPathsImpl ?? getAiCoworkerPathsDefault;
  const sessionDb = await SessionDb.create({
    paths: getAiCoworkerPathsImpl({ homedir: opts.homedir }),
    emitTelemetry: (name, status, attributes, durationMs) => {
      void lazyEmitObservabilityEvent(config, {
        name,
        at: new Date().toISOString(),
        status,
        ...(durationMs !== undefined ? { durationMs } : {}),
        attributes,
      }).catch(() => {
        // Session DB observability is best-effort only.
      });
    },
  });
  const aiCoworkerPaths = getAiCoworkerPathsImpl({ homedir: opts.homedir });
  const research = new ResearchService({
    rootDir: aiCoworkerPaths.rootDir,
    workspacePath: config.workingDirectory,
    sessionDb,
    getConfig: () => config,
    sendJsonRpc: (ws, payload) => sendJsonRpc(ws, payload),
  });
  const sessions = new SessionRegistry();
  const sessionBindings = sessions.bindings;
  const socketSendQueue = new SocketSendQueue();
  let workspaceControl: WorkspaceControl;
  let skillMutationBus: SkillMutationBus;
  let workspaceBackupService: WorkspaceBackupService | null = null;
  let getAgentControl: () => AgentControl;
  let serverStopped = false;

  const refreshLocalSkillState = async ({
    workingDirectory,
    sourceSessionId,
    allWorkspaces = false,
  }: {
    workingDirectory: string;
    sourceSessionId?: string;
    allWorkspaces?: boolean;
  }) => {
    await refreshSessionsForSkillMutation({
      sessionBindings: sessions.listBindings(),
      workspaceControlBindings: [],
      workingDirectory,
      sourceSessionId,
      allWorkspaces,
    });
    try {
      await workspaceControl.emitRefreshNotifications({
        workingDirectory,
        allWorkspaces,
      });
    } catch {
      // Best-effort only; explicit control refreshes remain available on demand.
    }
  };

  const getWorkspaceBackupService = (): WorkspaceBackupService => {
    if (workspaceBackupService) {
      return workspaceBackupService;
    }
    const { WorkspaceBackupService } =
      require("./workspaceBackups") as typeof import("./workspaceBackups");
    workspaceBackupService = new WorkspaceBackupService({
      homedir: opts.homedir,
      sessionDb,
      getLiveSession: (sessionId) => {
        const session = sessions.getSession(sessionId);
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
    return workspaceBackupService;
  };

  const addBindingSink = (
    binding: SessionBinding,
    sinkId: string,
    sink: (evt: ServerEvent) => void,
  ) => sessions.addSink(binding, sinkId, sink);

  const removeBindingSink = (binding: SessionBinding, sinkId: string) =>
    sessions.removeSink(binding, sinkId);

  const countLiveConnectionSinks = (binding: SessionBinding) =>
    sessions.countLiveConnectionSinks(binding);

  const sessionEventCapture = createSessionEventCapture({
    addBindingSink,
    removeBindingSink,
  });

  const loadWorkspaceControlConfig = async (cwd: string): Promise<AgentConfig> => {
    const nextConfig = await loadConfig({
      cwd,
      env: {
        ...env,
        AGENT_WORKING_DIR: cwd,
      },
      homedir: opts.homedir,
      builtInDir,
    });
    const providerOptions =
      isPlainObject(opts.providerOptions) && isPlainObject(nextConfig.providerOptions)
        ? deepMerge(
            opts.providerOptions as Record<string, unknown>,
            nextConfig.providerOptions as Record<string, unknown>,
          )
        : isPlainObject(nextConfig.providerOptions)
          ? nextConfig.providerOptions
          : isPlainObject(opts.providerOptions)
            ? opts.providerOptions
            : undefined;
    if (providerOptions) {
      nextConfig.providerOptions = providerOptions;
    }
    return nextConfig;
  };

  const buildSessionCommon = (
    binding: SessionBinding,
    sessionKind: SessionKind = "root",
    currentConfig: AgentConfig = config,
    syncConfig: (nextConfig: AgentConfig) => void = (nextConfig) => {
      config = nextConfig;
    },
  ) => {
    const emit = (evt: ServerEvent) => {
      for (const sink of binding.sinks.values()) {
        try {
          sink(evt);
        } catch {
          // ignore individual sink failures
        }
      }
    };

    return {
      discoveredSkills,
      yolo: opts.yolo,
      connectProviderImpl: opts.connectProviderImpl,
      getAiCoworkerPathsImpl,
      runTurnImpl: opts.runTurnImpl,
      persistModelSelectionImpl:
        sessionKind === "root"
          ? async (selection: {
              provider: AgentConfig["provider"];
              model: string;
              preferredChildModel: string;
              childModelRoutingMode?: import("../types").ChildModelRoutingMode;
              preferredChildModelRef?: string;
              allowedChildModelRefs?: string[];
            }) => {
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
      sessionDb,
      emit,
      createAgentSessionImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["createAgentSessionImpl"]>>[0],
      ) => await getAgentControl().spawn(agentOpts),
      listAgentSessionsImpl: async (
        parentSessionId: Parameters<NonNullable<SessionDependencies["listAgentSessionsImpl"]>>[0],
      ) => await getAgentControl().list(parentSessionId),
      sendAgentInputImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["sendAgentInputImpl"]>>[0],
      ) => await getAgentControl().sendInput(agentOpts),
      waitForAgentImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["waitForAgentImpl"]>>[0],
      ) => await getAgentControl().wait(agentOpts),
      inspectAgentImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["inspectAgentImpl"]>>[0],
      ) => await getAgentControl().inspect(agentOpts),
      resumeAgentImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["resumeAgentImpl"]>>[0],
      ) => await getAgentControl().resume(agentOpts),
      closeAgentImpl: async (
        agentOpts: Parameters<NonNullable<SessionDependencies["closeAgentImpl"]>>[0],
      ) => await getAgentControl().close(agentOpts),
      cancelAgentSessionsImpl: (
        parentSessionId: Parameters<NonNullable<SessionDependencies["cancelAgentSessionsImpl"]>>[0],
      ) => getAgentControl().cancelAll(parentSessionId),
      deleteSessionImpl: async (opts: {
        requesterSessionId: string;
        targetSessionId: string;
      }): Promise<void> => {
        void opts.requesterSessionId;
        const liveChildIds = [...sessionBindings.values()]
          .map((childBinding) => childBinding.session)
          .filter(
            (session): session is AgentSession =>
              !!session && session.isAgentOf(opts.targetSessionId),
          )
          .map((session) => session.id);
        const persistedChildIds = sessionDb
          .listAgentSessions(opts.targetSessionId)
          .map((summary) => summary.agentId);
        const sessionIdsToDispose = new Set([
          opts.targetSessionId,
          ...persistedChildIds,
          ...liveChildIds,
        ]);

        for (const sessionId of sessionIdsToDispose) {
          const candidateBinding = sessionBindings.get(sessionId);
          if (!candidateBinding?.session) continue;
          sessions.removeBindingForDeletedSession(sessionId, opts.targetSessionId);
        }

        await sessionDb.deleteSession(opts.targetSessionId);
      },
      listWorkspaceBackupsImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
      }) => await getWorkspaceBackupService().listWorkspaceBackups(opts.workingDirectory),
      createWorkspaceBackupCheckpointImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
      }) =>
        await getWorkspaceBackupService().createCheckpoint(
          opts.workingDirectory,
          opts.targetSessionId,
        ),
      restoreWorkspaceBackupImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
        checkpointId?: string;
      }) =>
        await getWorkspaceBackupService().restoreBackup(
          opts.workingDirectory,
          opts.targetSessionId,
          opts.checkpointId,
        ),
      deleteWorkspaceBackupCheckpointImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
        checkpointId: string;
      }) =>
        await getWorkspaceBackupService().deleteCheckpoint(
          opts.workingDirectory,
          opts.targetSessionId,
          opts.checkpointId,
        ),
      deleteWorkspaceBackupEntryImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
      }) =>
        await getWorkspaceBackupService().deleteEntry(opts.workingDirectory, opts.targetSessionId),
      getWorkspaceBackupDeltaImpl: async (opts: {
        requesterSessionId: string;
        workingDirectory: string;
        targetSessionId: string;
        checkpointId: string;
      }) =>
        await getWorkspaceBackupService().getCheckpointDelta(
          opts.workingDirectory,
          opts.targetSessionId,
          opts.checkpointId,
        ),
      getLiveSessionSnapshotImpl: (sessionId: string) => sessions.getLiveSessionSnapshot(sessionId),
      getLiveSessionWorkingDirectoryImpl: (sessionId: string) =>
        sessions.getLiveSessionWorkingDirectory(sessionId),
      buildLegacySessionSnapshotImpl: (record: import("./sessionDb").PersistedSessionRecord) =>
        loadSessionSnapshotProjectorModule().createLegacySessionSnapshot(record),
      getSkillMutationBlockReasonImpl: (workingDirectory: string) => {
        const busySession = sessions.findBusyWorkspaceSession(workingDirectory);
        if (!busySession) {
          return null;
        }
        return "Skill mutations are blocked while another session in this workspace is running.";
      },
      refreshSkillsAcrossWorkspaceSessionsImpl: async ({
        workingDirectory,
        sourceSessionId,
        allWorkspaces = false,
      }: {
        workingDirectory: string;
        sourceSessionId: string;
        allWorkspaces?: boolean;
      }) => {
        await refreshLocalSkillState({
          workingDirectory,
          sourceSessionId,
          allWorkspaces,
        });
        if (allWorkspaces) {
          await skillMutationBus.publish();
        }
      },
    };
  };

  const disposeBinding = (binding: SessionBinding, reason: string) => {
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
  };

  const loadInitialSessionSnapshot = (persisted: PersistedSessionRecord) => {
    try {
      const snapshot = sessionDb.getSessionSnapshot(persisted.sessionId);
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
  };

  const buildSession = (
    binding: SessionBinding,
    persistedSessionId?: string,
    overrides?: {
      config?: AgentConfig;
      persistenceEnabled?: boolean;
      system?: string;
      seedContext?: SeededSessionContext;
      sessionInfoPatch?: Partial<SessionInfoState>;
    },
  ): {
    session: AgentSession;
    isResume: boolean;
    resumedFromStorage: boolean;
  } => {
    if (persistedSessionId) {
      const persisted = sessionDb.getSessionRecord(persistedSessionId);
      if (persisted) {
        const common = buildSessionCommon(binding, persisted.sessionKind);
        const { AgentSession } = loadAgentSessionModule();
        const session = AgentSession.fromPersisted({
          persisted,
          initialSessionSnapshot: loadInitialSessionSnapshot(persisted),
          baseConfig: { ...config },
          ...common,
        });
        return { session, isResume: true, resumedFromStorage: true };
      }
    }

    const sessionKind = overrides?.sessionInfoPatch?.sessionKind ?? "root";
    let sessionConfig = { ...(overrides?.config ?? config) };
    const common = buildSessionCommon(binding, sessionKind, sessionConfig, (nextConfig) => {
      sessionConfig = nextConfig;
    });
    const { AgentSession } = loadAgentSessionModule();
    const session = new AgentSession({
      config: sessionConfig,
      system: overrides?.system ?? system,
      persistenceEnabled: overrides?.persistenceEnabled,
      ...(overrides?.seedContext ? { seedContext: overrides.seedContext } : {}),
      ...(overrides?.sessionInfoPatch ? { sessionInfoPatch: overrides.sessionInfoPatch } : {}),
      ...common,
    });
    return { session, isResume: false, resumedFromStorage: false };
  };

  const getConnectedProviders = async (
    parentConfig: AgentConfig,
  ): Promise<AgentConfig["provider"][]> =>
    (await getProviderCatalog({ homedir: resolveAuthHomeDir(parentConfig, opts.homedir) }))
      .connected as AgentConfig["provider"][];

  let agentControl: AgentControl | null = null;
  getAgentControl = (): AgentControl => {
    if (agentControl) {
      return agentControl;
    }
    const { AgentControl } =
      require("./agents/AgentControl") as typeof import("./agents/AgentControl");
    agentControl = new AgentControl({
      sessionBindings,
      sessionDb,
      getConnectedProviders,
      buildSession,
      loadAgentPrompt: lazyLoadAgentPrompt,
      disposeBinding,
      emitParentAgentStatus: (parentSessionId, agent) => {
        const parentBinding = sessionBindings.get(parentSessionId);
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
        const parentBinding = sessionBindings.get(parentSessionId);
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
    return agentControl;
  };

  const threadJournal = new ThreadJournal(sessionDb, {
    addBindingSink,
  });
  const sendJsonRpc = (ws: Bun.ServerWebSocket<StartServerSocketData>, payload: unknown) =>
    socketSendQueue.sendJsonRpc(ws, payload);

  const shouldSendJsonRpcNotification = (
    ws: Bun.ServerWebSocket<StartServerSocketData>,
    method: string,
  ) => !ws.data.rpc?.capabilities.optOutNotificationMethods.includes(method);

  const createJsonRpcThreadSession = (
    cwd: string,
    provider?: AgentConfig["provider"],
    model?: string,
  ) => {
    const binding: SessionBinding = { session: null, socket: null, sinks: new Map() };
    const threadConfig: AgentConfig = {
      ...config,
      workingDirectory: cwd,
      ...(provider ? { provider, runtime: defaultRuntimeNameForProvider(provider) } : {}),
      ...(model ? { model } : {}),
    };
    const built = buildSession(binding, undefined, {
      config: threadConfig,
    });
    binding.session = built.session;
    threadJournal.ensureSink(binding, built.session.id);
    sessions.addBinding(built.session.id, binding);
    return built.session;
  };

  const loadThreadBinding = (threadId: string): SessionBinding | null => {
    const existing = sessions.getBinding(threadId);
    if (existing?.session) {
      threadJournal.ensureSink(existing, threadId);
      return existing;
    }
    const persisted = sessionDb.getSessionRecord(threadId);
    if (!persisted) return null;
    const binding: SessionBinding = { session: null, socket: null, sinks: new Map() };
    const built = buildSession(binding, threadId);
    binding.session = built.session;
    threadJournal.ensureSink(binding, built.session.id);
    sessions.addBinding(built.session.id, binding);
    return binding;
  };

  const readThreadSnapshot = (threadId: string) => {
    const liveSnapshot = sessions.getLiveSessionSnapshot(threadId);
    if (liveSnapshot) return liveSnapshot;
    const persisted = sessionDb.getSessionRecord(threadId);
    if (!persisted) return null;
    return loadInitialSessionSnapshot(persisted);
  };

  const jsonRpcTransport = createJsonRpcTransportAdapter({
    maxPendingRequests: jsonRpcMaxPendingRequests,
    loadThreadBinding,
    getThreadBinding: (threadId) => sessions.getBinding(threadId),
    addBindingSink,
    removeBindingSink,
    countLiveConnectionSinks,
    listThreadJournalEvents: (threadId, opts) => threadJournal.list(threadId, opts),
    enqueueThreadJournalEvent: async (event) => await threadJournal.enqueue(event),
    shouldSendNotification: (ws, method) => shouldSendJsonRpcNotification(ws, method),
    sendJsonRpc,
    extractTextInput: extractJsonRpcTextInput,
  });

  workspaceControl = new WorkspaceControl({
    yolo: opts.yolo,
    sendJsonRpc,
    shouldSendJsonRpcNotification,
    buildSession,
    loadWorkspaceControlConfig,
    disposeBinding,
    captureEvent: sessionEventCapture.capture,
  });

  skillMutationBus = new SkillMutationBus({
    userAgentDir: config.userAgentDir,
    workingDirectory: config.workingDirectory,
    refreshLocalSkillState,
  });
  await skillMutationBus.start();

  const runtime: ServerRuntime = {
    getConfig: () => config,
    setConfig: (nextConfig) => {
      config = nextConfig;
    },
    sessionDb,
    research,
    sessions,
    workspaceControl,
    threadJournal,
    socketSendQueue,
    skillMutationBus,
  };

  const jsonRpcRequestRouter = createJsonRpcRequestRouter({
    getConfig: runtime.getConfig,
    research: runtime.research,
    threads: {
      create: ({ cwd, provider, model }) => createJsonRpcThreadSession(cwd, provider, model),
      load: (threadId) => loadThreadBinding(threadId),
      getLive: (threadId) => sessions.getBinding(threadId),
      getPersisted: (threadId) => sessionDb.getSessionRecord(threadId),
      listPersisted: ({ cwd } = {}) =>
        sessionDb
          .listSessions({ ...(cwd ? { workingDirectory: cwd } : {}) })
          .map((record) => sessionDb.getSessionRecord(record.sessionId))
          .filter((record): record is PersistedSessionRecord => record !== null),
      listLiveRoot: ({ cwd } = {}) => sessions.listRootSessions({ ...(cwd ? { cwd } : {}) }),
      subscribe: (ws, threadId, opts) => jsonRpcTransport.subscribeThread(ws, threadId, opts),
      unsubscribe: (ws, threadId) => jsonRpcTransport.unsubscribeThread(ws, threadId),
      readSnapshot: (threadId) => readThreadSnapshot(threadId),
    },
    workspaceControl: {
      getOrCreateBinding: async (cwd) => await runtime.workspaceControl.getOrCreateBinding(cwd),
      withSession: async (cwd, runner) => await runtime.workspaceControl.withSession(cwd, runner),
      readState: async (cwd) => await runtime.workspaceControl.readState(cwd),
    },
    journal: {
      enqueue: async (event) => await runtime.threadJournal.enqueue(event),
      waitForIdle: async (threadId) => await runtime.threadJournal.waitForIdle(threadId),
      list: (threadId, opts) => runtime.threadJournal.list(threadId, opts),
      replay: (ws, threadId, afterSeq, limit) =>
        jsonRpcTransport.replayJournal(ws, threadId, afterSeq, limit),
    },
    events: {
      capture: sessionEventCapture.capture,
      captureMutationOutcome: sessionEventCapture.captureMutationOutcome,
      captureMutationEvents: sessionEventCapture.captureMutationEvents,
    },
    jsonrpc: {
      send: (ws, payload) => sendJsonRpc(ws, payload),
      sendResult: (ws, id, result) => sendJsonRpc(ws, buildJsonRpcResultResponse(id, result)),
      sendError: (ws, id, error) => sendJsonRpc(ws, buildJsonRpcErrorResponse(id, error)),
    },
    utils: {
      resolveWorkspacePath: (params, method) =>
        requireWorkspacePath(params, method, config.workingDirectory),
      extractTextInput: extractJsonRpcTextInput,
      extractInput: extractJsonRpcInput,
      buildThreadFromSession: buildJsonRpcThreadFromSession,
      buildThreadFromRecord: buildJsonRpcThreadFromRecord,
      shouldIncludeThreadSummary: shouldIncludeJsonRpcThreadSummary,
      buildControlSessionStateEvents,
      isSessionError: isJsonRpcSessionError,
    },
  });

  const routeJsonRpcRequest = async (
    ws: Bun.ServerWebSocket<StartServerSocketData>,
    message: { id: string | number; method: string; params?: unknown },
  ) => {
    const params = isPlainObject(message.params) ? message.params : undefined;
    if (params) {
      try {
        runtime.workspaceControl.registerSubscriber(
          ws,
          requireWorkspacePath(params, message.method, config.workingDirectory),
        );
      } catch {
        // Ignore non-workspace-control requests that do not resolve a cwd.
      }
    }
    await jsonRpcRequestRouter(ws, message);
  };

  // Returns the request's Origin header iff it is a loopback origin (localhost/127.0.0.1/::1,
  // any port). Returns null otherwise, in which case CORS headers are omitted so non-loopback
  // pages cannot read cross-origin responses from this server.
  function pickLoopbackOrigin(req: Request): string | null {
    const origin = req.headers.get("origin");
    if (!origin) return null;
    try {
      const u = new URL(origin);
      const host = u.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
        return origin;
      }
    } catch {
      // fall through
    }
    return null;
  }

  function createServer(port: number): ReturnType<typeof Bun.serve> {
    return Bun.serve<StartServerSocketData>({
      hostname,
      port,
      async fetch(req, srv) {
        const url = new URL(req.url);
        const allowedOrigin = pickLoopbackOrigin(req);
        const corsHeaders: Record<string, string> = allowedOrigin
          ? {
              "Access-Control-Allow-Origin": allowedOrigin,
              Vary: "Origin",
            }
          : {};
        if (req.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              ...corsHeaders,
              "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Sec-WebSocket-Protocol",
              "Access-Control-Max-Age": "86400",
            },
          });
        }
        if (url.pathname === "/ws") {
          const resumeSessionIdRaw = url.searchParams.get("resumeSessionId");
          const resumeSessionId = resumeSessionIdRaw?.trim()
            ? resumeSessionIdRaw.trim()
            : undefined;
          const protocolResult = resolveWsProtocol({
            offeredSubprotocols: splitWebSocketSubprotocolHeader(
              req.headers.get("sec-websocket-protocol"),
            ),
            requestedProtocol: url.searchParams.get("protocol"),
            defaultProtocol: wsProtocolDefault,
          });
          if (!protocolResult.ok) {
            return new Response(protocolResult.error, { status: 400, headers: corsHeaders });
          }
          const upgraded = srv.upgrade(req, {
            headers: protocolResult.protocol.selectedSubprotocol
              ? {
                  "Sec-WebSocket-Protocol": protocolResult.protocol.selectedSubprotocol,
                }
              : undefined,
            data: {
              resumeSessionId,
              protocolMode: protocolResult.protocol.mode,
              selectedSubprotocol: protocolResult.protocol.selectedSubprotocol,
              connectionId: crypto.randomUUID(),
            },
          });
          if (upgraded) return;
          return new Response("WebSocket upgrade failed", { status: 400, headers: corsHeaders });
        }
        const webDesktopRoute = await handleWebDesktopRoute(req, {
          cwd: opts.cwd,
          desktopService: webDesktopService,
        });
        if (webDesktopRoute) {
          for (const [key, value] of Object.entries(corsHeaders)) {
            webDesktopRoute.headers.set(key, value);
          }
          return webDesktopRoute;
        }
        return new Response("OK", { status: 200, headers: corsHeaders });
      },
      websocket: {
        open(ws) {
          jsonRpcTransport.openConnection(ws);
        },
        message(ws, raw) {
          const decoded = decodeJsonRpcMessage(raw);
          if (!decoded.ok) {
            sendJsonRpc(ws, decoded.response);
            return;
          }
          jsonRpcTransport.handleMessage(ws, decoded.message, routeJsonRpcRequest);
        },
        close(ws) {
          runtime.workspaceControl.removeSubscriber(ws);
          research.unsubscribeAll(ws);
          jsonRpcTransport.closeConnection(ws);
          runtime.socketSendQueue.delete(ws.data.connectionId);
        },
        drain(ws) {
          runtime.socketSendQueue.flush(ws);
        },
      },
    });
  }

  function isAddrInUse(err: unknown): boolean {
    const parsed = errorWithCodeSchema.safeParse(err);
    return parsed.success && parsed.data.code === "EADDRINUSE";
  }

  const requestedPort = opts.port ?? 7337;
  const webDesktopService =
    env.COWORK_WEB_DESKTOP_SERVICE === "1"
      ? new WebDesktopService({ homedir: opts.homedir })
      : null;

  function serveWithPortFallback(port: number): ReturnType<typeof Bun.serve> {
    try {
      // Normal behavior: when port=0, Bun (like Node) will request an ephemeral port from the OS.
      return createServer(port);
    } catch (err) {
      // Fallback for environments/versions where binding port 0 may fail.
      if (port !== 0) throw err;

      const min = 49152;
      const max = 65535;
      const attempts = 50;
      let lastErr: unknown = err;

      for (let i = 0; i < attempts; i++) {
        const candidate = min + Math.floor(Math.random() * (max - min + 1));
        try {
          return createServer(candidate);
        } catch (e) {
          lastErr = e;
          if (isAddrInUse(e)) continue;
          throw e;
        }
      }

      throw lastErr;
    }
  }

  const server = serveWithPortFallback(requestedPort);
  const originalStop = server.stop.bind(server) as (
    closeActiveConnections?: boolean,
  ) => Promise<void>;
  const evictionTimer = setInterval(() => sessions.evictIdleBindings(), 60_000);

  const stoppableServer = server as typeof server & {
    stop: (closeActiveConnections?: boolean) => Promise<void>;
  };
  stoppableServer.stop = async (closeActiveConnections?: boolean) => {
    if (serverStopped) return;
    serverStopped = true;
    clearInterval(evictionTimer);
    runtime.skillMutationBus.stop();
    runtime.workspaceControl.clearSubscribers();
    await runtime.sessions.disposeAll("server stopping");
    try {
      sessionDb.close();
    } catch {
      // ignore
    }
    try {
      await webDesktopService?.stopAll();
    } catch {
      // ignore
    }
    await originalStop(closeActiveConnections);
  };

  const url = `ws://${hostname}:${server.port}/ws`;
  return { server: stoppableServer, config, system, url };
}
