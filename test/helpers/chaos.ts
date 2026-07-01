/**
 * Shared fault-injection doubles for the chaos harness.
 *
 * These are deterministic seams — a controllable WebSocket, a manual timer
 * scheduler, and health-endpoint fetch fakes — so reliability scenarios (server
 * death, slow handshake, reconnect-during-approval, health failure) run without
 * real sleeps or spawned processes.
 */

/**
 * Controllable WebSocket double for driving {@link JsonRpcSocket} through
 * connect / handshake / drop / reconnect by hand. Mirrors the browser
 * `WebSocket` surface that `JsonRpcSocket` binds via `on*` handlers.
 *
 * Auto-opens on the next microtask (matching a real socket resolving its
 * connection) so the handshake can proceed; drive the rest with
 * {@link emitMessage} and {@link close}.
 */
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  /** Set false before constructing to require a manual {@link open} call. */
  static autoOpen = true;

  url: string;
  protocols?: string | string[];
  protocol = "";
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onmessage: null | ((ev: { data: unknown }) => void | Promise<void>) = null;
  onclose: null | (() => void) = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    this.protocol = typeof protocols === "string" ? protocols : (protocols?.[0] ?? "");
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) {
      queueMicrotask(() => this.open());
    }
  }

  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("No FakeWebSocket instances have been constructed");
    return ws;
  }

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.autoOpen = true;
  }

  open(): void {
    if (this.readyState !== FakeWebSocket.CONNECTING) return;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(String(data));
  }

  /** Simulate the socket closing — either an intentional close or a fault. */
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  async emitMessage(data: unknown): Promise<void> {
    if (!this.onmessage) throw new Error("onmessage handler is not set");
    await this.onmessage({ data });
  }

  /** Parsed view of everything the socket has sent so far. */
  sentMessages(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  /**
   * Answer this socket's pending JSON-RPC `initialize` request so the handshake
   * completes and queued operations flush. The id is read from the sent frames
   * (it is not stable across reconnects — `JsonRpcSocket` shares one counter).
   */
  async completeHandshake(): Promise<void> {
    const initialize = this.sentMessages().find((message) => message.method === "initialize");
    if (!initialize || typeof initialize.id !== "number") {
      throw new Error("initialize request has not been sent on this socket yet");
    }
    await this.emitMessage(
      JSON.stringify({ id: initialize.id, result: { protocolVersion: "0.1" } }),
    );
    await flushMicrotasks();
  }
}

export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

type ManualTimers = {
  readonly timeoutCallbacks: Array<() => void>;
  scheduler: {
    setTimeout(callback: () => void, delayMs?: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(callback: () => void, delayMs?: number): unknown;
    clearInterval(handle: unknown): void;
  };
};

/**
 * A timer scheduler whose callbacks only fire when the test invokes them, so
 * reconnect backoff can be advanced deterministically.
 */
export function createManualTimers(): ManualTimers {
  let nextId = 0;
  const timeoutCallbacks = new Map<number, () => void>();
  const intervalCallbacks = new Map<number, () => void>();

  const handleId = (handle: unknown): number => {
    return typeof handle === "object" && handle !== null && "id" in handle
      ? Number((handle as { id?: unknown }).id)
      : NaN;
  };

  return {
    get timeoutCallbacks() {
      return [...timeoutCallbacks.values()];
    },
    scheduler: {
      setTimeout(callback: () => void) {
        const id = ++nextId;
        timeoutCallbacks.set(id, callback);
        return { kind: "timeout", id };
      },
      clearTimeout(handle: unknown) {
        const id = handleId(handle);
        if (Number.isFinite(id)) timeoutCallbacks.delete(id);
      },
      setInterval(callback: () => void) {
        const id = ++nextId;
        intervalCallbacks.set(id, callback);
        return { kind: "interval", id };
      },
      clearInterval(handle: unknown) {
        const id = handleId(handle);
        if (Number.isFinite(id)) intervalCallbacks.delete(id);
      },
    },
  };
}

function makeAbortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

/** A `fetch` that always answers the health probe with `200 { ok: true }`. */
export function okHealthFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** A `fetch` that answers the health probe with an arbitrary status (e.g. 503). */
export function statusHealthFetch(status: number, body = ""): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

/**
 * A `fetch` that models a health endpoint whose response never arrives within
 * the supervisor's 1.5s window: it rejects with an `AbortError`, which is what
 * the supervisor's `AbortController`-backed `fetchWithTimeout` throws once
 * `SERVER_HEALTH_TIMEOUT_MS` elapses. Rejecting immediately keeps the test
 * deterministic instead of waiting out the real timeout.
 */
export function abortingHealthFetch(): typeof fetch {
  return (async () => {
    throw makeAbortError();
  }) as unknown as typeof fetch;
}
