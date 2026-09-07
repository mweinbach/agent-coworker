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
      retryOnDisconnect: boolean;
      timeoutMs?: number;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  | {
      kind: "notification";
      method: string;
      params?: unknown;
    }
  | {
      kind: "response";
      id: string | number;
      result: unknown;
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
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_JSONRPC_SUBPROTOCOL = "cowork.jsonrpc.v1";
const JSONRPC_INVALID_PARAMS_ERROR_CODE = -32602;

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

type JsonRpcRequestError = Error & {
  jsonRpcCode?: number;
  jsonRpcData?: unknown;
};

export type JsonRpcSocketReconnectEvent = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
  queuedOperationCount: number;
  pendingRequestCount: number;
};

export type JsonRpcSocketRequestOptions = {
  retryable?: boolean;
  retryOnDisconnect?: boolean;
  timeoutMs?: number;
};

export type JsonRpcSocketOpts = {
  url: string;
  clientInfo: {
    name: string;
    title?: string;
    version?: string;
  };
  experimentalApi?: boolean;
  toolRetryLineage?: boolean;
  optOutNotificationMethods?: string[];
  protocols?: string | string[];
  WebSocketImpl?: WebSocketConstructorLike;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  maxQueuedMessages?: number;
  openTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  timers?: JsonRpcSocketTimerScheduler;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  onReconnecting?: (event: JsonRpcSocketReconnectEvent) => void;
  onReconnectExhausted?: (reason: string) => void;
  onNotification?: (message: { method: string; params?: unknown }) => void;
  onServerRequest?: (message: JsonRpcLiteRequest) => void;
  onServerResponse?: (message: JsonRpcLiteClientResponse) => void;
  onInvalidMessage?: (message: JsonRpcSocketInvalidMessage) => void;
};

export class JsonRpcSocket {
  private readonly clientInfo: JsonRpcSocketOpts["clientInfo"];
  private readonly experimentalApi: boolean;
  private readonly toolRetryLineage: boolean;
  private readonly optOutNotificationMethods: string[];
  private readonly connectionTarget: { url: string; protocols: string | string[] };
  private readonly WebSocketImpl: WebSocketConstructorLike;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly maxQueuedMessages: number;
  private readonly openTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly timers: JsonRpcSocketTimerScheduler;
  private readonly onOpen?: () => void;
  private readonly onClose?: (reason: string) => void;
  private readonly onReconnecting?: (event: JsonRpcSocketReconnectEvent) => void;
  private readonly onReconnectExhausted?: (reason: string) => void;
  private readonly onNotification?: (message: { method: string; params?: unknown }) => void;
  private readonly onServerRequest?: (message: JsonRpcLiteRequest) => void;
  private readonly onServerResponse?: (message: JsonRpcLiteClientResponse) => void;
  private readonly onInvalidMessage?: (message: JsonRpcSocketInvalidMessage) => void;

