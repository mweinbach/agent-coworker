import { JsonRpcSocket } from "../../lib/agentSocket";
import type { StoreGet, StoreSet } from "../store.helpers";
import type { ThreadRuntime, WorkspaceRecord } from "../types";
import {
  RUNTIME,
  bumpWorkspaceJsonRpcSocketGeneration,
  getWorkspaceJsonRpcSocketGeneration,
} from "./runtimeState";
import { JSONRPC_SOCKET_OVERRIDE_KEY } from "./jsonRpcSocketOverride";

type JsonRpcNotification =
  | { kind: "notification"; method: string; params?: any }
  | { kind: "request"; id: string | number; method: string; params?: any };

type WorkspaceNotificationRouter = (message: JsonRpcNotification) => void;
type WorkspaceLifecycleListener = {
  onOpen?: () => void;
  onClose?: () => void;
};

const workspaceRouters = new Map<string, Set<WorkspaceNotificationRouter>>();
const workspaceLifecycleListeners = new Map<string, Set<WorkspaceLifecycleListener>>();
const workspaceStoreSetters = new Map<string, StoreSet>();
const disposedWorkspaceIds = new Set<string>();
const noopSet: StoreSet = () => {};
const DESKTOP_JSONRPC_OPEN_TIMEOUT_MS = 1_500;
const DESKTOP_JSONRPC_HANDSHAKE_TIMEOUT_MS = 1_500;

type JsonRpcSocketConstructor = new (...args: any[]) => any;
type WorkspaceJsonRpcSocket = JsonRpcSocket & {
  __coworkOpened?: boolean;
  __coworkUrl?: string;
  __coworkGeneration?: number;
};

function resolveJsonRpcSocketImpl(): JsonRpcSocketConstructor {
  const override = (globalThis as Record<string, unknown>)[JSONRPC_SOCKET_OVERRIDE_KEY];
  if (typeof override === "function") {
    return override as JsonRpcSocketConstructor;
  }
  return JsonRpcSocket as JsonRpcSocketConstructor;
}

function getWorkspaceById(get: StoreGet, workspaceId: string): WorkspaceRecord | undefined {
  const state = get() as { workspaces?: WorkspaceRecord[] };
  return state.workspaces?.find((workspace) => workspace.id === workspaceId);
}

function isWorkspaceDisposed(workspaceId: string): boolean {
  return disposedWorkspaceIds.has(workspaceId);
}

export function reactivateWorkspaceJsonRpcSocketState(workspaceId: string): void {
  disposedWorkspaceIds.delete(workspaceId);
}

function rememberWorkspaceStoreSet(workspaceId: string, set: StoreSet | undefined) {
  if (set && !isWorkspaceDisposed(workspaceId)) {
    workspaceStoreSetters.set(workspaceId, set);
  }
}

function getWorkspaceStoreSet(workspaceId: string): StoreSet {
  return workspaceStoreSetters.get(workspaceId) ?? noopSet;
}

function getWorkspaceUrl(get: StoreGet, workspaceId: string): string | null {
  const state = get() as { workspaceRuntimeById?: Record<string, { serverUrl?: string | null }> };
  return state.workspaceRuntimeById?.[workspaceId]?.serverUrl ?? null;
}

function emitToWorkspaceRouters(workspaceId: string, message: JsonRpcNotification) {
  if (isWorkspaceDisposed(workspaceId)) return;
  const routers = workspaceRouters.get(workspaceId);
  if (!routers) return;
  for (const router of routers) {
    router(message);
  }
}

function emitWorkspaceLifecycle(workspaceId: string, event: "open" | "close") {
  if (isWorkspaceDisposed(workspaceId)) return;
  const listeners = workspaceLifecycleListeners.get(workspaceId);
  if (!listeners) return;
  for (const listener of listeners) {
    if (event === "open") {
      listener.onOpen?.();
      continue;
    }
    listener.onClose?.();
  }
}

function syncWorkspaceSocketState(workspaceId: string, isOpen: boolean) {
  getWorkspaceStoreSet(workspaceId)((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        controlSessionId: isOpen ? `jsonrpc:${workspaceId}` : null,
      },
    },
  }));
  emitWorkspaceLifecycle(workspaceId, isOpen ? "open" : "close");
}

function isActiveWorkspaceJsonRpcSocketGeneration(
  workspaceId: string,
  generation: number | undefined,
): boolean {
  return generation !== undefined && getWorkspaceJsonRpcSocketGeneration(workspaceId) === generation;
}

export function registerWorkspaceJsonRpcRouter(workspaceId: string, router: WorkspaceNotificationRouter): () => void {
  if (isWorkspaceDisposed(workspaceId)) {
    return () => {};
  }
  const routers = workspaceRouters.get(workspaceId) ?? new Set<WorkspaceNotificationRouter>();
  routers.add(router);
  workspaceRouters.set(workspaceId, routers);
  return () => {
    const current = workspaceRouters.get(workspaceId);
    if (!current) return;
    current.delete(router);
    if (current.size === 0) {
      workspaceRouters.delete(workspaceId);
    }
  };
}

