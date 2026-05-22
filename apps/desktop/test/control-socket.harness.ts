import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcHandlers = new Map<string, (params?: any) => any | Promise<any>>();

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  static deferClose = false;
  readonly readyPromise = Promise.resolve();
  closed = false;
  private closeDeferred = false;

  constructor(
    public readonly opts: {
      url?: string;
      onOpen?: () => void;
      onClose?: () => void;
      onNotification?: (message: { method: string; params?: unknown }) => void;
    },
  ) {
    MockJsonRpcSocket.instances.push(this);
  }

  connect() {
    this.opts.onOpen?.();
  }

  async request(method: string, params?: unknown) {
    jsonRpcRequests.push({ method, params });
    const handler = jsonRpcHandlers.get(method);
    if (!handler) {
      return {};
    }
    return await handler(params);
  }

  respond() {
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
}

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { createControlSocketHelpers } = await import("../src/app/store.helpers/controlSocket");
const { ensureWorkspaceJsonRpcSocket } = await import("../src/app/store.helpers/jsonRpcSocket");
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
    modelProvider: "openai",
    model: "gpt-5.2",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
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
    jsonRpcHandlers.clear();
    MockJsonRpcSocket.instances.length = 0;
    MockJsonRpcSocket.deferClose = false;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    RUNTIME.pluginInstallWaiters.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.providerStatusRefreshGeneration = 0;
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
  MockJsonRpcSocket,
  makeThread,
  makeThreadListEntry,
  persistCalls,
  RUNTIME,
  setJsonRpcSocketOverride,
};
