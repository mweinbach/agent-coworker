import { z } from "zod";

import { SERVER_EVENT_TYPES, type ClientMessage, type ServerEvent } from "../server/protocol";

const serverEventEnvelopeSchema = z.object({
  type: z.enum(SERVER_EVENT_TYPES),
  sessionId: z.preprocess((value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }, z.string()),
}).passthrough();

const jsonObjectSchema = z.record(z.string(), z.unknown());

export function safeJsonParse(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function safeParseServerEvent(raw: unknown): ServerEvent | null {
  const parsedJson = safeJsonParse(raw);
  const parsedObject = jsonObjectSchema.safeParse(parsedJson);
  if (!parsedObject.success) {
    return null;
  }

  const envelope = serverEventEnvelopeSchema.safeParse(parsedObject.data);
  if (!envelope.success) return null;
  return parsedObject.data as ServerEvent;
}

export type AgentSocketOpts = {
  url: string;
  resumeSessionId?: string;
  client: string;
  version?: string;
  onEvent: (evt: ServerEvent) => void;
  onClose?: (reason: string) => void;
  onOpen?: () => void;
  WebSocketImpl?: typeof WebSocket;

  /** Enable automatic reconnection on unexpected disconnects. Default: false. */
  autoReconnect?: boolean;
  /** Maximum number of reconnection attempts before giving up. Default: 10. */
  maxReconnectAttempts?: number;
  /** Ping interval in ms for keepalive. 0 disables. Default: 30000. */
  pingIntervalMs?: number;
};

/** Base delay for exponential backoff (ms). */
const BASE_RECONNECT_DELAY_MS = 500;
/** Maximum delay cap for exponential backoff (ms). */
const MAX_RECONNECT_DELAY_MS = 30_000;

export class AgentSocket {
  private readonly url: string;
  private readonly onEvent: (evt: ServerEvent) => void;
  private readonly onClose?: (reason: string) => void;
  private readonly onOpen?: () => void;
  private readonly clientHello: { client: string; version?: string };
  private readonly WebSocketImpl: typeof WebSocket;

  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly pingIntervalMs: number;

  private ws: WebSocket | null = null;
  private ready = Promise.withResolvers<string>();
  private _sessionId: string | null = null;
  private resumeSessionId: string | null = null;

  // Reconnection state.
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  // Keepalive state.
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // Queue messages sent while disconnected (if autoReconnect is on).
  private sendQueue: ClientMessage[] = [];

  constructor(opts: AgentSocketOpts) {
    this.url = opts.url;
    this.resumeSessionId = opts.resumeSessionId?.trim() || null;
    this.onEvent = opts.onEvent;
    this.onClose = opts.onClose;
    this.onOpen = opts.onOpen;
    this.clientHello = { client: opts.client, version: opts.version };

    this.autoReconnect = opts.autoReconnect ?? false;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 10;
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000;

    const impl = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
    if (!impl) {
      throw new Error("WebSocket is not available in this environment.");
    }
    this.WebSocketImpl = impl as typeof WebSocket;
  }

  get sessionId() {
    return this._sessionId;
  }

  get readyPromise(): Promise<string> {
    return this.ready.promise;
  }

  connect() {
    if (this.ws) return;
    this.intentionalClose = false;
    this.doConnect();
  }

  private getConnectUrl(): string {
    if (!this.resumeSessionId) return this.url;
    try {
      const parsed = new URL(this.url);
      parsed.searchParams.set("resumeSessionId", this.resumeSessionId);
      return parsed.toString();
    } catch {
      const separator = this.url.includes("?") ? "&" : "?";
      return `${this.url}${separator}resumeSessionId=${encodeURIComponent(this.resumeSessionId)}`;
    }
  }

  private doConnect() {
    const ws = new this.WebSocketImpl(this.getConnectUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      try {
        ws.send(
          JSON.stringify({
            type: "client_hello",
            ...this.clientHello,
          } satisfies ClientMessage)
        );
      } catch {
        // ignore
      }
      this.startPing();
      this.onOpen?.();
    };

    ws.onmessage = (ev) => {
      const evt = safeParseServerEvent(String((ev as any).data));
      if (!evt) return;

      // Pong is an internal keepalive and should not be surfaced to consumers.
      if (evt.type === "pong") return;

      if (evt.type === "server_hello") {
        this._sessionId = evt.sessionId;
        this.resumeSessionId = evt.sessionId;
        this.ready.resolve(evt.sessionId);

        // Flush any messages that were queued while disconnected.
        this.flushSendQueue();
      }

      this.onEvent(evt);
    };

    ws.onerror = () => {
      // We'll rely on onclose for state transitions.
    };

    ws.onclose = () => {
      this.stopPing();
      const hadSession = !!this._sessionId;
      const hasResumeCandidate = hadSession || !!this.resumeSessionId;
      if (!this._sessionId) this.ready.reject(new Error("websocket closed"));
      this.ws = null;
      this._sessionId = null;

      if (!this.intentionalClose && this.autoReconnect && hasResumeCandidate) {
        this.scheduleReconnect();
      } else {
        this.onClose?.("websocket closed");
      }
    };
  }

  close() {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.stopPing();
    this.sendQueue = [];
    this.resumeSessionId = null;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      // If auto-reconnect is on and this is a user message, queue it.
      if (this.autoReconnect && !this.intentionalClose) {
        this.sendQueue.push(msg);
        return true; // indicate "accepted" even though delivery is deferred
      }
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Reconnection with exponential backoff + jitter
  // ---------------------------------------------------------------------------

  private scheduleReconnect() {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.onClose?.("max reconnect attempts exceeded");
      return;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt + Math.random() * 200,
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt++;

    // Reset the ready promise so consumers can await the new session.
    this.ready = Promise.withResolvers<string>();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  // ---------------------------------------------------------------------------
  // Keepalive ping
  // ---------------------------------------------------------------------------

  private startPing() {
    this.stopPing();
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) {
        const sessionId = this._sessionId;
        if (!sessionId) return;
        try {
          this.ws.send(JSON.stringify({ type: "ping", sessionId } satisfies ClientMessage));
        } catch {
          // ignore
        }
      }
    }, this.pingIntervalMs);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Queue flush
  // ---------------------------------------------------------------------------

  private flushSendQueue() {
    if (this.sendQueue.length === 0) return;
    const queue = this.sendQueue;
    this.sendQueue = [];
    for (const msg of queue) {
      this.send(msg);
    }
  }
}