export function registerWorkspaceJsonRpcLifecycle(workspaceId: string, listener: WorkspaceLifecycleListener): () => void {
  if (isWorkspaceDisposed(workspaceId)) {
    return () => {};
  }
  const listeners = workspaceLifecycleListeners.get(workspaceId) ?? new Set<WorkspaceLifecycleListener>();
  listeners.add(listener);
  workspaceLifecycleListeners.set(workspaceId, listeners);
  return () => {
    const current = workspaceLifecycleListeners.get(workspaceId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      workspaceLifecycleListeners.delete(workspaceId);
    }
  };
}

export function disposeWorkspaceJsonRpcSocketState(workspaceId: string): void {
  disposedWorkspaceIds.add(workspaceId);
  workspaceRouters.delete(workspaceId);
  workspaceLifecycleListeners.delete(workspaceId);
  workspaceStoreSetters.delete(workspaceId);
}

export function disposeAllJsonRpcSocketState(): void {
  const workspaceIds = new Set<string>();
  for (const workspaceId of workspaceRouters.keys()) {
    workspaceIds.add(workspaceId);
  }
  for (const workspaceId of workspaceLifecycleListeners.keys()) {
    workspaceIds.add(workspaceId);
  }
  for (const workspaceId of workspaceStoreSetters.keys()) {
    workspaceIds.add(workspaceId);
  }
  for (const workspaceId of workspaceIds) {
    disposeWorkspaceJsonRpcSocketState(workspaceId);
  }
}

export function ensureWorkspaceJsonRpcSocket(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
): any | null {
  if (isWorkspaceDisposed(workspaceId)) {
    return null;
  }
  rememberWorkspaceStoreSet(workspaceId, set);
  const url = getWorkspaceUrl(get, workspaceId);
  if (!url) return null;

  let socketGeneration = getWorkspaceJsonRpcSocketGeneration(workspaceId);
  const existing = RUNTIME.jsonRpcSockets.get(workspaceId) as WorkspaceJsonRpcSocket | undefined;
  if (existing) {
    if (existing.__coworkUrl && existing.__coworkUrl !== url) {
      socketGeneration = bumpWorkspaceJsonRpcSocketGeneration(workspaceId);
      try {
        existing.close?.();
      } catch {
        // ignore
      }
    } else {
      const controlSessionId = (get() as { workspaceRuntimeById?: Record<string, { controlSessionId?: string | null }> })
        .workspaceRuntimeById?.[workspaceId]?.controlSessionId ?? null;
      if (set && existing.__coworkOpened === true && !controlSessionId) {
        syncWorkspaceSocketState(workspaceId, true);
      }
      return existing;
    }
  }
  if (socketGeneration === 0) {
    socketGeneration = bumpWorkspaceJsonRpcSocketGeneration(workspaceId);
  }

  const JsonRpcSocketImpl = resolveJsonRpcSocketImpl();
  const socket = new JsonRpcSocketImpl({
    url,
    clientInfo: {
      name: "cowork-desktop",
      title: "Cowork Desktop",
      version: "0.1.0",
    },
    allowQueryProtocolFallback: true,
    autoReconnect: true,
    openTimeoutMs: DESKTOP_JSONRPC_OPEN_TIMEOUT_MS,
    handshakeTimeoutMs: DESKTOP_JSONRPC_HANDSHAKE_TIMEOUT_MS,
    onNotification: (message: any) => {
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      emitToWorkspaceRouters(workspaceId, { kind: "notification", method: message.method, params: message.params });
    },
    onServerRequest: (message: any) => {
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      emitToWorkspaceRouters(workspaceId, {
        kind: "request",
        id: message.id,
        method: message.method,
        params: message.params,
      });
    },
    onOpen: () => {
      socket.__coworkOpened = true;
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      syncWorkspaceSocketState(workspaceId, true);
    },
    onClose: () => {
      socket.__coworkOpened = false;
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      syncWorkspaceSocketState(workspaceId, false);
    },
  }) as WorkspaceJsonRpcSocket;

  if (!("readyPromise" in socket)) {
    (socket as any).readyPromise = Promise.resolve();
  }
  if (typeof (socket as any).request !== "function") {
    (socket as any).request = async () => ({});
  }
  if (typeof (socket as any).respond !== "function") {
    (socket as any).respond = () => true;
  }
  socket.__coworkOpened = false;
  socket.__coworkUrl = url;
  socket.__coworkGeneration = socketGeneration;

  RUNTIME.jsonRpcSockets.set(workspaceId, socket);
  socket.connect();
  return socket;
}

export async function requestJsonRpc(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  method: string,
  params?: unknown,
): Promise<any> {
  const socket = ensureWorkspaceJsonRpcSocket(get, set, workspaceId);
  if (!socket) {
    throw new Error("JSON-RPC workspace socket is unavailable");
  }
  return await socket.request(method, params, { retryable: true });
}

