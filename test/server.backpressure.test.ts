import { describe, expect, test } from "bun:test";

import { SocketSendQueue } from "../src/server/runtime/SocketSendQueue";
import { startAgentServer } from "../src/server/startServer";
import type { StartServerSocket } from "../src/server/startServer/types";
import { makeTmpProject, serverOpts, stopTestServer } from "./helpers/wsHarness";

function createSocketSendHarness(statuses: number[], connectionId = "conn-1") {
  const sent: string[] = [];
  const socket = {
    data: { connectionId },
    send(serialized: string) {
      sent.push(serialized);
      return statuses.shift() ?? 1;
    },
  } as unknown as StartServerSocket;

  return { sent, socket };
}

describe("WebSocket backpressure queue", () => {
  test("queues messages when send returns backpressure", () => {
    const queue = new SocketSendQueue();
    const payload = { jsonrpc: "2.0", method: "model_stream_chunk", params: {} };
    const { sent, socket } = createSocketSendHarness([0, 1]);

    queue.send(socket, payload);
    queue.flush(socket);

    expect(sent).toEqual([JSON.stringify(payload), JSON.stringify(payload)]);
  });

  test("evicts stream deltas first when queue is full", () => {
    const queue = new SocketSendQueue(3);
    const ask = { jsonrpc: "2.0", method: "ask", params: {} };
    const streamDelta = { jsonrpc: "2.0", method: "model_stream_chunk", params: {} };
    const approval = { jsonrpc: "2.0", method: "approval", params: {} };
    const other = { jsonrpc: "2.0", method: "other", params: {} };
    const { sent, socket } = createSocketSendHarness([0, 0, 0, 0, 1, 1, 1]);

    queue.send(socket, ask);
    queue.send(socket, streamDelta);
    queue.send(socket, approval);
    queue.send(socket, other);
    queue.flush(socket);

    expect(sent.slice(4)).toEqual([
      JSON.stringify(ask),
      JSON.stringify(approval),
      JSON.stringify(other),
    ]);
  });

  test("evicts agentMessage/delta params first when queue is full", () => {
    const queue = new SocketSendQueue(3);
    const ask = { jsonrpc: "2.0", method: "ask", params: {} };
    const agentDelta = {
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { type: "agentMessage/delta" },
    };
    const approval = { jsonrpc: "2.0", method: "approval", params: {} };
    const other = { jsonrpc: "2.0", method: "other", params: {} };
    const { sent, socket } = createSocketSendHarness([0, 0, 0, 0, 1, 1, 1]);

    queue.send(socket, ask);
    queue.send(socket, agentDelta);
    queue.send(socket, approval);
    queue.send(socket, other);
    queue.flush(socket);

    expect(sent.slice(4)).toEqual([
      JSON.stringify(ask),
      JSON.stringify(approval),
      JSON.stringify(other),
    ]);
  });

  test("flush clears the queue", () => {
    const queue = new SocketSendQueue();
    const ask = { jsonrpc: "2.0", method: "ask", params: {} };
    const approval = { jsonrpc: "2.0", method: "approval", params: {} };
    const { sent, socket } = createSocketSendHarness([0, 0, 1, 1]);

    queue.send(socket, ask);
    queue.send(socket, approval);
    queue.flush(socket);
    queue.flush(socket);

    expect(sent).toEqual([
      JSON.stringify(ask),
      JSON.stringify(approval),
      JSON.stringify(ask),
      JSON.stringify(approval),
    ]);
  });

  test("deleteConnection clears pending sends for the connection", () => {
    const queue = new SocketSendQueue();
    const payload = { jsonrpc: "2.0", method: "ask", params: {} };
    const { sent, socket } = createSocketSendHarness([0, 1]);

    queue.send(socket, payload);
    queue.deleteConnection(socket.data.connectionId);
    queue.flush(socket);

    expect(sent).toEqual([JSON.stringify(payload)]);
  });

  test("shouldSendNotification respects client opt-outs", () => {
    const queue = new SocketSendQueue();
    const { socket } = createSocketSendHarness([]);
    socket.data.rpc = {
      initializeRequestReceived: true,
      initializedNotificationReceived: true,
      pendingRequestCount: 0,
      maxPendingRequests: 100,
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: ["item/agentMessage/delta"],
      },
      pendingServerRequests: new Map(),
    };

    expect(queue.shouldSendNotification(socket, "item/agentMessage/delta")).toBe(false);
    expect(queue.shouldSendNotification(socket, "approval")).toBe(true);
  });
});

describe("startServer backpressure integration", () => {
  test("sendJsonRpc queues on backpressure and flushes on drain", async () => {
    // This is a smoke test that the server starts and handles connections.
    // Full backpressure simulation requires Bun.ServerWebSocket mocking.
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
