import { describe, expect, test } from "bun:test";

import {
  ReliableBatchDeliveryError,
  type ReliableBatchEnqueueResult,
  type ReliableBatchEnvelope,
  type ReliableBatchFailure,
  type ReliableBatchFailureUpdate,
  type ReliableBatchLimits,
  type ReliableBatchMalformedRecord,
  ReliableBatchQueue,
  type ReliableBatchScheduler,
  type ReliableBatchStats,
  type ReliableBatchStore,
} from "../src/shared/reliableBatchQueue";

type TestItem = {
  order: number;
};

const LIMITS: ReliableBatchLimits = {
  maxBatches: 4,
  maxEvents: 4,
  maxBytes: 1_024,
  maxBatchEvents: 2,
  maxBatchBytes: 512,
};

class ManualClock implements ReliableBatchScheduler {
  now = 0;
  private nextHandle = 0;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  schedule = (delayMs: number, callback: () => void): number => {
    const handle = ++this.nextHandle;
    this.tasks.set(handle, {
      at: this.now + Math.max(0, delayMs),
      callback,
    });
    return handle;
  };

  cancel = (handle: unknown): void => {
    if (typeof handle === "number") {
      this.tasks.delete(handle);
    }
  };

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) {
        break;
      }
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

type SharedStoreState = {
  batches: ReliableBatchEnvelope<TestItem>[];
  lease: { ownerId: string; expiresAt: number } | null;
  capabilityAbsent: boolean;
  malformed: unknown[];
};

class MemoryStore implements ReliableBatchStore<TestItem> {
  readonly state: SharedStoreState;
  headOverride: unknown | null = null;

  constructor(
    state: SharedStoreState = {
      batches: [],
      lease: null,
      capabilityAbsent: false,
      malformed: [],
    },
  ) {
    this.state = state;
  }

  async enqueue(
    batch: ReliableBatchEnvelope<TestItem>,
    limits: ReliableBatchLimits,
  ): Promise<ReliableBatchEnqueueResult<TestItem>> {
    const stats = await this.stats(batch.scope);
    if (this.state.capabilityAbsent) {
      return {
        accepted: false,
        recoveryId: batch.id,
        reason: "capability_absent",
        items: batch.items,
        bytes: batch.bytes,
        stats,
        limits,
      };
    }
    const next = {
      batches: stats.batches + 1,
      events: stats.events + batch.items.length,
      bytes: stats.bytes + batch.bytes,
    };
    if (
      next.batches > limits.maxBatches ||
      next.events > limits.maxEvents ||
      next.bytes > limits.maxBytes
    ) {
      return {
        accepted: false,
        recoveryId: batch.id,
        reason: "overflow",
        items: batch.items,
        bytes: batch.bytes,
        stats,
        limits,
      };
    }
    this.state.batches.push(structuredClone(batch));
    return { accepted: true, batch: structuredClone(batch), stats: next };
  }

