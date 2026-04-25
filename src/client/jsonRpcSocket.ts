import { z } from "zod";

import {
  type JsonRpcLiteClientResponse,
  type JsonRpcLiteRequest,
  parseJsonRpcClientMessage,
} from "../server/jsonrpc/protocol";

type WebSocketLike = Pick<WebSocket, "readyState" | "send" | "close"> &
  Partial<
    Pick<
      WebSocket,
      | "addEventListener"
      | "removeEventListener"
      | "onopen"
      | "onmessage"
      | "onerror"
      | "onclose"
      | "protocol"
    >
  >;

type WebSocketConstructorLike = {
  new (url: string, protocols?: string | string[]): WebSocketLike;
  readonly OPEN: number;
};

type JsonRpcSocketTimerScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
};

type QueuedOperation =
  | {
      kind: "request";
      method: string;
      params?: unknown;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  | {
      kind: "notification";
      method: string;
      params?: unknown;
    };

const webSocketImplSchema = z.custom<WebSocketConstructorLike>(
  (value) => typeof value === "function",
);
const defaultTimerScheduler: JsonRpcSocketTimerScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as never),
};

const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_MAX_QUEUED_MESSAGES = 128;
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_JSONRPC_SUBPROTOCOL = "cowork.jsonrpc.v1";

function isBlobLike(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

async function decodeSocketData(rawData: unknown): Promise<unknown> {
  if (typeof rawData === "string") return rawData;
  if (rawData instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(rawData));
  }
  if (ArrayBuffer.isView(rawData)) {
    const view = rawData as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (isBlobLike(rawData)) {
    return await rawData.text();
  }
  return rawData;
}

function bindSocketHandler(
  ws: WebSocketLike,
  eventName: "open" | "message" | "error" | "close",
  handler: (event: Event | MessageEvent) => void,
): void {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(eventName, handler as EventListener);
    return;
  }

  const propertyName = `on${eventName}` as const;
  ws[propertyName] = handler as never;
}

export type JsonRpcSocketInvalidMessage = {
  message: string;
  raw: unknown;
};

export type JsonRpcRequestError = Error & {
  jsonRpcCode?: number;
};

export type JsonRpcSocketOpts = {
  url: string;
  clientInfo: {
    name: string;
    title?: string;
    version?: string;
  };
  experimentalApi?: boolean;
  optOutNotificationMethods?: string[];
  protocols?: string | string[];
  WebSocketImpl?: WebSocketConstructorLike;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  maxQueuedMessages?: number;
  openTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  timers?: JsonRpcSocketTimerScheduler;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  onNotification?: (message: { method: string; params?: unknown }) => void;
  onServerRequest?: (message: JsonRpcLiteRequest) => void;
  onInvalidMessage?: (message: JsonRpcSocketInvalidMessage) => void;
};

type JsonRpcConnectionTarget = {
  url: string;
  protocols?: string | string[];
};

function buildConnectionTarget(url: string, protocols: string | string[] | undefined): JsonRpcConnectionTarget {
  return {
    url,
    protocols,
  };
}

export class JsonRpcSocket {
  private readonly url: string;
  private readonly clientInfo: JsonRpcSocketOpts["clientInfo"];
  private readonly experimentalApi: boolean;
  private readonly optOutNotificationMethods: string[];
  private readonly connectionTarget: JsonRpcConnectionTarget;
  private readonly WebSocketImpl: WebSocketConstructorLike;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly maxQueuedMessages: number;
  private readonly openTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly timers: JsonRpcSocketTimerScheduler;
  private readonly onOpen?: () => void;
  private readonly onClose?: (reason: string) => void;
  private readonly onNotification?: (message: { method: string; params?: unknown }) => void;
  private readonly onServerRequest?: (message: JsonRpcLiteRequest) => void;
  private readonly onInvalidMessage?: (message: JsonRpcSocketInvalidMessage) => void;

  private ws: WebSocketLike | null = null;
  private ready = Promise.withResolvers<void>();
  private initialized = false;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private openTimeoutHandle: unknown = null;
  private handshakeTimeoutHandle: unknown = null;
  private intentionalClose = false;
  private reconnectExhausted = false;
  private pendingInitializationFailure: Error | null = null;
  private nextId = 0;
  private pendingRequests = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private queuedOperations: QueuedOperation[] = [];

