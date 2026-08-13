import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { removeWithRetry } from "../src/platform/fs";
import { scratchRoots } from "../src/platform/sandbox";
import { TranscriptInbox, TranscriptInboxError } from "../src/server/transcriptInbox";

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

function event(threadId: string, text: string) {
  return {
    ts: "2026-08-13T10:00:00.000Z",
    threadId,
    direction: "server" as const,
    payload: { text },
  };
}

describe("TranscriptInbox hard capacity", () => {
  test("rejects further appends with 503 when pending batches occupy every slot", async () => {
    const workspace = await makeTempDir("cowork-transcript-capacity-");
    const userDataDir = path.join(workspace, "user-data");
    await fs.mkdir(userDataDir, { recursive: true });

    const inbox = new TranscriptInbox({
      userDataDir,
      maxBatches: 1,
      retentionMs: Number.MAX_SAFE_INTEGER,
      hardenPrivateDir: (candidate) => {
        if (candidate.endsWith(`${path.sep}transcripts`)) {
          throw new Error("disk quota exceeded");
        }
      },
      hardenPrivateFile: () => {},
    });

    try {
      inbox.appendBatch([event("thread-capacity", "first")], "capacity-pending");
      throw new Error("expected projection failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptInboxError);
      expect((error as TranscriptInboxError).message).toBe("Unable to project transcript batch");
      expect((error as TranscriptInboxError).status).toBe(500);
    }

    try {
      inbox.appendBatch([event("thread-capacity", "second")], "capacity-blocked");
      throw new Error("expected capacity rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptInboxError);
      expect((error as TranscriptInboxError).message).toBe("Transcript inbox capacity reached");
      expect((error as TranscriptInboxError).status).toBe(503);
    }
  });

  test("does not consume a capacity slot for a rejected empty batch", async () => {
    const workspace = await makeTempDir("cowork-transcript-empty-batch-");
    const userDataDir = path.join(workspace, "user-data");
    const inbox = new TranscriptInbox({
      userDataDir,
      maxBatches: 1,
      retentionMs: Number.MAX_SAFE_INTEGER,
    });

    try {
      inbox.appendBatch([], "empty-batch");
      throw new Error("expected empty-batch rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptInboxError);
      expect((error as TranscriptInboxError).status).toBe(413);
    }

    expect(() =>
      inbox.appendBatch([event("thread-empty", "ok")], "valid-after-empty"),
    ).not.toThrow();
  });
});
