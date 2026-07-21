import { describe, expect, test } from "bun:test";
import { SocketSendQueue } from "../../src/server/runtime/SocketSendQueue";
import type { StartServerSocket } from "../../src/server/startServer/types";

function createMockSocket(
  connectionId: string,
  sendImpl: (msg: string) => number,
): StartServerSocket {
  return {
    data: {
      connectionId,
      rpc: { capabilities: { optOutNotificationMethods: [] } },
    },
    send: sendImpl,
  } as unknown as StartServerSocket;
}

describe("Empirical Stress & Chaos Harness: WebSocket SendQueue", () => {
  test("Scenario A: High Concurrency & Mass Throughput (1,000,000 messages across 100 sockets)", () => {
    const queue = new SocketSendQueue(500);
    const numSockets = 100;
    const msgsPerSocket = 10000;
    const sockets: StartServerSocket[] = [];

    // Create 100 sockets: even sockets writable (send=1), odd sockets backpressured (send=0)
    for (let i = 0; i < numSockets; i++) {
      const connId = `stress-conn-${i}`;
      const isWritable = i % 2 === 0;
      sockets.push(createMockSocket(connId, () => (isWritable ? 1 : 0)));
    }

    const start = performance.now();
    for (let i = 0; i < msgsPerSocket; i++) {
      for (let s = 0; s < numSockets; s++) {
        const ws = sockets[s];
        const isDelta = i % 3 === 0;
        queue.send(ws, {
          method: isDelta ? "model_stream_chunk" : "ask",
          params: { socketIndex: s, msgSeq: i },
        });
      }
    }
    const duration = performance.now() - start;

    const stats = queue.getStats();

    // 50 backpressured sockets * max 500 cap = max 25,000 queued messages held in memory
    expect(stats.maxQueueDepth).toBe(500);

    // Verify stats tracking
    expect(stats.queuedSends).toBe(50 * msgsPerSocket); // 500,000 queued attempts
    expect(stats.droppedDeltas + stats.droppedImportant).toBeGreaterThan(0);

    // Writable sockets (even index) should have 0 depth in queue
    for (let s = 0; s < numSockets; s += 2) {
      expect(stats.queueDepthByConnection[`stress-conn-${s}`]).toBeUndefined();
    }

    // Backpressured sockets (odd index) should be capped at 500
    for (let s = 1; s < numSockets; s += 2) {
      expect(stats.queueDepthByConnection[`stress-conn-${s}`]).toBe(500);
    }

    // Throughput should easily exceed 100k msgs/sec in Bun
    console.log(
      `[Stress Test A] 1M messages processed in ${duration.toFixed(2)}ms (${Math.round(1000000 / (duration / 1000))} msgs/sec)`,
    );
  });

  test("Scenario B: Re-backpressure during flush (ws.send returns 0 on 3rd queued item)", () => {
    const queue = new SocketSendQueue(100);
    let sentCount = 0;

    // Send returns 0 initially (backpressured)
    let sendReturnValue = 0;
    const ws = createMockSocket("flush-conn-1", () => {
      if (sendReturnValue === 1) {
        sentCount++;
        if (sentCount >= 2) {
          // After sending 2 messages during flush, buffer fills up again!
          sendReturnValue = 0;
        }
        return 1;
      }
      return sendReturnValue;
    });

    // Queue 5 important messages
    for (let i = 1; i <= 5; i++) {
      queue.send(ws, { method: "important_event", params: { id: i } });
    }

    expect(queue.getStats().queueDepthByConnection["flush-conn-1"]).toBe(5);

    // Now trigger flush when socket signals drain (returns 1 for first 2 calls, then 0 for 3rd call)
    sendReturnValue = 1;
    queue.flush(ws);

    // CHECK: How many messages remain in the queue?
    // Messages 1 and 2 were sent.
    // Message 3 got sendReturnValue = 0 (backpressured again).
    // If flush handles status === 0 properly, queue depth should be 3 (messages 3, 4, 5 remain).
    // If flush drops on status === 0, queue depth will be 0 (messages 3, 4, 5 dropped silently!).
    const depthAfterFlush = queue.getStats().queueDepthByConnection["flush-conn-1"] ?? 0;
    console.log(
      `[Chaos Test B] Depth after partial flush: ${depthAfterFlush} (expected 3, sent ${sentCount})`,
    );

    // EXPECT: depth after flush should be 3!
    expect(sentCount).toBe(2);
    expect(depthAfterFlush).toBe(3);
  });

  test("Scenario C: Disconnect Memory Cleanup (No dangling connections in pendingSends)", () => {
    const queue = new SocketSendQueue(100);
    const count = 1000;

    for (let i = 0; i < count; i++) {
      const connId = `cleanup-conn-${i}`;
      const ws = createMockSocket(connId, () => 0);
      queue.send(ws, { method: "test", params: { i } });
    }

    expect(Object.keys(queue.getStats().queueDepthByConnection).length).toBe(count);

    // Disconnect all sockets
    for (let i = 0; i < count; i++) {
      queue.deleteConnection(`cleanup-conn-${i}`);
    }

    const statsAfter = queue.getStats();
    expect(Object.keys(statsAfter.queueDepthByConnection).length).toBe(0);
  });

  test("Scenario D: Message Ordering & Integrity under Delta Eviction", () => {
    const queue = new SocketSendQueue(4);
    const ws = createMockSocket("order-conn", () => 0);

    const received: any[] = [];
    const flushWs = createMockSocket("order-conn", (payloadStr) => {
      received.push(JSON.parse(payloadStr));
      return 1;
    });

    // Send sequence: Important-1, Delta-1, Delta-2, Important-2
    queue.send(ws, { method: "ask", params: { seq: 1 } });
    queue.send(ws, { method: "model_stream_chunk", params: { seq: 2 } });
    queue.send(ws, { method: "model_stream_chunk", params: { seq: 3 } });
    queue.send(ws, { method: "approval", params: { seq: 4 } });

    // Queue is now full (4 items: Important-1, Delta-1, Delta-2, Important-2)
    // Send two more items: Delta-3, Important-3
    // This should evict Delta-1 and Delta-2, leaving: Important-1, Important-2, Delta-3, Important-3
    queue.send(ws, { method: "model_stream_chunk", params: { seq: 5 } });
    queue.send(ws, {
      method: "item/agentMessage/delta",
      params: { type: "agentMessage/delta", seq: 6 },
    });

    // Now flush to readable socket
    queue.flush(flushWs);

    expect(received.length).toBe(4);
    // Important-1 (seq 1), Important-2 (seq 4), Delta-3 (seq 5), Delta-4 (seq 6)
    expect(received[0].params.seq).toBe(1);
    expect(received[1].params.seq).toBe(4);
    expect(received[2].params.seq).toBe(5);
    expect(received[3].params.seq).toBe(6);
  });

  test("Scenario E: External Sink Exception Resilience", () => {
    const queue = new SocketSendQueue(100);
    const ws = createMockSocket("sink-conn", () => 1);

    queue.setExternalSink("sink-conn", () => {
      throw new Error("Sink error!");
    });

    // Send message when sink throws exception
    expect(() => {
      queue.send(ws, { method: "test" });
    }).not.toThrow();

    const stats = queue.getStats();
    expect(stats.externalSinkFailures).toBe(1);
  });
});