  private ws: WebSocketLike | null = null;
  private ready = Promise.withResolvers<void>();
  private readySettled: boolean = false;
  private initialized: boolean = false;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private openTimeoutHandle: unknown = null;
  private handshakeTimeoutHandle: unknown = null;
  private intentionalClose: boolean = false;
  private reconnectExhausted: boolean = false;
  private pendingInitializationFailure: Error | null = null;
  private serverSupportsToolRetryLineage = false;
  private nextId = 0;
  private pendingRequests = new Map<
    string | number,
    {
      method: string;
      params?: unknown;
      retryOnDisconnect: boolean;
      timeoutMs: number;
      timeoutHandle: unknown;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private queuedOperations: QueuedOperation[] = [];

  constructor(opts: JsonRpcSocketOpts) {
    this.clientInfo = opts.clientInfo;
    this.experimentalApi = opts.experimentalApi === true;
    this.toolRetryLineage = opts.toolRetryLineage === true;
    this.optOutNotificationMethods = [...(opts.optOutNotificationMethods ?? [])];
    this.connectionTarget = {
      url: opts.url,
      protocols: opts.protocols ?? DEFAULT_JSONRPC_SUBPROTOCOL,
    };
    this.autoReconnect = opts.autoReconnect ?? false;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 10;
    this.maxQueuedMessages = Math.max(1, opts.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES);
    this.openTimeoutMs = Math.max(0, opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
    this.handshakeTimeoutMs = Math.max(0, opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.requestTimeoutMs = Math.max(0, opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.timers = opts.timers ?? defaultTimerScheduler;
    this.onOpen = opts.onOpen;
    this.onClose = opts.onClose;
    this.onReconnecting = opts.onReconnecting;
    this.onReconnectExhausted = opts.onReconnectExhausted;
    this.onNotification = opts.onNotification;
    this.onServerRequest = opts.onServerRequest;
    this.onServerResponse = opts.onServerResponse;
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

  get supportsToolRetryLineage(): boolean {
    return this.serverSupportsToolRetryLineage;
  }

  private resetReadyPromise() {
    this.ready = Promise.withResolvers<void>();
    this.readySettled = false;
    void this.ready.promise.catch(() => {
      // prevent unhandled rejection noise for callers that never await readiness
    });
  }

  private settleReadyPromise(error?: Error) {
    this.readySettled = true;
    if (error) {
      this.ready.reject(error);
    } else {
      this.ready.resolve();
    }
  }

  connect() {
    if (this.ws) return;
    this.cancelReconnect();
    this.intentionalClose = false;
    this.reconnectExhausted = false;
    if (this.readySettled) {
      this.resetReadyPromise();
    }
    this.doConnect();
  }

  close() {
    this.intentionalClose = true;
    this.reconnectExhausted = false;
    this.cancelReconnect();
    this.clearConnectionTimeouts();
    this.initialized = false;
    this.serverSupportsToolRetryLineage = false;
    this.pendingInitializationFailure = null;
    const closedError = new Error("socket closed");
    this.settleReadyPromise(closedError);
    this.rejectQueuedRequests(closedError);
    this.rejectPendingRequests(closedError, false);
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
    opts?: JsonRpcSocketRequestOptions,
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
          retryOnDisconnect: opts.retryOnDisconnect === true,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
      }
      throw new Error(`JSON-RPC socket is not ready for request: ${method}`);
    }
    return await this.sendRequestNow(method, params, opts);
  }

  notify(method: string, params?: unknown, opts?: { retryable?: boolean }): boolean {
    if (!this.initialized || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      if (this.reconnectExhausted) {
        return false;
      }
      if (opts?.retryable === true && this.autoReconnect && !this.intentionalClose) {
        try {
          this.enqueueNotification({ kind: "notification", method, params });
          return true;
        } catch {
          return false;
        }
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

  respond(id: string | number, result: unknown, opts?: { retryable?: boolean }): boolean {
    if (!this.initialized || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      if (this.reconnectExhausted) {
        return false;
      }
      if (opts?.retryable === true && this.autoReconnect && !this.intentionalClose) {
        try {
          this.enqueueResponse({ kind: "response", id, result });
          return true;
        } catch {
          return false;
        }
      }
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

  private enqueueResponse(operation: Extract<QueuedOperation, { kind: "response" }>) {
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
    let ws: WebSocketLike;
    try {
      ws = new this.WebSocketImpl(target.url, target.protocols);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.intentionalClose && this.autoReconnect) {
        this.scheduleReconnect(failure);
      } else {
        this.settleReadyPromise(failure);
        this.rejectQueuedRequests(failure);
        this.onClose?.(failure.message);
      }
      return;
    }
    this.ws = ws;
    this.armOpenTimeout(ws);
    let messageQueue = Promise.resolve();

    bindSocketHandler(ws, "open", () => {
      if (this.ws !== ws) {
        return;
      }
      this.clearOpenTimeout();
      this.armHandshakeTimeout(ws);
      void this.performHandshake(ws).catch((error) => {
        const formatted = error instanceof Error ? error : new Error(String(error));
        this.failInitialization(ws, formatted);
      });
    });

    bindSocketHandler(ws, "message", (event) => {
      const processMessage = async () => {
        if (this.ws !== ws) {
          return;
        }
        const rawData = "data" in event ? event.data : undefined;
        let decoded: unknown;
        try {
          decoded = await decodeSocketData(rawData);
        } catch (error) {
          if (this.ws === ws) {
            this.onInvalidMessage?.({
              message: error instanceof Error ? error.message : "failed_to_decode_socket_payload",
              raw: rawData,
            });
          }
          return;
        }

        if (this.ws !== ws) {
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
      };
      const processing = messageQueue.then(processMessage, processMessage);
      messageQueue = processing.catch(() => {
        // Keep later inbound messages serializable after a handler failure.
      });
      return processing;
    });

    bindSocketHandler(ws, "error", () => {
      // rely on close for reconnection transitions
    });

    bindSocketHandler(ws, "close", () => {
      if (this.ws !== ws) {
        return;
      }
      const wasInitialized = this.initialized;
      const failure = this.pendingInitializationFailure ?? new Error("websocket closed");
      this.initialized = false;
      this.ws = null;
      this.pendingInitializationFailure = null;
      this.clearConnectionTimeouts();
      this.rejectPendingRequests(failure, !this.intentionalClose && this.autoReconnect);
      if (!this.intentionalClose && this.autoReconnect) {
        if (wasInitialized) {
          this.resetReadyPromise();
        }
        this.scheduleReconnect(failure);
      } else {
        if (!wasInitialized) {
          this.settleReadyPromise(failure);
        }
        this.rejectQueuedRequests(failure);
        this.onClose?.(failure.message);
      }
    });
  }

  private async performHandshake(ws: WebSocketLike): Promise<void> {
    const initializeParams = (includeToolRetryLineage: boolean) => ({
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: this.experimentalApi,
        ...(includeToolRetryLineage ? { toolRetryLineage: true } : {}),
        ...(this.optOutNotificationMethods.length > 0
          ? { optOutNotificationMethods: this.optOutNotificationMethods }
          : {}),
      },
    });
    let initializeResult: unknown;
    try {
      initializeResult = await this.sendRequestNow(
        "initialize",
        initializeParams(this.toolRetryLineage),
      );
    } catch (error) {
      if (this.ws !== ws) {
        return;
      }
      const requestError = error as JsonRpcRequestError;
      if (
        !this.toolRetryLineage ||
        requestError.jsonRpcCode !== JSONRPC_INVALID_PARAMS_ERROR_CODE
      ) {
        throw error;
      }
      this.serverSupportsToolRetryLineage = false;
      initializeResult = await this.sendRequestNow("initialize", initializeParams(false));
    }
    if (this.ws !== ws) {
      return;
    }
    const capabilities =
      initializeResult &&
      typeof initializeResult === "object" &&
      "capabilities" in initializeResult &&
      initializeResult.capabilities &&
      typeof initializeResult.capabilities === "object"
        ? initializeResult.capabilities
        : null;
    this.serverSupportsToolRetryLineage =
      capabilities !== null &&
      "toolRetryLineage" in capabilities &&
      capabilities.toolRetryLineage === true;
    if (ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("Failed to send initialized notification");
    }
    ws.send(JSON.stringify({ method: "initialized" }));
    this.clearHandshakeTimeout();
    this.initialized = true;
    this.reconnectAttempt = 0;
    this.settleReadyPromise();
    this.flushQueuedOperations();
    if (this.ws === ws && this.initialized) {
      this.onOpen?.();
    }
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

  private async sendRequestNow(
    method: string,
    params?: unknown,
    opts?: JsonRpcSocketRequestOptions,
  ): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error(`JSON-RPC socket is not open for request: ${method}`);
    }
    const id = ++this.nextId;
    const timeoutMs = Math.max(0, opts?.timeoutMs ?? this.requestTimeoutMs);
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending = {
        method,
        params,
        retryOnDisconnect: opts?.retryOnDisconnect === true,
        timeoutMs,
        timeoutHandle: null as unknown,
        resolve,
        reject,
      };
      this.pendingRequests.set(id, pending);
      if (method !== "initialize" && timeoutMs > 0) {
        pending.timeoutHandle = this.timers.setTimeout(() => {
          if (this.pendingRequests.get(id) !== pending) {
            return;
          }
          this.pendingRequests.delete(id);
          pending.timeoutHandle = null;
          reject(new Error(`JSON-RPC request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
    try {
      ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    } catch (error) {
      const pending = this.pendingRequests.get(id);
      if (pending?.timeoutHandle !== null && pending?.timeoutHandle !== undefined) {
        this.timers.clearTimeout(pending.timeoutHandle);
      }
      this.pendingRequests.delete(id);
      throw error instanceof Error ? error : new Error(String(error));
    }
    return await promise;
  }

  private handleResponse(message: JsonRpcLiteClientResponse) {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      this.onServerResponse?.(message);
      return;
    }
    this.pendingRequests.delete(message.id);
    if (pending.timeoutHandle !== null) {
      this.timers.clearTimeout(pending.timeoutHandle);
    }
    if (message.error) {
      const error = new Error(message.error.message) as JsonRpcRequestError;
      error.jsonRpcCode = message.error.code;
      if (message.error.data !== undefined) {
        error.jsonRpcData = message.error.data;
      }
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
    for (const [index, operation] of queued.entries()) {
      if (!this.initialized || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
        this.queuedOperations.unshift(...queued.slice(index));
        return;
      }
      if (operation.kind === "notification") {
        if (!this.notify(operation.method, operation.params)) {
          this.queuedOperations.unshift(...queued.slice(index));
          return;
        }
        continue;
      }
      if (operation.kind === "response") {
        if (!this.respond(operation.id, operation.result)) {
          this.queuedOperations.unshift(...queued.slice(index));
          return;
        }
        continue;
      }
      void this.sendRequestNow(operation.method, operation.params, {
        retryOnDisconnect: operation.retryOnDisconnect,
        ...(operation.timeoutMs !== undefined ? { timeoutMs: operation.timeoutMs } : {}),
      })
        .then((result) => {
          operation.resolve(result);
        })
        .catch((error) => {
          operation.reject(error instanceof Error ? error : new Error(String(error)));
        });
    }
  }

  private scheduleReconnect(reason: Error) {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.reconnectExhausted = true;
      const exhaustedError = new Error("max reconnect attempts exceeded");
      this.settleReadyPromise(exhaustedError);
      this.rejectQueuedRequests(exhaustedError);
      this.onReconnectExhausted?.(exhaustedError.message);
      this.onClose?.(exhaustedError.message);
      return;
    }
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt + Math.random() * 200,
      MAX_RECONNECT_DELAY_MS,
    );
    this.onReconnecting?.({
      attempt: this.reconnectAttempt + 1,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
      reason: reason.message,
      queuedOperationCount: this.queuedOperations.length,
      pendingRequestCount: this.pendingRequests.size,
    });
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

  private rejectPendingRequests(error: Error, requeueRetryable: boolean) {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutHandle !== null) {
        this.timers.clearTimeout(pending.timeoutHandle);
      }
      if (requeueRetryable && pending.retryOnDisconnect) {
        if (this.queuedOperations.length < this.maxQueuedMessages) {
          this.queuedOperations.push({
            kind: "request",
            method: pending.method,
            params: pending.params,
            retryOnDisconnect: true,
            timeoutMs: pending.timeoutMs,
            resolve: pending.resolve,
            reject: pending.reject,
          });
          continue;
        }
        pending.reject(new Error("JSON-RPC retry queue is full"));
        continue;
      }
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
