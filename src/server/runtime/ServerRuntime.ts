import fs from "node:fs/promises";
import type { runTurn as runTurnFn } from "../../agent";
import { loadConfig } from "../../config";
import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../../connect";
import { getAiCoworkerPaths as getAiCoworkerPathsDefault } from "../../connect";
import { checkLibreOfficeCapability, ensureCoworkRuntimeReady } from "../../coworkRuntime";
import type { CoworkRuntimeBootstrapProgress } from "../../coworkRuntime/types";
import { createConversationImportService } from "../../import/conversations";
import type { emitObservabilityEvent as emitObservabilityEventFn } from "../../observability/otel";
import { home } from "../../platform/paths";
import type {
  loadAgentPrompt as loadAgentPromptFn,
  loadSystemPromptWithSkills as loadSystemPromptWithSkillsFn,
} from "../../prompt";
import { createLmStudioLocalService } from "../../providers/lmstudio/local";
import { SkillImprovementService } from "../../skillImprovement";
import { ensureDefaultGlobalSkillsReady } from "../../skills/defaultGlobalSkills";
import type { AgentConfig } from "../../types";
import { resolveVersion } from "../../version";
import { WorktreeService } from "../git/WorktreeService";
import { decodeJsonRpcMessage } from "../jsonrpc/decodeJsonRpcMessage";
import {
  buildJsonRpcErrorResponse,
  buildJsonRpcResultResponse,
  type JsonRpcLiteClientResponse,
  type JsonRpcLiteNotification,
} from "../jsonrpc/protocol";
import { createJsonRpcRequestRouter, type JsonRpcRouteContext } from "../jsonrpc/routes";
import {
  buildControlSessionStateEvents,
  buildJsonRpcThreadFromRecord,
  buildJsonRpcThreadFromSession,
  extractJsonRpcInput,
  extractJsonRpcTextInput,
  isJsonRpcSessionError,
  requireWorkspacePath,
  shouldIncludeJsonRpcThreadSummary,
} from "../jsonrpc/routes/shared";
import type { JsonRpcThread } from "../jsonrpc/routes/types";
import { jsonRpcTaskRequestSchemas } from "../jsonrpc/schema.tasks";
import { getTaskRpcRequiredPermissions } from "../jsonrpc/taskPermissions";
import { projectToolRetryCompatibility } from "../jsonrpc/toolRetryCompatibility";
import { createJsonRpcTransportAdapter } from "../jsonrpc/transportAdapter";
import { ResearchService } from "../research/ResearchService";
import { ServerFileLog, shouldEnableServerFileLog } from "../serverFileLog";
import { getSessionTaskLock } from "../session/taskLocks";
import { type PersistedSessionRecord, SessionDb } from "../sessionDb";
import { readSkillCatalogMtimeSnapshot } from "../skillCatalogMtime";
import { refreshSessionsForSkillMutation } from "../skillMutationRefresh";
import type { StartServerSocket } from "../startServer/types";
import { TaskCoordinator } from "../tasks/TaskCoordinator";
import { LocalThreadHost } from "../threads/localThreadHost";
import { ThreadManagementService } from "../threads/ThreadManagementService";
import type { WebDesktopServiceLike } from "../webDesktopService";
import { isErrorWithCode, isPlainObject, mergeRuntimeProviderOptions } from "./ConfigPatchStore";
import { SessionRegistry } from "./SessionRegistry";
import { SkillMutationBus } from "./SkillMutationBus";
import { SocketSendQueue } from "./SocketSendQueue";
import { runStartupMaintenance } from "./startupMaintenance";
import { ThreadJournal } from "./ThreadJournal";
import { WorkspaceControl } from "./WorkspaceControl";
import { WorkspaceJsonRpcSubscribers } from "./WorkspaceJsonRpcSubscribers";

let observabilityOtelModulePromise: Promise<typeof import("../../observability/otel")> | null =
  null;
let promptModulePromise: Promise<typeof import("../../prompt")> | null = null;

const lazyEmitObservabilityEvent: typeof emitObservabilityEventFn = async (...args) => {
  observabilityOtelModulePromise ??= import("../../observability/otel");
  return await (await observabilityOtelModulePromise).emitObservabilityEvent(...args);
};

const loadPromptModule = async (): Promise<typeof import("../../prompt")> => {
  promptModulePromise ??= import("../../prompt");
  return await promptModulePromise;
};

const lazyLoadAgentPrompt: typeof loadAgentPromptFn = async (...args) =>
  await (await loadPromptModule()).loadAgentPrompt(...args);

