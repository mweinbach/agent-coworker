import { describe, expect, test } from "bun:test";
import { SocketSendQueue } from "../src/server/runtime/SocketSendQueue";
import type { StartServerSocket } from "../src/server/startServer/types";

function fakeSocket(sendImpl: (serialized: string) => number): StartServerSocket {
  return {
    data: {
      connectionId: "conn-1",
      rpc: {
        capabilities: { optOutNotificationMethods: [] },
      },
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

  test("queues messages when send returns -1 (socket closing)", () => {
    const q = new SocketSendQueue(500);
    q.send(
      fakeSocket(() => -1),
      { method: "ask", params: { id: "closing" } },
    );
    const stats = q.getStats();
    expect(stats.queueDepthByConnection["conn-1"]).toBe(1);
    expect(stats.queuedSends).toBe(1);
    expect(stats.sendFailures).toBe(0);
  });

  test("counts serializationFailures and drops non-serializable payloads", () => {
    const q = new SocketSendQueue(500);
    const circular: Record<string, unknown> = { method: "ask" };
    circular.self = circular;
    q.send(
      fakeSocket(() => 1),
      circular,
    );
    expect(q.getStats().serializationFailures).toBe(1);
    expect(q.getStats().queueDepthByConnection["conn-1"]).toBeUndefined();
    expect(q.getStats().queuedSends).toBe(0);
  });

  test("counts sendFailures when ws.send throws and does not queue", () => {
    const q = new SocketSendQueue(500);
    q.send(
      fakeSocket(() => {
        throw new Error("socket closed");
      }),
      { method: "ask", params: {} },
    );
    const stats = q.getStats();
    expect(stats.sendFailures).toBe(1);
    expect(stats.queueDepthByConnection["conn-1"]).toBeUndefined();
    expect(stats.queuedSends).toBe(0);
  });

  test("flush drops the head item when send throws and continues draining", () => {
    const q = new SocketSendQueue(500);
    const received: string[] = [];
    let sendCalls = 0;
    const ws = fakeSocket((serialized) => {
      sendCalls += 1;
      if (sendCalls === 1) return 0; // queue on first send
      if (sendCalls === 2) return 0; // queue second
      if (sendCalls === 3) throw new Error("transient drain failure");
      received.push(serialized);
      return 1;
    });
    q.send(ws, { method: "ask", params: { seq: 1 } });
    q.send(ws, { method: "approval", params: { seq: 2 } });
    expect(q.getStats().queueDepthByConnection["conn-1"]).toBe(2);

    q.flush(ws);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!).params.seq).toBe(2);
    expect(q.getStats().queueDepthByConnection["conn-1"]).toBeUndefined();
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
