import { z } from "zod";

import type {
  CanvasDocumentCloseResult,
  CanvasDocumentOpenResult,
  CanvasDocumentRevisionResult,
  CanvasDocumentSaveResult,
} from "../../../../../src/shared/canvasDocument";
import type { SessionSnapshot } from "../../../../../src/shared/sessionSnapshot";
import type {
  SpreadsheetBatchPatchOperation,
  SpreadsheetBatchPatchResult,
  SpreadsheetFileVersion,
  SpreadsheetFileVersionResult,
  SpreadsheetWorkbookSnapshotResult,
} from "../../../../../src/shared/spreadsheetPreview";
import { JsonRpcSocket } from "../../lib/agentSocket";
import { writeRendererLog } from "../../lib/desktopCommands";
import { withBrowserAccessToken } from "../../lib/webAdapter";
import type { TurnReference } from "../../lib/wsProtocol";
import type { AbortableActionOptions, StoreGet, StoreSet } from "../store.helpers";
import type { ThreadRuntime, WorkspaceRecord } from "../types";
import { JSONRPC_SOCKET_OVERRIDE_KEY } from "./jsonRpcSocketOverride";
import { throwIfOperationAborted, waitForOperation } from "./operationIntent";
import {
  bumpWorkspaceJsonRpcSocketGeneration,
  getWorkspaceJsonRpcSocketGeneration,
  RUNTIME,
} from "./runtimeState";

type JsonRpcNotification =
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "request"; id: string | number; method: string; params?: unknown }
  | {
      kind: "response";
      id: string | number;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };

type WorkspaceNotificationRouter = (message: JsonRpcNotification) => void;
type WorkspaceLifecycleListener = {
  onOpen?: () => void;
  onClose?: () => void;
  onReconnecting?: () => void;
  onReconnectExhausted?: () => void;
};

const workspaceRouters = new Map<string, Set<WorkspaceNotificationRouter>>();
const workspaceLifecycleListeners = new Map<string, Set<WorkspaceLifecycleListener>>();
const workspaceStoreSetters = new Map<string, StoreSet>();
const disposedWorkspaceIds = new Set<string>();
const noopSet: StoreSet = () => {};
const DESKTOP_JSONRPC_OPEN_TIMEOUT_MS = 5_000;
const DESKTOP_JSONRPC_HANDSHAKE_TIMEOUT_MS = 10_000;
const jsonRpcDesktopThreadRecordSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    modelProvider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    messageCount: z.number().int().nonnegative().optional(),
    lastEventSeq: z.number().int().nonnegative().optional(),
    status: z
      .object({
        type: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const jsonRpcDesktopThreadListResultSchema = z
  .object({
    threads: z.array(jsonRpcDesktopThreadRecordSchema),
    // Older desktop tests and lightweight mocks may omit total; the renderer only
    // hydrates sessions from the validated thread rows.
    total: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type WorkspaceJsonRpcSocket = JsonRpcSocket & {
  readyPromise?: Promise<void>;
  request?: (
    method: string,
    params?: unknown,
    options?: JsonRpcRequestRetryOptions,
  ) => Promise<unknown>;
  respond?: (
    requestId: string | number,
    result: unknown,
    options?: { retryable?: boolean },
  ) => boolean;
  connect: () => void;
  close?: () => void;
  __coworkOpened?: boolean;
  __coworkReconnectPending?: boolean;
  __coworkUrl?: string;
  __coworkGeneration?: number;
  readonly supportsToolRetryLineage?: boolean;
};
type JsonRpcSocketConstructor = new (options: Record<string, unknown>) => WorkspaceJsonRpcSocket;
type JsonRpcSocketMessage = {
  id?: string | number;
  method: string;
  params?: unknown;
};
type JsonRpcThreadRecord = z.infer<typeof jsonRpcDesktopThreadRecordSchema>;

type JsonRpcRequestRetryOptions = {
  retryable?: boolean;
  retryOnDisconnect?: boolean;
};

export function workspaceSupportsToolRetryLineage(workspaceId: string): boolean {
  const socket = RUNTIME.jsonRpcSockets.get(workspaceId) as WorkspaceJsonRpcSocket | undefined;
  return socket?.supportsToolRetryLineage === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonRpcResultSchema = z.ZodType;

function formatJsonRpcResultError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

export function parseJsonRpcResult<TSchema extends JsonRpcResultSchema>(
  method: string,
  schema: TSchema,
  result: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`Invalid ${method} response: ${formatJsonRpcResultError(parsed.error)}`);
  }
  return parsed.data;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseThreadReadSnapshotResult(
  method: string,
  result: unknown,
): Record<string, unknown> | null {
  const record = optionalRecord(result);
  if (!record || !("coworkSnapshot" in record)) {
    throw new Error(`Invalid ${method} response: missing coworkSnapshot`);
  }
  if (record.coworkSnapshot === null) return null;
  const snapshot = optionalRecord(record.coworkSnapshot);
  if (!snapshot || typeof snapshot.sessionId !== "string" || snapshot.sessionId.trim() === "") {
    throw new Error(`Invalid ${method} response: coworkSnapshot.sessionId must be a string`);
  }
  return snapshot;
}

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

function emitWorkspaceReconnectLifecycle(
  workspaceId: string,
  event: "reconnecting" | "reconnectExhausted",
) {
  if (isWorkspaceDisposed(workspaceId)) return;
  const listeners = workspaceLifecycleListeners.get(workspaceId);
  if (!listeners) return;
  for (const listener of listeners) {
    if (event === "reconnecting") {
      listener.onReconnecting?.();
      continue;
    }
    listener.onReconnectExhausted?.();
  }
}

function safeServerUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl.split("?")[0] ?? rawUrl;
  }
}

function logRendererSocketEvent(
  workspaceId: string,
  event: string,
  meta: Record<string, string | number | boolean | null> = {},
): void {
  void writeRendererLog({
    category: "jsonrpc-socket",
    message: event,
    meta: {
      workspaceId,
      ...meta,
    },
  }).catch(() => {
    // Renderer diagnostics are best-effort only.
  });
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

function markWorkspaceSocketReconnecting(workspaceId: string) {
  getWorkspaceStoreSet(workspaceId)((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        controlSessionId: null,
      },
    },
  }));
  emitWorkspaceReconnectLifecycle(workspaceId, "reconnecting");
}