function shouldRegisterTaskSubscriber(method: string, ws: StartServerSocket): boolean {
  if (!Object.hasOwn(jsonRpcTaskRequestSchemas, method)) {
    return false;
  }
  const requiredPermissions = getTaskRpcRequiredPermissions(method);
  if (requiredPermissions.includes("conversations") && ws.data.taskReadAllowed === false) {
    return false;
  }
  if (requiredPermissions.includes("turns") && ws.data.taskMutationAllowed === false) {
    return false;
  }
  return true;
}

const lazyLoadSystemPromptWithSkills: typeof loadSystemPromptWithSkillsFn = async (...args) =>
  await (await loadPromptModule()).loadSystemPromptWithSkills(...args);

export interface StartAgentServerOptions {
  cwd: string;
  hostname?: string;
  port?: number;
  mobileH3?: {
    hostname?: string;
    port?: number;
    hostHints?: string[];
  };
  env?: Record<string, string | undefined>;
  providerOptions?: Record<string, unknown>;
  yolo?: boolean;
  homedir?: string;
  desktopService?: WebDesktopServiceLike | null;
  connectProviderImpl?: typeof connectModelProvider;
  getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
  runTurnImpl?: typeof runTurnFn;
  loadAgentPromptImpl?: typeof loadAgentPromptFn;
  loadSystemPromptWithSkillsImpl?: typeof loadSystemPromptWithSkillsFn;
  ensureCoworkRuntimeReadyImpl?: typeof ensureCoworkRuntimeReady;
  ensureDefaultGlobalSkillsReadyImpl?: typeof ensureDefaultGlobalSkillsReady;
  preloadSystemPrompt?: boolean;
  taskTerminalQuiesceTimeoutMs?: number;
  onCoworkRuntimeBootstrapProgress?: (progress: CoworkRuntimeBootstrapProgress) => void;
}

type JsonRpcRequest = { id: string | number; method: string; params?: unknown };
type JsonRpcDecodedMessage = JsonRpcRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse;

/**
 * Summarized reliability snapshot served by the cheap `/cowork/health` endpoint.
 * Distinct from the detailed `cowork/runtime/diagnostics/read` JSON-RPC payload:
 * every field is derived from an O(1) / in-memory accessor so it is safe to hit
 * on a fast polling loop. `startup` is appended by `startAgentServer`, which owns
 * the readiness flag.
 */
export type HealthSnapshot = {
  ok: true;
  version: string;
  uptimeMs: number;
  cwd: string;
  activeSessions: number;
  db: { ok: boolean; lockWaitMs?: number };
  journal: { healthy: boolean; backlog: number };
  sendQueue: { dropped: number; queued: number };
};

export type RuntimeStartupReadiness = {
  ready: boolean;
  error?: string;
};

export type AgentServerRuntime = {
  config: AgentConfig;
  system: string;
  env: Record<string, string | undefined> & { COWORK_BUILTIN_DIR?: string };
  jsonRpcMaxPendingRequests: number;
  sendJsonRpc(ws: StartServerSocket, payload: unknown): void;
  openConnection(ws: StartServerSocket): void;
  openHttpConnection(connection: StartServerSocket): void;
  handleMessage(ws: StartServerSocket, raw: string | Buffer): void;
  handleDecodedMessage(ws: StartServerSocket, message: JsonRpcDecodedMessage): void;
  closeConnection(ws: StartServerSocket): void;
  drainConnection(ws: StartServerSocket): void;
  isAddrInUse(err: unknown): boolean;
  startIdleEviction(): ReturnType<typeof setInterval>;
  getHealthSnapshot(): HealthSnapshot;
  getStartupReadiness(): RuntimeStartupReadiness;
  waitForStartupReady(): Promise<void>;
  stop(): Promise<void>;
};

