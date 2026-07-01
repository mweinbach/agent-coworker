import { beforeEach, describe, expect, test } from "bun:test";

import { JsonRpcSocket, type JsonRpcSocketReconnectEvent } from "../../src/client/jsonRpcSocket";
import { createManualTimers, FakeWebSocket, flushMicrotasks } from "../helpers/chaos";

// Chaos scenarios for the client transport: what happens when the workspace
// server dies mid-request or the connection drops while an approval is pending.
// Everything is driven through the injectable FakeWebSocket + manual timers, so
// reconnect backoff is advanced by hand — no real sleeps.

describe("chaos: jsonRpcSocket reliability", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
  });

  test("scenario 2: retryable turn/start survives a server kill mid-flight and resolves after reconnect", async () => {
    const reconnects: JsonRpcSocketReconnectEvent[] = [];
    const timers = createManualTimers();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/ws",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as never,
      autoReconnect: true,
      timers: timers.scheduler as never,
      onReconnecting: (event) => reconnects.push(event),
    });

    socket.connect();
    await flushMicrotasks();
    const ws1 = FakeWebSocket.latest();
    await ws1.completeHandshake();

    // Turn is in flight when the server dies. retryOnDisconnect keeps it alive.
    const turnPromise = socket.request(
      "turn/start",
      { threadId: "thr-1", input: [{ type: "text", text: "hi" }] },
      { retryable: true, retryOnDisconnect: true },
    );
    const inFlight = ws1.sentMessages().at(-1);
    expect(inFlight).toMatchObject({ method: "turn/start" });

    // Kill the server before the turn is answered.
    ws1.close();
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0]!.queuedOperationCount).toBeGreaterThanOrEqual(1);

    // Advance reconnect backoff → a fresh socket + handshake.
    timers.timeoutCallbacks[0]!();
    await flushMicrotasks();
    const ws2 = FakeWebSocket.latest();
    expect(ws2).not.toBe(ws1);
    await ws2.completeHandshake();

    // The queued turn/start is re-sent on the new connection; answering it
    // resolves the original caller's promise.
    const resent = ws2.sentMessages().at(-1);
    expect(resent).toMatchObject({ method: "turn/start" });
    await ws2.emitMessage(
      JSON.stringify({ id: resent!.id, result: { turn: { id: "turn-1", status: "running" } } }),
    );

    await expect(turnPromise).resolves.toEqual({ turn: { id: "turn-1", status: "running" } });
  });

  test("scenario 2 variant: a non-retryable turn/start rejects when the server dies", async () => {
    const socket = new JsonRpcSocket({
      url: "ws://example.test/ws",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as never,
      autoReconnect: true,
      timers: createManualTimers().scheduler as never,
    });

    socket.connect();
    await flushMicrotasks();
    const ws1 = FakeWebSocket.latest();
    await ws1.completeHandshake();

    const turnPromise = socket.request("turn/start", { threadId: "thr-1" });
    // Guard against an unhandled rejection race before we assert.
    const settled = turnPromise.then(
      () => ({ ok: true as const }),
      (error: Error) => ({ ok: false as const, error }),
    );
    ws1.close();

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
  });

  test("scenario 4: an approval response queued during a reconnect is delivered on the new socket", async () => {
    const serverRequests: Array<{ id: string | number; method: string }> = [];
    const reconnects: JsonRpcSocketReconnectEvent[] = [];
    const timers = createManualTimers();
    const socket = new JsonRpcSocket({
      url: "ws://example.test/ws",
      clientInfo: { name: "desktop" },
      WebSocketImpl: FakeWebSocket as never,
      autoReconnect: true,
      timers: timers.scheduler as never,
      onServerRequest: (message) => {
        serverRequests.push({ id: message.id, method: message.method });
      },
      onReconnecting: (event) => reconnects.push(event),
    });

    socket.connect();
    await flushMicrotasks();
    const ws1 = FakeWebSocket.latest();
    await ws1.completeHandshake();

    // Server asks the user to approve a dangerous command.
    await ws1.emitMessage(
      JSON.stringify({
        id: "appr-1",
        method: "item/commandExecution/requestApproval",
        params: { command: "rm -rf build", dangerous: true },
      }),
    );
    expect(serverRequests).toEqual([
      { id: "appr-1", method: "item/commandExecution/requestApproval" },
    ]);

    // Connection drops before the user's decision reaches the server.
    ws1.close();
    expect(reconnects).toHaveLength(1);

    // The user approves during the outage; the response is queued, not lost.
    expect(socket.respond("appr-1", { decision: "accept" }, { retryable: true })).toBe(true);

    // Reconnect and confirm the approval response is flushed to the new socket.
    timers.timeoutCallbacks[0]!();
    await flushMicrotasks();
    const ws2 = FakeWebSocket.latest();
    expect(ws2).not.toBe(ws1);
    await ws2.completeHandshake();

    expect(ws2.sentMessages().at(-1)).toEqual({ id: "appr-1", result: { decision: "accept" } });
  });
});
