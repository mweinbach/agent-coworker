import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";

const jsonRpcRequests: Array<{ method: string; params?: unknown; options?: unknown }> = [];
const jsonRpcResponses: Array<{ id: string | number; result: unknown; options?: unknown }> = [];
const jsonRpcHandlers = new Map<string, (params?: any) => any | Promise<any>>();

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  static deferClose = false;
  readonly readyPromise = Promise.resolve();
  closed = false;
  connectCalls = 0;
  private closeDeferred = false;

  constructor(
    public readonly opts: {
      url?: string;
      openTimeoutMs?: number;
      handshakeTimeoutMs?: number;
      onOpen?: () => void;
      onClose?: () => void;
      onReconnecting?: (event: unknown) => void;
      onReconnectExhausted?: () => void;
      onNotification?: (message: { method: string; params?: unknown }) => void;
    },
  ) {
    MockJsonRpcSocket.instances.push(this);
  }

  connect() {
    this.connectCalls += 1;
    this.opts.onOpen?.();
  }

  async request(method: string, params?: unknown, options?: unknown) {
    jsonRpcRequests.push({ method, params, options });
    const handler = jsonRpcHandlers.get(method);
    if (!handler) {
      return {};
    }
    return await handler(params);
  }

  respond(id: string | number, result: unknown, options?: unknown) {
    jsonRpcResponses.push({ id, result, options });
    return true;
  }

  close() {
    this.closed = true;
    if (MockJsonRpcSocket.deferClose) {
      this.closeDeferred = true;
      return;
    }
    this.opts.onClose?.();
  }

  emitDeferredClose() {
    if (!this.closeDeferred) return;
    this.closeDeferred = false;
    this.opts.onClose?.();
  }

  reconnecting() {
    this.opts.onReconnecting?.({
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      reason: "websocket closed",
      queuedOperationCount: 0,
      pendingRequestCount: 0,
    } as never);
  }

  reconnectExhausted() {
    this.opts.onReconnectExhausted?.();
  }
}

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { createControlSocketHelpers } = await import("../src/app/store.helpers/controlSocket");
const { ensureWorkspaceJsonRpcSocket, requestJsonRpc, respondToJsonRpcRequest } = await import(
  "../src/app/store.helpers/jsonRpcSocket"
);
const { RUNTIME, defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");

let persistCalls = 0;

const deps = {
  nowIso: () => "2026-03-20T00:00:00.000Z",
  makeId: () => "note-1",
  persist: () => {
    persistCalls += 1;
  },
  pushNotification: <T>(notifications: T[], entry: T) => [...notifications, entry],
  isProviderName: () => true,
};

function makeThread(threadId: string, workspaceId: string) {
  return {
    id: threadId,
    workspaceId,
    title: threadId,
    titleSource: "manual" as const,
    createdAt: "2026-03-20T00:00:00.000Z",
    lastMessageAt: "2026-03-20T00:00:00.000Z",
    status: "active" as const,
    sessionId: threadId,
    messageCount: 1,
    lastEventSeq: 1,
    draft: false,
    legacyTranscriptId: null,
  };
}

function makeThreadListEntry(threadId: string) {
  return {
    id: threadId,
    title: threadId,
    preview: "",
    modelProvider: "openai",
    model: "gpt-5.2",
    cwd: "/tmp/workspace",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
    messageCount: 1,
    lastEventSeq: 1,
    status: { type: "idle" },
  };
}

function createState(workspaceId: string, patch: Record<string, unknown> = {}) {
  const state = {
    selectedWorkspaceId: workspaceId,
    selectedThreadId: null,
    threads: [],
    threadRuntimeById: {},
    workspaceRuntimeById: {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://mock",
        ...((patch.workspaceRuntimeById as Record<string, unknown> | undefined)?.[workspaceId] ??
          {}),
      },
    },
    workspaces: [
      {
        id: workspaceId,
        name: "Workspace",
        path: "/tmp/workspace",
        createdAt: "2026-03-20T00:00:00.000Z",
        lastOpenedAt: "2026-03-20T00:00:00.000Z",
        wsProtocol: "jsonrpc",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    notifications: [],
    providerStatusByName: {},
    providerStatusLastUpdatedAt: null,
    providerStatusRefreshing: false,
    providerCatalog: [],
    providerDefaultModelByProvider: {},
    providerConnected: [],
    providerAuthMethodsByProvider: {},
    providerLastAuthChallenge: null,
    providerLastAuthResult: null,
    view: "chat",
    ...patch,
  } as any;
  const get = () => state;
  const set = (updater: any) => {
    const patchValue = typeof updater === "function" ? updater(state) : updater;
    Object.assign(state, patchValue);
  };
  return { state, get, set };
}

function installFakeSocket(
  workspaceId: string,
  request: (method: string, params?: any) => any | Promise<any>,
) {
  RUNTIME.jsonRpcSockets.set(workspaceId, {
    readyPromise: Promise.resolve(),
    request,
    respond: () => true,
    close: () => {},
  } as any);
}

async function flushAsyncWork() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

export function registerControlSocketLifecycleHooks() {
  beforeEach(() => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    jsonRpcRequests.length = 0;
    jsonRpcResponses.length = 0;
    jsonRpcHandlers.clear();
    MockJsonRpcSocket.instances.length = 0;
    MockJsonRpcSocket.deferClose = false;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    RUNTIME.pluginInstallWaiters.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.providerStatusRefreshGeneration = 0;
    RUNTIME.mcpOAuthRefreshPollGenerations.clear();
    RUNTIME.agentProfilesCatalogGenerations.clear();
    persistCalls = 0;
  });

  afterEach(() => {
    clearJsonRpcSocketOverride();
  });
}

export {
  clearJsonRpcSocketOverride,
  createControlSocketHelpers,
  createState,
  defaultWorkspaceRuntime,
  deps,
  ensureWorkspaceJsonRpcSocket,
  flushAsyncWork,
  installFakeSocket,
  jsonRpcHandlers,
  jsonRpcRequests,
  jsonRpcResponses,
  MockJsonRpcSocket,
  makeThread,
  makeThreadListEntry,
  persistCalls,
  RUNTIME,
  requestJsonRpc,
  respondToJsonRpcRequest,
  setJsonRpcSocketOverride,
};
