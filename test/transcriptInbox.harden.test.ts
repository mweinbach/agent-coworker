import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { removeWithRetry } from "../src/platform/fs";
import { scratchRoots } from "../src/platform/sandbox";
import {
  type ProjectedTranscriptEvent,
  TranscriptInbox,
  TranscriptInboxError,
} from "../src/server/transcriptInbox";

const cleanupPaths = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", prefix));
  cleanupPaths.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (target) => {
      await removeWithRetry(target, { recursive: true, bestEffort: true });
      cleanupPaths.delete(target);
    }),
  );
});

describe("TranscriptInbox harden error tolerance", () => {
  test("ignores transient Windows harden failures for WAL/SHM sidecars", async () => {
    const workspace = await makeTempDir("cowork-transcript-harden-ignore-");
    const userDataDir = path.join(workspace, "user-data");
    await fs.mkdir(userDataDir, { recursive: true });

    const ignorableMessages = [
      "icacls.exe failed with exit code 5: Access is denied.",
      "resource is locked by another process",
      "device or resource busy",
      "Access is denied.",
      "EPERM: operation not permitted",
    ];
    let ignorableIndex = 0;
    const hardenedSidecars: string[] = [];

    const inbox = new TranscriptInbox({
      userDataDir,
      hardenPrivateDir: () => {},
      hardenPrivateFile: (candidate) => {
        if (candidate.endsWith("-wal") || candidate.endsWith("-shm")) {
          hardenedSidecars.push(candidate);
          throw new Error(ignorableMessages[ignorableIndex++ % ignorableMessages.length]);
        }
      },
    });

    const databasePath = path.join(userDataDir, "transcript-inbox.sqlite");
    const holdingConnection = new Database(databasePath);
    try {
      holdingConnection.exec("PRAGMA journal_mode = WAL");
      holdingConnection.query("SELECT COUNT(*) FROM transcript_batches").get();

      expect(() =>
        inbox.appendBatch(
          [
            {
              ts: "2026-07-26T10:00:00.000Z",
              threadId: "thread-harden",
              direction: "server",
              payload: { text: "keep going" },
            },
          ],
          "harden-ignore-batch",
        ),
      ).not.toThrow();
    } finally {
      holdingConnection.close(false);
    }

    expect(hardenedSidecars.some((candidate) => candidate.endsWith("-wal"))).toBe(true);
    expect(hardenedSidecars.some((candidate) => candidate.endsWith("-shm"))).toBe(true);
  });

  test("still surfaces unexpected harden failures", async () => {
    const workspace = await makeTempDir("cowork-transcript-harden-fail-");
    const userDataDir = path.join(workspace, "user-data");
    await fs.mkdir(userDataDir, { recursive: true });

    const inbox = new TranscriptInbox({
      userDataDir,
      hardenPrivateDir: () => {},
      hardenPrivateFile: (candidate) => {
        if (candidate.endsWith("-wal")) {
          throw new Error("disk quota exceeded");
        }
      },
    });

    const databasePath = path.join(userDataDir, "transcript-inbox.sqlite");
    const holdingConnection = new Database(databasePath);
    try {
      holdingConnection.exec("PRAGMA journal_mode = WAL");
      holdingConnection.query("SELECT COUNT(*) FROM transcript_batches").get();

      expect(() =>
        inbox.appendBatch(
          [
            {
              ts: "2026-07-26T10:00:00.000Z",
              threadId: "thread-harden-fail",
              direction: "server",
              payload: { text: "should fail" },
            },
          ],
          "harden-fail-batch",
        ),
      ).toThrow(TranscriptInboxError);
    } finally {
      holdingConnection.close(false);
    }
  });
});