  constructor(opts: JsonRpcSocketOpts) {
    this.url = opts.url;
    this.clientInfo = opts.clientInfo;
    this.experimentalApi = opts.experimentalApi === true;
    this.optOutNotificationMethods = [...(opts.optOutNotificationMethods ?? [])];
    this.connectionTarget = buildConnectionTarget(opts.url, opts.protocols ?? DEFAULT_JSONRPC_SUBPROTOCOL);
    this.autoReconnect = opts.autoReconnect ?? false;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 10;
    this.maxQueuedMessages = Math.max(1, opts.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES);
    this.openTimeoutMs = Math.max(0, opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
    this.handshakeTimeoutMs = Math.max(0, opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.timers = opts.timers ?? defaultTimerScheduler;
    this.onOpen = opts.onOpen;
    this.onClose = opts.onClose;
    this.onNotification = opts.onNotification;
    this.onServerRequest = opts.onServerRequest;
    this.onInvalidMessage = opts.onInvalidMessage;

    const impl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: unknown }).WebSocket;
    const parsedImpl = webSocketImplSchema.safeParse(impl);
    if (!parsedImpl.success) {
      throw new Error("WebSocket is not available in this environment.");
    }
    this.WebSocketImpl = parsedImpl.data;
    void this.ready.promise.catch(() => {
      // prevent unhandled rejection noise for callers that never await readiness
    });
  }

  get readyPromise(): Promise<void> {
    return this.ready.promise;
  }

  private resetReadyPromise() {
    this.ready = Promise.withResolvers<void>();
    void this.ready.promise.catch(() => {
      // prevent unhandled rejection noise for callers that never await readiness
    });
  }

  connect() {
    if (this.ws) return;
    this.intentionalClose = false;
    this.reconnectExhausted = false;
    this.resetReadyPromise();
    this.doConnect();
  }