function isActiveWorkspaceJsonRpcSocketGeneration(
  workspaceId: string,
  generation: number | undefined,
): boolean {
  return (
    generation !== undefined && getWorkspaceJsonRpcSocketGeneration(workspaceId) === generation
  );
}

export function registerWorkspaceJsonRpcRouter(
  workspaceId: string,
  router: WorkspaceNotificationRouter,
): () => void {
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

export function registerWorkspaceJsonRpcLifecycle(
  workspaceId: string,
  listener: WorkspaceLifecycleListener,
): () => void {
  if (isWorkspaceDisposed(workspaceId)) {
    return () => {};
  }
  const listeners =
    workspaceLifecycleListeners.get(workspaceId) ?? new Set<WorkspaceLifecycleListener>();
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
): WorkspaceJsonRpcSocket | null {
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
      const controlSessionId =
        (get() as { workspaceRuntimeById?: Record<string, { controlSessionId?: string | null }> })
          .workspaceRuntimeById?.[workspaceId]?.controlSessionId ?? null;
      if (existing.__coworkOpened === false && existing.__coworkReconnectPending !== true) {
        existing.connect();
      }
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
    url: withBrowserAccessToken(url),
    clientInfo: {
      name: "cowork-desktop",
      title: "Cowork Desktop",
      version: "0.1.0",
    },
    toolRetryLineage: true,
    autoReconnect: true,
    openTimeoutMs: DESKTOP_JSONRPC_OPEN_TIMEOUT_MS,
    handshakeTimeoutMs: DESKTOP_JSONRPC_HANDSHAKE_TIMEOUT_MS,
    onNotification: (message: JsonRpcSocketMessage) => {
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      emitToWorkspaceRouters(workspaceId, {
        kind: "notification",
        method: message.method,
        params: message.params,
      });
    },
    onServerRequest: (message: JsonRpcSocketMessage) => {
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      if (message.id === undefined) {
        return;
      }
      emitToWorkspaceRouters(workspaceId, {
        kind: "request",
        id: message.id,
        method: message.method,
        params: message.params,
      });
    },
    onServerResponse: (message: {
      id: string | number;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    }) => {
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      emitToWorkspaceRouters(workspaceId, {
        kind: "response",
        id: message.id,
        ...(message.result !== undefined ? { result: message.result } : {}),
        ...(message.error ? { error: message.error } : {}),
      });
    },
    onOpen: () => {
      socket.__coworkOpened = true;
      socket.__coworkReconnectPending = false;
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      logRendererSocketEvent(workspaceId, "socket open", {
        generation: socket.__coworkGeneration ?? null,
        serverUrl: safeServerUrl(url),
      });
      syncWorkspaceSocketState(workspaceId, true);
    },
    onReconnecting: (event: {
      attempt?: unknown;
      maxAttempts?: unknown;
      delayMs?: unknown;
      reason?: unknown;
      queuedOperationCount?: unknown;
      pendingRequestCount?: unknown;
    }) => {
      socket.__coworkOpened = false;
      socket.__coworkReconnectPending = true;
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      const attempt = typeof event.attempt === "number" ? event.attempt : null;
      logRendererSocketEvent(workspaceId, "socket reconnecting", {
        generation: socket.__coworkGeneration ?? null,
        serverUrl: safeServerUrl(url),
        attempt,
        maxAttempts: typeof event.maxAttempts === "number" ? event.maxAttempts : null,
        delayMs: typeof event.delayMs === "number" ? Math.round(event.delayMs) : null,
        reason: typeof event.reason === "string" ? event.reason : "websocket closed",
        queuedOperationCount:
          typeof event.queuedOperationCount === "number" ? event.queuedOperationCount : null,
        pendingRequestCount:
          typeof event.pendingRequestCount === "number" ? event.pendingRequestCount : null,
      });
      markWorkspaceSocketReconnecting(workspaceId);
    },
    onReconnectExhausted: (reason: string) => {
      socket.__coworkOpened = false;
      socket.__coworkReconnectPending = false;
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      logRendererSocketEvent(workspaceId, "socket reconnect exhausted", {
        generation: socket.__coworkGeneration ?? null,
        serverUrl: safeServerUrl(url),
        reason,
      });
      emitWorkspaceReconnectLifecycle(workspaceId, "reconnectExhausted");
    },
    onClose: () => {
      socket.__coworkOpened = false;
      socket.__coworkReconnectPending = false;
      if (!isActiveWorkspaceJsonRpcSocketGeneration(workspaceId, socket.__coworkGeneration)) {
        return;
      }
      logRendererSocketEvent(workspaceId, "socket close", {
        generation: socket.__coworkGeneration ?? null,
        serverUrl: safeServerUrl(url),
      });
      syncWorkspaceSocketState(workspaceId, false);
    },
  }) as WorkspaceJsonRpcSocket;

  socket.readyPromise ??= Promise.resolve();
  socket.request ??= async () => ({});
  socket.respond ??= () => true;
  socket.__coworkOpened = false;
  socket.__coworkReconnectPending = false;
  socket.__coworkUrl = url;
  socket.__coworkGeneration = socketGeneration;

  RUNTIME.jsonRpcSockets.set(workspaceId, socket);
  socket.connect();
  return socket;
}