describe("TranscriptInbox recovery", () => {
  async function readProjectedEvents(filePath: string): Promise<ProjectedTranscriptEvent[]> {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as ProjectedTranscriptEvent];
      } catch {
        return [];
      }
    });
  }

  test.each(["valid", "torn"] as const)(
    "preserves events when appending after an unterminated %s transcript tail",
    async (tail) => {
      const userDataDir = await makeTempDir("cowork-transcript-tail-");
      const inbox = new TranscriptInbox({
        userDataDir,
        hardenPrivateDir: () => {},
        hardenPrivateFile: () => {},
      });
      const existing: ProjectedTranscriptEvent = {
        ts: "2026-07-26T10:00:00.000Z",
        threadId: "thread-tail",
        direction: "server",
        payload: { text: "existing" },
        deliveryId: "existing-batch:0",
      };
      const event = { ...existing, payload: { text: "recovered" }, deliveryId: undefined };
      const filePath = path.join(userDataDir, "transcripts", "thread-tail.jsonl");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        `${JSON.stringify(existing)}${tail === "torn" ? '\n{"ts":' : ""}`,
      );

      inbox.appendBatch([event], "recovered-batch");
      inbox.appendBatch([event], "recovered-batch");
      inbox.projectPending(existing.threadId);

      expect(await readProjectedEvents(filePath)).toEqual([
        existing,
        { ...event, deliveryId: "recovered-batch:0" },
      ]);
    },
  );

  test.each(["thread", "all", "append", "other-thread"] as const)(
    "replays %s pending batches in durable acceptance order with equal timestamps",
    async (scope) => {
      const userDataDir = await makeTempDir("cowork-transcript-replay-order-");
      const inbox = new TranscriptInbox({
        userDataDir,
        now: () => 1_000,
        hardenPrivateDir: (candidate) => {
          if (candidate === path.join(userDataDir, "transcripts")) {
            throw new Error("simulated projection failure");
          }
        },
        hardenPrivateFile: () => {},
      });
      for (const batchId of ["z-earlier", "a-later"]) {
        const event = {
          ts: "2026-07-26T10:00:00.000Z",
          threadId: "thread-replay",
          direction: "server" as const,
          payload: { batchId },
        };
        expect(() =>
          inbox.appendBatch(
            [event, ...(batchId === "a-later" ? [{ ...event, threadId: "other-thread" }] : [])],
            batchId,
          ),
        ).toThrow("Unable to project transcript batch");
      }

      const restarted = new TranscriptInbox({
        userDataDir,
        now: () => 1_000,
        hardenPrivateDir: () => {},
        hardenPrivateFile: () => {},
      });
      if (scope === "append") {
        restarted.appendBatch(
          [
            {
              ts: "2026-07-26T10:00:01.000Z",
              threadId: "thread-replay",
              direction: "server",
              payload: { batchId: "newest" },
            },
          ],
          "newest",
        );
      } else {
        if (scope === "other-thread") restarted.projectPending("other-thread");
        restarted.projectPending(scope === "all" ? undefined : "thread-replay");
      }
      const events = await readProjectedEvents(
        path.join(userDataDir, "transcripts", "thread-replay.jsonl"),
      );
      expect(events.map((event) => event.deliveryId)).toEqual([
        "z-earlier:0",
        "a-later:0",
        ...(scope === "append" ? ["newest:0"] : []),
      ]);
    },
  );

  test("keeps unrelated threads progressing when a pending projection is blocked", async () => {
    const userDataDir = await makeTempDir("cowork-transcript-blocked-thread-");
    const inbox = new TranscriptInbox({
      userDataDir,
      hardenPrivateDir: () => {},
      hardenPrivateFile: () => {},
    });
    await fs.mkdir(path.join(userDataDir, "transcripts", "blocked-thread.jsonl"), {
      recursive: true,
    });
    const event = {
      ts: "2026-07-26T10:00:00.000Z",
      threadId: "blocked-thread",
      direction: "server" as const,
      payload: { text: "event" },
    };
    expect(() => inbox.appendBatch([event], "blocked-batch")).toThrow(TranscriptInboxError);

    inbox.appendBatch([{ ...event, threadId: "other-thread" }], "other-batch");

    const events = await readProjectedEvents(
      path.join(userDataDir, "transcripts", "other-thread.jsonl"),
    );
    expect(events.map((item) => item.deliveryId)).toEqual(["other-batch:0"]);
  });

  test("settles fully canceled batches so they do not exhaust inbox capacity", async () => {
    const userDataDir = await makeTempDir("cowork-transcript-canceled-capacity-");
    const inbox = new TranscriptInbox({
      userDataDir,
      maxBatches: 1,
      hardenPrivateDir: () => {},
      hardenPrivateFile: () => {},
    });
    const event = {
      ts: "2026-07-26T10:00:00.000Z",
      threadId: "thread-capacity",
      direction: "server" as const,
      payload: { text: "event" },
      generation: 0,
    };
    inbox.deleteThread(event.threadId, 1);
    inbox.appendBatch([event], "stale-batch");
    inbox.appendBatch([{ ...event, generation: 1 }], "current-batch");

    const events = await readProjectedEvents(
      path.join(userDataDir, "transcripts", `${event.threadId}.jsonl`),
    );
    expect(events.map((item) => item.deliveryId)).toEqual(["current-batch:0"]);
  });

  test.each([1, 2])(
    "preserves generation %i events when an earlier deletion is retried",
    async (generation) => {
      const userDataDir = await makeTempDir("cowork-transcript-delete-retry-");
      const inbox = new TranscriptInbox({
        userDataDir,
        hardenPrivateDir: () => {},
        hardenPrivateFile: () => {},
      });
      const event = {
        ts: "2026-07-26T10:00:00.000Z",
        threadId: "thread-delete-retry",
        direction: "server" as const,
        payload: { text: "keep this generation" },
        generation,
      };
      inbox.deleteThread(event.threadId, generation);
      inbox.appendBatch([event], "new-generation-batch");

      expect(inbox.deleteThread(event.threadId, 1)).toBe(generation);
      inbox.projectPending(event.threadId);

      expect(
        await readProjectedEvents(path.join(userDataDir, "transcripts", `${event.threadId}.jsonl`)),
      ).toEqual([
        {
          ts: event.ts,
          threadId: event.threadId,
          direction: event.direction,
          payload: event.payload,
          deliveryId: "new-generation-batch:0",
        },
      ]);
    },
  );

  test("rejects unsafe batch ids before they consume inbox capacity", async () => {
    const userDataDir = await makeTempDir("cowork-transcript-batch-id-");
    const inbox = new TranscriptInbox({
      userDataDir,
      maxBatches: 1,
      retentionMs: Number.MAX_SAFE_INTEGER,
      now: () => 1_000,
      hardenPrivateDir: () => {},
      hardenPrivateFile: () => {},
    });
    const event = {
      ts: "2026-07-26T10:00:00.000Z",
      threadId: "thread-batch-id",
      direction: "server" as const,
      payload: { text: "kept" },
    };
    for (const batchId of ["", "../evil", "has space", "a".repeat(257), "batch\\id"]) {
      let error: unknown;
      try {
        inbox.appendBatch([event], batchId);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TranscriptInboxError);
      if (error instanceof TranscriptInboxError) {
        expect(error.message).toBe("batchId contains invalid characters");
        expect(error.status).toBe(400);
      }
    }

    const accepted = "a".repeat(256);
    inbox.appendBatch([event], accepted);

    const database = new Database(path.join(userDataDir, "transcript-inbox.sqlite"));
    try {
      const rows = database
        .query("SELECT batch_id FROM transcript_batches ORDER BY rowid")
        .all() as Array<{ batch_id: string }>;
      expect(rows).toEqual([{ batch_id: accepted }]);
    } finally {
      database.close(false);
    }
  });

  test("fails closed when a blocked projection fills the inbox", async () => {
    const userDataDir = await makeTempDir("cowork-transcript-capacity-");
    const inbox = new TranscriptInbox({
      userDataDir,
      maxBatches: 1,
      retentionMs: Number.MAX_SAFE_INTEGER,
      now: () => 1_000,
      hardenPrivateDir: () => {},
      hardenPrivateFile: () => {},
    });
    await fs.mkdir(path.join(userDataDir, "transcripts", "blocked-thread.jsonl"), {
      recursive: true,
    });
    const blocked = {
      ts: "2026-07-26T10:00:00.000Z",
      threadId: "blocked-thread",
      direction: "server" as const,
      payload: { text: "blocked" },
    };
    expect(() => inbox.appendBatch([blocked], "blocked-batch")).toThrow(TranscriptInboxError);

    let error: unknown;
    try {
      inbox.appendBatch(
        [{ ...blocked, threadId: "other-thread", payload: { text: "should not land" } }],
        "other-batch",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TranscriptInboxError);
    if (error instanceof TranscriptInboxError) {
      expect(error.message).toBe("Transcript inbox capacity reached");
      expect(error.status).toBe(503);
    }

    const database = new Database(path.join(userDataDir, "transcript-inbox.sqlite"));
    try {
      const rows = database
        .query("SELECT batch_id FROM transcript_batches ORDER BY rowid")
        .all() as Array<{ batch_id: string }>;
      expect(rows).toEqual([{ batch_id: "blocked-batch" }]);
    } finally {
      database.close(false);
    }
    await expect(
      fs.access(path.join(userDataDir, "transcripts", "other-thread.jsonl")),
    ).rejects.toThrow();
  });

  test("refuses to project a delivery id whose transcript bytes changed", async () => {
    const userDataDir = await makeTempDir("cowork-transcript-projection-conflict-");
    const inbox = new TranscriptInbox({
      userDataDir,
      now: () => 1_000,
      hardenPrivateDir: () => {},
      hardenPrivateFile: () => {},
    });
    inbox.appendBatch(
      [
        {
          ts: "2026-07-26T10:00:00.000Z",
          threadId: "thread-conflict",
          direction: "server",
          payload: { text: "first" },
        },
      ],
      "proj-a",
    );
    const filePath = path.join(userDataDir, "transcripts", "thread-conflict.jsonl");
    const original = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      payload: { text: string };
    };
    original.payload.text = "tampered";
    const tampered = `${JSON.stringify(original)}\n`;
    await fs.writeFile(filePath, tampered);

    const databasePath = path.join(userDataDir, "transcript-inbox.sqlite");
    const database = new Database(databasePath);
    try {
      database
        .query("UPDATE transcript_events SET projected = 0 WHERE delivery_id = ?")
        .run("proj-a:0");
      database
        .query(
          "UPDATE transcript_batches SET state = 'pending', completed_at_ms = NULL WHERE batch_id = ?",
        )
        .run("proj-a");
    } finally {
      database.close(false);
    }

    let error: unknown;
    try {
      inbox.projectPending("thread-conflict");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TranscriptInboxError);
    if (error instanceof TranscriptInboxError) {
      expect(error.message).toBe(
        "Idempotency key conflicts with the existing transcript projection",
      );
      expect(error.status).toBe(409);
    }
    expect(await fs.readFile(filePath, "utf8")).toBe(tampered);

    const verify = new Database(databasePath);
    try {
      const row = verify
        .query("SELECT projected, event_json FROM transcript_events WHERE delivery_id = ?")
        .get("proj-a:0") as { projected: number; event_json: string };
      expect(row.projected).toBe(0);
      expect(JSON.parse(row.event_json)).toMatchObject({ payload: { text: "first" } });
    } finally {
      verify.close(false);
    }
  });
});
