import { Database } from "bun:sqlite";
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