  async getHead(scope: string): Promise<ReliableBatchEnvelope<TestItem> | null> {
    if (this.headOverride !== null) {
      return structuredClone(this.headOverride) as ReliableBatchEnvelope<TestItem>;
    }
    return structuredClone(
      this.state.batches
        .filter((batch) => batch.scope === scope)
        .sort(
          (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
        )[0] ?? null,
    );
  }

  async list(scope: string): Promise<ReliableBatchEnvelope<TestItem>[]> {
    return structuredClone(this.state.batches.filter((batch) => batch.scope === scope));
  }

  async stats(scope: string): Promise<ReliableBatchStats> {
    const batches = this.state.batches.filter((batch) => batch.scope === scope);
    return {
      batches: batches.length,
      events: batches.reduce((total, batch) => total + batch.items.length, 0),
      bytes: batches.reduce((total, batch) => total + batch.bytes, 0),
    };
  }

  async acknowledge(scope: string, batchId: string, ownerId: string): Promise<boolean> {
    if (this.state.lease?.ownerId !== ownerId) {
      return false;
    }
    const index = this.state.batches.findIndex(
      (batch) => batch.scope === scope && batch.id === batchId,
    );
    if (index < 0) {
      return false;
    }
    this.state.batches.splice(index, 1);
    return true;
  }

  async recordFailure(
    scope: string,
    batchId: string,
    ownerId: string,
    update: ReliableBatchFailureUpdate,
  ): Promise<boolean> {
    if (this.state.lease?.ownerId !== ownerId) {
      return false;
    }
    const batch = this.state.batches.find(
      (candidate) => candidate.scope === scope && candidate.id === batchId,
    );
    if (!batch) {
      return false;
    }
    Object.assign(batch, update);
    return true;
  }

  async retry(scope: string, batchId?: string): Promise<void> {
    for (const batch of this.state.batches) {
      if (batch.scope === scope && (!batchId || batch.id === batchId)) {
        batch.status = "pending";
        batch.attempts = 0;
        batch.nextAttemptAt = 0;
        delete batch.failureReason;
        delete batch.lastError;
      }
    }
  }

  async discard(scope: string, batchId: string): Promise<void> {
    this.state.batches = this.state.batches.filter(
      (batch) => batch.scope !== scope || batch.id !== batchId,
    );
  }

  async tryAcquireLease(
    _scope: string,
    ownerId: string,
    now: number,
    expiresAt: number,
  ): Promise<boolean> {
    if (
      this.state.lease &&
      this.state.lease.ownerId !== ownerId &&
      this.state.lease.expiresAt > now
    ) {
      return false;
    }
    this.state.lease = { ownerId, expiresAt };
    return true;
  }

  async renewLease(
    _scope: string,
    ownerId: string,
    _now: number,
    expiresAt: number,
  ): Promise<boolean> {
    if (this.state.lease?.ownerId !== ownerId) {
      return false;
    }
    this.state.lease.expiresAt = expiresAt;
    return true;
  }

  async releaseLease(_scope: string, ownerId: string): Promise<void> {
    if (this.state.lease?.ownerId === ownerId) {
      this.state.lease = null;
    }
  }

  async isCapabilityAbsent(): Promise<boolean> {
    return this.state.capabilityAbsent;
  }

  async markCapabilityAbsentAndClear(): Promise<void> {
    this.state.capabilityAbsent = true;
    this.state.batches = [];
  }

  async quarantineMalformed(
    _scope: string,
    validate: (value: unknown) => boolean,
  ): Promise<ReliableBatchMalformedRecord[]> {
    const malformed = this.state.malformed
      .filter((value) => !validate(value))
      .map((value) => ({
        id:
          value && typeof value === "object" && "id" in value
            ? String((value as { id?: unknown }).id)
            : null,
        message: "Malformed transcript outbox record was quarantined",
      }));
    this.state.malformed = this.state.malformed.filter(validate);
    if (this.headOverride !== null && !validate(this.headOverride)) {
      const value = this.headOverride;
      malformed.push({
        id:
          value && typeof value === "object" && "id" in value
            ? String((value as { id?: unknown }).id)
            : null,
        message: "Malformed transcript outbox record was quarantined",
      });
      this.headOverride = null;
    }
    return malformed;
  }
}

function createIds(prefix: string): () => string {
  let nextId = 0;
  return () => `${prefix}-${++nextId}`;
}

function createQueue(options: {
  store: MemoryStore;
  clock: ManualClock;
  send: ConstructorParameters<typeof ReliableBatchQueue<TestItem>>[0]["send"];
  failures?: ReliableBatchFailure<TestItem>[];
  idPrefix?: string;
  maxAttempts?: number;
}): ReliableBatchQueue<TestItem> {
  return new ReliableBatchQueue<TestItem>({
    scope: "scope-a",
    destination: "https://server-a/transcript",
    store: options.store,
    send: options.send,
    createId: createIds(options.idPrefix ?? "id"),
    measureItems: (items) => JSON.stringify(items).length,
    validateItem: (value): value is TestItem =>
      Boolean(value) &&
      typeof value === "object" &&
      typeof (value as { order?: unknown }).order === "number",
    clock: { now: () => options.clock.now },
    scheduler: options.clock,
    limits: LIMITS,
    onFailure: (failure) => options.failures?.push(failure),
    retryDelayMs: () => 100,
    maxAttempts: options.maxAttempts ?? 3,
    leaseMs: 1_000,
    ownerRetryMs: 50,
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe("ReliableBatchQueue", () => {
  test("persists Retry-After state and resumes in order after restart", async () => {
    const clock = new ManualClock();
    const store = new MemoryStore();
    const attempts: number[] = [];
    const first = createQueue({
      store,
      clock,
      idPrefix: "first",
      send: async (batch) => {
        attempts.push(batch.items[0]?.order ?? -1);
        throw new ReliableBatchDeliveryError("transient", "busy", {
          retryAfterMs: 5_000,
        });
      },
    });
    await first.enqueue([{ order: 1 }]);
    await first.enqueue([{ order: 2 }]);
    await clock.advance(0);

    expect(attempts).toEqual([1]);
    expect(store.state.batches[0]).toMatchObject({
      attempts: 1,
      nextAttemptAt: 5_000,
      status: "pending",
    });
    await first.close();

    const restartedAttempts: number[] = [];
    const restarted = createQueue({
      store,
      clock,
      idPrefix: "restart",
      send: async (batch) => {
        restartedAttempts.push(batch.items[0]?.order ?? -1);
      },
    });
    await clock.advance(4_999);
    expect(restartedAttempts).toEqual([]);
    await clock.advance(1);

    expect(restartedAttempts).toEqual([1, 2]);
    expect(await restarted.snapshot()).toEqual([]);
    await restarted.close();
  });

  test("aborts a disposed owner and lets one replacement owner resume the same batch", async () => {
    const clock = new ManualClock();
    const store = new MemoryStore();
    const firstAttempts: string[] = [];
    const replacementAttempts: string[] = [];
    const first = createQueue({
      store,
      clock,
      idPrefix: "first",
      send: async (batch, context) => {
        firstAttempts.push(batch.id);
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        });
      },
    });
    const replacement = createQueue({
      store,
      clock,
      idPrefix: "replacement",
      send: async (batch) => {
        replacementAttempts.push(batch.id);
      },
    });
    const result = await first.enqueue([{ order: 1 }]);
    expect(result.accepted).toBe(true);
    await clock.advance(0);
    expect(firstAttempts).toHaveLength(1);
    expect(replacementAttempts).toEqual([]);

    await first.close();
    await clock.advance(50);

    expect(replacementAttempts).toEqual(firstAttempts);
    expect(await replacement.snapshot()).toEqual([]);
    await replacement.close();
  });

  test("enforces aggregate bounds and returns the rejected items for backpressure recovery", async () => {
    const clock = new ManualClock();
    const store = new MemoryStore();
    const failures: ReliableBatchFailure<TestItem>[] = [];
    const queue = createQueue({
      store,
      clock,
      failures,
      send: async () => {
        throw new ReliableBatchDeliveryError("permanent", "blocked");
      },
    });
    await queue.enqueue([{ order: 1 }, { order: 2 }]);
    await queue.enqueue([{ order: 3 }, { order: 4 }]);
    const rejected = await queue.enqueue([{ order: 5 }]);

    expect(rejected).toMatchObject({
      accepted: false,
      reason: "overflow",
      items: [{ order: 5 }],
    });
    expect(failures.at(-1)?.reason).toBe("overflow");
    expect((await queue.snapshot()).flatMap((batch) => batch.items)).toEqual([
      { order: 1 },
      { order: 2 },
      { order: 3 },
      { order: 4 },
    ]);
    await queue.close();
  });

  test("quarantines malformed persisted records and visibly reports them", async () => {
    const clock = new ManualClock();
    const store = new MemoryStore();
    store.state.malformed.push({ id: "broken", scope: "scope-a", items: "not-an-array" });
    const failures: ReliableBatchFailure<TestItem>[] = [];
    const queue = createQueue({
      store,
      clock,
      failures,
      send: async () => {},
    });
    await clock.advance(0);

    expect(failures).toContainEqual(
      expect.objectContaining({
        batchId: "broken",
        reason: "malformed",
      }),
    );
    expect(store.state.malformed).toEqual([]);
    await queue.close();
  });

  test("validates a malformed head inserted by another owner after the initial scan", async () => {
    const clock = new ManualClock();
    const store = new MemoryStore();
    const failures: ReliableBatchFailure<TestItem>[] = [];
    const queue = createQueue({
      store,
      clock,
      failures,
      send: async () => {
        throw new Error("Malformed heads must never be delivered");
      },
    });
    await clock.advance(0);

    store.headOverride = {
      id: "late-broken",
      scope: "scope-a",
      createdAt: clock.now,
      items: "not-an-array",
    };
    queue.wake();
    await clock.advance(0);

    expect(store.headOverride).toBeNull();
    expect(failures).toContainEqual(
      expect.objectContaining({
        batchId: "late-broken",
        reason: "malformed",
      }),
    );
    await queue.close();
  });

  test("reports lease storage errors and reschedules instead of going dormant", async () => {
    const clock = new ManualClock();
    const store = new MemoryStore();
    const acquireLease = store.tryAcquireLease.bind(store);
    let leaseAttempts = 0;
    store.tryAcquireLease = async (...args) => {
      leaseAttempts += 1;
      if (leaseAttempts === 1) {
        throw new Error("IndexedDB lease failed");
      }
      return await acquireLease(...args);
    };
    const delivered: number[] = [];
    const failures: ReliableBatchFailure<TestItem>[] = [];
    const queue = createQueue({
      store,
      clock,
      failures,
      send: async (batch) => {
        delivered.push(batch.items[0]?.order ?? -1);
      },
    });
    await queue.enqueue([{ order: 1 }]);
    await clock.advance(0);

    expect(failures).toContainEqual(
      expect.objectContaining({
        reason: "persistence",
        error: expect.objectContaining({ message: "IndexedDB lease failed" }),
      }),
    );
    expect(delivered).toEqual([]);

    await clock.advance(50);
    expect(delivered).toEqual([1]);
    await queue.close();
  });

  test("treats a missing capability as acknowledged absence without accumulation", async () => {
    const clock = new ManualClock();
    const store = new MemoryStore();
    const failures: ReliableBatchFailure<TestItem>[] = [];
    const queue = createQueue({
      store,
      clock,
      failures,
      send: async () => {
        throw new ReliableBatchDeliveryError("capability_absent", "not found");
      },
    });
    await queue.enqueue([{ order: 1 }]);
    await clock.advance(0);

    expect(store.state.capabilityAbsent).toBe(true);
    expect(await queue.snapshot()).toEqual([]);
    expect(failures).toEqual([]);
    await queue.close();
  });
});