export async function createAgentServerRuntime(
  opts: StartAgentServerOptions,
): Promise<AgentServerRuntime> {
  const startedAtMs = Date.now();
  const rawEnv = opts.env ?? { ...process.env, AGENT_WORKING_DIR: opts.cwd };
  const env: Record<string, string | undefined> & {
    COWORK_BUILTIN_DIR?: string;
  } = { ...rawEnv };
  const parsedJsonRpcMaxPendingRequests = Number(
    env.COWORK_WS_JSONRPC_MAX_PENDING_REQUESTS ?? "128",
  );
  const jsonRpcMaxPendingRequests = Math.max(
    0,
    Number.isFinite(parsedJsonRpcMaxPendingRequests)
      ? Math.floor(parsedJsonRpcMaxPendingRequests)
      : 128,
  );
  const taskTerminalQuiesceTimeoutMs =
    typeof opts.taskTerminalQuiesceTimeoutMs === "number" &&
    Number.isFinite(opts.taskTerminalQuiesceTimeoutMs) &&
    opts.taskTerminalQuiesceTimeoutMs >= 0
      ? Math.floor(opts.taskTerminalQuiesceTimeoutMs)
      : 30_000;

  const builtInDir =
    typeof env.COWORK_BUILTIN_DIR === "string" && env.COWORK_BUILTIN_DIR.trim()
      ? env.COWORK_BUILTIN_DIR
      : undefined;

  let config = await loadConfig({ cwd: opts.cwd, env, homedir: opts.homedir, builtInDir });
  const mergedProviderOptions = mergeRuntimeProviderOptions(
    opts.providerOptions,
    config.providerOptions,
  );
  if (mergedProviderOptions) config.providerOptions = mergedProviderOptions;

  await fs.mkdir(config.projectCoworkDir, { recursive: true });

  let system = "";
  let discoveredSkills: Array<{ name: string; description: string }> = [];
  let initialSkillCatalogMtimeSnapshot: string | null = null;
  let startupReady = false;
  let startupError: string | null = null;
  let resolveStartupReady: () => void = () => undefined;
  const startupReadyPromise = new Promise<void>((resolve) => {
    resolveStartupReady = resolve;
  });
  const markStartupReady = (error?: unknown): void => {
    if (startupReady) return;
    startupReady = true;
    if (error !== undefined) {
      startupError = error instanceof Error ? error.message : String(error);
    }
    resolveStartupReady();
  };

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
  // Must complete before any session can start a turn: flips execution states
  // left as running/pending_init by a previous process that died mid-turn.
  try {
    const reconciled = await sessionDb.reconcileStaleExecutionStates();
    if (reconciled > 0) {
      console.warn(`[maintenance] reconciled ${reconciled} stale session execution state(s)`);
    }
  } catch (error) {
    console.warn(
      `[maintenance] execution state reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const fileLog = shouldEnableServerFileLog(env)
    ? new ServerFileLog({ logsDir: aiCoworkerPaths.logsDir })
    : null;
  const sendQueue = new SocketSendQueue();
  const sendJsonRpc = (ws: StartServerSocket, payload: unknown): void => {
    const compatiblePayload = projectToolRetryCompatibility(ws, payload);
    if (compatiblePayload !== null) {
      sendQueue.send(ws, compatiblePayload);
    }
  };
  const taskSubscribers = new WorkspaceJsonRpcSubscribers(sendQueue);
  const jsonRpcConnections = new Set<StartServerSocket>();
  const threadSubscribers = new Map<string, Map<string, StartServerSocket>>();
  const threadSubscriptionsByConnectionId = new Map<string, Set<string>>();
  const threadCreationKeys = new Map<string, string>();
  let workspaceListRevision = 0;
  const rememberThreadSubscriber = (ws: StartServerSocket, threadId: string): void => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;
    const subscribers = threadSubscribers.get(threadId) ?? new Map<string, StartServerSocket>();
    subscribers.set(connectionId, ws);
    threadSubscribers.set(threadId, subscribers);

    const threadIds = threadSubscriptionsByConnectionId.get(connectionId) ?? new Set<string>();
    threadIds.add(threadId);
    threadSubscriptionsByConnectionId.set(connectionId, threadIds);
  };
  const forgetThreadSubscriber = (ws: StartServerSocket, threadId: string): void => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;
    const subscribers = threadSubscribers.get(threadId);
    subscribers?.delete(connectionId);
    if (subscribers?.size === 0) threadSubscribers.delete(threadId);

    const threadIds = threadSubscriptionsByConnectionId.get(connectionId);
    threadIds?.delete(threadId);
    if (threadIds?.size === 0) threadSubscriptionsByConnectionId.delete(connectionId);
  };
  const forgetAllThreadSubscribers = (ws: StartServerSocket): void => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;
    const threadIds = threadSubscriptionsByConnectionId.get(connectionId);
    if (!threadIds) return;
    for (const threadId of threadIds) {
      const subscribers = threadSubscribers.get(threadId);
      subscribers?.delete(connectionId);
      if (subscribers?.size === 0) threadSubscribers.delete(threadId);
    }
    threadSubscriptionsByConnectionId.delete(connectionId);
  };
  const subscribeSourceChatToTaskWorkspace = (input: {
    sourceSessionId: string;
    workspacePath: string;
  }): void => {
    const subscribers = threadSubscribers.get(input.sourceSessionId);
    if (!subscribers) return;
    for (const ws of subscribers.values()) {
      if (ws.data.taskReadAllowed === false) continue;
      taskSubscribers.register(ws, input.workspacePath);
    }
  };
  const broadcastJsonRpcNotification = (method: string, params: unknown) => {
    for (const connection of jsonRpcConnections) {
      if (!connection.data.rpc || !sendQueue.shouldSendNotification(connection, method)) {
        continue;
      }
      sendJsonRpc(connection, { method, params });
    }
  };
  const broadcastWorkspaceListChanged = () => {
    workspaceListRevision += 1;
    broadcastJsonRpcNotification("workspace/listChanged", {
      revision: workspaceListRevision,
    });
  };
  const research = new ResearchService({
    rootDir: aiCoworkerPaths.rootDir,
    workspacePath: config.workingDirectory,
    sessionDb,
    getConfig: () => config,
    sendJsonRpc,
  });
  let registry!: SessionRegistry;
  const tasks = new TaskCoordinator({
    sessionDb,
    notify: ({ method, params }) => {
      const cwd = typeof params.cwd === "string" ? params.cwd : null;
      if (cwd) taskSubscribers.notify(cwd, method, params);
    },
    quiesceTaskThreads: async (task, reason) => {
      const waits: Promise<void>[] = [];
      const sessionIds = new Set(task.threads.map((thread) => thread.sessionId));
      if (task.sourceSessionId) sessionIds.add(task.sourceSessionId);
      for (const sessionId of sessionIds) {
        const binding = registry.sessionBindings.get(sessionId);
        const runtime = binding?.runtime;
        if (!runtime) {
          waits.push(
            registry.cancelAgentSessions(sessionId, {
              timeoutMs: taskTerminalQuiesceTimeoutMs,
            }),
          );
          continue;
        }
        const disposeRuntime = () => {
          try {
            runtime.lifecycle.dispose(`task ${task.id} ${reason}`, {
              closeSharedCodexClient: true,
            });
          } catch {
            // Continue quiescing sibling task threads.
          }
        };
        try {
          const taskLock = getSessionTaskLock(sessionDb, sessionId);
          waits.push(
            runtime.turns
              .cancelAndWaitForSettlement({
                includeSubagents: true,
                timeoutMs: taskTerminalQuiesceTimeoutMs,
                ...(taskLock ? { taskLock } : {}),
              })
              .catch((error) => {
                disposeRuntime();
                throw error;
              }),
          );
        } catch {
          disposeRuntime();
        }
      }
      const settled = await Promise.allSettled(waits);
      const rejection = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejection) throw rejection.reason;
    },
  });
  const threadJournal = new ThreadJournal(sessionDb);
  const worktreeService = new WorktreeService({ homedir: opts.homedir });
  const loadThreadSessionBootstrap = async (cwd: string) => {
    const threadConfig = await loadConfig({
      cwd,
      env: { ...env, AGENT_WORKING_DIR: cwd },
      homedir: opts.homedir,
      builtInDir,
    });
    const providerOptions = mergeRuntimeProviderOptions(
      opts.providerOptions,
      threadConfig.providerOptions,
    );
    if (providerOptions) threadConfig.providerOptions = providerOptions;
    const loadSystemPromptWithSkills =
      opts.loadSystemPromptWithSkillsImpl ?? lazyLoadSystemPromptWithSkills;
    const prompt = await loadSystemPromptWithSkills(threadConfig);
    return { config: threadConfig, system: prompt.prompt };
  };
  let workspaceControl: WorkspaceControl;
  let skillMutationBus: SkillMutationBus;
  let skillImprovement: SkillImprovementService;
  let localThreadHost: LocalThreadHost | null = null;
  let threadManagement: ThreadManagementService | null = null;
  registry = new SessionRegistry({
    config,
    env,
    system,
    discoveredSkills,
    fileLog,
    yolo: opts.yolo,
    homedir: opts.homedir,
    connectProviderImpl: opts.connectProviderImpl,
    getAiCoworkerPathsImpl,
    runTurnImpl: opts.runTurnImpl,
    sessionDb,
    taskCoordinator: tasks,
    threadJournal,
    loadAgentPrompt: opts.loadAgentPromptImpl ?? lazyLoadAgentPrompt,
    setConfig: (nextConfig) => {
      config = nextConfig;
    },
    readSkillCatalogMtimeSnapshot,
    initialSkillCatalogMtimeSnapshot,
    shouldWarmSessionResources: () => startupReady,
    onThreadListChanged: broadcastWorkspaceListChanged,
    refreshSkillsAcrossWorkspaceSessions: async ({
      workingDirectory,
      sourceSessionId,
      allWorkspaces = false,
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
    recordSkillImprovementUsage: async (usage) =>
      await skillImprovement.recordCompletedTurnUsage(usage),
    onTaskCreatedFromChat: subscribeSourceChatToTaskWorkspace,
    getThreadControl: (sessionId) => {
      if (!localThreadHost?.isSessionEligibleForTools(sessionId)) return null;
      return threadManagement?.createControl(sessionId) ?? null;
    },
  });
  localThreadHost = new LocalThreadHost({
    sessionDb,
    registry,
    threadJournal,
    taskCoordinator: tasks,
    desktopService: opts.desktopService ?? null,
    worktreeService,
    getConfig: () => config,
    loadThreadSessionBootstrap,
    homedir: opts.homedir,
    onThreadListChanged: broadcastWorkspaceListChanged,
  });
  threadManagement = new ThreadManagementService([localThreadHost]);
  tasks.setThreadFactory(async ({ task, provider, model }) => {
    const runtime = registry.createJsonRpcThreadSession(
      task.workspacePath,
      provider as AgentConfig["provider"] | undefined,
      model,
    );
    await runtime.lifecycle.waitForPersistenceIdle();
    return { sessionId: runtime.id };
  });
  tasks.setContinuationDispatcher(async (input) => await registry.dispatchTaskContinuation(input));
  await tasks.reconcileFailedRuns();
  await tasks.reconcilePendingArtifactRevisionSettlements();

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
      sessionBindings: registry.sessionBindings.values(),
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

  workspaceControl = new WorkspaceControl({
    env,
    builtInDir,
    homedir: opts.homedir,
    yolo: opts.yolo,
    runtimeProviderOptions: opts.providerOptions,
    fallbackWorkingDirectory: config.workingDirectory,
    registry,
    socketSendQueue: sendQueue,
  });

  skillMutationBus = new SkillMutationBus({
    userCoworkDir: config.userCoworkDir,
    workingDirectory: config.workingDirectory,
    refreshLocalSkillState,
  });
  await skillMutationBus.start();

  skillImprovement = new SkillImprovementService({
    config,
    // Settings applied through workspace control sessions persist to disk but
    // never update this module's `config` binding, so always reload the
    // effective config (optionally for a specific workspace) from disk.
    getConfig: async (cwd?: string) => {
      const targetCwd = cwd?.trim() || config.workingDirectory;
      const fresh = await loadConfig({
        cwd: targetCwd,
        env: { ...env, AGENT_WORKING_DIR: targetCwd },
        homedir: opts.homedir,
        builtInDir,
      });
      const providerOptions = mergeRuntimeProviderOptions(
        opts.providerOptions,
        fresh.providerOptions,
      );
      if (providerOptions) fresh.providerOptions = providerOptions;
      return fresh;
    },
    hasBusySessions: () =>
      [...registry.sessionBindings.values()].some((binding) => binding.runtime?.read.isBusy),
    signalSkillMutation: async () => {
      await refreshLocalSkillState({
        workingDirectory: config.workingDirectory,
        allWorkspaces: true,
      });
      await skillMutationBus.publish();
    },
    broadcastStatus: (event) => workspaceControl.broadcastSkillImprovementStatus(event),
    log: (line) => console.warn(line),
  });
  skillImprovement.start();

  const runStartupReadinessWork = async (): Promise<void> => {
    // Deferred housekeeping (stream-chunk retention, leaked temp files, backup
    // pruning) must never delay or fail startup readiness.
    void runStartupMaintenance({
      sessionDb,
      sessionsDir: aiCoworkerPaths.sessionsDir,
      homedir: opts.homedir,
      log: (line) => console.warn(line),
    }).catch(() => {
      // best-effort housekeeping only
    });

    const failures: string[] = [];
    const ensureRuntimeReady = opts.ensureCoworkRuntimeReadyImpl ?? ensureCoworkRuntimeReady;
    const ensureDefaultSkillsReady =
      opts.ensureDefaultGlobalSkillsReadyImpl ?? ensureDefaultGlobalSkillsReady;
    const loadSystemPromptWithSkills =
      opts.loadSystemPromptWithSkillsImpl ?? lazyLoadSystemPromptWithSkills;
    const runtimeSetup = ensureRuntimeReady({
      homedir: opts.homedir,
      env,
      onProgress: opts.onCoworkRuntimeBootstrapProgress,
      log: (line) => {
        console.warn(`[cowork-runtime] ${line}`);
      },
    }).then((coworkRuntimeSetup) => {
      if (coworkRuntimeSetup) Object.assign(env, coworkRuntimeSetup.runtimeEnv);
    });
    const defaultSkillsSetup = ensureDefaultSkillsReady({
      homedir: opts.homedir,
      env,
      config,
      log: (line) => {
        console.warn(`[default-skills] ${line}`);
      },
    });

    const [runtimeSettled, defaultSkillsSettled] = await Promise.allSettled([
      runtimeSetup,
      defaultSkillsSetup,
    ]);
    if (runtimeSettled.status === "rejected") {
      failures.push(
        `Cowork runtime setup failed: ${
          runtimeSettled.reason instanceof Error
            ? runtimeSettled.reason.message
            : String(runtimeSettled.reason)
        }`,
      );
    }
    if (defaultSkillsSettled.status === "rejected") {
      failures.push(
        `Default skill setup failed: ${
          defaultSkillsSettled.reason instanceof Error
            ? defaultSkillsSettled.reason.message
            : String(defaultSkillsSettled.reason)
        }`,
      );
    }

    if (opts.preloadSystemPrompt !== false) {
      try {
        const loadedSystemPrompt = await loadSystemPromptWithSkills(config);
        system = loadedSystemPrompt.prompt;
        discoveredSkills = loadedSystemPrompt.discoveredSkills;
        initialSkillCatalogMtimeSnapshot = await readSkillCatalogMtimeSnapshot(config);
        registry.updateSystemPromptSnapshot({
          system,
          discoveredSkills,
          initialSkillCatalogMtimeSnapshot,
        });
      } catch (error) {
        failures.push(
          `System prompt preload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    registry.warmLiveSessionResources();
    if (failures.length > 0) {
      console.warn(`[startup] ${failures.join("; ")}`);
      markStartupReady(new Error(failures.join("; ")));
      return;
    }
    markStartupReady();
  };

  void runStartupReadinessWork().catch((error) => {
    console.warn(`[startup] ${error instanceof Error ? error.message : String(error)}`);
    markStartupReady(error);
  });

  const jsonRpcTransport = createJsonRpcTransportAdapter({
    maxPendingRequests: jsonRpcMaxPendingRequests,
    loadThreadBinding: (threadId) => registry.loadThreadBinding(threadId),
    getThreadBinding: (threadId) => registry.sessionBindings.get(threadId),
    addBindingSink: (binding, sinkId, sink) => registry.addBindingSink(binding, sinkId, sink),
    removeBindingSink: (binding, sinkId) => registry.removeBindingSink(binding, sinkId),
    countLiveConnectionSinks: (binding) => registry.countLiveConnectionSinks(binding),
    listThreadJournalEvents: (threadId, journalOpts) => threadJournal.list(threadId, journalOpts),
    getThreadJournalTailSeq: (threadId) => sessionDb.getThreadJournalTailSeq(threadId),
    enqueueThreadJournalEvent: async (event) => await threadJournal.enqueue(event),
    shouldSendNotification: (ws, method) => sendQueue.shouldSendNotification(ws, method),
    sendJsonRpc,
    extractTextInput: extractJsonRpcTextInput,
  });
  const disposeDesktopStateWatcher =
    opts.desktopService?.watchStateChanges?.(() => {
      broadcastWorkspaceListChanged();
    }) ?? null;
  const conversationImports = createConversationImportService({
    sessionDb,
    // HOME is normally unset on Windows; the old `env.HOME ?? process.cwd()`
    // fallback made external-conversation discovery silently probe the
    // workspace cwd and find nothing there. platform home() resolves the real
    // profile dir on every OS (with the COWORK_HOME_OVERRIDE test lever).
    homedir: opts.homedir ?? home(env),
    getConfig: () => config,
    desktopService: opts.desktopService ?? null,
    onWorkspaceListChanged: broadcastWorkspaceListChanged,
  });

  const withJsonRpcThreadMetadata = (thread: JsonRpcThread): JsonRpcThread => {
    const metadata = sessionDb.getThreadMetadata(thread.id);
    return {
      ...thread,
      pinned: metadata?.pinned ?? false,
      pinnedAt: metadata?.pinnedAt ?? null,
      archived: metadata?.archived ?? false,
      archivedAt: metadata?.archivedAt ?? null,
    };
  };

  const jsonRpcRouteContext: JsonRpcRouteContext = {
    getConfig: () => config,
    homedir: opts.homedir,
    research,
    skillImprovement,
    tasks,
    conversationImports,
    taskRequests: {
      onStarted: ({ ws, method, workspacePath }) => {
        if (!shouldRegisterTaskSubscriber(method, ws)) return;
        return taskSubscribers.beginBufferedRegistration(ws, workspacePath);
      },
      onSucceeded: ({ ws, method, workspacePath }) => {
        workspaceControl.registerSubscriber(ws, workspacePath);
        if (shouldRegisterTaskSubscriber(method, ws)) {
          taskSubscribers.register(ws, workspacePath);
        }
      },
    },
    threads: {
      create: ({ cwd, provider, model }) =>
        registry.createJsonRpcThreadSession(cwd, provider, model),
      load: (threadId) => registry.loadThreadBinding(threadId),
      getLive: (threadId) => registry.sessionBindings.get(threadId),
      getPersisted: (threadId) => sessionDb.getSessionRecord(threadId),
      listPersisted: ({ cwd } = {}) =>
        sessionDb
          .listSessions({ ...(cwd ? { workingDirectory: cwd } : {}) })
          .filter((record) => !tasks.isTaskThread(record.sessionId))
          .map((record) => sessionDb.getSessionRecord(record.sessionId))
          .filter((record): record is PersistedSessionRecord => record !== null),
      listLiveRoot: ({ cwd } = {}) =>
        registry.listLiveRoot({ cwd }).filter((runtime) => !tasks.isTaskThread(runtime.id)),
      subscribe: (ws, threadId, subscribeOpts) => {
        const binding = jsonRpcTransport.subscribeThread(ws, threadId, subscribeOpts);
        if (binding?.runtime) rememberThreadSubscriber(ws, threadId);
        return binding;
      },
      unsubscribe: (ws, threadId) => {
        const result = jsonRpcTransport.unsubscribeThread(ws, threadId);
        if (result === "unsubscribed") forgetThreadSubscriber(ws, threadId);
        return result;
      },
      readSnapshot: (threadId) => registry.readThreadSnapshot(threadId),
      getByCreationKey: (key) => {
        let threadId = threadCreationKeys.get(key);
        if (!threadId) {
          threadId = sessionDb.getThreadIdByCreationKey(key) ?? undefined;
          if (threadId) {
            threadCreationKeys.set(key, threadId);
          }
        }
        if (!threadId) return null;
        const runtime = registry.loadThreadBinding(threadId)?.runtime ?? null;
        if (!runtime) {
          threadCreationKeys.delete(key);
        }
        return runtime;
      },
      rememberCreationKey: async (key, threadId) => {
        threadCreationKeys.set(key, threadId);
        await sessionDb.rememberThreadCreationKey(key, threadId);
      },
    },
    workspaceControl: {
      getOrCreateBinding: async (cwd) => await workspaceControl.getOrCreateBinding(cwd),
      withSession: async (cwd, runner) => await workspaceControl.withSession(cwd, runner),
      readState: async (cwd) => await workspaceControl.readState(cwd),
    },
    desktopService: opts.desktopService ?? null,
    threadManagement: {
      forkThread: async (input) => {
        if (!localThreadHost) throw new Error("Thread management is unavailable");
        return await localThreadHost.forkThread(input);
      },
      setPinned: async (input) => {
        if (!localThreadHost) throw new Error("Thread management is unavailable");
        return await localThreadHost.setPinned(input);
      },
      setArchived: async (input) => {
        if (!localThreadHost) throw new Error("Thread management is unavailable");
        return await localThreadHost.setArchived(input);
      },
    },
    journal: {
      enqueue: async (event) => await threadJournal.enqueue(event),
      waitForIdle: async (threadId) => await threadJournal.waitForIdle(threadId),
      list: (threadId, journalOpts) => threadJournal.list(threadId, journalOpts),
      replay: (ws, threadId, afterSeq, limit) =>
        jsonRpcTransport.replayJournal(ws, threadId, afterSeq, limit),
      getHealth: (threadId) => threadJournal.getHealth(threadId),
    },
    events: {
      capture: registry.sessionEventCapture.capture,
      captureMutationOutcome: registry.sessionEventCapture.captureMutationOutcome,
      captureMutationEvents: registry.sessionEventCapture.captureMutationEvents,
    },
    runtime: {
      checkLibreOffice: async (checkOpts) =>
        await checkLibreOfficeCapability({
          env,
          smoke: checkOpts.smoke === true,
        }),
      getDiagnostics: () => {
        const threadIds = new Set<string>([
          ...registry.sessionBindings.keys(),
          ...sessionDb.listSessions().map((record) => record.sessionId),
        ]);
        let untrustedThreadCount = 0;
        let failedWriteCount = 0;
        let droppedEventCount = 0;
        let pendingThreadCount = 0;
        for (const threadId of threadIds) {
          const health = threadJournal.getHealth(threadId);
          if (!health.trusted) {
            untrustedThreadCount += 1;
          }
          failedWriteCount += health.failedWriteCount;
          droppedEventCount += health.droppedEventCount;
          if (health.pendingEventCount > 0) {
            pendingThreadCount += 1;
          }
        }
        return {
          startup: {
            ready: startupReady,
            ...(startupError ? { error: startupError } : {}),
          },
          sendQueue: sendQueue.getStats(),
          journal: {
            untrustedThreadCount,
            failedWriteCount,
            droppedEventCount,
            pendingThreadCount,
          },
          dbLocks: sessionDb.getWriteLockDiagnostics(),
        };
      },
      waitForStartupReady: async () => {
        await startupReadyPromise;
      },
    },
    lmstudioLocal: createLmStudioLocalService({ env }),
    jsonrpc: {
      send: sendJsonRpc,
      sendResult: (ws, id, result) => sendJsonRpc(ws, buildJsonRpcResultResponse(id, result)),
      sendError: (ws, id, error) => sendJsonRpc(ws, buildJsonRpcErrorResponse(id, error)),
    },
    utils: {
      resolveWorkspacePath: (params, method) =>
        requireWorkspacePath(params, method, config.workingDirectory, opts.homedir),
      extractTextInput: extractJsonRpcTextInput,
      extractInput: extractJsonRpcInput,
      buildThreadFromSession: (runtime) =>
        withJsonRpcThreadMetadata(buildJsonRpcThreadFromSession(runtime)),
      buildThreadFromRecord: (record) =>
        withJsonRpcThreadMetadata(buildJsonRpcThreadFromRecord(record)),
      shouldIncludeThreadSummary: shouldIncludeJsonRpcThreadSummary,
      buildControlSessionStateEvents,
      isSessionError: isJsonRpcSessionError,
    },
  };
  const jsonRpcRequestRouter = createJsonRpcRequestRouter(jsonRpcRouteContext);

  const routeJsonRpcRequest = async (ws: StartServerSocket, message: JsonRpcRequest) => {
    const params = isPlainObject(message.params) ? message.params : undefined;
    if (params || message.method.startsWith("task/")) {
      try {
        const isTaskMethod = message.method.startsWith("task/");
        if (!isTaskMethod) {
          const cwd = requireWorkspacePath(
            params ?? {},
            message.method,
            config.workingDirectory,
            opts.homedir,
          );
          workspaceControl.registerSubscriber(ws, cwd);
        }
      } catch {
        // Ignore non-workspace-control requests that do not resolve a cwd.
      }
    }
    await jsonRpcRequestRouter(ws, message);
  };

  let stopped = false;

  return {
    get config() {
      return config;
    },
    get system() {
      return system;
    },
    env,
    jsonRpcMaxPendingRequests,
    sendJsonRpc,
    openConnection: (ws) => {
      jsonRpcConnections.add(ws);
      jsonRpcTransport.openConnection(ws);
    },
    openHttpConnection: (connection) => {
      jsonRpcConnections.add(connection);
      jsonRpcTransport.openConnection(connection);
      connection.data.selectedSubprotocol ??= "cowork.jsonrpc.v1";
      connection.data.protocolMode ??= "h3";
    },
    handleDecodedMessage: (ws, message) => {
      jsonRpcTransport.handleMessage(ws, message, routeJsonRpcRequest);
    },
    handleMessage: (ws, raw) => {
      const decoded = decodeJsonRpcMessage(raw);
      if (!decoded.ok) {
        sendJsonRpc(ws, decoded.response);
        return;
      }
      jsonRpcTransport.handleMessage(ws, decoded.message, routeJsonRpcRequest);
    },
    closeConnection: (ws) => {
      jsonRpcConnections.delete(ws);
      workspaceControl.removeSubscriber(ws);
      taskSubscribers.remove(ws);
      forgetAllThreadSubscribers(ws);
      research.unsubscribeAll(ws);
      jsonRpcTransport.closeConnection(ws);
      sendQueue.deleteConnection(ws.data.connectionId);
    },
    drainConnection: (ws) => {
      sendQueue.flush(ws);
    },
    isAddrInUse: (err) => isErrorWithCode(err, "EADDRINUSE"),
    startIdleEviction: () =>
      setInterval(() => {
        registry.evictIdleSessionBindings(5 * 60 * 1000);
      }, 60_000),
    getHealthSnapshot: () => {
      const lockDiagnostics = sessionDb.getWriteLockDiagnostics();
      const journalHealth = threadJournal.getAggregateHealth();
      const sendQueueStats = sendQueue.getStats();
      return {
        ok: true,
        version: resolveVersion(env),
        uptimeMs: Date.now() - startedAtMs,
        cwd: config.workingDirectory,
        activeSessions: registry.sessionBindings.size,
        db: {
          ok: sessionDb.ping(),
          ...(lockDiagnostics.maxWaitMs > 0 ? { lockWaitMs: lockDiagnostics.maxWaitMs } : {}),
        },
        journal: {
          healthy: journalHealth.healthy,
          backlog: journalHealth.backlog,
        },
        sendQueue: {
          dropped: sendQueueStats.droppedDeltas + sendQueueStats.droppedImportant,
          queued: sendQueueStats.queuedSends,
        },
      };
    },
    getStartupReadiness: () => ({
      ready: startupReady,
      ...(startupError ? { error: startupError } : {}),
    }),
    waitForStartupReady: async () => {
      await startupReadyPromise;
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (!startupReady) {
        markStartupReady(new Error("Server stopped before startup completed"));
      }
      disposeDesktopStateWatcher?.();
      skillImprovement.stop();
      skillMutationBus.stop();
      workspaceControl.clearSubscribers();
      taskSubscribers.clear();
      threadSubscribers.clear();
      threadSubscriptionsByConnectionId.clear();
      await threadJournal.close();
      await registry.disposeAll("server stopping");
      await fileLog?.flush();
      try {
        sessionDb.close();
      } catch {
        // ignore
      }
      try {
        const { shutdownObservabilityRuntime } = await import("../../observability/runtime");
        await shutdownObservabilityRuntime();
      } catch {
        // ignore
      }
    },
  };
}
