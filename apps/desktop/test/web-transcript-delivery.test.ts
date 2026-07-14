import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";

import {
  measureTranscriptEventsBytes,
  measureUtf8Bytes,
  TRANSCRIPT_EVENTS_MAX_BYTES,
  TRANSCRIPT_REQUEST_BODY_MAX_BYTES,
} from "../../../src/shared/transcriptBatchProtocol";
import type { TranscriptBatchInput, TranscriptDeliveryFailure } from "../src/lib/desktopApi";
import { IndexedDbReliableBatchStore } from "../src/lib/indexedDbReliableBatchStore";
import {
  createWebTranscriptDelivery,
  type WebTranscriptBatchInput,
} from "../src/lib/webTranscriptDelivery";

const EVENT: TranscriptBatchInput = {
  ts: "2026-07-10T07:00:00.000Z",
  threadId: "thread-durable",
  direction: "server",
  payload: { type: "agent_message", text: "durable" },
};

class ManualClock {
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

class LifecycleTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function createIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function createStore(
  factory: IDBFactory,
  name: string,
  clock: ManualClock,
): IndexedDbReliableBatchStore<WebTranscriptBatchInput> {
  return new IndexedDbReliableBatchStore<WebTranscriptBatchInput>({
    factory,
    dbName: name,
    now: () => clock.now,
  });
}

function eventWithSerializedSize(targetBytes: number): TranscriptBatchInput {
  const template: WebTranscriptBatchInput = {
    ...EVENT,
    payload: { text: "" },
    generation: 0,
  };
  const baseBytes = measureTranscriptEventsBytes([template]);
  if (targetBytes < baseBytes) {
    throw new Error(`Target must be at least ${baseBytes} bytes`);
  }
  return {
    ...EVENT,
    payload: { text: "x".repeat(targetBytes - baseBytes) },
  };
}

function firstEventText(batch: { items: WebTranscriptBatchInput[] }): unknown {
  const payload = batch.items[0]?.payload;
  return payload && typeof payload === "object" && "text" in payload ? payload.text : undefined;
}

async function settle(): Promise<void> {
  // Drain fake-indexeddb's macrotask queue without waiting on real timers:
  // setImmediate fires ahead of timer resolution, so 20 turns of the event
  // loop settle the same work the old 20x Bun.sleep(1) did in ~0ms.
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function complete(transaction: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function seedLegacyOutbox(factory: IDBFactory, name: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const upgradeDatabase = request.result;
      const batches = upgradeDatabase.createObjectStore("batches", {
        keyPath: ["scope", "id"],
      });
      batches.createIndex("scopeOrder", ["scope", "createdAt", "id"], {
        unique: false,
      });
      upgradeDatabase.createObjectStore("scopes", { keyPath: "scope" });
      upgradeDatabase.createObjectStore("leases", { keyPath: "scope" });
      upgradeDatabase.createObjectStore("deadLetters", {
        keyPath: "quarantineId",
        autoIncrement: true,
      });
      upgradeDatabase.createObjectStore("generations", {
        keyPath: ["scope", "threadId"],
      });
    };
    request.onsuccess = () => resolve(request.result);
  });
  const transaction = database.transaction(["batches", "scopes"], "readwrite");
  const batches = transaction.objectStore("batches");
  const legacyBatch = (id: string, text: string) => ({
    id,
    scope: "legacy-scope",
    destination: "http://server/transcript",
    createdAt: 0,
    items: [
      {
        ...EVENT,
        payload: { text },
        generation: 0,
      },
    ],
    bytes: 100,
    attempts: 0,
    nextAttemptAt: 0,
    status: "pending",
  });
  batches.add(legacyBatch("legacy-b", "second-legacy-id"));
  batches.add(legacyBatch("legacy-a", "first-legacy-id"));
  transaction.objectStore("scopes").put({
    scope: "legacy-scope",
    capabilityAbsentUntil: null,
    batches: 2,
    events: 2,
    bytes: 200,
  });
  await complete(transaction);
  database.close();
}

