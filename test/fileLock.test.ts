import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { which } from "../src/platform/exec";
import { hostPlatform } from "../src/platform/host";
import { canonicalizeSync } from "../src/platform/paths";
import { lockDatabasePathFor, withFileLock } from "../src/utils/fileLock";
import { symlinkOrJunction } from "./helpers/platform";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const tempDirs: string[] = [];
const childProcesses: Array<ReturnType<typeof Bun.spawn>> = [];
const electronRelativePath = await fs
  .readFile(path.join(REPO_ROOT, "node_modules/electron/path.txt"), "utf-8")
  .then((value) => value.trim())
  .catch(() => null);
const electronPath = electronRelativePath
  ? path.join(REPO_ROOT, "node_modules/electron/dist", electronRelativePath)
  : null;
const externalRuntimes = [
  { name: "Node", executable: which("node") },
  {
    name: "Electron",
    executable:
      electronPath && (await fs.stat(electronPath).catch(() => null)) ? electronPath : null,
  },
];

async function buildNodeLockModule(dir: string): Promise<string> {
  const bundle = await Bun.build({
    entrypoints: [path.join(REPO_ROOT, "src/utils/fileLock.ts")],
    outdir: dir,
    naming: "file-lock.mjs",
    target: "node",
    format: "esm",
    external: ["bun:sqlite", "node:sqlite"],
  });
  if (!bundle.success || !bundle.outputs[0]) {
    throw new Error(`Could not bundle the Node lock module: ${bundle.logs.join("\n")}`);
  }
  return bundle.outputs[0].path;
}

