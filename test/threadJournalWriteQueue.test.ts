import { describe, expect, test } from "bun:test";

import {
  enqueueThreadJournalWrite,
  waitForThreadJournalWriteQueueIdle,
} from "../src/server/startServer/threadJournalWriteQueue";

async function nextTick(): Promise<void> {
  await Bun.sleep(0);
}

describe("threadJournalWriteQueue", () => {
  test("same-thread writes execute in order", async () => {
    const queues = new Map<string, Promise<void>>();
    const events: string[] = [];
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();

    const first = enqueueThreadJournalWrite(queues, "thread-1", async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const second = enqueueThreadJournalWrite(queues, "thread-1", async () => {
      events.push("second:start");
      await secondGate.promise;
      events.push("second:end");
    });

    await nextTick();
    expect(events).toEqual(["first:start"]);

    firstGate.resolve();
    await first;
    await nextTick();
    expect(events).toEqual(["first:start", "first:end", "second:start"]);

    secondGate.resolve();
    await second;
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("removes the map entry after a successful final write", async () => {
    const queues = new Map<string, Promise<void>>();

    const write = enqueueThreadJournalWrite(queues, "thread-1", async () => {});

    expect(queues.has("thread-1")).toBe(true);
    await write;
    await nextTick();
    expect(queues.has("thread-1")).toBe(false);
  });

  test("removes the map entry after a failed final write", async () => {
    const queues = new Map<string, Promise<void>>();
    const error = new Error("append failed");

    const write = enqueueThreadJournalWrite(queues, "thread-1", async () => {
      throw error;
    });

    expect(queues.has("thread-1")).toBe(true);
    await expect(write).rejects.toThrow("append failed");
    await nextTick();
    expect(queues.has("thread-1")).toBe(false);
  });

  test("an older write settling does not delete a newer active tail", async () => {
    const queues = new Map<string, Promise<void>>();
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();

    const first = enqueueThreadJournalWrite(queues, "thread-1", async () => {
      await firstGate.promise;
    });
    const firstTail = queues.get("thread-1");
    const second = enqueueThreadJournalWrite(queues, "thread-1", async () => {
      await secondGate.promise;
    });
    const secondTail = queues.get("thread-1");

    expect(firstTail).toBeDefined();
    expect(secondTail).toBeDefined();
    expect(secondTail).not.toBe(firstTail);

    firstGate.resolve();
    await first;
    await nextTick();
    expect(queues.get("thread-1")).toBe(secondTail);

    secondGate.resolve();
    await second;
    await nextTick();
    expect(queues.has("thread-1")).toBe(false);
  });

  test("waitForIdle waits for the latest queued write and leaves the queue empty", async () => {
    const queues = new Map<string, Promise<void>>();
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();

    const first = enqueueThreadJournalWrite(queues, "thread-1", async () => {
      await firstGate.promise;
    });
    const second = enqueueThreadJournalWrite(queues, "thread-1", async () => {
      await secondGate.promise;
    });

    let idleResolved = false;
    const idle = waitForThreadJournalWriteQueueIdle(queues, "thread-1").then(() => {
      idleResolved = true;
    });

    await nextTick();
    expect(idleResolved).toBe(false);

    firstGate.resolve();
    await first;
    await nextTick();
    expect(idleResolved).toBe(false);
    expect(queues.has("thread-1")).toBe(true);

    secondGate.resolve();
    await second;
    await idle;
    expect(idleResolved).toBe(true);
    expect(queues.has("thread-1")).toBe(false);
  });

  test("later writes still run after an earlier failure", async () => {
    const queues = new Map<string, Promise<void>>();

    const first = enqueueThreadJournalWrite(queues, "thread-1", async () => {
      throw new Error("first append failed");
    });
    let secondStarted = false;
    const second = enqueueThreadJournalWrite(queues, "thread-1", async () => {
      secondStarted = true;
    });

    await expect(first).rejects.toThrow("first append failed");
    await second;
    await nextTick();
    expect(secondStarted).toBe(true);
    expect(queues.has("thread-1")).toBe(false);
  });
});