export async function requestJsonRpcThreadList(get: StoreGet, set: StoreSet | undefined, workspaceId: string): Promise<any[]> {
  const workspace = getWorkspaceById(get, workspaceId);
  const result = await requestJsonRpc(get, set, workspaceId, "thread/list", {
    cwd: workspace?.path,
  });
  return Array.isArray((result as any)?.threads) ? (result as any).threads : [];
}

export async function requestJsonRpcThreadRead(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
): Promise<any | null> {
  const result = await requestJsonRpc(get, set, workspaceId, "thread/read", {
    threadId,
  });
  return (result as any)?.coworkSnapshot ?? null;
}

export async function startJsonRpcThread(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
): Promise<any> {
  const workspace = getWorkspaceById(get, workspaceId);
  return await requestJsonRpc(get, set, workspaceId, "thread/start", {
    cwd: workspace?.path,
  });
}

export async function resumeJsonRpcThread(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
): Promise<any> {
  return await requestJsonRpc(get, set, workspaceId, "thread/resume", { threadId });
}

export async function startJsonRpcTurn(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
  text: string,
  clientMessageId?: string,
): Promise<any> {
  return await requestJsonRpc(get, set, workspaceId, "turn/start", {
    threadId,
    input: [{ type: "text", text }],
    ...(clientMessageId ? { clientMessageId } : {}),
  });
}

export async function steerJsonRpcTurn(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
  turnId: string,
  text: string,
  clientMessageId?: string,
): Promise<any> {
  return await requestJsonRpc(get, set, workspaceId, "turn/steer", {
    threadId,
    turnId,
    input: [{ type: "text", text }],
    ...(clientMessageId ? { clientMessageId } : {}),
  });
}

export async function interruptJsonRpcTurn(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
): Promise<any> {
  return await requestJsonRpc(get, set, workspaceId, "turn/interrupt", { threadId });
}

export async function unsubscribeJsonRpcThread(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
): Promise<any> {
  return await requestJsonRpc(get, set, workspaceId, "thread/unsubscribe", { threadId });
}

export function respondToJsonRpcRequest(
  workspaceId: string,
  requestId: string | number,
  result: unknown,
): boolean {
  const socket = RUNTIME.jsonRpcSockets.get(workspaceId);
  if (!socket) return false;
  return socket.respond(requestId, result);
}

export function findThreadIdForJsonRpcNotification(
  get: StoreGet,
  workspaceId: string,
  threadId: string | null | undefined,
): string | null {
  if (!threadId) return null;
  const runtimeById = get().threadRuntimeById;
  const direct = get().threads.find((thread) => thread.workspaceId === workspaceId && thread.id === threadId);
  if (direct) return direct.id;
  const bySession = get().threads.find((thread) =>
    thread.workspaceId === workspaceId
    && (thread.sessionId === threadId || runtimeById[thread.id]?.sessionId === threadId),
  );
  return bySession?.id ?? null;
}

export function buildSyntheticServerHelloFromJsonRpcThread(
  thread: any,
  opts?: { isResume?: boolean },
) {
  return {
    type: "server_hello" as const,
    sessionId: thread.id,
    config: {
      provider: thread.modelProvider,
      model: thread.model,
      workingDirectory: thread.cwd,
    },
    ...(opts?.isResume ? { isResume: true, busy: thread.status?.type === "running" } : {}),
  };
}

export function buildSyntheticSessionInfoFromJsonRpcThread(thread: any) {
  return {
    type: "session_info" as const,
    sessionId: thread.id,
    title: thread.title,
    titleSource: "manual" as const,
    titleModel: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    provider: thread.modelProvider,
    model: thread.model,
  };
}

export function buildSyntheticSessionSettings(
  runtime: ThreadRuntime | undefined,
  workspace: WorkspaceRecord | undefined,
) {
  return {
    type: "session_settings" as const,
    sessionId: runtime?.sessionId ?? "",
    enableMcp: runtime?.enableMcp ?? workspace?.defaultEnableMcp ?? true,
    enableMemory: true,
    memoryRequireApproval: false,
  };
}

export const __internal = {
  getWorkspaceStateSnapshot: (workspaceId: string) => ({
    isDisposed: isWorkspaceDisposed(workspaceId),
    hasStoreSetter: workspaceStoreSetters.has(workspaceId),
    routerCount: workspaceRouters.get(workspaceId)?.size ?? 0,
    lifecycleListenerCount: workspaceLifecycleListeners.get(workspaceId)?.size ?? 0,
  }),
  reset: (workspaceId?: string) => {
    if (workspaceId) {
      disposedWorkspaceIds.delete(workspaceId);
      workspaceStoreSetters.delete(workspaceId);
      workspaceRouters.delete(workspaceId);
      workspaceLifecycleListeners.delete(workspaceId);
      return;
    }
    disposedWorkspaceIds.clear();
    workspaceStoreSetters.clear();
    workspaceRouters.clear();
    workspaceLifecycleListeners.clear();
  },
};
