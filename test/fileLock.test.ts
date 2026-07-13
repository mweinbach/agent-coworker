import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hostPlatform } from "../src/platform/host";
import { lockDatabasePathFor, withFileLock } from "../src/utils/fileLock";
import { symlinkOrJunction } from "./helpers/platform";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const tempDirs: string[] = [];
const childProcesses: Array<ReturnType<typeof Bun.spawn>> = [];

async function makeTempTarget(): Promise<{
  dir: string;
  lockRoot: string;
  target: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-"));
  tempDirs.push(dir);
  return {
    dir,
    lockRoot: path.join(dir, "lock-cache"),
    target: path.join(dir, "store.json"),
  };
}

async function spawnLockHolder(input: {
  dir: string;
  lockRoot: string;
  target: string;
}): Promise<ReturnType<typeof Bun.spawn>> {
  const scriptPath = path.join(input.dir, "lock-holder.ts");
  const readyPath = path.join(input.dir, "holder-ready");
  await fs.writeFile(
    scriptPath,
    [
      'import fs from "node:fs/promises";',
      `import { withFileLock } from ${JSON.stringify(path.join(REPO_ROOT, "src/utils/fileLock.ts"))};`,
      "const [target, lockRoot, readyPath] = process.argv.slice(2);",
      "if (!target || !lockRoot || !readyPath) throw new Error('missing lock-holder argument');",
      "await withFileLock(target, async () => {",
      '  await fs.writeFile(readyPath, "ready");',
      "  await new Promise(() => {});",
      "}, { lockRoot });",
    ].join("\n"),
    "utf-8",
  );

  const child = Bun.spawn({
    cmd: [process.execPath, "run", scriptPath, input.target, input.lockRoot, readyPath],
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });
  childProcesses.push(child);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await fs.stat(readyPath).catch(() => null)) return child;
    const exitCode = await Promise.race([child.exited, Bun.sleep(10).then(() => null)]);
    if (exitCode !== null) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`lock holder exited ${exitCode} before acquiring the lock: ${stderr}`);
    }
  }
  throw new Error("lock holder did not acquire the lock within 2 seconds");
}

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    child.kill();
    await child.exited.catch(() => {});
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("withFileLock", () => {
  test("serializes concurrent critical sections in one process", async () => {
    const { lockRoot, target } = await makeTempTarget();
    let inside = 0;
    let maxInside = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        withFileLock(
          target,
          async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            await Bun.sleep(5);
            order.push(index);
            inside -= 1;
          },
          { lockRoot },
        ),
      ),
    );

    expect(maxInside).toBe(1);
    expect(order).toHaveLength(8);
  });

  test("uses independent transaction locks for different targets", async () => {
    const { dir, lockRoot, target } = await makeTempTarget();
    const secondTarget = path.join(dir, "second.json");
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondEntered = false;

    const first = withFileLock(target, async () => firstCanFinish, { lockRoot });
    const second = withFileLock(
      secondTarget,
      async () => {
        secondEntered = true;
      },
      { lockRoot },
    );
    await second;
    expect(secondEntered).toBe(true);
    releaseFirst();
    await first;
  });

  test("canonical aliases share one lock database", async () => {
    const { dir, lockRoot } = await makeTempTarget();
    const coworkRoot = path.join(dir, ".cowork");
    const configDir = path.join(coworkRoot, "config");
    const aliasRoot = path.join(dir, "cowork-alias");
    const directTarget = path.join(configDir, "store.json");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(directTarget, "{}\n", "utf-8");
    await symlinkOrJunction(coworkRoot, aliasRoot, { type: "dir" });
    const aliasTarget = path.join(aliasRoot, "config", "store.json");

    expect(lockDatabasePathFor(aliasTarget, lockRoot)).toBe(
      lockDatabasePathFor(directTarget, lockRoot),
    );

    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let aliasEntered = false;
    const first = withFileLock(
      directTarget,
      async () => {
        firstEntered();
        await firstCanFinish;
      },
      { lockRoot },
    );
    await firstDidEnter;
    const alias = withFileLock(
      aliasTarget,
      async () => {
        aliasEntered = true;
      },
      { lockRoot },
    );

    await Bun.sleep(50);
    expect(aliasEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, alias]);
    expect(aliasEntered).toBe(true);
  });

  test("Windows casing variants share one lock database", async () => {
    if (hostPlatform() !== "win32") return;
    const { dir, lockRoot } = await makeTempTarget();
    const configDir = path.join(dir, ".cowork", "config");
    const directTarget = path.join(configDir, "store.json");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(directTarget, "{}\n", "utf-8");
    const caseVariant = directTarget.replace(
      `${path.sep}.cowork${path.sep}`,
      `${path.sep}.COWORK${path.sep}`,
    );

    expect(lockDatabasePathFor(caseVariant, lockRoot)).toBe(
      lockDatabasePathFor(directTarget, lockRoot),
    );
  });

  test("canonical lock-root aliases cannot split coordination", async () => {
    const { dir, target } = await makeTempTarget();
    const directLockRoot = path.join(dir, "direct-lock-cache");
    const aliasLockRoot = path.join(dir, "lock-cache-alias");
    await fs.mkdir(directLockRoot, { recursive: true });
    await symlinkOrJunction(directLockRoot, aliasLockRoot, { type: "dir" });

    expect(lockDatabasePathFor(target, aliasLockRoot)).toBe(
      lockDatabasePathFor(target, directLockRoot),
    );
  });

  test("keeps one lexical alias serialized while its target is swapped", async () => {
    const { dir, lockRoot } = await makeTempTarget();
    const firstRoot = path.join(dir, "first-root");
    const secondRoot = path.join(dir, "second-root");
    const aliasRoot = path.join(dir, "mutable-alias");
    await Promise.all([
      fs.mkdir(firstRoot, { recursive: true }),
      fs.mkdir(secondRoot, { recursive: true }),
    ]);
    await symlinkOrJunction(firstRoot, aliasRoot, { type: "dir" });
    const aliasTarget = path.join(aliasRoot, "store.json");

    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let secondEntered = false;
    const first = withFileLock(
      aliasTarget,
      async () => {
        firstEntered();
        await firstCanFinish;
      },
      { lockRoot },
    );
    await firstDidEnter;

    await fs.rm(aliasRoot, { recursive: true, force: true });
    await symlinkOrJunction(secondRoot, aliasRoot, { type: "dir" });
    const second = withFileLock(
      aliasTarget,
      async () => {
        secondEntered = true;
      },
      { lockRoot },
    );

    try {
      await Bun.sleep(50);
      expect(secondEntered).toBe(false);
    } finally {
      releaseFirst();
      await first;
    }
    await second;
    expect(secondEntered).toBe(true);
  });

  test("keeps the lock database in the private cache and reuses it", async () => {
    const { lockRoot, target } = await makeTempTarget();
    const lockPath = lockDatabasePathFor(target, lockRoot);

    await withFileLock(target, async () => undefined, { lockRoot });
    const stat = await fs.stat(lockPath);
    expect(stat.isFile()).toBe(true);
    expect(path.dirname(lockPath)).toBe(lockRoot);

    await expect(withFileLock(target, async () => "reacquired", { lockRoot })).resolves.toBe(
      "reacquired",
    );
  });

  test("releases the transaction after the callback throws", async () => {
    const { lockRoot, target } = await makeTempTarget();

    await expect(
      withFileLock(
        target,
        async () => {
          throw new Error("boom");
        },
        { lockRoot },
      ),
    ).rejects.toThrow("boom");

    await expect(withFileLock(target, async () => "recovered", { lockRoot })).resolves.toBe(
      "recovered",
    );
  });

  test("times out behind a live process and recovers immediately after that process exits", async () => {
    const input = await makeTempTarget();
    const child = await spawnLockHolder(input);

    await expect(
      withFileLock(input.target, async () => "never", {
        acquireTimeoutMs: 100,
        lockRoot: input.lockRoot,
        retryDelayMs: 5,
      }),
    ).rejects.toThrow("Timed out acquiring file lock");

    child.kill();
    await child.exited;
    childProcesses.splice(childProcesses.indexOf(child), 1);

    await expect(
      withFileLock(input.target, async () => "recovered", {
        acquireTimeoutMs: 1_000,
        lockRoot: input.lockRoot,
        retryDelayMs: 5,
      }),
    ).resolves.toBe("recovered");
  }, 10_000);

  test("the acquisition deadline includes the in-process queue", async () => {
    const { lockRoot, target } = await makeTempTarget();
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let queuedCallbackRan = false;
    const first = withFileLock(
      target,
      async () => {
        firstEntered();
        await firstCanFinish;
      },
      { lockRoot },
    );
    await firstDidEnter;

    const queued = withFileLock(
      target,
      async () => {
        queuedCallbackRan = true;
      },
      { acquireTimeoutMs: 50, lockRoot },
    );
    try {
      await expect(queued).rejects.toThrow("Timed out acquiring file lock");
      expect(queuedCallbackRan).toBe(false);
    } finally {
      releaseFirst();
      await first;
    }
    await Bun.sleep(20);
    expect(queuedCallbackRan).toBe(false);
  });

  test("clamps retry sleeps to the remaining acquisition budget", async () => {
    const { lockRoot, target } = await makeTempTarget();
    let now = 0;
    const delays: number[] = [];

    await expect(
      withFileLock(
        target,
        async () => "never",
        { acquireTimeoutMs: 50, lockRoot, retryDelayMs: 1_000 },
        {
          now: () => now,
          sleep: async (delayMs) => {
            delays.push(delayMs);
            now += delayMs;
          },
          openDatabase: () => ({
            close: () => undefined,
            exec: (sql) => {
              if (sql === "BEGIN IMMEDIATE") {
                throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
              }
            },
          }),
        },
      ),
    ).rejects.toThrow("Timed out acquiring file lock");
    expect(delays).toEqual([50]);
  });

  test("a rollback error still closes the connection and cannot wedge later callers", async () => {
    const { lockRoot, target } = await makeTempTarget();
    let injectRollbackError = true;

    await expect(
      withFileLock(
        target,
        async () => undefined,
        { lockRoot },
        {
          openDatabase: (filePath) => {
            const database = new Database(filePath, { create: true, strict: false });
            database.exec("PRAGMA busy_timeout = 0");
            return {
              close: (throwOnError) => database.close(throwOnError),
              exec: (sql) => {
                if (sql === "ROLLBACK" && injectRollbackError) {
                  injectRollbackError = false;
                  throw new Error("simulated rollback failure");
                }
                database.exec(sql);
              },
            };
          },
        },
      ),
    ).rejects.toThrow("simulated rollback failure");

    await expect(withFileLock(target, async () => "recovered", { lockRoot })).resolves.toBe(
      "recovered",
    );
  });
});
