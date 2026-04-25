import { describe, expect, test } from "bun:test";

import { JsonRpcSocket } from "../src/client/jsonRpcSocket";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

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
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(String(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  async emitMessage(data: unknown) {
    if (!this.onmessage) throw new Error("onmessage handler is not set");
    await this.onmessage({ data });
  }
}

class ExhaustingReconnectWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: ExhaustingReconnectWebSocket[] = [];

  url: string;
  protocols?: string | string[];
  protocol = "";
  readyState = ExhaustingReconnectWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onmessage: null | ((ev: { data: unknown }) => void | Promise<void>) = null;
  onclose: null | (() => void) = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    this.protocol = typeof protocols === "string" ? protocols : (protocols?.[0] ?? "");
    ExhaustingReconnectWebSocket.instances.push(this);
    const instanceNumber = ExhaustingReconnectWebSocket.instances.length;
    queueMicrotask(() => {
      if (instanceNumber === 1) {
        this.readyState = ExhaustingReconnectWebSocket.OPEN;
        this.onopen?.();
        return;
      }
      this.readyState = ExhaustingReconnectWebSocket.CLOSED;
      this.onclose?.();
    });
  }

  send(data: string) {
    this.sent.push(String(data));
  }

  close() {
    this.readyState = ExhaustingReconnectWebSocket.CLOSED;
    this.onclose?.();
  }

  async emitMessage(data: unknown) {
    if (!this.onmessage) throw new Error("onmessage handler is not set");
    await this.onmessage({ data });
  }
}

async function flushMicrotasks() {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function parseSentMessages(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

function createManualTimers() {
  let nextId = 0;
  const timeoutCallbacks = new Map<number, () => void>();
  const intervalCallbacks = new Map<number, () => void>();

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
        const id =
          typeof handle === "object" && handle !== null && "id" in handle
            ? Number((handle as { id?: unknown }).id)
            : NaN;
        if (Number.isFinite(id)) {
          timeoutCallbacks.delete(id);
        }
      },
      setInterval(callback: () => void) {
        const id = ++nextId;
        intervalCallbacks.set(id, callback);
        return { kind: "interval", id };
      },
      clearInterval(handle: unknown) {
        const id =
          typeof handle === "object" && handle !== null && "id" in handle
            ? Number((handle as { id?: unknown }).id)
            : NaN;
        if (Number.isFinite(id)) {
          intervalCallbacks.delete(id);
        }
      },
    },
  };
}