export async function requestJsonRpc<T = Record<string, unknown>>(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  method: string,
  params?: unknown,
  options: AbortableActionOptions = {},
): Promise<T> {
  throwIfOperationAborted(options.signal);
  const socket = ensureWorkspaceJsonRpcSocket(get, set, workspaceId);
  if (!socket) {
    throw new Error("JSON-RPC workspace socket is unavailable");
  }
  throwIfOperationAborted(options.signal);
  return (await waitForOperation(
    socket.request(method, params, getJsonRpcRequestRetryOptions(method, params)),
    options.signal,
  )) as T;
}

function hasStableStringKey(params: unknown, key: string): boolean {
  return isRecord(params) && typeof params[key] === "string" && params[key].trim().length > 0;
}

function getJsonRpcRequestRetryOptions(
  method: string,
  params: unknown,
): JsonRpcRequestRetryOptions {
  if (
    method === "thread/list" ||
    method === "thread/read" ||
    method === "thread/resume" ||
    method === "thread/hydrate" ||
    method.endsWith("/read") ||
    method.endsWith("/list") ||
    method.endsWith("/get") ||
    method.endsWith("/catalog/read") ||
    method === "cowork/session/state/read" ||
    method === "cowork/provider/authMethods/read" ||
    method === "cowork/provider/status/refresh" ||
    method === "cowork/creation/preflight" ||
    method === "cowork/runtime/libreoffice/check" ||
    method === "cowork/workspace/document/open" ||
    method === "cowork/workspace/document/revision" ||
    method === "cowork/workspace/spreadsheet/workbook" ||
    method === "cowork/workspace/spreadsheet/version"
  ) {
    return { retryable: true, retryOnDisconnect: true };
  }
  if (method === "thread/start" && hasStableStringKey(params, "clientThreadId")) {
    return { retryable: true, retryOnDisconnect: true };
  }
  if (method === "research/start" && hasStableStringKey(params, "clientResearchId")) {
    return { retryable: true, retryOnDisconnect: true };
  }
  return { retryable: false, retryOnDisconnect: false };
}

