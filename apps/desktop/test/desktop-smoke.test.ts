import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  type ConnectDesktopSmokeJsonRpcOptions,
  connectDesktopSmokeJsonRpc,
  type DesktopSmokeJsonRpcConnection,
  runDesktopSmokePromptLoadCheck,
} from "../electron/services/desktopSmoke";

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocols?: string | string[];
  sent: string[] = [];
  closeCalls = 0;

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(String(data));
  }

  close() {
    this.closeCalls += 1;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  emitOpen() {
    this.emit("open");
  }

  emitMessage(data: unknown) {
    this.emit("message", data);
  }

  emitSocketError(error: Error) {
    this.emit("error", error);
  }

  emitSocketClose(reason = "") {
    this.emit("close", 1006, Buffer.from(reason, "utf8"));
  }
}

function parseSentMessages(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

async function flushMicrotasks() {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function createSocketOptions(
  overrides: Partial<ConnectDesktopSmokeJsonRpcOptions> = {},
): ConnectDesktopSmokeJsonRpcOptions {
  FakeWebSocket.instances = [];
  return {
    url: "ws://example.test/socket",
    clientVersion: "1.2.3",
    createWebSocket: (url: string, protocols?: string | string[]) =>
      new FakeWebSocket(url, protocols) as any,
    ...overrides,
  };
}

function createManualTimers() {
  let nextId = 0;
  const timeoutCallbacks = new Map<number, () => void>();

  return {
    get timeoutCallbacks() {
      return [...timeoutCallbacks.entries()];
    },
    timers: {
      setTimeoutFn(callback: () => void) {
        const id = ++nextId;
        timeoutCallbacks.set(id, callback);
        return { id } as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn(handle: ReturnType<typeof setTimeout>) {
        const id =
          typeof handle === "object" && handle !== null && "id" in handle
            ? Number((handle as { id?: unknown }).id)
            : NaN;
        if (Number.isFinite(id)) {
          timeoutCallbacks.delete(id);
        }
      },
    },
  };
}

async function connectWithInitializedSocket(
  overrides: Partial<ConnectDesktopSmokeJsonRpcOptions> = {},
): Promise<{ rpc: Awaited<ReturnType<typeof connectDesktopSmokeJsonRpc>>; ws: FakeWebSocket }> {
  const connectPromise = connectDesktopSmokeJsonRpc(createSocketOptions(overrides));
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await flushMicrotasks();
  expect(parseSentMessages(ws)).toEqual([
    {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "desktop-smoke",
          version: "1.2.3",
        },
      },
    },
  ]);
  ws.emitMessage(JSON.stringify({ id: 1, result: { protocolVersion: "0.1" } }));
  const rpc = await connectPromise;
  expect(parseSentMessages(ws)[1]).toEqual({ method: "initialized" });
  return { rpc, ws };
}

describe("desktop smoke JSON-RPC helper", () => {
  test("connects with the JSON-RPC subprotocol, initializes, and sends initialized", async () => {
    const { rpc, ws } = await connectWithInitializedSocket();

    expect(ws.url).toBe("ws://example.test/socket");
    expect(ws.protocols).toBe("cowork.jsonrpc.v1");
    rpc.close();
  });

  test("rejects on an unexpected protocol version and closes the socket", async () => {
    const connectPromise = connectDesktopSmokeJsonRpc(createSocketOptions());
    const ws = FakeWebSocket.instances[0]!;

    ws.emitOpen();
    ws.emitMessage(JSON.stringify({ id: 1, result: { protocolVersion: "0.2" } }));

    await expect(connectPromise).rejects.toThrow(
      "Desktop smoke initialize returned an unexpected protocol version",
    );
    expect(ws.closeCalls).toBe(1);
  });

  test("closes the socket when initialize responds with a JSON-RPC error", async () => {
    const connectPromise = connectDesktopSmokeJsonRpc(createSocketOptions());
    const ws = FakeWebSocket.instances[0]!;

    ws.emitOpen();
    ws.emitMessage(JSON.stringify({ id: 1, error: { code: 500, message: "denied" } }));

    await expect(connectPromise).rejects.toThrow("initialize failed (500): denied");
    expect(ws.closeCalls).toBe(1);
  });

  test("surfaces request errors and still resolves queued notifications", async () => {
    const { rpc, ws } = await connectWithInitializedSocket();

    ws.emitMessage(
      JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-1" } } }),
    );

    const requestPromise = rpc.sendRequest("thread/start", { cwd: "/workspace" });
    expect(parseSentMessages(ws)[2]).toEqual({
      id: 2,
      method: "thread/start",
      params: { cwd: "/workspace" },
    });

    ws.emitMessage(JSON.stringify({ id: 2, error: { code: 123, message: "boom" } }));

    await expect(requestPromise).rejects.toThrow("thread/start failed (123): boom");
    await expect(
      rpc.waitFor((message) => message.method === "thread/started", { label: "thread/started" }),
    ).resolves.toMatchObject({
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    });
    rpc.close();
  });

  test("rejects pending waiters immediately on post-open socket error", async () => {
    const { rpc, ws } = await connectWithInitializedSocket();

    const waitPromise = rpc.waitFor(() => false, { label: "turn/completed", timeoutMs: 30_000 });
    ws.emitSocketError(new Error("socket boom"));

    await expect(waitPromise).rejects.toThrow("socket boom");
    rpc.close();
  });

  test("rejects pending waiters immediately on post-open socket close", async () => {
    const { rpc, ws } = await connectWithInitializedSocket();

    const waitPromise = rpc.waitFor(() => false, { label: "turn/completed", timeoutMs: 30_000 });
    ws.emitSocketClose("server crashed");

    await expect(waitPromise).rejects.toThrow("Desktop smoke websocket closed: server crashed");
    rpc.close();
  });

  test("rejects malformed incoming JSON and closes the socket", async () => {
    const { rpc, ws } = await connectWithInitializedSocket();

    const waitPromise = rpc.waitFor(() => false, { label: "turn/completed", timeoutMs: 30_000 });
    ws.emitMessage("{not valid json");

    await expect(waitPromise).rejects.toThrow("Desktop smoke received malformed JSON-RPC message");
    expect(ws.closeCalls).toBe(1);
    rpc.close();
  });

  test("includes the wait label in timeout errors", async () => {
    const manualTimers = createManualTimers();
    const { rpc } = await connectWithInitializedSocket(manualTimers.timers);

    const waitPromise = rpc.waitFor(() => false, {
      label: "turn/completed for turn-1",
      timeoutMs: 123,
    });
    const timerCallback = manualTimers.timeoutCallbacks.at(-1)?.[1];
    if (!timerCallback) {
      throw new Error("expected waitFor to register a timeout");
    }
    timerCallback();

    await expect(waitPromise).rejects.toThrow(
      "Timed out waiting for desktop smoke turn/completed for turn-1",
    );
    rpc.close();
  });
});

describe("runDesktopSmokePromptLoadCheck", () => {
  test("runs the expected thread and turn sequence", async () => {
    const calls: string[] = [];
    const sendRequestCalls: Array<{ method: string; params: unknown }> = [];
    const waitForCalls: Array<{ label: string; timeoutMs?: number }> = [];
    let closeCalls = 0;

    const rpc: DesktopSmokeJsonRpcConnection = {
      async sendRequest(method, params) {
        calls.push(`send:${method}`);
        sendRequestCalls.push({ method, params });
        if (method === "thread/start") {
          return { result: { thread: { id: "thread-1" } } };
        }
        if (method === "turn/start") {
          return { result: { turn: { id: "turn-1" } } };
        }
        return { result: {} };
      },
      async waitFor(predicate, options) {
        calls.push(`wait:${options.label}`);
        waitForCalls.push(options);
        if (options.label.startsWith("thread/started")) {
          const message = { method: "thread/started", params: { thread: { id: "thread-1" } } };
          expect(predicate(message)).toBe(true);
          return message;
        }
        const message = {
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed" } },
        };
        expect(predicate(message)).toBe(true);
        return message;
      },
      close() {
        closeCalls += 1;
      },
    };

    await runDesktopSmokePromptLoadCheck({
      url: "ws://example.test/socket",
      workspacePath: "/workspace",
      clientVersion: "1.2.3",
      now: () => 123,
      connectJsonRpc: async (options) => {
        expect(options.url).toBe("ws://example.test/socket");
        expect(options.clientVersion).toBe("1.2.3");
        return rpc;
      },
    });

    expect(calls).toEqual([
      "send:thread/start",
      "wait:thread/started for thread-1",
      "send:cowork/session/config/set",
      "send:turn/start",
      "wait:turn/completed for turn-1",
    ]);
    expect(sendRequestCalls).toEqual([
      {
        method: "thread/start",
        params: { cwd: "/workspace" },
      },
      {
        method: "cowork/session/config/set",
        params: {
          threadId: "thread-1",
          config: {
            userName: "Desktop Smoke 123",
          },
        },
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: "Desktop smoke packaged turn check",
        },
      },
    ]);
    expect(waitForCalls).toEqual([
      { label: "thread/started for thread-1" },
      { label: "turn/completed for turn-1", timeoutMs: 30_000 },
    ]);
    expect(closeCalls).toBe(1);
  });

  test("rejects when thread/start omits the thread id and still closes the connection", async () => {
    let closeCalls = 0;
    const rpc: DesktopSmokeJsonRpcConnection = {
      async sendRequest() {
        return { result: { thread: {} } };
      },
      async waitFor() {
        throw new Error("waitFor should not be called");
      },
      close() {
        closeCalls += 1;
      },
    };

    await expect(
      runDesktopSmokePromptLoadCheck({
        url: "ws://example.test/socket",
        workspacePath: "/workspace",
        clientVersion: "1.2.3",
        connectJsonRpc: async () => rpc,
      }),
    ).rejects.toThrow("Desktop smoke thread/start did not return a thread id");
    expect(closeCalls).toBe(1);
  });

  test("rejects when turn/start omits the turn id and still closes the connection", async () => {
    let closeCalls = 0;
    const rpc: DesktopSmokeJsonRpcConnection = {
      async sendRequest(method) {
        if (method === "thread/start") {
          return { result: { thread: { id: "thread-1" } } };
        }
        if (method === "turn/start") {
          return { result: { turn: {} } };
        }
        return { result: {} };
      },
      async waitFor() {
        return { method: "thread/started", params: { thread: { id: "thread-1" } } };
      },
      close() {
        closeCalls += 1;
      },
    };

    await expect(
      runDesktopSmokePromptLoadCheck({
        url: "ws://example.test/socket",
        workspacePath: "/workspace",
        clientVersion: "1.2.3",
        connectJsonRpc: async () => rpc,
      }),
    ).rejects.toThrow("Desktop smoke turn/start did not return a turn id");
    expect(closeCalls).toBe(1);
  });

  test("accepts failed turn statuses so smoke does not depend on provider credentials", async () => {
    let closeCalls = 0;
    const rpc: DesktopSmokeJsonRpcConnection = {
      async sendRequest(method) {
        if (method === "thread/start") {
          return { result: { thread: { id: "thread-1" } } };
        }
        if (method === "turn/start") {
          return { result: { turn: { id: "turn-1" } } };
        }
        return { result: {} };
      },
      async waitFor(_predicate, options) {
        if (options.label.startsWith("thread/started")) {
          return { method: "thread/started", params: { thread: { id: "thread-1" } } };
        }
        return { method: "turn/completed", params: { turn: { id: "turn-1", status: "failed" } } };
      },
      close() {
        closeCalls += 1;
      },
    };

    await expect(
      runDesktopSmokePromptLoadCheck({
        url: "ws://example.test/socket",
        workspacePath: "/workspace",
        clientVersion: "1.2.3",
        connectJsonRpc: async () => rpc,
      }),
    ).resolves.toBeUndefined();
    expect(closeCalls).toBe(1);
  });

  test("rejects missing or unrecognized turn statuses and still closes the connection", async () => {
    let closeCalls = 0;
    const rpc: DesktopSmokeJsonRpcConnection = {
      async sendRequest(method) {
        if (method === "thread/start") {
          return { result: { thread: { id: "thread-1" } } };
        }
        if (method === "turn/start") {
          return { result: { turn: { id: "turn-1" } } };
        }
        return { result: {} };
      },
      async waitFor(_predicate, options) {
        if (options.label.startsWith("thread/started")) {
          return { method: "thread/started", params: { thread: { id: "thread-1" } } };
        }
        return { method: "turn/completed", params: { turn: { id: "turn-1", status: "mystery" } } };
      },
      close() {
        closeCalls += 1;
      },
    };

    await expect(
      runDesktopSmokePromptLoadCheck({
        url: "ws://example.test/socket",
        workspacePath: "/workspace",
        clientVersion: "1.2.3",
        connectJsonRpc: async () => rpc,
      }),
    ).rejects.toThrow("Desktop smoke turn/completed reported an invalid status: mystery");
    expect(closeCalls).toBe(1);
  });
});
