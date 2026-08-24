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

  test("evicts real projected assistant stream deltas before approvals and RPC replies", () => {
    const q = new SocketSendQueue(3);
    const ws = fakeSocket(() => 0);
    q.send(ws, { id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
    q.send(ws, {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
    });
    q.send(ws, { method: "turn/completed", params: {} });
    q.send(ws, { id: 1, result: { ok: true } });
    expect(q.getStats().droppedDeltas).toBe(1);
    expect(q.getStats().droppedImportant).toBe(0);
  });

  test("evicts projected reasoning deltas before essential lifecycle events", () => {
    const q = new SocketSendQueue(2);
    const ws = fakeSocket(() => 0);
    q.send(ws, { method: "turn/started", params: {} });
    q.send(ws, {
      method: "item/reasoning/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "thinking" },
    });
    q.send(ws, { method: "turn/completed", params: {} });

    expect(q.getStats().droppedDeltas).toBe(1);
    expect(q.getStats().droppedImportant).toBe(0);
  });

  test("drops a new stream delta instead of evicting a queued approval or turn completion", () => {
    let backpressured = true;
    const delivered: Array<{ method?: string }> = [];
    const q = new SocketSendQueue(2);
    const ws = fakeSocket((serialized) => {
      if (backpressured) return 0;
      delivered.push(JSON.parse(serialized));
      return 1;
    });

    q.send(ws, { method: "item/commandExecution/requestApproval", params: {} });
    q.send(ws, { method: "turn/completed", params: {} });
    q.send(ws, {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "late" },
    });

    expect(q.getStats().droppedDeltas).toBe(1);
    expect(q.getStats().droppedImportant).toBe(0);
    backpressured = false;
    q.flush(ws);
    expect(delivered.map((message) => message.method)).toEqual([
      "item/commandExecution/requestApproval",
      "turn/completed",
    ]);
  });

  test("preserves lifecycle ordering when a socket becomes writable before its drain event", () => {
    let backpressured = true;
    const delivered: number[] = [];
    const q = new SocketSendQueue(5);
    const ws = fakeSocket((serialized) => {
      if (backpressured) return 0;
      delivered.push((JSON.parse(serialized) as { seq: number }).seq);
      return 1;
    });

    q.send(ws, { seq: 1, method: "turn/started", params: {} });
    backpressured = false;
    q.send(ws, { seq: 2, method: "turn/completed", params: {} });

    expect(delivered).toEqual([]);
    expect(q.getStats().queueDepthByConnection["conn-1"]).toBe(2);
    q.flush(ws);
    expect(delivered).toEqual([1, 2]);
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