  close() {
    this.intentionalClose = true;
    this.reconnectExhausted = false;
    this.cancelReconnect();
    this.clearConnectionTimeouts();
    this.initialized = false;
    this.pendingInitializationFailure = null;
    const closedError = new Error("socket closed");
    this.rejectQueuedRequests(closedError);
    this.rejectPendingRequests(closedError);
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  async request(
    method: string,
    params?: unknown,
    opts?: { retryable?: boolean },
  ): Promise<unknown> {
    if (!this.initialized || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      if (this.reconnectExhausted) {
        throw new Error("max reconnect attempts exceeded");
      }
      if (opts?.retryable === true && this.autoReconnect && !this.intentionalClose) {
        return await this.enqueueOperation({
          kind: "request",
          method,
          params,
        });
      }
      throw new Error(`JSON-RPC socket is not ready for request: ${method}`);
    }
    return await this.sendRequestNow(method, params);
  }

  notify(method: string, params?: unknown, opts?: { retryable?: boolean }): boolean {
    if (!this.initialized || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      if (this.reconnectExhausted) {
        return false;
      }
      if (opts?.retryable === true && this.autoReconnect && !this.intentionalClose) {
        this.enqueueNotification({ kind: "notification", method, params });
        return true;
      }
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ method, ...(params !== undefined ? { params } : {}) }));
      return true;
    } catch {
      return false;
    }
  }

  respond(id: string | number, result: unknown): boolean {
    if (!this.initialized || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ id, result }));
      return true;
    } catch {
      return false;
    }
  }

  private async enqueueOperation(
    operation: Omit<Extract<QueuedOperation, { kind: "request" }>, "resolve" | "reject">,
  ): Promise<unknown> {
    if (this.queuedOperations.length >= this.maxQueuedMessages) {
      throw new Error("JSON-RPC retry queue is full");
    }
    return await new Promise((resolve, reject) => {
      this.queuedOperations.push({
        ...operation,
        resolve,
        reject,
      });
    });
  }

  private enqueueNotification(operation: Extract<QueuedOperation, { kind: "notification" }>) {
    if (this.queuedOperations.length >= this.maxQueuedMessages) {
      throw new Error("JSON-RPC retry queue is full");
    }
    this.queuedOperations.push(operation);
  }

  private doConnect() {
    this.initialized = false;
    this.reconnectExhausted = false;
    this.pendingInitializationFailure = null;
    const target = this.connectionTarget;
    const ws = new this.WebSocketImpl(target.url, target.protocols);
    this.ws = ws;
    this.armOpenTimeout(ws);

    bindSocketHandler(ws, "open", () => {
      this.clearOpenTimeout();
      this.armHandshakeTimeout(ws);
      void this.performHandshake().catch((error) => {
        const formatted = error instanceof Error ? error : new Error(String(error));
        this.failInitialization(ws, formatted);
      });
    });

    bindSocketHandler(ws, "message", async (event) => {
      const rawData = "data" in event ? event.data : undefined;
      let decoded: unknown;
      try {
        decoded = await decodeSocketData(rawData);
      } catch (error) {
        this.onInvalidMessage?.({
          message: error instanceof Error ? error.message : "failed_to_decode_socket_payload",
          raw: rawData,
        });
        return;
      }

      const parsed = parseJsonRpcClientMessage(decoded);
      if (!parsed.ok) {
        this.onInvalidMessage?.({
          message: parsed.error.message,
          raw: decoded,
        });
        return;
      }

      const message = parsed.message;
      if ("id" in message && !("method" in message)) {
        this.handleResponse(message);
        return;
      }
      if ("id" in message && "method" in message) {
        this.onServerRequest?.(message);
        return;
      }
      this.onNotification?.(message);
    });

    bindSocketHandler(ws, "error", () => {
      // rely on close for reconnection transitions
    });

    bindSocketHandler(ws, "close", () => {
      const wasInitialized = this.initialized;
      const failure = this.pendingInitializationFailure ?? new Error("websocket closed");
      this.initialized = false;
      this.ws = null;
      this.pendingInitializationFailure = null;
      this.clearConnectionTimeouts();
      this.rejectPendingRequests(failure);
      if (!this.intentionalClose && this.autoReconnect) {
        if (wasInitialized) {
          this.resetReadyPromise();
        }
        this.scheduleReconnect();
      } else {
        if (!wasInitialized) {
          this.ready.reject(failure);
        }
        this.rejectQueuedRequests(failure);
        this.onClose?.(failure.message);
      }
    });
  }

  private async performHandshake(): Promise<void> {
    await this.sendRequestNow("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: this.experimentalApi,
        ...(this.optOutNotificationMethods.length > 0
          ? { optOutNotificationMethods: this.optOutNotificationMethods }
          : {}),
      },
    });
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("Failed to send initialized notification");
    }
    ws.send(JSON.stringify({ method: "initialized" }));
    this.clearHandshakeTimeout();
    this.initialized = true;
    this.reconnectAttempt = 0;
    this.ready.resolve();
    this.flushQueuedOperations();
    this.onOpen?.();
  }

  private armOpenTimeout(ws: WebSocketLike) {
    this.clearOpenTimeout();
    if (this.openTimeoutMs <= 0) {
      return;
    }
    this.openTimeoutHandle = this.timers.setTimeout(() => {
      if (this.ws !== ws || this.initialized) {
        return;
      }
      this.failInitialization(
        ws,
        new Error(`Timed out opening JSON-RPC socket after ${this.openTimeoutMs}ms`),
      );
    }, this.openTimeoutMs);
  }

  private armHandshakeTimeout(ws: WebSocketLike) {
    this.clearHandshakeTimeout();
    if (this.handshakeTimeoutMs <= 0) {
      return;
    }
    this.handshakeTimeoutHandle = this.timers.setTimeout(() => {
      if (this.ws !== ws || this.initialized) {
        return;
      }
      this.failInitialization(
        ws,
        new Error(
          `Timed out waiting for JSON-RPC initialize response after ${this.handshakeTimeoutMs}ms`,
        ),
      );
    }, this.handshakeTimeoutMs);
  }

  private clearOpenTimeout() {
    if (this.openTimeoutHandle !== null) {
      this.timers.clearTimeout(this.openTimeoutHandle);
      this.openTimeoutHandle = null;
    }
  }

  private clearHandshakeTimeout() {
    if (this.handshakeTimeoutHandle !== null) {
      this.timers.clearTimeout(this.handshakeTimeoutHandle);
      this.handshakeTimeoutHandle = null;
    }
  }

  private clearConnectionTimeouts() {
    this.clearOpenTimeout();
    this.clearHandshakeTimeout();
  }

  private failInitialization(ws: WebSocketLike, error: Error) {
    if (this.ws !== ws || this.initialized) {
      return;
    }
    this.pendingInitializationFailure = error;
    this.clearConnectionTimeouts();
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  private async sendRequestNow(method: string, params?: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error(`JSON-RPC socket is not open for request: ${method}`);
    }
    const id = ++this.nextId;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
    try {
      ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    } catch (error) {
      this.pendingRequests.delete(id);
      throw error instanceof Error ? error : new Error(String(error));
    }
    return await promise;
  }

  private handleResponse(message: JsonRpcLiteClientResponse) {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message) as JsonRpcRequestError;
      error.jsonRpcCode = message.error.code;
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }

  private flushQueuedOperations() {
    if (!this.initialized || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      return;
    }
    const queued = this.queuedOperations;
    this.queuedOperations = [];
    for (const operation of queued) {
      if (operation.kind === "notification") {
        this.notify(operation.method, operation.params);
        continue;
      }
      void this.sendRequestNow(operation.method, operation.params)
        .then((result) => {
          operation.resolve(result);
        })
        .catch((error) => {
          operation.reject(error instanceof Error ? error : new Error(String(error)));
        });
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.reconnectExhausted = true;
      const exhaustedError = new Error("max reconnect attempts exceeded");
      this.ready.reject(exhaustedError);
      this.rejectQueuedRequests(exhaustedError);
      this.onClose?.(exhaustedError.message);
      return;
    }
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt + Math.random() * 200,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private cancelReconnect() {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  private rejectPendingRequests(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private rejectQueuedRequests(error: Error) {
    const queued = this.queuedOperations;
    this.queuedOperations = [];
    for (const operation of queued) {
      if (operation.kind !== "request") continue;
      operation.reject(error);
    }
  }
}
