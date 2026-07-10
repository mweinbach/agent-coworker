import { describe, expect, test } from "bun:test";

import { createTranscriptBuffer } from "../src/app/store.helpers/transcriptBuffer";

describe("transcript buffer host adapters", () => {
  test("preserves Electron debounce batching when durable capture is unavailable", async () => {
    const appended: unknown[][] = [];
    let scheduled: (() => void) | null = null;
    const buffer = createTranscriptBuffer({
      nowIso: () => "2026-07-10T07:00:00.000Z",
      captureEvent: () => null,
      appendBatch: async (events) => {
        appended.push(events);
      },
      schedule: (callback) => {
        scheduled = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
    });

    buffer.appendThreadTranscript("thread-electron", "client", { text: "one" });
    buffer.appendThreadTranscript("thread-electron", "server", { text: "two" });
    expect(appended).toEqual([]);
    expect(scheduled).not.toBeNull();
    const flush = scheduled as (() => void) | null;
    flush?.();
    await Promise.resolve();

    expect(appended).toEqual([
      [
        {
          ts: "2026-07-10T07:00:00.000Z",
          threadId: "thread-electron",
          direction: "client",
          payload: { text: "one" },
        },
        {
          ts: "2026-07-10T07:00:00.000Z",
          threadId: "thread-electron",
          direction: "server",
          payload: { text: "two" },
        },
      ],
    ]);
  });

  test("retains a web event until durable capture acknowledges its IndexedDB commit", async () => {
    const captured: unknown[] = [];
    let scheduled = false;
    let acknowledge: (() => void) | null = null;
    const buffer = createTranscriptBuffer({
      nowIso: () => "2026-07-10T07:00:00.000Z",
      captureEvent: (event) => {
        captured.push(event);
        return new Promise((resolve) => {
          acknowledge = () =>
            resolve({
              accepted: true,
              batchId: "durable-batch",
              pendingEvents: 1,
              pendingBytes: 100,
            });
        });
      },
      appendBatch: async () => {
        throw new Error("Web capture must bypass the in-memory batch");
      },
      schedule: (callback) => {
        scheduled = true;
        return globalThis.setTimeout(callback, 0);
      },
    });

    buffer.appendThreadTranscript("thread-web", "server", { text: "durable" });

    expect(buffer.pendingCount()).toBe(1);
    expect(captured).toEqual([
      {
        ts: "2026-07-10T07:00:00.000Z",
        threadId: "thread-web",
        direction: "server",
        payload: { text: "durable" },
      },
    ]);
    expect(scheduled).toBe(false);
    acknowledge?.();
    await Promise.resolve();
    expect(buffer.pendingCount()).toBe(0);
  });

  test("falls back to Electron batching when capture rejects unexpectedly", async () => {
    const appended: unknown[][] = [];
    let scheduled: (() => void) | null = null;
    const buffer = createTranscriptBuffer({
      nowIso: () => "2026-07-10T07:00:00.000Z",
      captureEvent: async () => {
        throw new Error("bridge replaced");
      },
      appendBatch: async (events) => {
        appended.push(events);
      },
      schedule: (callback) => {
        scheduled = callback;
        return 1;
      },
    });

    buffer.appendThreadTranscript("thread-fallback", "client", { text: "retained" });
    expect(buffer.pendingCount()).toBe(1);
    await Promise.resolve();
    const flush = scheduled as (() => void) | null;
    flush?.();
    await Promise.resolve();

    expect(buffer.pendingCount()).toBe(0);
    expect(appended).toEqual([
      [
        {
          ts: "2026-07-10T07:00:00.000Z",
          threadId: "thread-fallback",
          direction: "client",
          payload: { text: "retained" },
        },
      ],
    ]);
  });
});