export async function requestJsonRpcThreadList(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
): Promise<z.infer<typeof jsonRpcDesktopThreadListResultSchema>["threads"]> {
  const workspace = getWorkspaceById(get, workspaceId);
  const result = await requestJsonRpc(get, set, workspaceId, "thread/list", {
    cwd: workspace?.path,
  });
  return parseJsonRpcResult("thread/list", jsonRpcDesktopThreadListResultSchema, result).threads;
}

export async function requestJsonRpcThreadRead(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
): Promise<SessionSnapshot | null> {
  const result = await requestJsonRpc(get, set, workspaceId, "thread/read", {
    threadId,
  });
  return parseThreadReadSnapshotResult("thread/read", result) as SessionSnapshot | null;
}

export async function startJsonRpcThread(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  opts?: { provider?: string | null; model?: string | null; clientThreadId?: string | null },
): Promise<unknown> {
  const workspace = getWorkspaceById(get, workspaceId);
  const provider = typeof opts?.provider === "string" ? opts.provider.trim() : "";
  const model = typeof opts?.model === "string" ? opts.model.trim() : "";
  return await requestJsonRpc(get, set, workspaceId, "thread/start", {
    cwd: workspace?.path,
    ...(opts?.clientThreadId ? { clientThreadId: opts.clientThreadId } : {}),
    ...(provider && model ? { provider, model } : {}),
  });
}

export async function resumeJsonRpcThread(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
): Promise<unknown> {
  return await requestJsonRpc(get, set, workspaceId, "thread/resume", { threadId });
}

type InlineFileAttachmentInput = {
  filename: string;
  contentBase64: string;
  mimeType: string;
};

type UploadedFileAttachmentInput = {
  filename: string;
  path: string;
  mimeType: string;
};

export type FileAttachmentInput = InlineFileAttachmentInput | UploadedFileAttachmentInput;

export async function startJsonRpcTurn(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
  text: string,
  clientMessageId?: string,
  attachments?: FileAttachmentInput[],
  references?: TurnReference[],
  retryToolItemIds?: string[],
): Promise<unknown> {
  const input: Array<Record<string, unknown>> = [];
  if (text) {
    input.push({ type: "text", text });
  }
  if (attachments && attachments.length > 0) {
    for (const a of attachments) {
      if ("contentBase64" in a) {
        input.push({
          type: "file",
          filename: a.filename,
          contentBase64: a.contentBase64,
          mimeType: a.mimeType,
        });
      } else {
        input.push({
          type: "uploadedFile",
          filename: a.filename,
          path: a.path,
          mimeType: a.mimeType,
        });
      }
    }
  }
  const socket = ensureWorkspaceJsonRpcSocket(get, set, workspaceId);
  if (!socket) {
    throw new Error("JSON-RPC workspace socket is unavailable");
  }
  if (retryToolItemIds && retryToolItemIds.length > 0 && !socket.supportsToolRetryLineage) {
    throw new Error("This server does not support exact tool retries.");
  }
  return await requestJsonRpc(get, set, workspaceId, "turn/start", {
    threadId,
    input,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(references && references.length > 0 ? { references } : {}),
    ...(retryToolItemIds && retryToolItemIds.length > 0
      ? { retry: { toolItemIds: retryToolItemIds } }
      : {}),
  });
}