async function runExternalLockScript(
  executable: string,
  script: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [executable, "--input-type=module", "--eval", script],
    cwd: REPO_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  childProcesses.push(child);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

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

async function spawnLockHolder(
  input: { dir: string; lockRoot: string; target: string },
  externalExecutable?: string,
): Promise<ReturnType<typeof Bun.spawn>> {
  const scriptPath = path.join(
    input.dir,
    externalExecutable ? "lock-holder.mjs" : "lock-holder.ts",
  );
  const modulePath = externalExecutable
    ? pathToFileURL(await buildNodeLockModule(input.dir)).href
    : path.join(REPO_ROOT, "src/utils/fileLock.ts");
  const readyPath = path.join(input.dir, "holder-ready");
  await fs.writeFile(
    scriptPath,
    [
      'import fs from "node:fs/promises";',
      `import { withFileLock } from ${JSON.stringify(modulePath)};`,
      "const [target, lockRoot, readyPath] = process.argv.slice(2);",
      "if (!target || !lockRoot || !readyPath) throw new Error('missing lock-holder argument');",
      // Node needs an active handle while the deliberately unresolved callback
      // holds the lock. The timer also bounds orphaned test children.
      "const failSafe = setTimeout(() => process.exit(124), 10_000);",
      "try {",
      "await withFileLock(target, async () => {",
      // The parent uses existence as readiness, so publish only complete JSON.
      "  const pendingReadyPath = readyPath + '.pending';",
      "  await fs.writeFile(pendingReadyPath, JSON.stringify({ bun: typeof Bun, node: process.versions.node, electron: process.versions.electron ?? null }));",
      "  await fs.rename(pendingReadyPath, readyPath);",
      "  await new Promise(() => {});",
      "}, { lockRoot });",
      "} finally { clearTimeout(failSafe); }",
    ].join("\n"),
    "utf-8",
  );

  const child = Bun.spawn({
    cmd: [
      ...(externalExecutable ? [externalExecutable] : [process.execPath, "run"]),
      scriptPath,
      input.target,
      input.lockRoot,
      readyPath,
    ],
    cwd: REPO_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
    child.kill("SIGKILL");
    await child.exited.catch(() => {});
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("withFileLock", () => {
  for (const runtime of externalRuntimes) {
    test.skipIf(!runtime.executable)(
      `${runtime.name} imports the bundled lock module without a Bun global (requires installed runtime)`,
      async () => {
        if (!runtime.executable) throw new Error(`${runtime.name} is not installed`);
        const { dir, lockRoot, target } = await makeTempTarget();
        const modulePath = await buildNodeLockModule(dir);
        const result = await runExternalLockScript(
          runtime.executable,
          [
            `import { withFileLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
            "if (typeof Bun !== 'undefined' || process.versions.bun) throw new Error('unexpected Bun runtime');",
            `const value = await withFileLock(${JSON.stringify(target)}, async () => "acquired", { lockRoot: ${JSON.stringify(lockRoot)} });`,
            "console.log(JSON.stringify({ value, bun: typeof Bun, node: process.versions.node, electron: process.versions.electron ?? null }));",
          ].join("\n"),
        );
        expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({ exitCode: 0 });
        const evidence = JSON.parse(result.stdout);
        expect(evidence).toMatchObject({ value: "acquired", bun: "undefined" });
        expect(evidence.node).toBeString();
        if (runtime.name === "Electron") expect(evidence.electron).toBeString();
        else expect(evidence.electron).toBeNull();
      },
      10_000,
    );

    test.skipIf(!runtime.executable)(
      `${runtime.name} holds the same SQLite lock against Bun until process exit (requires installed runtime)`,
      async () => {
        if (!runtime.executable) throw new Error(`${runtime.name} is not installed`);
        const input = await makeTempTarget();
        const child = await spawnLockHolder(input, runtime.executable);
        const evidence = JSON.parse(
          await fs.readFile(path.join(input.dir, "holder-ready"), "utf-8"),
        );
        expect(evidence.bun).toBe("undefined");
        expect(evidence.node).toBeString();
        if (runtime.name === "Electron") expect(evidence.electron).toBeString();

        await expect(
          withFileLock(input.target, async () => "must not enter", {
            acquireTimeoutMs: 100,
            lockRoot: input.lockRoot,
            retryDelayMs: 5,
          }),
        ).rejects.toThrow("Timed out acquiring file lock");

        child.kill("SIGKILL");
        await child.exited;
        childProcesses.splice(childProcesses.indexOf(child), 1);
        await expect(
          withFileLock(input.target, async () => "recovered", {
            acquireTimeoutMs: 1_000,
            lockRoot: input.lockRoot,
            retryDelayMs: 5,
          }),
        ).resolves.toBe("recovered");
      },
      10_000,
    );

    test.skipIf(!runtime.executable)(
      `Bun holds the same SQLite lock against ${runtime.name}, which recovers after exit (requires installed runtime)`,
      async () => {
        if (!runtime.executable) throw new Error(`${runtime.name} is not installed`);
        const input = await makeTempTarget();
        const child = await spawnLockHolder(input);
        const modulePath = await buildNodeLockModule(input.dir);
        const script = [
          `import { withFileLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
          "if (typeof Bun !== 'undefined' || process.versions.bun) throw new Error('unexpected Bun runtime');",
          "let value;",
          "try {",
          `  value = await withFileLock(${JSON.stringify(input.target)}, async () => "acquired", { lockRoot: ${JSON.stringify(input.lockRoot)}, acquireTimeoutMs: 100, retryDelayMs: 5 });`,
          "} catch (error) { value = error instanceof Error ? error.message : String(error); }",
          "console.log(JSON.stringify({ value, bun: typeof Bun, node: process.versions.node, electron: process.versions.electron ?? null }));",
        ].join("\n");

        const blocked = await runExternalLockScript(runtime.executable, script);
        expect({ exitCode: blocked.exitCode, stderr: blocked.stderr }).toMatchObject({
          exitCode: 0,
        });
        const evidence = JSON.parse(blocked.stdout);
        expect(evidence.value).toStartWith("Timed out acquiring file lock");
        expect(evidence.bun).toBe("undefined");
        if (runtime.name === "Electron") expect(evidence.electron).toBeString();

        child.kill("SIGKILL");
        await child.exited;
        childProcesses.splice(childProcesses.indexOf(child), 1);
        const recovered = await runExternalLockScript(runtime.executable, script);
        expect({ exitCode: recovered.exitCode, stderr: recovered.stderr }).toMatchObject({
          exitCode: 0,
        });
        expect(JSON.parse(recovered.stdout)).toMatchObject({ value: "acquired", bun: "undefined" });
      },
      10_000,
    );
  }

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
    expect(path.dirname(lockPath)).toBe(canonicalizeSync(lockRoot));

    await expect(withFileLock(target, async () => "reacquired", { lockRoot })).resolves.toBe(
      "reacquired",
    );
  });

  test("shares transaction locks with native Bun SQLite and recovers after rollback", async () => {
    const { lockRoot, target } = await makeTempTarget();
    const lockPath = lockDatabasePathFor(target, lockRoot);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const database = new Database(lockPath, { create: true, strict: false });
    try {
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN IMMEDIATE");
      await expect(
        withFileLock(target, async () => "must not enter", {
          acquireTimeoutMs: 100,
          lockRoot,
          retryDelayMs: 5,
        }),
      ).rejects.toThrow("Timed out acquiring file lock");

      database.exec("ROLLBACK");
      // Keep the native connection open: rollback alone must release the lock.
      await expect(
        withFileLock(target, async () => "recovered", {
          acquireTimeoutMs: 1_000,
          lockRoot,
          retryDelayMs: 5,
        }),
      ).resolves.toBe("recovered");
    } finally {
      database.close(true);
    }
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
