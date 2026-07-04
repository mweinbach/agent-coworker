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

  test("takes over a lock whose owner metadata is expired", async () => {
    const target = await makeTempTarget();
    const lockDir = lockDirPathFor(target);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 60_000).toISOString() }),
      "utf-8",
    );

    const result = await withFileLock(target, async () => "ran", { staleLockMs: 1_000 });
    expect(result).toBe("ran");
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
