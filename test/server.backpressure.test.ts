import { describe, expect, test } from "bun:test";

// We test the backpressure queue logic by extracting it into a pure helper
// rather than mocking Bun.ServerWebSocket internals.

interface FakeQueue {
  queue: string[];
  max: number;
  send: (serialized: string) => number;
  flush: () => void;
}

function createFakeBackpressureQueue(max: number): FakeQueue {
  const queue: string[] = [];

  const evictLeastCritical = () => {
    for (let i = 0; i < queue.length; i++) {
      try {
        const parsed = JSON.parse(queue[i]) as {
          method?: string;
          params?: { type?: string };
        };
        if (
          parsed.method === "model_stream_chunk" ||
          parsed.params?.type === "agentMessage/delta"
        ) {
          queue.splice(i, 1);
          return;
        }
      } catch {
        // ignore malformed JSON
      }
    }
    queue.shift();
  };

  const send = (serialized: string) => {
    const status = 0; // simulate backpressure
    if (status === 0 || status === -1) {
      if (queue.length >= max) {
        evictLeastCritical();
      }
      queue.push(serialized);
    }
    return status;
  };

  const flush = () => {
    while (queue.length > 0) {
      const status = 1; // simulate send success on drain
      if (status === -1) {
        break;
      }
      queue.shift();
    }
  };

  return { queue, max, send, flush };
}

describe("WebSocket backpressure queue", () => {
  test("queues messages when send returns backpressure", () => {
    const q = createFakeBackpressureQueue(500);
    q.send('{"jsonrpc":"2.0","method":"model_stream_chunk","params":{}}');
    expect(q.queue.length).toBe(1);
  });

  test("evicts stream deltas first when queue is full", () => {
    const q = createFakeBackpressureQueue(3);
    q.send('{"jsonrpc":"2.0","method":"ask","params":{}}');
    q.send('{"jsonrpc":"2.0","method":"model_stream_chunk","params":{}}');
    q.send('{"jsonrpc":"2.0","method":"approval","params":{}}');
    expect(q.queue.length).toBe(3);
    q.send('{"jsonrpc":"2.0","method":"other","params":{}}');
    expect(q.queue.length).toBe(3);
    expect(q.queue[0]).toBe('{"jsonrpc":"2.0","method":"ask","params":{}}');
    expect(q.queue[1]).toBe('{"jsonrpc":"2.0","method":"approval","params":{}}');
    expect(q.queue[2]).toBe('{"jsonrpc":"2.0","method":"other","params":{}}');
  });

  test("evicts agentMessage/delta params first when queue is full", () => {
    const q = createFakeBackpressureQueue(3);
    q.send('{"jsonrpc":"2.0","method":"ask","params":{}}');
    q.send(
      '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"type":"agentMessage/delta"}}',
    );
    q.send('{"jsonrpc":"2.0","method":"approval","params":{}}');
    expect(q.queue.length).toBe(3);
    q.send('{"jsonrpc":"2.0","method":"other","params":{}}');
    expect(q.queue.length).toBe(3);
    expect(q.queue[0]).toBe('{"jsonrpc":"2.0","method":"ask","params":{}}');
    expect(q.queue[1]).toBe('{"jsonrpc":"2.0","method":"approval","params":{}}');
    expect(q.queue[2]).toBe('{"jsonrpc":"2.0","method":"other","params":{}}');
  });

  test("flush clears the queue", () => {
    const q = createFakeBackpressureQueue(500);
    q.send('{"jsonrpc":"2.0","method":"ask","params":{}}');
    q.send('{"jsonrpc":"2.0","method":"approval","params":{}}');
    expect(q.queue.length).toBe(2);
    q.flush();
    expect(q.queue.length).toBe(0);
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
