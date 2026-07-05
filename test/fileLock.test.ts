import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lockDirPathFor, withFileLock } from "../src/utils/fileLock";

const tempDirs: string[] = [];

async function makeTempTarget(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-"));
  tempDirs.push(dir);
  return path.join(dir, "store.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("withFileLock", () => {
  test("serializes concurrent critical sections in one process", async () => {
    const target = await makeTempTarget();
    let inside = 0;
    let maxInside = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        withFileLock(target, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(index);
          inside -= 1;
        }),
      ),
    );

    expect(maxInside).toBe(1);
    expect(order).toHaveLength(8);
  });

  test("releases the lock directory after the callback settles", async () => {
    const target = await makeTempTarget();
    await withFileLock(target, async () => {
      const stat = await fs.stat(lockDirPathFor(target));
      expect(stat.isDirectory()).toBe(true);
    });
    await expect(fs.stat(lockDirPathFor(target))).rejects.toThrow();

    await expect(
      withFileLock(target, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.stat(lockDirPathFor(target))).rejects.toThrow();
  });

  test("takes over a stale lock held by a dead process", async () => {
    const target = await makeTempTarget();
    const lockDir = lockDirPathFor(target);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 999_999, createdAt: new Date().toISOString() }),
      "utf-8",
    );

    const result = await withFileLock(target, async () => "ran", undefined, {
      processAlive: () => false,
    });
    expect(result).toBe("ran");
    await expect(fs.stat(lockDir)).rejects.toThrow();
  });

  test("never steals a lock from a live owner even when its metadata is expired", async () => {
    const target = await makeTempTarget();
    const lockDir = lockDirPathFor(target);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 60_000).toISOString() }),
      "utf-8",
    );

    // A slow-but-alive owner must surface as an acquire timeout, never a
    // takeover that would reopen the lost-update race the lock exists to close.
    await expect(
      withFileLock(target, async () => "never", {
        staleLockMs: 1_000,
        acquireTimeoutMs: 250,
        retryDelayMs: 10,
      }),
    ).rejects.toThrow("Timed out acquiring file lock");
  });

  test("takes over an expired lock whose owner process is gone", async () => {
    const target = await makeTempTarget();
    const lockDir = lockDirPathFor(target);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 999_999, createdAt: new Date(Date.now() - 60_000).toISOString() }),
      "utf-8",
    );

    const result = await withFileLock(
      target,
      async () => "ran",
      { staleLockMs: 1_000 },
      {
        processAlive: () => false,
      },
    );
    expect(result).toBe("ran");
  });

  test("a paused creator cannot clobber a lock claimed during its ownerless window", async () => {
    const target = await makeTempTarget();
    const lockDir = lockDirPathFor(target);
    const ownerPath = path.join(lockDir, "owner.json");

    let aEntered = false;
    // Process A creates the lock directory, then (via the onBeforeOwnerWrite
    // seam) is paused right before its owner write while a competing live
    // process B claims the ownerless directory with an exclusive owner file.
    const aPromise = withFileLock(
      target,
      async () => {
        aEntered = true;
      },
      { acquireTimeoutMs: 300, retryDelayMs: 5, staleLockMs: 60_000 },
      {
        processAlive: () => true,
        onBeforeOwnerWrite: async () => {
          try {
            await fs.mkdir(lockDir, { recursive: true });
            await fs.writeFile(
              ownerPath,
              JSON.stringify({ pid: 4242, createdAt: new Date().toISOString() }),
              { encoding: "utf-8", flag: "wx" },
            );
          } catch {
            // Already claimed on a later retry — leave B's owner intact.
          }
        },
      },
    );

    // A's exclusive owner write must fail against B's owner file, and because B
    // is alive A must time out instead of stealing or overwriting the lock —
    // never entering the critical section.
    await expect(aPromise).rejects.toThrow("Timed out acquiring file lock");
    expect(aEntered).toBe(false);
    const owner = JSON.parse(await fs.readFile(ownerPath, "utf-8"));
    expect(owner.pid).toBe(4242);
  });

  test("times out when a live process holds the lock", async () => {
    const target = await makeTempTarget();
    const lockDir = lockDirPathFor(target);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf-8",
    );

    await expect(
      withFileLock(target, async () => "never", {
        acquireTimeoutMs: 100,
        retryDelayMs: 10,
        staleLockMs: 60_000,
      }),
    ).rejects.toThrow("Timed out acquiring file lock");
  });
});