export type JsonRpcTurnSteerResult = {
  turnId: string;
  steerRequestId: string;
  replayed?: boolean;
};

export async function steerJsonRpcTurn(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
  turnId: string,
  text: string,
  clientMessageId?: string,
  attachments?: FileAttachmentInput[],
  references?: TurnReference[],
): Promise<JsonRpcTurnSteerResult> {
  const input: Array<Record<string, unknown>> = [];
  if (text) {
    input.push({ type: "text", text });
  }
  if (attachments && attachments.length > 0) {
    for (const a of attachments) {
      if ("contentBase64" in a) {
        input.push({
          type: "file",
          filename: a.filename,
          contentBase64: a.contentBase64,
          mimeType: a.mimeType,
        });
      } else {
        input.push({
          type: "uploadedFile",
          filename: a.filename,
          path: a.path,
          mimeType: a.mimeType,
        });
      }
    }
  }
  const result = await requestJsonRpc(get, set, workspaceId, "turn/steer", {
    threadId,
    turnId,
    input,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(references && references.length > 0 ? { references } : {}),
  });
  if (
    !result ||
    typeof result !== "object" ||
    typeof (result as Record<string, unknown>).turnId !== "string" ||
    typeof (result as Record<string, unknown>).steerRequestId !== "string"
  ) {
    throw new Error("turn/steer returned an invalid result.");
  }
  const record = result as Record<string, unknown>;
  return {
    turnId: record.turnId as string,
    steerRequestId: record.steerRequestId as string,
    ...(typeof record.replayed === "boolean" ? { replayed: record.replayed } : {}),
  };
}

export async function interruptJsonRpcTurn(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
): Promise<unknown> {
  return await requestJsonRpc(get, set, workspaceId, "turn/interrupt", { threadId });
}

export async function uploadJsonRpcWorkspaceFile(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  filename: string,
  contentBase64: string,
  options: AbortableActionOptions = {},
): Promise<{ filename: string; path: string }> {
  const workspace = getWorkspaceById(get, workspaceId);
  const result = await requestJsonRpc(
    get,
    set,
    workspaceId,
    "cowork/session/file/upload",
    {
      cwd: workspace?.path,
      filename,
      contentBase64,
    },
    options,
  );
  const event = isRecord(result) && isRecord(result.event) ? result.event : null;
  return {
    filename: typeof event?.filename === "string" ? event.filename : filename,
    path: typeof event?.path === "string" ? event.path : "",
  };
}

export async function openJsonRpcWorkspaceDocument(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  input: {
    path: string;
    documentId: string;
    generation: number;
    maxBytes?: number;
  },
): Promise<CanvasDocumentOpenResult> {
  return (await requestJsonRpc(get, set, workspaceId, "cowork/workspace/document/open", {
    ...input,
  })) as CanvasDocumentOpenResult;
}

export async function revisionJsonRpcWorkspaceDocument(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  input: { documentId: string; generation: number },
): Promise<CanvasDocumentRevisionResult> {
  return (await requestJsonRpc(get, set, workspaceId, "cowork/workspace/document/revision", {
    ...input,
  })) as CanvasDocumentRevisionResult;
}

export async function saveJsonRpcWorkspaceDocument(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  input: {
    documentId: string;
    generation: number;
    editRevision: number;
    content: string;
  },
): Promise<CanvasDocumentSaveResult> {
  return (await requestJsonRpc(get, set, workspaceId, "cowork/workspace/document/save", {
    ...input,
  })) as CanvasDocumentSaveResult;
}

export async function saveAsJsonRpcWorkspaceDocument(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  input: {
    documentId: string;
    generation: number;
    editRevision: number;
    content: string;
    path: string;
  },
): Promise<CanvasDocumentSaveResult> {
  return (await requestJsonRpc(get, set, workspaceId, "cowork/workspace/document/saveAs", {
    ...input,
  })) as CanvasDocumentSaveResult;
}

