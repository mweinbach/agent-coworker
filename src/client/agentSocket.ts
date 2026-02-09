import type { ClientMessage, ServerEvent } from "../server/protocol";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function safeJsonParse(raw: unknown): any | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export type AgentSocketOpts = {
  url: string;
  client: string;
  version?: string;
  onEvent: (evt: ServerEvent) => void;
  onClose?: (reason: string) => void;
  onOpen?: () => void;
  WebSocketImpl?: typeof WebSocket;
};

export class AgentSocket {
  private readonly url: string;
  private readonly onEvent: (evt: ServerEvent) => void;
  private readonly onClose?: (reason: string) => void;
  private readonly onOpen?: () => void;
  private readonly clientHello: { client: string; version?: string };
  private readonly WebSocketImpl: typeof WebSocket;

  private ws: WebSocket | null = null;
  private ready = deferred<string>();
  private _sessionId: string | null = null;

  constructor(opts: AgentSocketOpts) {
    this.url = opts.url;
    this.onEvent = opts.onEvent;
    this.onClose = opts.onClose;
    this.onOpen = opts.onOpen;
    this.clientHello = { client: opts.client, version: opts.version };

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
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;

    ws.onopen = () => {
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
      this.onOpen?.();
    };

    ws.onmessage = (ev) => {
      const msg = safeJsonParse(String((ev as any).data));
      if (!msg || typeof msg.type !== "string") return;

      const evt = msg as ServerEvent;
      if (evt.type === "server_hello") {
        this._sessionId = evt.sessionId;
        this.ready.resolve(evt.sessionId);
      }

      this.onEvent(evt);
    };

    ws.onerror = () => {
      // We'll rely on onclose for state transitions.
    };

    ws.onclose = () => {
      const reason = "websocket closed";
      if (!this._sessionId) this.ready.reject(new Error(reason));
      this.ws = null;
      this._sessionId = null;
      this.onClose?.(reason);
    };
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
}