describe("JsonRpcSocket runtime", () => {
  test("performs initialize handshake and sends initialized notification", async () => {
    FakeWebSocket.instances = [];
    let opened = 0;
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop", version: "1.0.0" },
      WebSocketImpl: FakeWebSocket as any,
      onOpen: () => {
        opened += 1;
      },
    });

    socket.connect();
    await flushMicrotasks();

    const ws = FakeWebSocket.instances[0]!;
    expect(parseSentMessages(ws)).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "desktop",
            version: "1.0.0",
          },
          capabilities: {
            experimentalApi: false,
          },
        },
      },
    ]);

    await ws.emitMessage(JSON.stringify({ id: 1, result: { protocolVersion: "0.1" } }));
    await flushMicrotasks();
    expect(parseSentMessages(ws)).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "desktop",
            version: "1.0.0",
          },
          capabilities: {
            experimentalApi: false,
          },
        },
      },
      {
        method: "initialized",
      },
    ]);
    expect(opened).toBe(1);

    const requestPromise = socket.request("thread/list", { cwd: "/workspace" });
    expect(parseSentMessages(ws)[2]).toEqual({
      id: 2,
      method: "thread/list",
      params: { cwd: "/workspace" },
    });
    await ws.emitMessage(JSON.stringify({ id: 2, result: { threads: [] } }));
    await expect(requestPromise).resolves.toEqual({ threads: [] });
  });

  test("routes server requests to the handler and can respond", async () => {
    FakeWebSocket.instances = [];
    const requests: Array<{ id: string | number; method: string }> = [];
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as any,
      onServerRequest: (message) => {
        requests.push({ id: message.id, method: message.method });
      },
    });

    socket.connect();
    await flushMicrotasks();

    const ws = FakeWebSocket.instances[0]!;
    await ws.emitMessage(JSON.stringify({ id: 1, result: { protocolVersion: "0.1" } }));
    await flushMicrotasks();
    await ws.emitMessage(
      JSON.stringify({
        id: "req-1",
        method: "item/tool/requestUserInput",
        params: { question: "Continue?" },
      }),
    );

    expect(requests).toEqual([{ id: "req-1", method: "item/tool/requestUserInput" }]);
    expect(socket.respond("req-1", { answer: "yes" })).toBe(true);
    expect(parseSentMessages(ws).at(-1)).toEqual({
      id: "req-1",
      result: { answer: "yes" },
    });
  });

  test("preserves JSON-RPC error codes on request failures", async () => {
    FakeWebSocket.instances = [];
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as any,
    });

    socket.connect();
    await flushMicrotasks();

    const ws = FakeWebSocket.instances[0]!;
    await ws.emitMessage(JSON.stringify({ id: 1, result: { protocolVersion: "0.1" } }));
    await flushMicrotasks();

    const requestPromise = socket.request("research/followup", { parentResearchId: "research-1" });
    await ws.emitMessage(
      JSON.stringify({
        id: 2,
        error: { code: -32602, message: "parent research is not completed" },
      }),
    );

    await expect(requestPromise).rejects.toMatchObject({
      message: "parent research is not completed",
      jsonRpcCode: -32602,
    });
  });

  test("queues only retryable operations and enforces queue bounds across reconnect", async () => {
    FakeWebSocket.instances = [];
    const timers = createManualTimers();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as any,
      autoReconnect: true,
      maxQueuedMessages: 1,
      timers: timers.scheduler as any,
    });

    socket.connect();
    await flushMicrotasks();

    const ws1 = FakeWebSocket.instances[0]!;
    await ws1.emitMessage(JSON.stringify({ id: 1, result: { protocolVersion: "0.1" } }));
    await flushMicrotasks();
    ws1.close();

    const queued = socket.request("thread/list", { cwd: "/workspace" }, { retryable: true });
    await expect(
      socket.request("thread/read", { threadId: "thr-1" }, { retryable: true }),
    ).rejects.toThrow("JSON-RPC retry queue is full");

    timers.timeoutCallbacks[0]!();
    await flushMicrotasks();

    const ws2 = FakeWebSocket.instances[1]!;
    await ws2.emitMessage(JSON.stringify({ id: 2, result: { protocolVersion: "0.1" } }));
    await flushMicrotasks();
    expect(parseSentMessages(ws2)).toEqual([
      {
        id: 2,
        method: "initialize",
        params: {
          clientInfo: {
            name: "desktop",
          },
          capabilities: {
            experimentalApi: false,
          },
        },
      },
      {
        method: "initialized",
      },
      {
        id: 3,
        method: "thread/list",
        params: { cwd: "/workspace" },
      },
    ]);
    await ws2.emitMessage(JSON.stringify({ id: 3, result: { threads: [] } }));
    await expect(queued).resolves.toEqual({ threads: [] });
  });

  test("rejects non-retryable requests while disconnected", async () => {
    FakeWebSocket.instances = [];
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as any,
    });

    await expect(socket.request("thread/list", { cwd: "/workspace" })).rejects.toThrow(
      "JSON-RPC socket is not ready for request: thread/list",
    );
    expect(socket.notify("turn/interrupt", { threadId: "thr-1" })).toBe(false);
  });

  test("rejects queued retryable requests once reconnect attempts are exhausted", async () => {
    ExhaustingReconnectWebSocket.instances = [];
    const timers = createManualTimers();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop" },
      WebSocketImpl: ExhaustingReconnectWebSocket as any,
      autoReconnect: true,
      maxReconnectAttempts: 1,
      timers: timers.scheduler as any,
    });

    socket.connect();
    await flushMicrotasks();

    const ws1 = ExhaustingReconnectWebSocket.instances[0]!;
    await ws1.emitMessage(JSON.stringify({ id: 1, result: { protocolVersion: "0.1" } }));
    await flushMicrotasks();
    ws1.close();

    const queued = socket.request("thread/list", { cwd: "/workspace" }, { retryable: true });
    timers.timeoutCallbacks[0]!();
    await flushMicrotasks();

    await expect(queued).rejects.toThrow("max reconnect attempts exceeded");
    await expect(
      socket.request("thread/read", { threadId: "thr-1" }, { retryable: true }),
    ).rejects.toThrow("max reconnect attempts exceeded");
  });

  test("rejects readyPromise and closes the socket when initialize fails", async () => {
    FakeWebSocket.instances = [];
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as any,
    });

    socket.connect();
    const ready = socket.readyPromise;
    await flushMicrotasks();

    const ws = FakeWebSocket.instances[0]!;
    await ws.emitMessage(
      JSON.stringify({
        id: 1,
        error: {
          code: -32000,
          message: "initialize failed",
        },
      }),
    );
    await flushMicrotasks();

    await expect(ready).rejects.toThrow("initialize failed");
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("rejects readiness when the JSON-RPC subprotocol handshake times out", async () => {
    FakeWebSocket.instances = [];
    const timers = createManualTimers();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as any,
      timers: timers.scheduler as any,
      openTimeoutMs: 1_000,
      handshakeTimeoutMs: 1_000,
    });

    socket.connect();
    const ready = socket.readyPromise;
    await flushMicrotasks();

    const ws1 = FakeWebSocket.instances[0]!;
    expect(ws1.url).toBe("ws://example.test/socket");
    expect(ws1.protocols).toBe("cowork.jsonrpc.v1");

    timers.timeoutCallbacks[0]!();
    await flushMicrotasks();

    expect(FakeWebSocket.instances).toHaveLength(1);
    await expect(ready).rejects.toThrow("Timed out waiting for JSON-RPC initialize response");
  });

  test("preserves queued retryable requests across a transient reconnect handshake failure", async () => {
    FakeWebSocket.instances = [];
    const timers = createManualTimers();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as any,
      autoReconnect: true,
      maxReconnectAttempts: 2,
      timers: timers.scheduler as any,
    });

    socket.connect();
    await flushMicrotasks();

    const ws1 = FakeWebSocket.instances[0]!;
    await ws1.emitMessage(JSON.stringify({ id: 1, result: { protocolVersion: "0.1" } }));
    await flushMicrotasks();
    ws1.close();

    const queued = socket.request("thread/list", { cwd: "/workspace" }, { retryable: true });
    timers.timeoutCallbacks[0]!();
    await flushMicrotasks();

    const ws2 = FakeWebSocket.instances[1]!;
    await ws2.emitMessage(
      JSON.stringify({
        id: 2,
        error: {
          code: -32000,
          message: "initialize failed",
        },
      }),
    );
    await flushMicrotasks();

    timers.timeoutCallbacks[1]!();
    await flushMicrotasks();

    const ws3 = FakeWebSocket.instances[2]!;
    await ws3.emitMessage(JSON.stringify({ id: 3, result: { protocolVersion: "0.1" } }));
    await flushMicrotasks();
    expect(parseSentMessages(ws3)).toEqual([
      {
        id: 3,
        method: "initialize",
        params: {
          clientInfo: {
            name: "desktop",
          },
          capabilities: {
            experimentalApi: false,
          },
        },
      },
      {
        method: "initialized",
      },
      {
        id: 4,
        method: "thread/list",
        params: { cwd: "/workspace" },
      },
    ]);

    await ws3.emitMessage(JSON.stringify({ id: 4, result: { threads: [] } }));
    await expect(queued).resolves.toEqual({ threads: [] });
  });

  test("counts failed initialize handshakes toward reconnect exhaustion", async () => {
    FakeWebSocket.instances = [];
    const timers = createManualTimers();
    const closedReasons: string[] = [];
    const socket = new JsonRpcSocket({
      url: "ws://example.test/socket",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as any,
      autoReconnect: true,
      maxReconnectAttempts: 1,
      timers: timers.scheduler as any,
      onClose: (reason) => {
        closedReasons.push(reason);
      },
    });

    socket.connect();
    await flushMicrotasks();

    const ws1 = FakeWebSocket.instances[0]!;
    await ws1.emitMessage(
      JSON.stringify({
        id: 1,
        error: {
          code: -32000,
          message: "initialize failed",
        },
      }),
    );
    await flushMicrotasks();

    const queued = socket.request("thread/list", { cwd: "/workspace" }, { retryable: true });
    timers.timeoutCallbacks[0]!();
    await flushMicrotasks();

    const ws2 = FakeWebSocket.instances[1]!;
    await ws2.emitMessage(
      JSON.stringify({
        id: 2,
        error: {
          code: -32000,
          message: "initialize failed again",
        },
      }),
    );
    await flushMicrotasks();

    await expect(queued).rejects.toThrow("max reconnect attempts exceeded");
    await expect(
      socket.request("thread/read", { threadId: "thr-1" }, { retryable: true }),
    ).rejects.toThrow("max reconnect attempts exceeded");
    expect(closedReasons).toContain("max reconnect attempts exceeded");
    expect(timers.timeoutCallbacks).toHaveLength(1);
  });
});