export async function closeJsonRpcWorkspaceDocument(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  input: { documentId: string; generation: number },
): Promise<CanvasDocumentCloseResult> {
  return (await requestJsonRpc(get, set, workspaceId, "cowork/workspace/document/close", {
    ...input,
  })) as CanvasDocumentCloseResult;
}

export async function previewJsonRpcWorkspaceSpreadsheetWorkbook(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  filePath: string,
  opts: {
    sheetName?: string;
  } = {},
): Promise<SpreadsheetWorkbookSnapshotResult> {
  const workspace = getWorkspaceById(get, workspaceId);
  return (await requestJsonRpc(get, set, workspaceId, "cowork/workspace/spreadsheet/workbook", {
    cwd: workspace?.path,
    path: filePath,
    ...(opts.sheetName ? { sheetName: opts.sheetName } : {}),
  })) as SpreadsheetWorkbookSnapshotResult;
}

export async function versionJsonRpcWorkspaceSpreadsheet(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  filePath: string,
): Promise<SpreadsheetFileVersionResult> {
  const workspace = getWorkspaceById(get, workspaceId);
  return (await requestJsonRpc(get, set, workspaceId, "cowork/workspace/spreadsheet/version", {
    cwd: workspace?.path,
    path: filePath,
  })) as SpreadsheetFileVersionResult;
}

export async function patchJsonRpcWorkspaceSpreadsheet(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  filePath: string,
  operations: SpreadsheetBatchPatchOperation[],
  expectedFileVersion?: SpreadsheetFileVersion,
): Promise<SpreadsheetBatchPatchResult> {
  const workspace = getWorkspaceById(get, workspaceId);
  return (await requestJsonRpc(get, set, workspaceId, "cowork/workspace/spreadsheet/patch", {
    cwd: workspace?.path,
    path: filePath,
    operations,
    ...(expectedFileVersion ? { expectedFileVersion } : {}),
  })) as SpreadsheetBatchPatchResult;
}

export async function previewJsonRpcWorkspacePresentation(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  filePath: string,
): Promise<unknown> {
  const workspace = getWorkspaceById(get, workspaceId);
  return await requestJsonRpc(get, set, workspaceId, "cowork/workspace/presentation/preview", {
    cwd: workspace?.path,
    path: filePath,
  });
}

export async function unsubscribeJsonRpcThread(
  get: StoreGet,
  set: StoreSet | undefined,
  workspaceId: string,
  threadId: string,
): Promise<unknown> {
  return await requestJsonRpc(get, set, workspaceId, "thread/unsubscribe", { threadId });
}

export function respondToJsonRpcRequest(
  workspaceId: string,
  requestId: string | number,
  result: unknown,
): boolean {
  const socket = RUNTIME.jsonRpcSockets.get(workspaceId);
  if (!socket) return false;
  return socket.respond?.(requestId, result) ?? false;
}

export function findThreadIdForJsonRpcNotification(
  get: StoreGet,
  workspaceId: string,
  threadId: string | null | undefined,
): string | null {
  if (!threadId) return null;
  const runtimeById = get().threadRuntimeById;
  const direct = get().threads.find(
    (thread) => thread.workspaceId === workspaceId && thread.id === threadId,
  );
  if (direct) return direct.id;
  const bySession = get().threads.find(
    (thread) =>
      thread.workspaceId === workspaceId &&
      (thread.sessionId === threadId || runtimeById[thread.id]?.sessionId === threadId),
  );
  return bySession?.id ?? null;
}

export function buildSyntheticServerHelloFromJsonRpcThread(
  thread: JsonRpcThreadRecord,
  opts?: { isResume?: boolean },
) {
  const activeTurnId =
    thread.status &&
    "turnId" in thread.status &&
    typeof thread.status.turnId === "string" &&
    thread.status.turnId.trim()
      ? thread.status.turnId
      : null;
  return {
    type: "server_hello" as const,
    sessionId: thread.id,
    config: {
      provider: thread.modelProvider,
      model: thread.model,
      workingDirectory: thread.cwd,
    },
    ...(opts?.isResume
      ? {
          isResume: true,
          busy: thread.status?.type === "running",
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
        }
      : {}),
  };
}

export function buildSyntheticSessionInfoFromJsonRpcThread(thread: JsonRpcThreadRecord) {
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
