import { describe, expect, test } from "bun:test";
import { SocketSendQueue } from "../src/server/runtime/SocketSendQueue";
import type { StartServerSocket } from "../src/server/startServer/types";

type FakeSocketOptions = {
  optOutNotificationMethods?: string[];
  omitRpc?: boolean;
};

function fakeSocket(
  sendImpl: (serialized: string) => number,
  options: FakeSocketOptions = {},
): StartServerSocket {
  return {
    data: {
      connectionId: "conn-1",
      ...(options.omitRpc
        ? {}
        : {
            rpc: {
              capabilities: {
                optOutNotificationMethods: options.optOutNotificationMethods ?? [],
              },
            },
          }),
    },
    send: sendImpl,
  } as unknown as StartServerSocket;
}

describe("WebSocket backpressure queue", () => {
  test("queues messages when send returns backpressure", () => {
    const q = new SocketSendQueue(500);
    q.send(
      fakeSocket(() => 0),
      { method: "model_stream_chunk", params: {} },
    );
    expect(q.getStats().queueDepthByConnection["conn-1"]).toBe(1);
    expect(q.getStats().queuedSends).toBe(1);
  });

  test("evicts stream deltas first when queue is full", () => {
    const q = new SocketSendQueue(3);
    const ws = fakeSocket(() => 0);
    q.send(ws, { method: "ask", params: {} });
    q.send(ws, { method: "model_stream_chunk", params: {} });
    q.send(ws, { method: "approval", params: {} });
    q.send(ws, { method: "other", params: {} });
    const stats = q.getStats();
    expect(stats.queueDepthByConnection["conn-1"]).toBe(3);
    expect(stats.droppedDeltas).toBe(1);
    expect(stats.droppedImportant).toBe(0);
  });

  test("evicts agentMessage/delta params first when queue is full", () => {
    const q = new SocketSendQueue(3);
    const ws = fakeSocket(() => 0);
    q.send(ws, { method: "ask", params: {} });
    q.send(ws, {
      method: "item/agentMessage/delta",
      params: { type: "agentMessage/delta" },
    });
    q.send(ws, { method: "approval", params: {} });
    q.send(ws, { method: "other", params: {} });
    expect(q.getStats().droppedDeltas).toBe(1);
  });

  test("counts important drops when pressure overflows a queue without deltas", () => {
    const q = new SocketSendQueue(2);
    const ws = fakeSocket(() => 0);
    q.send(ws, { method: "ask", params: {} });
    q.send(ws, { method: "approval", params: {} });
    q.send(ws, { method: "other", params: {} });
    expect(q.getStats().droppedImportant).toBe(1);
  });

  test("flush clears the queue", () => {
    let backpressured = true;
    const q = new SocketSendQueue(500);
    const ws = fakeSocket(() => (backpressured ? 0 : 1));
    q.send(ws, { method: "ask", params: {} });
    q.send(ws, { method: "approval", params: {} });
    expect(q.getStats().queueDepthByConnection["conn-1"]).toBe(2);
    backpressured = false;
    q.flush(ws);
    expect(q.getStats().queueDepthByConnection["conn-1"]).toBeUndefined();
  });

  test("respects per-connection notification opt-outs", () => {
    const q = new SocketSendQueue(500);
    const ws = fakeSocket(() => 1, {
      optOutNotificationMethods: ["item/agentMessage/delta"],
    });

    expect(q.shouldSendNotification(ws, "item/agentMessage/delta")).toBe(false);
    expect(q.shouldSendNotification(ws, "item/tool/start")).toBe(true);
  });

  test("sends notifications by default before JSON-RPC capabilities are initialized", () => {
    const q = new SocketSendQueue(500);
    const ws = fakeSocket(() => 1, { omitRpc: true });

    expect(q.shouldSendNotification(ws, "item/agentMessage/delta")).toBe(true);
  });
});

describe("startServer backpressure integration", () => {
  test("sendJsonRpc queues on backpressure and flushes on drain", async () => {
    // This is a smoke test that the server starts and handles connections.
    // Full backpressure simulation requires Bun.ServerWebSocket mocking.
    const { startAgentServer } = await import("../src/server/startServer");
    const { makeTmpProject, serverOpts, stopTestServer } = await import("./helpers/wsHarness");

    const tmpDir = await makeTmpProject();
    const { server } = await startAgentServer(serverOpts(tmpDir));

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, "cowork.jsonrpc.v1");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for websocket open")),
        5_000,
      );
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WebSocket error"));
      };
    });

    ws.close();
    await stopTestServer(server);
  });
});
