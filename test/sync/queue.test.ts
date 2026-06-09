import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CloudSyncQueue } from "../../src/sync/queue";
import {
  CLOUD_SYNC_PAYLOAD_VERSION,
  CLOUD_SYNC_SETTINGS_DEDUPE_KEY,
  type CloudSyncPatch,
  type CloudSyncQueueEntry,
} from "../../src/sync/types";
import { buildCloudSyncSettingsSnapshot } from "../../src/sync/redaction";

const BASE_TS = "2026-01-01T00:00:00.000Z";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-queue-test-"));
  tempDirs.push(dir);
  return dir;
}

async function makeTempOutboxPath(): Promise<string> {
  const dir = await makeTempDir();
  return path.join(dir, "outbox.jsonl");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeSettingsPayload() {
  return buildCloudSyncSettingsSnapshot({
    privacyTelemetrySettings: {},
    desktopSettings: {},
  });
}

function makePatch(id: string, dedupeKey?: string): CloudSyncPatch {
  return {
    version: CLOUD_SYNC_PAYLOAD_VERSION,
    id,
    scope: "settings",
    ...(dedupeKey !== undefined ? { dedupeKey } : {}),
    createdAt: BASE_TS,
    payload: makeSettingsPayload(),
  };
}

// ---------------------------------------------------------------------------
// read() — non-existent file returns empty array
// ---------------------------------------------------------------------------
describe("CloudSyncQueue.read()", () => {
  test("returns empty array when outbox file does not exist", async () => {
    const queue = new CloudSyncQueue({ outboxPath: await makeTempOutboxPath() });
    expect(await queue.read()).toEqual([]);
  });

  test("returns empty array after clear() empties the file", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("a"));
    await queue.clear();
    expect(await queue.read()).toEqual([]);
  });

  test("skips corrupt JSON lines without throwing", async () => {
    const outboxPath = await makeTempOutboxPath();
    // Write a mix of valid and corrupt JSONL lines
    const validEntry: CloudSyncQueueEntry = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("valid"),
      attempts: 0,
      nextAttemptAt: BASE_TS,
    };
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.writeFile(
      outboxPath,
      `{corrupt json\n${JSON.stringify(validEntry)}\nnot-json-at-all\n`,
      "utf8",
    );

    const queue = new CloudSyncQueue({ outboxPath });
    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patch.id).toBe("valid");
  });

  test("skips lines with wrong queueVersion", async () => {
    const outboxPath = await makeTempOutboxPath();
    const wrongVersion = {
      queueVersion: 99,
      patch: makePatch("wrong"),
      attempts: 0,
      nextAttemptAt: BASE_TS,
    };
    const goodEntry: CloudSyncQueueEntry = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("good"),
      attempts: 0,
      nextAttemptAt: BASE_TS,
    };
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.writeFile(
      outboxPath,
      `${JSON.stringify(wrongVersion)}\n${JSON.stringify(goodEntry)}\n`,
      "utf8",
    );

    const queue = new CloudSyncQueue({ outboxPath });
    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patch.id).toBe("good");
  });

  test("skips entries with missing or non-numeric attempts", async () => {
    const outboxPath = await makeTempOutboxPath();
    const missingAttempts = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("no-attempts"),
      nextAttemptAt: BASE_TS,
      // attempts omitted
    };
    const stringAttempts = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("str-attempts"),
      attempts: "zero",
      nextAttemptAt: BASE_TS,
    };
    const goodEntry: CloudSyncQueueEntry = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("good"),
      attempts: 0,
      nextAttemptAt: BASE_TS,
    };
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.writeFile(
      outboxPath,
      [missingAttempts, stringAttempts, goodEntry].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const queue = new CloudSyncQueue({ outboxPath });
    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patch.id).toBe("good");
  });

  test("skips entries with missing or invalid nextAttemptAt", async () => {
    const outboxPath = await makeTempOutboxPath();
    const missingTs = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("no-ts"),
      attempts: 0,
      // nextAttemptAt omitted
    };
    const invalidTs = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("bad-ts"),
      attempts: 0,
      nextAttemptAt: "not-a-date",
    };
    const goodEntry: CloudSyncQueueEntry = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("good"),
      attempts: 0,
      nextAttemptAt: BASE_TS,
    };
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.writeFile(
      outboxPath,
      [missingTs, invalidTs, goodEntry].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const queue = new CloudSyncQueue({ outboxPath });
    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patch.id).toBe("good");
  });

  test("skips entries with null or missing patch", async () => {
    const outboxPath = await makeTempOutboxPath();
    const nullPatch = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: null,
      attempts: 0,
      nextAttemptAt: BASE_TS,
    };
    const goodEntry: CloudSyncQueueEntry = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("good"),
      attempts: 0,
      nextAttemptAt: BASE_TS,
    };
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.writeFile(
      outboxPath,
      [nullPatch, goodEntry].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const queue = new CloudSyncQueue({ outboxPath });
    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patch.id).toBe("good");
  });

  test("trims lastError whitespace and omits blank lastError", async () => {
    const outboxPath = await makeTempOutboxPath();
    const withBlankError: CloudSyncQueueEntry = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("blank-err"),
      attempts: 1,
      nextAttemptAt: BASE_TS,
      lastError: "   ",
    };
    const withRealError: CloudSyncQueueEntry = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("real-err"),
      attempts: 1,
      nextAttemptAt: BASE_TS,
      lastError: "  network error  ",
    };
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.writeFile(
      outboxPath,
      [withBlankError, withRealError].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const queue = new CloudSyncQueue({ outboxPath });
    const entries = await queue.read();
    expect(entries).toHaveLength(2);
    // blank lastError is omitted
    expect(entries[0]).not.toHaveProperty("lastError");
    // real lastError is trimmed
    expect(entries[1]?.lastError).toBe("network error");
  });

  test("skips empty and whitespace-only JSONL lines", async () => {
    const outboxPath = await makeTempOutboxPath();
    const goodEntry: CloudSyncQueueEntry = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("good"),
      attempts: 0,
      nextAttemptAt: BASE_TS,
    };
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.writeFile(
      outboxPath,
      `\n   \n${JSON.stringify(goodEntry)}\n\n`,
      "utf8",
    );

    const queue = new CloudSyncQueue({ outboxPath });
    const entries = await queue.read();
    expect(entries).toHaveLength(1);
  });

  test("normalizes negative attempts to 0 on parse", async () => {
    const outboxPath = await makeTempOutboxPath();
    const negAttempts = {
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch: makePatch("neg"),
      attempts: -5,
      nextAttemptAt: BASE_TS,
    };
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.writeFile(outboxPath, JSON.stringify(negAttempts) + "\n", "utf8");

    const queue = new CloudSyncQueue({ outboxPath });
    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// enqueue() — basic persistence and dedupe behavior
// ---------------------------------------------------------------------------
describe("CloudSyncQueue.enqueue()", () => {
  test("persists a single patch and round-trips through read()", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    const p = makePatch("p1", CLOUD_SYNC_SETTINGS_DEDUPE_KEY);
    const result = await queue.enqueue(p);
    expect(result).toHaveLength(1);
    expect(result[0]?.patch.id).toBe("p1");
    expect(result[0]?.attempts).toBe(0);
    expect(result[0]?.nextAttemptAt).toBe(BASE_TS);

    const read = await queue.read();
    expect(read).toHaveLength(1);
    expect(read[0]?.patch.id).toBe("p1");
  });

  test("deduplicates patches sharing the same scope+dedupeKey", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("first", CLOUD_SYNC_SETTINGS_DEDUPE_KEY));
    await queue.enqueue(makePatch("second", CLOUD_SYNC_SETTINGS_DEDUPE_KEY));

    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patch.id).toBe("second");
  });

  test("does NOT deduplicate patches without a dedupeKey", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("first")); // no dedupeKey
    await queue.enqueue(makePatch("second")); // no dedupeKey

    const entries = await queue.read();
    expect(entries).toHaveLength(2);
  });

  test("allows multiple patches with different dedupeKeys", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("a", "key-a"));
    await queue.enqueue(makePatch("b", "key-b"));

    const entries = await queue.read();
    expect(entries).toHaveLength(2);
  });

  test("creates outbox parent directories recursively", async () => {
    const dir = await makeTempDir();
    const outboxPath = path.join(dir, "nested", "deep", "outbox.jsonl");
    const queue = new CloudSyncQueue({
      outboxPath,
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("x"));
    const content = await fs.readFile(outboxPath, "utf8");
    expect(content.length).toBeGreaterThan(0);
  });

  test("sets nextAttemptAt to now()'s ISO string", async () => {
    const fixedDate = new Date("2025-06-15T12:00:00.000Z");
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => fixedDate,
    });
    await queue.enqueue(makePatch("x"));
    const entries = await queue.read();
    expect(entries[0]?.nextAttemptAt).toBe("2025-06-15T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// write() — cap enforcement (maxEntries / maxBytes)
// ---------------------------------------------------------------------------
describe("CloudSyncQueue.write() — cap enforcement", () => {
  test("caps at maxEntries by keeping the most recent entries", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      maxEntries: 3,
      now: () => new Date(BASE_TS),
    });

    for (let i = 0; i < 5; i++) {
      await queue.enqueue(makePatch(`p${i}`, `key-${i}`));
    }

    const entries = await queue.read();
    expect(entries.length).toBeLessThanOrEqual(3);
    // The most recent entries should be kept
    const ids = entries.map((e) => e.patch.id);
    expect(ids).toContain("p4");
  });

  test("caps at maxBytes by evicting oldest entries first", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      maxEntries: 100,
      maxBytes: 500,
      now: () => new Date(BASE_TS),
    });

    // Enqueue many entries until we'd normally exceed 500 bytes
    for (let i = 0; i < 10; i++) {
      await queue.enqueue(makePatch(`p${i}`, `key-${i}`));
    }

    const content = await fs.readFile(queue.outboxPath, "utf8");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(500);
  });

  test("maxEntries=2 with unique dedupeKeys keeps only last 2", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      maxEntries: 2,
      maxBytes: 700,
      now: () => new Date(BASE_TS),
    });

    await queue.enqueue({ ...makePatch("one"), dedupeKey: "one" });
    await queue.enqueue({ ...makePatch("two"), dedupeKey: "two" });
    await queue.enqueue({ ...makePatch("three"), dedupeKey: "three" });

    const entries = await queue.read();
    expect(entries.length).toBeLessThanOrEqual(2);
    const content = await fs.readFile(queue.outboxPath, "utf8");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(700);
  });

  test("writing empty array produces an empty file (no trailing newline)", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("x"));
    await queue.write([]);
    const content = await fs.readFile(queue.outboxPath, "utf8");
    expect(content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// due() — filtering by nextAttemptAt
// ---------------------------------------------------------------------------
describe("CloudSyncQueue.due()", () => {
  test("returns entries whose nextAttemptAt <= now", async () => {
    let now = new Date(BASE_TS);
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => now,
    });

    // This entry is due immediately
    await queue.enqueue(makePatch("ready", "k1"));
    expect(await queue.due()).toHaveLength(1);

    // Simulate a retry delay: next attempt is 1s into the future
    await queue.markFailed("ready", new Error("timeout"));
    expect(await queue.due()).toHaveLength(0);

    // Advance clock past the retry delay (base is 1000ms)
    now = new Date(Date.parse(BASE_TS) + 1001);
    expect(await queue.due()).toHaveLength(1);
  });

  test("returns empty when queue is empty", async () => {
    const queue = new CloudSyncQueue({ outboxPath: await makeTempOutboxPath() });
    expect(await queue.due()).toEqual([]);
  });

  test("returns only entries that are past their delay, not future ones", async () => {
    const now = new Date(BASE_TS);
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => now,
    });

    // Enqueue two with different dedupeKeys so both persist
    await queue.enqueue(makePatch("early", "k-early"));
    await queue.markFailed("early", new Error("err")); // bumped to future

    // Read the current entries to verify the state
    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(await queue.due()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// remove() — by patchId
// ---------------------------------------------------------------------------
describe("CloudSyncQueue.remove()", () => {
  test("removes the matching entry by patch.id", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("a", "ka"));
    await queue.enqueue(makePatch("b", "kb"));

    await queue.remove("a");
    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patch.id).toBe("b");
  });

  test("is a no-op when the patchId does not exist", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("a"));
    await queue.remove("nonexistent");
    expect(await queue.read()).toHaveLength(1);
  });

  test("works on an empty queue without throwing", async () => {
    const queue = new CloudSyncQueue({ outboxPath: await makeTempOutboxPath() });
    await expect(queue.remove("anything")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// markFailed() — exponential backoff
// ---------------------------------------------------------------------------
describe("CloudSyncQueue.markFailed()", () => {
  test("increments attempts and sets lastError", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("x", "kx"));
    await queue.markFailed("x", new Error("first failure"));

    const entries = await queue.read();
    expect(entries[0]?.attempts).toBe(1);
    expect(entries[0]?.lastError).toBe("first failure");
  });

  test("converts non-Error error values to string", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("x", "kx"));
    await queue.markFailed("x", "string error");

    const entries = await queue.read();
    expect(entries[0]?.lastError).toBe("string error");
  });

  test("backoff delay grows with each failure", async () => {
    const now = new Date(BASE_TS);
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => now,
    });
    await queue.enqueue(makePatch("x", "kx"));

    const delays: number[] = [];
    const nowMs = now.getTime();
    // Simulate 4 consecutive failures
    for (let i = 0; i < 4; i++) {
      await queue.markFailed("x", new Error(`fail ${i}`));
      const entries = await queue.read();
      const nextMs = Date.parse(entries[0]?.nextAttemptAt ?? "");
      delays.push(nextMs - nowMs);
    }

    // Each delay should be >= the previous (exponential growth)
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });

  test("backoff delay is capped at RETRY_MAX_MS (5 minutes)", async () => {
    const now = new Date(BASE_TS);
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => now,
    });
    await queue.enqueue(makePatch("x", "kx"));

    // 20 failures — well past the cap
    for (let i = 0; i < 20; i++) {
      await queue.markFailed("x", new Error("fail"));
    }

    const entries = await queue.read();
    const nextMs = Date.parse(entries[0]?.nextAttemptAt ?? "");
    const maxMs = 5 * 60 * 1000;
    expect(nextMs - now.getTime()).toBeLessThanOrEqual(maxMs);
  });

  test("is a no-op for an unknown patchId", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("x", "kx"));
    await queue.markFailed("unknown-id", new Error("nope"));
    const entries = await queue.read();
    // Entry "x" should be untouched
    expect(entries[0]?.patch.id).toBe("x");
    expect(entries[0]?.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------
describe("CloudSyncQueue.clear()", () => {
  test("removes all entries from the queue", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => new Date(BASE_TS),
    });
    await queue.enqueue(makePatch("a", "ka"));
    await queue.enqueue(makePatch("b", "kb"));
    await queue.clear();
    expect(await queue.read()).toEqual([]);
  });

  test("is idempotent on an already-empty queue", async () => {
    const queue = new CloudSyncQueue({ outboxPath: await makeTempOutboxPath() });
    await queue.clear();
    await queue.clear();
    expect(await queue.read()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// outboxPath is exposed on the instance
// ---------------------------------------------------------------------------
describe("CloudSyncQueue instance properties", () => {
  test("exposes outboxPath when constructed with explicit path", async () => {
    const outboxPath = await makeTempOutboxPath();
    const queue = new CloudSyncQueue({ outboxPath });
    expect(queue.outboxPath).toBe(outboxPath);
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip — JSONL format correctness
// ---------------------------------------------------------------------------
describe("JSONL persistence round-trip", () => {
  test("each line in the file is a valid JSON object", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      maxEntries: 100,
      now: () => new Date(BASE_TS),
    });
    for (let i = 0; i < 3; i++) {
      await queue.enqueue(makePatch(`p${i}`, `key-${i}`));
    }

    const content = await fs.readFile(queue.outboxPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("read() correctly round-trips all fields set by enqueue()", async () => {
    const now = new Date("2025-03-10T08:00:00.000Z");
    const queue = new CloudSyncQueue({
      outboxPath: await makeTempOutboxPath(),
      now: () => now,
    });
    const p = makePatch("round-trip", "rt-key");
    await queue.enqueue(p);

    const entries = await queue.read();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.queueVersion).toBe(CLOUD_SYNC_PAYLOAD_VERSION);
    expect(e.patch.id).toBe("round-trip");
    expect(e.attempts).toBe(0);
    expect(e.nextAttemptAt).toBe("2025-03-10T08:00:00.000Z");
    expect(e.lastError).toBeUndefined();
  });
});