describe("web transcript IndexedDB delivery", () => {
  test("durably captures before lifecycle flush and retains the stable batch", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const lifecycle = new LifecycleTarget();
    const keepalive: boolean[] = [];
    const store = createStore(factory, "capture-before-pagehide", clock);
    const delivery = createWebTranscriptDelivery({
      scope: JSON.stringify(["ws://server-a/ws", "/workspace"]),
      destination: "http://server-a/cowork/desktop/transcript/batch",
      accessHeaders: () => ({ Authorization: "Bearer token" }),
      fetch: async (_input, init) => {
        keepalive.push(init?.keepalive === true);
        throw new Error("connection lost");
      },
      indexedDB: factory,
      lifecycleTarget: lifecycle,
      createId: createIds("capture"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store,
    });

    const capture = delivery.capture(EVENT);
    lifecycle.dispatch("pagehide");
    const result = await capture;
    await settle();

    expect(result.accepted).toBe(true);
    expect(await delivery.snapshot()).toHaveLength(1);
    expect(keepalive).toContain(true);
    await delivery.close();
  });

  test("binds a persisted batch to its original destination across restart", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const dbName = "immutable-destination";
    const first = createWebTranscriptDelivery({
      scope: "scope-a",
      destination: "http://server-a/transcript",
      accessHeaders: () => ({}),
      fetch: async () => new Response(null, { status: 503 }),
      indexedDB: factory,
      createId: createIds("first"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, dbName, clock),
    });
    const captured = await first.capture(EVENT);
    expect(captured.accepted).toBe(true);
    const batchId = captured.accepted ? captured.batch.id : "";
    await first.close();

    const destinations: string[] = [];
    const second = createWebTranscriptDelivery({
      scope: "scope-a",
      destination: "http://server-b/transcript",
      accessHeaders: () => ({}),
      fetch: async (input) => {
        destinations.push(String(input));
        return new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("second"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, dbName, clock),
    });
    await clock.advance(0);

    expect(destinations).toEqual(["http://server-a/transcript"]);
    expect(await second.snapshot()).toEqual([]);
    expect(batchId).toBe("first-2");
    await second.close();
  });

  test("orders identical-timestamp captures monotonically across owners and restart", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const dbName = "monotonic-concurrent-order";
    const createDelivery = (idPrefix: string) =>
      createWebTranscriptDelivery({
        scope: "monotonic-scope",
        destination: "http://server/transcript",
        accessHeaders: () => ({}),
        fetch: async () => new Response(null, { status: 204 }),
        indexedDB: factory,
        createId: createIds(idPrefix),
        now: () => clock.now,
        schedule: clock.schedule,
        cancelScheduled: clock.cancel,
        store: createStore(factory, dbName, clock),
      });
    const firstOwner = createDelivery("z-owner");
    const secondOwner = createDelivery("a-owner");

    await Promise.all([
      firstOwner.capture({
        ...EVENT,
        payload: { type: "agent_message", text: "first" },
      }),
      secondOwner.capture({
        ...EVENT,
        payload: { type: "agent_message", text: "second" },
      }),
    ]);

    const captureOrder = (await firstOwner.snapshot()).map(firstEventText);
    expect(captureOrder).toEqual(["first", "second"]);
    expect(
      (await firstOwner.snapshot()).map(
        (batch) => (batch as typeof batch & { sequence?: unknown }).sequence,
      ),
    ).toEqual([1, 2]);
    await firstOwner.close();
    await secondOwner.close();

    const restarted = createDelivery("restart");
    const restartOrder = (await restarted.snapshot()).map(firstEventText);
    expect(restartOrder).toEqual(["first", "second"]);
    expect(
      (await restarted.snapshot()).map(
        (batch) => (batch as typeof batch & { sequence?: unknown }).sequence,
      ),
    ).toEqual([1, 2]);
    await restarted.close();
  });

  test("migrates legacy timestamp ordering once and continues the persisted sequence", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const dbName = "legacy-monotonic-order";
    await seedLegacyOutbox(factory, dbName);
    const delivery = createWebTranscriptDelivery({
      scope: "legacy-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async () => new Response(null, { status: 204 }),
      indexedDB: factory,
      createId: createIds("upgraded"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, dbName, clock),
    });

    await delivery.capture({ ...EVENT, payload: { text: "new-after-upgrade" } });
    const snapshot = await delivery.snapshot();
    expect(snapshot.map(firstEventText)).toEqual([
      "first-legacy-id",
      "second-legacy-id",
      "new-after-upgrade",
    ]);
    expect(
      snapshot.map((batch) => (batch as typeof batch & { sequence?: unknown }).sequence),
    ).toEqual([1, 2, 3]);
    await delivery.close();
  });

  test("allows only one tab owner and a closed owner cannot erase the replacement result", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const dbName = "multi-tab-owner";
    const firstAttempts: string[] = [];
    const secondAttempts: string[] = [];
    const first = createWebTranscriptDelivery({
      scope: "shared-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async (_input, init) => {
        firstAttempts.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
        return new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("owner-a"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, dbName, clock),
    });
    const second = createWebTranscriptDelivery({
      scope: "shared-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async (_input, init) => {
        secondAttempts.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        return new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("owner-b"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, dbName, clock),
    });
    await first.capture(EVENT);
    await clock.advance(0);
    expect(firstAttempts).toHaveLength(1);
    expect(secondAttempts).toEqual([]);

    await first.close();
    await clock.advance(1_000);

    expect(secondAttempts).toEqual(firstAttempts);
    expect(await second.snapshot()).toEqual([]);
    await second.close();
  });

  test("rejects captures after disposal without reopening or mutating the outbox", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    let requests = 0;
    const store = createStore(factory, "closed-outbox", clock);
    const delivery = createWebTranscriptDelivery({
      scope: "closed-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("closed"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store,
    });

    await delivery.close();
    store.getGeneration = async () => {
      throw new Error("disposed store was reopened");
    };
    const result = await delivery.capture(EVENT);
    await clock.advance(0);

    expect(result).toMatchObject({
      accepted: false,
      reason: "closed",
      items: [EVENT],
    });
    expect(requests).toBe(0);
  });

  test("persists retry attempts and honors Retry-After after restart", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const dbName = "retry-after-restart";
    const first = createWebTranscriptDelivery({
      scope: "retry-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async () =>
        new Response("busy", {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
      indexedDB: factory,
      createId: createIds("retry-a"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, dbName, clock),
    });
    await first.capture(EVENT);
    await clock.advance(0);
    expect(await first.snapshot()).toEqual([
      expect.objectContaining({
        attempts: 1,
        nextAttemptAt: 5_000,
      }),
    ]);
    await first.close();

    let requests = 0;
    const restarted = createWebTranscriptDelivery({
      scope: "retry-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("retry-b"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, dbName, clock),
    });
    await clock.advance(4_999);
    expect(requests).toBe(0);
    await clock.advance(1);
    expect(requests).toBe(1);
    expect(await restarted.snapshot()).toEqual([]);
    await restarted.close();
  });

  test("retries deterministic timeouts without allowing later batches past the head", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const requestTexts: string[] = [];
    let requests = 0;
    const delivery = createWebTranscriptDelivery({
      scope: "timeout-order-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          events: Array<{ payload: { text: string } }>;
        };
        requestTexts.push(request.events[0]?.payload.text ?? "");
        requests += 1;
        if (requests === 1) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
        return new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("timeout-order"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      requestTimeoutMs: 1_000,
      store: createStore(factory, "timeout-order", clock),
    });
    await delivery.capture({ ...EVENT, payload: { text: "first" } });
    await delivery.capture({ ...EVENT, payload: { text: "second" } });

    await clock.advance(0);
    expect(requestTexts).toEqual(["first"]);
    await clock.advance(999);
    expect(requestTexts).toEqual(["first"]);
    await clock.advance(1);
    expect(await delivery.snapshot()).toEqual([
      expect.objectContaining({ attempts: 1, nextAttemptAt: 1_500 }),
      expect.objectContaining({ attempts: 0 }),
    ]);
    await clock.advance(499);
    expect(requestTexts).toEqual(["first"]);
    await clock.advance(1);

    expect(requestTexts).toEqual(["first", "first", "second"]);
    expect(await delivery.snapshot()).toEqual([]);
    await delivery.close();
  });

  test("honors Retry-After on transient 5xx while preserving head-of-line order", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const requestTexts: string[] = [];
    let requests = 0;
    const delivery = createWebTranscriptDelivery({
      scope: "server-retry-order-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          events: Array<{ payload: { text: string } }>;
        };
        requestTexts.push(request.events[0]?.payload.text ?? "");
        requests += 1;
        return requests === 1
          ? new Response("temporarily unavailable", {
              status: 503,
              headers: { "Retry-After": "2" },
            })
          : new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("server-retry-order"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, "server-retry-order", clock),
    });
    await delivery.capture({ ...EVENT, payload: { text: "first" } });
    await delivery.capture({ ...EVENT, payload: { text: "second" } });

    await clock.advance(0);
    expect(requestTexts).toEqual(["first"]);
    expect(await delivery.snapshot()).toEqual([
      expect.objectContaining({ attempts: 1, nextAttemptAt: 2_000 }),
      expect.objectContaining({ attempts: 0 }),
    ]);
    await clock.advance(1_999);
    expect(requestTexts).toEqual(["first"]);
    await clock.advance(1);

    expect(requestTexts).toEqual(["first", "first", "second"]);
    expect(await delivery.snapshot()).toEqual([]);
    await delivery.close();
  });

  test("accepts the exact event-byte boundary and rejects one byte beyond it before fetch", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const requestBodies: string[] = [];
    const delivery = createWebTranscriptDelivery({
      scope: "request-boundary-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async (_input, init) => {
        requestBodies.push(String(init?.body));
        return new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("request-boundary"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, "request-boundary", clock),
    });

    const boundary = await delivery.capture(eventWithSerializedSize(TRANSCRIPT_EVENTS_MAX_BYTES));
    expect(boundary.accepted).toBe(true);
    await clock.advance(0);
    expect(requestBodies).toHaveLength(1);
    const sent = requestBodies[0] ?? "";
    const parsed = JSON.parse(sent) as { events: WebTranscriptBatchInput[] };
    expect(measureTranscriptEventsBytes(parsed.events)).toBe(TRANSCRIPT_EVENTS_MAX_BYTES);
    expect(measureUtf8Bytes(sent)).toBeLessThanOrEqual(TRANSCRIPT_REQUEST_BODY_MAX_BYTES);

    const oversized = await delivery.capture(
      eventWithSerializedSize(TRANSCRIPT_EVENTS_MAX_BYTES + 1),
    );
    expect(oversized).toMatchObject({ accepted: false, reason: "batch_too_large" });
    await clock.advance(0);
    expect(requestBodies).toHaveLength(1);
    await delivery.close();
  });

  test("splits multi-event appends before either server request limit is exceeded", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const requestBodies: string[] = [];
    const delivery = createWebTranscriptDelivery({
      scope: "request-split-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async (_input, init) => {
        requestBodies.push(String(init?.body));
        return new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("request-split"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, "request-split", clock),
    });
    const results = await delivery.append([
      eventWithSerializedSize(140 * 1024),
      eventWithSerializedSize(140 * 1024),
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.accepted)).toBe(true);
    await clock.advance(0);
    expect(requestBodies).toHaveLength(2);
    for (const body of requestBodies) {
      const parsed = JSON.parse(body) as { events: WebTranscriptBatchInput[] };
      expect(parsed.events).toHaveLength(1);
      expect(measureTranscriptEventsBytes(parsed.events)).toBeLessThanOrEqual(
        TRANSCRIPT_EVENTS_MAX_BYTES,
      );
      expect(measureUtf8Bytes(body)).toBeLessThanOrEqual(TRANSCRIPT_REQUEST_BODY_MAX_BYTES);
    }
    await delivery.close();
  });

  test("cancels a deleted thread and advances its persisted generation", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const bodies: string[] = [];
    const delivery = createWebTranscriptDelivery({
      scope: "delete-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async (_input, init) => {
        bodies.push(String(init?.body ?? ""));
        return new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("delete"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, "delete-generation", clock),
    });
    await delivery.capture(EVENT);
    expect(await delivery.snapshot()).toHaveLength(1);
    expect(await delivery.deleteThread(EVENT.threadId)).toBe(1);
    expect(await delivery.snapshot()).toEqual([]);

    await delivery.capture({ ...EVENT, ts: "2026-07-10T07:00:01.000Z" });
    await clock.advance(0);
    const payload = JSON.parse(bodies[0] ?? "") as {
      events: Array<{ generation: number }>;
    };
    expect(payload.events[0]?.generation).toBe(1);
    await delivery.close();
  });

  test("reports quota failures with recoverable rejected events", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const store = createStore(factory, "quota-failure", clock);
    store.enqueue = async () => {
      throw new DOMException("quota reached", "QuotaExceededError");
    };
    const failures: TranscriptDeliveryFailure[] = [];
    const delivery = createWebTranscriptDelivery({
      scope: "quota-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async () => new Response(null, { status: 204 }),
      indexedDB: factory,
      createId: createIds("quota"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store,
    });
    delivery.onFailure((failure) => failures.push(failure));
    const result = await delivery.capture(EVENT);

    expect(result).toMatchObject({
      accepted: false,
      reason: "persistence",
      items: [EVENT],
    });
    expect(failures).toContainEqual(
      expect.objectContaining({
        reason: "persistence",
        canRetry: true,
      }),
    );
    expect(JSON.stringify(failures)).not.toContain("durable");
    await delivery.close();
  });

  test("turns generation read failures into acknowledged bounded recovery", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const store = createStore(factory, "generation-read-failure", clock);
    store.getGeneration = async () => {
      throw new DOMException("generation unavailable", "UnknownError");
    };
    const failures: TranscriptDeliveryFailure[] = [];
    const delivery = createWebTranscriptDelivery({
      scope: "generation-read-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async () => new Response(null, { status: 204 }),
      indexedDB: factory,
      createId: createIds("generation-read"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store,
    });
    delivery.onFailure((failure) => failures.push(failure));

    const result = await delivery.capture(EVENT);

    expect(result).toMatchObject({
      accepted: false,
      reason: "persistence",
    });
    expect(result.accepted ? null : result.recoveryId).toBeString();
    expect(failures).toContainEqual(
      expect.objectContaining({
        recoveryId: result.accepted ? null : result.recoveryId,
        reason: "persistence",
        canRetry: true,
        canDiscard: true,
      }),
    );
    await delivery.close();
  });

  test("bounds rejected payload recovery without deduplicating failure records", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const store = createStore(factory, "bounded-rejected-recovery", clock);
    store.enqueue = async () => {
      throw new DOMException("quota reached", "QuotaExceededError");
    };
    const failures: TranscriptDeliveryFailure[] = [];
    const delivery = createWebTranscriptDelivery({
      scope: "bounded-recovery-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async () => new Response(null, { status: 204 }),
      indexedDB: factory,
      createId: createIds("bounded-recovery"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store,
      rejectedRecoveryLimits: {
        maxRecords: 1,
        maxEvents: 1,
        maxBytes: 10_000,
        retentionMs: 100,
      },
    });
    delivery.onFailure((failure) => failures.push(failure));

    const first = await delivery.capture({
      ...EVENT,
      payload: { secret: "first-sensitive-value" },
    });
    const second = await delivery.capture({
      ...EVENT,
      ts: "2026-07-10T07:00:01.000Z",
      payload: { secret: "second-sensitive-value" },
    });

    expect(first.accepted).toBe(false);
    expect(second.accepted).toBe(false);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ canRetry: true, canDiscard: true });
    expect(failures[1]).toMatchObject({ canRetry: false, canDiscard: true });
    expect(failures[0]?.recoveryId).not.toBe(failures[1]?.recoveryId);
    expect(JSON.stringify(failures)).not.toContain("sensitive-value");

    await clock.advance(100);
    if (!first.accepted) {
      await expect(delivery.retry(first.recoveryId)).rejects.toThrow("sensitive payload");
    }
    await delivery.close();
  });

  test("does not accumulate 404 batches and probes the capability again after cooldown", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    let requests = 0;
    const delivery = createWebTranscriptDelivery({
      scope: "capability-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? new Response("missing", { status: 404 })
          : new Response(null, { status: 204 });
      },
      indexedDB: factory,
      createId: createIds("capability"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store: createStore(factory, "capability-cooldown", clock),
    });
    await delivery.capture(EVENT);
    await clock.advance(0);
    expect(await delivery.snapshot()).toEqual([]);

    const suppressed = await delivery.capture({ ...EVENT, ts: "2026-07-10T07:00:01.000Z" });
    expect(suppressed).toMatchObject({
      accepted: false,
      reason: "capability_absent",
    });
    await clock.advance(60_000);
    await delivery.capture({ ...EVENT, ts: "2026-07-10T07:01:01.000Z" });
    await clock.advance(0);

    expect(requests).toBe(2);
    expect(await delivery.snapshot()).toEqual([]);
    await delivery.close();
  });

  test("quarantines malformed IndexedDB records and exposes recovery guidance", async () => {
    const factory = new IDBFactory();
    const clock = new ManualClock();
    const dbName = "malformed-record";
    const store = createStore(factory, dbName, clock);
    await store.stats("malformed-scope");
    const database = await openDatabase(factory, dbName);
    const transaction = database.transaction("batches", "readwrite");
    transaction.objectStore("batches").put({
      scope: "malformed-scope",
      id: "malformed-batch",
      createdAt: 0,
      items: "not-an-array",
    });
    await complete(transaction);
    database.close();

    const failures: TranscriptDeliveryFailure[] = [];
    const delivery = createWebTranscriptDelivery({
      scope: "malformed-scope",
      destination: "http://server/transcript",
      accessHeaders: () => ({}),
      fetch: async () => new Response(null, { status: 204 }),
      indexedDB: factory,
      createId: createIds("malformed"),
      now: () => clock.now,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      store,
    });
    delivery.onFailure((failure) => failures.push(failure));
    await clock.advance(0);

    expect(await delivery.snapshot()).toEqual([]);
    expect(failures).toContainEqual(
      expect.objectContaining({
        batchId: "malformed-batch",
        reason: "malformed",
        message: expect.stringContaining("quarantined"),
      }),
    );
    await delivery.close();
  });
});
