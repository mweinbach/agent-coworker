import fs from "node:fs/promises";
import type { runTurn as runTurnFn } from "../../agent";
import { loadConfig } from "../../config";
import type { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../../connect";
import { getAiCoworkerPaths as getAiCoworkerPathsDefault } from "../../connect";
import type { emitObservabilityEvent as emitObservabilityEventFn } from "../../observability/otel";
import type {
  loadAgentPrompt as loadAgentPromptFn,
  loadSystemPromptWithSkills as loadSystemPromptWithSkillsFn,
} from "../../prompt";
import { ensureDefaultGlobalSkillsReady } from "../../skills/defaultGlobalSkills";
import type { AgentConfig } from "../../types";
import { decodeJsonRpcMessage } from "../jsonrpc/decodeJsonRpcMessage";
import { buildJsonRpcErrorResponse, buildJsonRpcResultResponse } from "../jsonrpc/protocol";
import { createJsonRpcRequestRouter } from "../jsonrpc/routes";
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
import { createJsonRpcTransportAdapter } from "../jsonrpc/transportAdapter";
import { ResearchService } from "../research/ResearchService";
import { type PersistedSessionRecord, SessionDb } from "../sessionDb";
import { refreshSessionsForSkillMutation } from "../skillMutationRefresh";
import type { StartServerSocket } from "../startServer/types";
import { isErrorWithCode, isPlainObject, mergeRuntimeProviderOptions } from "./ConfigPatchStore";
import { SessionRegistry } from "./SessionRegistry";
import { SkillMutationBus } from "./SkillMutationBus";
import { SocketSendQueue } from "./SocketSendQueue";
import { ThreadJournal } from "./ThreadJournal";
import { WorkspaceControl } from "./WorkspaceControl";

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

const lazyLoadSystemPromptWithSkills: typeof loadSystemPromptWithSkillsFn = async (...args) =>
  await (await loadPromptModule()).loadSystemPromptWithSkills(...args);

export interface StartAgentServerOptions {
  cwd: string;
  hostname?: string;
  port?: number;
  env?: Record<string, string | undefined>;
  providerOptions?: Record<string, unknown>;
  yolo?: boolean;
  homedir?: string;
  connectProviderImpl?: typeof connectModelProvider;
  getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
  runTurnImpl?: typeof runTurnFn;
  preloadSystemPrompt?: boolean;
}

type JsonRpcRequest = { id: string | number; method: string; params?: unknown };

export type AgentServerRuntime = {
  config: AgentConfig;
  system: string;
  env: Record<string, string | undefined> & { COWORK_BUILTIN_DIR?: string };
  jsonRpcMaxPendingRequests: number;
  sendJsonRpc(ws: StartServerSocket, payload: unknown): void;
  openConnection(ws: StartServerSocket): void;
  handleMessage(ws: StartServerSocket, raw: string | Buffer): void;
  closeConnection(ws: StartServerSocket): void;
  drainConnection(ws: StartServerSocket): void;
  isAddrInUse(err: unknown): boolean;
  startIdleEviction(): ReturnType<typeof setInterval>;
  stop(): Promise<void>;
};

export async function createAgentServerRuntime(
  opts: StartAgentServerOptions,
): Promise<AgentServerRuntime> {
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
  const mergedProviderOptions = mergeRuntimeProviderOptions(
    opts.providerOptions,
    config.providerOptions,
  );
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
  const sendQueue = new SocketSendQueue();
  const research = new ResearchService({
    rootDir: aiCoworkerPaths.rootDir,
    workspacePath: config.workingDirectory,
    sessionDb,
    getConfig: () => config,
    sendJsonRpc: (ws, payload) => sendQueue.send(ws, payload),
  });
  const threadJournal = new ThreadJournal(sessionDb);
  let workspaceControl: WorkspaceControl;
  let skillMutationBus: SkillMutationBus;
  const registry = new SessionRegistry({
    config,
    system,
    discoveredSkills,
    yolo: opts.yolo,
    homedir: opts.homedir,
    connectProviderImpl: opts.connectProviderImpl,
    getAiCoworkerPathsImpl,
    runTurnImpl: opts.runTurnImpl,
    sessionDb,
    threadJournal,
    loadAgentPrompt: lazyLoadAgentPrompt,
    setConfig: (nextConfig) => {
      config = nextConfig;
    },
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
  });

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
    userAgentDir: config.userAgentDir,
    workingDirectory: config.workingDirectory,
    refreshLocalSkillState,
  });
  await skillMutationBus.start();

  const jsonRpcTransport = createJsonRpcTransportAdapter({
    maxPendingRequests: jsonRpcMaxPendingRequests,
    loadThreadBinding: (threadId) => registry.loadThreadBinding(threadId),
    getThreadBinding: (threadId) => registry.sessionBindings.get(threadId),
    addBindingSink: (binding, sinkId, sink) => registry.addBindingSink(binding, sinkId, sink),
    removeBindingSink: (binding, sinkId) => registry.removeBindingSink(binding, sinkId),
    countLiveConnectionSinks: (binding) => registry.countLiveConnectionSinks(binding),
    listThreadJournalEvents: (threadId, journalOpts) => threadJournal.list(threadId, journalOpts),
    enqueueThreadJournalEvent: async (event) => await threadJournal.enqueue(event),
    shouldSendNotification: (ws, method) => sendQueue.shouldSendNotification(ws, method),
    sendJsonRpc: (ws, payload) => sendQueue.send(ws, payload),
    extractTextInput: extractJsonRpcTextInput,
  });

  const jsonRpcRequestRouter = createJsonRpcRequestRouter({
    getConfig: () => config,
    research,
    threads: {
      create: ({ cwd, provider, model }) =>
        registry.createJsonRpcThreadSession(cwd, provider, model),
      load: (threadId) => registry.loadThreadBinding(threadId),
      getLive: (threadId) => registry.sessionBindings.get(threadId),
      getPersisted: (threadId) => sessionDb.getSessionRecord(threadId),
      listPersisted: ({ cwd } = {}) =>
        sessionDb
          .listSessions({ ...(cwd ? { workingDirectory: cwd } : {}) })
          .map((record) => sessionDb.getSessionRecord(record.sessionId))
          .filter((record): record is PersistedSessionRecord => record !== null),
      listLiveRoot: ({ cwd } = {}) => registry.listLiveRoot({ cwd }),
      subscribe: (ws, threadId, subscribeOpts) =>
        jsonRpcTransport.subscribeThread(ws, threadId, subscribeOpts),
      unsubscribe: (ws, threadId) => jsonRpcTransport.unsubscribeThread(ws, threadId),
      readSnapshot: (threadId) => registry.readThreadSnapshot(threadId),
    },
    workspaceControl: {
      getOrCreateBinding: async (cwd) => await workspaceControl.getOrCreateBinding(cwd),
      withSession: async (cwd, runner) => await workspaceControl.withSession(cwd, runner),
      readState: async (cwd) => await workspaceControl.readState(cwd),
    },
    journal: {
      enqueue: async (event) => await threadJournal.enqueue(event),
      waitForIdle: async (threadId) => await threadJournal.waitForIdle(threadId),
      list: (threadId, journalOpts) => threadJournal.list(threadId, journalOpts),
      replay: (ws, threadId, afterSeq, limit) =>
        jsonRpcTransport.replayJournal(ws, threadId, afterSeq, limit),
    },
    events: {
      capture: registry.sessionEventCapture.capture,
      captureMutationOutcome: registry.sessionEventCapture.captureMutationOutcome,
      captureMutationEvents: registry.sessionEventCapture.captureMutationEvents,
    },
    jsonrpc: {
      send: (ws, payload) => sendQueue.send(ws, payload),
      sendResult: (ws, id, result) => sendQueue.send(ws, buildJsonRpcResultResponse(id, result)),
      sendError: (ws, id, error) => sendQueue.send(ws, buildJsonRpcErrorResponse(id, error)),
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

  const routeJsonRpcRequest = async (ws: StartServerSocket, message: JsonRpcRequest) => {
    const params = isPlainObject(message.params) ? message.params : undefined;
    if (params) {
      try {
        workspaceControl.registerSubscriber(
          ws,
          requireWorkspacePath(params, message.method, config.workingDirectory),
        );
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
    system,
    env,
    jsonRpcMaxPendingRequests,
    sendJsonRpc: (ws, payload) => sendQueue.send(ws, payload),
    openConnection: (ws) => {
      jsonRpcTransport.openConnection(ws);
    },
    handleMessage: (ws, raw) => {
      const decoded = decodeJsonRpcMessage(raw);
      if (!decoded.ok) {
        sendQueue.send(ws, decoded.response);
        return;
      }
      jsonRpcTransport.handleMessage(ws, decoded.message, routeJsonRpcRequest);
    },
    closeConnection: (ws) => {
      workspaceControl.removeSubscriber(ws);
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
    stop: async () => {
      if (stopped) return;
      stopped = true;
      skillMutationBus.stop();
      workspaceControl.clearSubscribers();
      await registry.disposeAll("server stopping");
      try {
        sessionDb.close();
      } catch {
        // ignore
      }
    },
  };
}
