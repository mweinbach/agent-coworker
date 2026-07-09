import { describe, expect, test } from "bun:test";

import {
  ReliableBatchDeliveryError,
  type ReliableBatchEnvelope,
  type ReliableBatchFailure,
  ReliableBatchQueue,
  type ReliableBatchStore,
} from "../src/shared/reliableBatchQueue";

type TestItem = {
  order: number;
};

function createMemoryStore(
  initial: ReliableBatchEnvelope<TestItem>[] = [],
): ReliableBatchStore<TestItem> & { read: () => ReliableBatchEnvelope<TestItem>[] } {
  let batches = structuredClone(initial);
  return {
    load: () => structuredClone(batches),
    save: (next) => {
      batches = structuredClone(next);
    },
    read: () => structuredClone(batches),
  };
}

function createIds(): () => string {
  let nextId = 0;
  return () => `batch-${++nextId}`;
}

describe("ReliableBatchQueue", () => {
  test("bounds transient retries and preserves batch order", async () => {
    const attempts: string[] = [];
    const store = createMemoryStore();
    const queue = new ReliableBatchQueue<TestItem>({
      store,
      createId: createIds(),
      nowIso: () => "2026-07-09T20:00:00.000Z",
      sleep: async () => {},
      send: async (batch) => {
        attempts.push(batch.id);
        if (batch.id === "batch-1" && attempts.length < 3) {
          throw new ReliableBatchDeliveryError("transient", "service unavailable");
        }
      },
    });

    queue.enqueue([{ order: 1 }]);
    queue.enqueue([{ order: 2 }]);
    const result = await queue.flush();

    expect(attempts).toEqual(["batch-1", "batch-1", "batch-1", "batch-2"]);
    expect(result).toEqual({ blocked: false, batches: [] });
    expect(store.read()).toEqual([]);
  });

  test("retains permanent failures and later batches until explicit recovery", async () => {
    let recovered = false;
    const delivered: number[] = [];
    const failures: ReliableBatchFailure<TestItem>[] = [];
    const store = createMemoryStore();
    const queue = new ReliableBatchQueue<TestItem>({
      store,
      createId: createIds(),
      nowIso: () => "2026-07-09T20:00:00.000Z",
      onFailure: (failure) => failures.push(failure),
      send: async (batch) => {
        if (!recovered) {
          throw new ReliableBatchDeliveryError("permanent", "unauthorized");
        }
        delivered.push(batch.items[0]?.order ?? -1);
      },
    });

    queue.enqueue([{ order: 1 }]);
    queue.enqueue([{ order: 2 }]);
    const blocked = await queue.flush();

    expect(blocked.blocked).toBe(true);
    expect(blocked.batches.map((batch) => batch.items[0]?.order)).toEqual([1, 2]);
    expect(store.read()).toEqual(blocked.batches);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe("permanent");

    recovered = true;
    const recoveredSnapshot = await queue.retry();
    expect(delivered).toEqual([1, 2]);
    expect(recoveredSnapshot).toEqual({ blocked: false, batches: [] });
  });

  test("rehydrates an ambiguous failed batch with the same idempotency key", async () => {
    const store = createMemoryStore();
    const firstIds: string[] = [];
    const firstQueue = new ReliableBatchQueue<TestItem>({
      store,
      createId: createIds(),
      nowIso: () => "2026-07-09T20:00:00.000Z",
      maxAttempts: 1,
      send: async (batch) => {
        firstIds.push(batch.id);
        throw new ReliableBatchDeliveryError("transient", "response was lost");
      },
    });
    const batchId = firstQueue.enqueue([{ order: 1 }]);
    await firstQueue.flush();

    const recoveredIds: string[] = [];
    const recoveredQueue = new ReliableBatchQueue<TestItem>({
      store,
      createId: createIds(),
      nowIso: () => "2026-07-09T20:01:00.000Z",
      send: async (batch) => {
        recoveredIds.push(batch.id);
      },
    });
    await recoveredQueue.flush();

    expect(batchId).toBe("batch-1");
    expect(firstIds).toEqual(["batch-1"]);
    expect(recoveredIds).toEqual(["batch-1"]);
    expect(store.read()).toEqual([]);
  });

  test("shutdown flush sends only the ordered head with keepalive and retains it for restart", async () => {
    const contexts: Array<{ id: string; keepalive: boolean }> = [];
    const store = createMemoryStore();
    const queue = new ReliableBatchQueue<TestItem>({
      store,
      createId: createIds(),
      nowIso: () => "2026-07-09T20:00:00.000Z",
      maxAttempts: 1,
      send: async (batch, context) => {
        contexts.push({ id: batch.id, keepalive: context.keepalive });
        if (!context.keepalive) {
          throw new ReliableBatchDeliveryError("permanent", "offline");
        }
      },
    });
    queue.enqueue([{ order: 1 }]);
    queue.enqueue([{ order: 2 }]);
    await queue.flush();

    await queue.flushForShutdown();

    expect(contexts).toEqual([
      { id: "batch-1", keepalive: false },
      { id: "batch-1", keepalive: true },
    ]);
    expect(store.read()).toHaveLength(2);
  });
});
