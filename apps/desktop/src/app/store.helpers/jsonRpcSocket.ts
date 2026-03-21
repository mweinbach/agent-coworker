import * as AgentSocketModule from "../../lib/agentSocket";
import type { StoreGet, StoreSet } from "../store.helpers";
import type { ThreadRuntime, WorkspaceRecord } from "../types";
import { RUNTIME } from "./runtimeState";

type JsonRpcNotification =
  | { kind: "notification"; method: string; params?: any }
  | { kind: "request"; id: string | number; method: string; params?: any };

type WorkspaceNotificationRouter = (message: JsonRpcNotification) => void;

const workspaceRouters = new Map<string, Set<WorkspaceNotificationRouter>>();
const JsonRpcSocketImpl = ((AgentSocketModule as any).JsonRpcSocket ?? AgentSocketModule.AgentSocket) as new (...args: any[]) => any;
const noopSet: StoreSet = () => {};

function getWorkspaceById(get: StoreGet, workspaceId: string): WorkspaceRecord | undefined {
  return get().workspaces.find((workspace) => workspace.id === workspaceId);
}

function getWorkspaceUrl(get: StoreGet, workspaceId: string): string | null {
  return get().workspaceRuntimeById[workspaceId]?.serverUrl ?? null;
}

function emitToWorkspaceRouters(workspaceId: string, message: JsonRpcNotification) {
  const routers = workspaceRouters.get(workspaceId);
  if (!routers) return;
  for (const router of routers) {
    router(message);
  }
}

export function registerWorkspaceJsonRpcRouter(workspaceId: string, router: WorkspaceNotificationRouter): () => void {
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

export function workspaceUsesJsonRpc(get: StoreGet, workspaceId: string): boolean {
  return getWorkspaceById(get, workspaceId)?.wsProtocol === "jsonrpc";
}

export function ensureWorkspaceJsonRpcSocket(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
): any | null {
  const effectiveSet = set ?? noopSet;
  if (!workspaceUsesJsonRpc(get, workspaceId)) return null;
  const url = getWorkspaceUrl(get, workspaceId);
  if (!url) return null;

  const existing = RUNTIME.jsonRpcSockets.get(workspaceId);
  if (existing) {
    return existing;
  }

  const socket = new JsonRpcSocketImpl({
    url,
    clientInfo: {
      name: "cowork-desktop",
      title: "Cowork Desktop",
      version: "0.1.0",
    },
    autoReconnect: true,
    onNotification: (message: any) => {
      emitToWorkspaceRouters(workspaceId, { kind: "notification", method: message.method, params: message.params });
    },
    onServerRequest: (message: any) => {
      emitToWorkspaceRouters(workspaceId, {
        kind: "request",
        id: message.id,
        method: message.method,
        params: message.params,
      });
    },
    onOpen: () => {
      effectiveSet((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            controlSessionId: `jsonrpc:${workspaceId}`,
          },
        },
      }));
    },
    onClose: () => {
      effectiveSet((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            controlSessionId: null,
          },
        },
      }));
    },
  });

  socket.connect();
  RUNTIME.jsonRpcSockets.set(workspaceId, socket);
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
  await socket.readyPromise;
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
    includeTurns: true,
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
): Promise<any> {
  return await requestJsonRpc(get, set, workspaceId, "turn/start", {
    threadId,
    input: [{ type: "text", text }],
  });
}

export async function steerJsonRpcTurn(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
  turnId: string,
  text: string,
): Promise<any> {
  return await requestJsonRpc(get, set, workspaceId, "turn/steer", {
    threadId,
    turnId,
    input: [{ type: "text", text }],
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
