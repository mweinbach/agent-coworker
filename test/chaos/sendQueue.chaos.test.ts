import { describe, expect, test } from "bun:test";

import { SocketSendQueue } from "../../src/server/runtime/SocketSendQueue";
import type { StartServerSocket } from "../../src/server/startServer/types";

// Chaos scenario 6: a slow/stuck client backs up the outbound queue past its
// cap. The queue must shed the least-critical traffic (stream deltas first,
// then important frames) rather than grow without bound, and the health
// endpoint must surface the drop/queue counters.
//
// NOTE: Bun's ServerWebSocket backpressure cannot be forced in-process (see the
// integration note in test/server.backpressure.test.ts), so overflow is driven
// directly against SocketSendQueue with a permanently backpressured socket, and
// we assert the exact projection that ServerRuntime.getHealthSnapshot() applies.

function backpressuredSocket(connectionId = "conn-1"): StartServerSocket {
  return {
    data: {
      connectionId,
      rpc: { capabilities: { optOutNotificationMethods: [] } },
    },
    // 0 == fully backpressured: every send is queued rather than written.
    send: () => 0,
  } as unknown as StartServerSocket;
}

/** Mirror of the sendQueue projection in ServerRuntime.getHealthSnapshot(). */
function projectSendQueueHealth(queue: SocketSendQueue): { dropped: number; queued: number } {
  const stats = queue.getStats();
  return {
    dropped: stats.droppedDeltas + stats.droppedImportant,
    queued: stats.queuedSends,
  };
}

describe("chaos: send queue overflow", () => {
  test("scenario 6: overflow sheds deltas first, then important frames, and caps depth", () => {
    const max = 3;
    const queue = new SocketSendQueue(max);
    const ws = backpressuredSocket();

    // Fill with two deltas + one important frame.
    queue.send(ws, { method: "model_stream_chunk", params: {} });
    queue.send(ws, { method: "item/agentMessage/delta", params: { type: "agentMessage/delta" } });
    queue.send(ws, { method: "ask", params: {} });
    // Two more important frames overflow the cap, evicting the two deltas.
    queue.send(ws, { method: "approval", params: {} });
    queue.send(ws, { method: "item/completed", params: {} });

    let stats = queue.getStats();
    expect(stats.droppedDeltas).toBe(2);
    expect(stats.droppedImportant).toBe(0);
    expect(stats.maxQueueDepth).toBe(max);
    expect(stats.queueDepthByConnection["conn-1"]).toBe(max);

    // No deltas left to shed — the next overflow drops an important frame.
    queue.send(ws, { method: "workspace/listChanged", params: {} });
    stats = queue.getStats();
    expect(stats.droppedImportant).toBe(1);
    expect(stats.maxQueueDepth).toBe(max);

    // Health projection reflects the shedding without leaking full stats.
    expect(projectSendQueueHealth(queue)).toEqual({ dropped: 3, queued: 6 });
  });

  test("a healthy (writable) socket never drops or queues", () => {
    const queue = new SocketSendQueue(3);
    const writable = {
      data: { connectionId: "conn-2", rpc: { capabilities: { optOutNotificationMethods: [] } } },
      send: () => 1,
    } as unknown as StartServerSocket;

    for (let i = 0; i < 10; i += 1) {
      queue.send(writable, { method: "item/completed", params: { i } });
    }

    expect(projectSendQueueHealth(queue)).toEqual({ dropped: 0, queued: 0 });
  });
});
