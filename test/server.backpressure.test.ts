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

  test("shouldSendNotification honors per-connection opt-outs", () => {
    const q = new SocketSendQueue(500);
    const optedOut = fakeSocket(() => 1);
    optedOut.data.rpc = {
      capabilities: { optOutNotificationMethods: ["cowork/control/event"] },
    };
    const open = fakeSocket(() => 1);

    expect(q.shouldSendNotification(optedOut, "cowork/control/event")).toBe(false);
    expect(q.shouldSendNotification(optedOut, "thread/started")).toBe(true);
    expect(q.shouldSendNotification(open, "cowork/control/event")).toBe(true);
  });

  test("external sink true consumes the send; false falls through to the socket", () => {
    const q = new SocketSendQueue(500);
    const sent: string[] = [];
    const ws = fakeSocket((serialized) => {
      sent.push(serialized);
      return 1;
    });

    q.setExternalSink("conn-1", () => true);
    q.send(ws, { method: "consumed", params: { id: 1 } });
    expect(sent).toEqual([]);

    q.setExternalSink("conn-1", () => false);
    q.send(ws, { method: "fallback", params: { id: 2 } });
    expect(sent).toEqual([JSON.stringify({ method: "fallback", params: { id: 2 } })]);

    q.setExternalSink("conn-1", null);
    q.send(ws, { method: "direct", params: { id: 3 } });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(JSON.stringify({ method: "direct", params: { id: 3 } }));

    q.setExternalSink("conn-1", () => true);
    q.deleteConnection("conn-1");
    q.send(ws, { method: "after-delete", params: { id: 4 } });
    expect(sent.at(-1)).toBe(JSON.stringify({ method: "after-delete", params: { id: 4 } }));
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
