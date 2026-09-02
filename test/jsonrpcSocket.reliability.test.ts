import { describe, expect, test } from "bun:test";

import { JsonRpcSocket } from "../src/client/jsonRpcSocket";
import { createManualTimers, FakeWebSocket, flushMicrotasks } from "./helpers/chaos";

describe("JsonRpcSocket foundational reliability", () => {
  test.each(["opening", "handshaking", "reconnecting"] as const)(
    "settles readiness when closed while %s",
    async (phase) => {
      FakeWebSocket.reset();
      FakeWebSocket.autoOpen = phase !== "opening";

      class AsyncCloseWebSocket extends FakeWebSocket {
        override close() {
          queueMicrotask(() => super.close());
        }
      }

      const timers = createManualTimers();
      const socket = new JsonRpcSocket({
        url: "ws://example.test/ws",
        clientInfo: { name: "desktop" },
        WebSocketImpl: AsyncCloseWebSocket as never,
        autoReconnect: true,
        timers: timers.scheduler as never,
      });

      socket.connect();
      await flushMicrotasks();
      if (phase === "reconnecting") {
        await FakeWebSocket.latest().completeHandshake();
        FakeWebSocket.latest().close();
        await flushMicrotasks();
      }

      const readiness = socket.readyPromise.then(
        () => "ready",
        (error: Error) => error.message,
      );
      socket.close();

      await expect(
        Promise.race([readiness, flushMicrotasks().then(() => "pending")]),
      ).resolves.toBe("socket closed");
      expect(timers.timeoutCallbacks).toHaveLength(0);

      FakeWebSocket.autoOpen = true;
      socket.connect();
      await flushMicrotasks();
      await FakeWebSocket.latest().completeHandshake();
      await expect(socket.readyPromise).resolves.toBeUndefined();
      socket.close();
    },
  );

  test("preserves readiness waiters when reconnecting manually during backoff", async () => {
    FakeWebSocket.reset();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/ws",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as never,
      autoReconnect: true,
      timers: createManualTimers().scheduler as never,
    });

    try {
      socket.connect();
      await flushMicrotasks();
      await FakeWebSocket.latest().completeHandshake();
      FakeWebSocket.latest().close();
      const readiness = socket.readyPromise.then(() => "ready");

      socket.connect();
      await flushMicrotasks();
      await FakeWebSocket.latest().completeHandshake();

      await expect(
        Promise.race([readiness, flushMicrotasks().then(() => "pending")]),
      ).resolves.toBe("ready");
    } finally {
      socket.close();
    }
  });

  test.each(["successful", "rejected"] as const)(
    "does not apply a stale %s handshake to a replacement connection",
    async (outcome) => {
      FakeWebSocket.reset();
      let opened = 0;
      const socket = new JsonRpcSocket({
        url: "ws://example.test/ws",
        clientInfo: { name: "desktop" },
        WebSocketImpl: FakeWebSocket as never,
        toolRetryLineage: true,
        timers: createManualTimers().scheduler as never,
        onOpen: () => {
          opened += 1;
        },
      });

      try {
        socket.connect();
        await flushMicrotasks();
        const previous = FakeWebSocket.latest();
        const initialize = previous.sentMessages()[0];
        const response =
          outcome === "successful"
            ? { result: { capabilities: { toolRetryLineage: true } } }
            : { error: { code: -32602, message: "Unknown capability: toolRetryLineage" } };
        const delivery = previous.emitMessage(JSON.stringify({ id: initialize?.id, ...response }));

        // Replace the connection after its reply is dispatched but before the
        // asynchronous handshake continuation consumes that reply.
        queueMicrotask(() =>
          queueMicrotask(() => {
            socket.close();
            socket.connect();
          }),
        );
        await delivery;
        await flushMicrotasks();
        await flushMicrotasks();

        const current = FakeWebSocket.latest();
        expect(current).not.toBe(previous);
        expect(current.sentMessages().map((message) => message.method)).toEqual(["initialize"]);
        expect(opened).toBe(0);
        expect(socket.supportsToolRetryLineage).toBe(false);

        await current.completeHandshake();
        await expect(socket.readyPromise).resolves.toBeUndefined();
        expect(opened).toBe(1);
      } finally {
        socket.close();
      }
    },
  );

  test("bounds an unanswered request so callers never remain pending forever", async () => {
    FakeWebSocket.reset();
    const timers = createManualTimers();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/ws",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as never,
      requestTimeoutMs: 1_000,
      timers: timers.scheduler as never,
    });

    socket.connect();
    await flushMicrotasks();
    const ws = FakeWebSocket.latest();
    await ws.completeHandshake();

    const request = socket.request("thread/read", { threadId: "thread-1" });
    expect(timers.timeoutCallbacks).toHaveLength(1);
    timers.timeoutCallbacks[0]?.();

    await expect(request).rejects.toThrow("JSON-RPC request thread/read timed out after 1000ms");
  });

  test("keeps WebSocket messages in delivery order while an earlier Blob is decoding", async () => {
    FakeWebSocket.reset();
    const notifications: string[] = [];
    const socket = new JsonRpcSocket({
      url: "ws://example.test/ws",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as never,
      onNotification: (message) => notifications.push(message.method),
    });

    socket.connect();
    await flushMicrotasks();
    const ws = FakeWebSocket.latest();
    await ws.completeHandshake();

    const firstPayload = Promise.withResolvers<string>();
    const firstMessage = new Blob();
    Object.defineProperty(firstMessage, "text", { value: () => firstPayload.promise });

    const firstDelivery = ws.emitMessage(firstMessage);
    const secondDelivery = ws.emitMessage(JSON.stringify({ method: "turn/completed" }));
    await flushMicrotasks();
    expect(notifications).toEqual([]);

    firstPayload.resolve(JSON.stringify({ method: "item/agentMessage/delta" }));
    await Promise.all([firstDelivery, secondDelivery]);

    expect(notifications).toEqual(["item/agentMessage/delta", "turn/completed"]);
  });

  test("drops messages still decoding after their connection has been replaced", async () => {
    FakeWebSocket.reset();
    const timers = createManualTimers();
    const notifications: string[] = [];
    const socket = new JsonRpcSocket({
      url: "ws://example.test/ws",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as never,
      autoReconnect: true,
      timers: timers.scheduler as never,
      onNotification: (message) => notifications.push(message.method),
    });

    socket.connect();
    await flushMicrotasks();
    const previous = FakeWebSocket.latest();
    await previous.completeHandshake();

    const stalePayload = Promise.withResolvers<string>();
    const staleMessage = new Blob();
    Object.defineProperty(staleMessage, "text", { value: () => stalePayload.promise });
    const staleDelivery = previous.emitMessage(staleMessage);

    previous.close();
    timers.timeoutCallbacks[0]?.();
    await flushMicrotasks();
    const current = FakeWebSocket.latest();
    await current.completeHandshake();

    stalePayload.resolve(JSON.stringify({ method: "turn/completed" }));
    await staleDelivery;
    await current.emitMessage(JSON.stringify({ method: "item/agentMessage/delta" }));

    expect(notifications).toEqual(["item/agentMessage/delta"]);
  });

  test("retries queued approvals and reads when reconnect flush loses its connection", async () => {
    FakeWebSocket.reset();
    const timers = createManualTimers();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/ws",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as never,
      autoReconnect: true,
      timers: timers.scheduler as never,
    });

    socket.connect();
    await flushMicrotasks();
    FakeWebSocket.latest().close();

    expect(socket.notify("cowork/refresh", {}, { retryable: true })).toBe(true);
    expect(socket.respond("approval-1", { decision: "accept" }, { retryable: true })).toBe(true);
    const retriedRead = socket.request(
      "thread/read",
      { threadId: "thread-1" },
      { retryable: true, retryOnDisconnect: true },
    );
    const observedRead = retriedRead.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

    timers.timeoutCallbacks[0]?.();
    await flushMicrotasks();
    const interrupted = FakeWebSocket.latest();
    const originalSend = interrupted.send.bind(interrupted);
    interrupted.send = (payload: string) => {
      const message = JSON.parse(payload) as { method?: string };
      if (message.method === "cowork/refresh") {
        interrupted.close();
        throw new Error("connection dropped while flushing");
      }
      originalSend(payload);
    };
    await interrupted.completeHandshake();

    timers.timeoutCallbacks[0]?.();
    await flushMicrotasks();
    const recovered = FakeWebSocket.latest();
    await recovered.completeHandshake();

    expect(recovered.sentMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "cowork/refresh" }),
        { id: "approval-1", result: { decision: "accept" } },
        expect.objectContaining({ method: "thread/read", params: { threadId: "thread-1" } }),
      ]),
    );
    expect(
      recovered.sentMessages().filter((message) => message.method === "cowork/refresh"),
    ).toHaveLength(1);
    expect(recovered.sentMessages().filter((message) => message.id === "approval-1")).toHaveLength(
      1,
    );
    expect(
      recovered.sentMessages().filter((message) => message.method === "thread/read"),
    ).toHaveLength(1);
    const resumedRead = recovered
      .sentMessages()
      .find((message) => message.method === "thread/read");
    await recovered.emitMessage(
      JSON.stringify({ id: resumedRead?.id, result: { thread: { id: "thread-1" } } }),
    );

    await expect(observedRead).resolves.toEqual({
      ok: true,
      value: { thread: { id: "thread-1" } },
    });
  });

  test("recovers when constructing a replacement WebSocket throws", async () => {
    FakeWebSocket.reset();

    class InitiallyUnavailableWebSocket extends FakeWebSocket {
      private static attempts = 0;

      constructor(url: string, protocols?: string | string[]) {
        if (++InitiallyUnavailableWebSocket.attempts === 1) {
          throw new Error("network adapter unavailable");
        }
        super(url, protocols);
      }
    }

    const timers = createManualTimers();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/ws",
      clientInfo: { name: "desktop" },
      WebSocketImpl: InitiallyUnavailableWebSocket as never,
      autoReconnect: true,
      timers: timers.scheduler as never,
    });

    expect(() => socket.connect()).not.toThrow();
    const pending = socket.request("thread/list", {}, { retryable: true });
    timers.timeoutCallbacks[0]?.();
    await flushMicrotasks();

    const recovered = FakeWebSocket.latest();
    await recovered.completeHandshake();
    const retriedRequest = recovered
      .sentMessages()
      .find((message) => message.method === "thread/list");
    await recovered.emitMessage(
      JSON.stringify({ id: retriedRequest?.id, result: { threads: [] } }),
    );

    await expect(pending).resolves.toEqual({ threads: [] });
  });
});
