import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type RuntimeBootstrapLock,
  withCoworkRuntimeBootstrapLock,
} from "../src/coworkRuntime/bootstrapLock";
import { hostPlatform } from "../src/platform/host";

const homes: string[] = [];
const worker = path.join(import.meta.dir, "fixtures", "runtime-bootstrap-lock-worker.ts");

async function temporaryHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-bootstrap-lock-"));
  homes.push(home);
  return home;
}

async function expectWorkerLocked(child: { stdout: ReadableStream<Uint8Array> }): Promise<void> {
  const reader = child.stdout.getReader();
  try {
    const message = await reader.read();
    expect(new TextDecoder().decode(message.value)).toContain("locked");
  } finally {
    reader.releaseLock();
  }
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("Cowork runtime bootstrap lock", () => {
  test("new-first blocks the legacy age reclaimer for the complete callback", async () => {
    const home = await temporaryHome();
    const lockDir = path.join(home, ".cowork", "runtime", ".bootstrap.lock");
    await withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22" }, async () => {
      const ownerText = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
      const owner = JSON.parse(ownerText);
      expect(owner.pid).toBe(process.pid);
      expect(Number.isNaN(Date.parse(owner.updatedAt))).toBe(true);
      expect(await fs.readdir(lockDir)).toEqual(["owner.json"]);
      // A legacy contender uses a 1ms stale threshold. Neither an old directory
      // mtime nor the absence of a heartbeat may let it steal a live new owner.
      await fs.utimes(lockDir, new Date(0), new Date(0));
      const legacy = Bun.spawn({
        cmd: [process.execPath, worker, home, "legacy-attempt"],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await legacy.exited).not.toBe(0);
      expect(await new Response(legacy.stderr).text()).toContain("Legacy lock timed out");
      expect(await fs.readFile(path.join(lockDir, "owner.json"), "utf8")).toBe(ownerText);
    });
    await expect(fs.lstat(lockDir)).rejects.toThrow();
    const legacy = Bun.spawn({
      cmd: [process.execPath, worker, home, "legacy-attempt"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await legacy.exited).toBe(0);
  });

  test("legacy-first refuses a live legacy owner without changing its files", async () => {
    const home = await temporaryHome();
    const legacy = Bun.spawn({
      cmd: [process.execPath, worker, home, "legacy-hold"],
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await expectWorkerLocked(legacy);
      const marker = path.join(home, ".cowork", "runtime", ".bootstrap.lock", "owner.json");
      const before = await fs.readFile(marker, "utf8");
      await expect(
        withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22" }, async () => {
          throw new Error("Must not enter a live legacy owner's critical section");
        }),
      ).rejects.toThrow(/legacy.*lock/i);
      expect(await fs.readFile(marker, "utf8")).toBe(before);
    } finally {
      legacy.kill("SIGKILL");
      await legacy.exited;
    }
  });

  test("times out instead of stealing a live owner after its legacy heartbeat ages", async () => {
    const home = await temporaryHome();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const owner = withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22" }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let enteredWaiter = false;
    try {
      // Reproduce a suspended owner's stale heartbeat if the obsolete protocol
      // is reintroduced. SQLite has no heartbeat file and retains OS ownership.
      const stale = new Date(0);
      await fs
        .utimes(path.join(home, ".cowork", "runtime", ".bootstrap.lock", "heartbeat"), stale, stale)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      await expect(
        withCoworkRuntimeBootstrapLock(
          { home, version: "2026-06-22", retryDelayMs: 5, acquireTimeoutMs: 50 },
          async () => {
            enteredWaiter = true;
          },
        ),
      ).rejects.toThrow(/timed out/i);
      expect(enteredWaiter).toBe(false);
    } finally {
      release.resolve();
      await owner;
    }
  });

  test("serializes bootstrap work sharing one home", async () => {
    const home = await temporaryHome();
    const entered = Promise.withResolvers<void>();
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;

    const run = async (wait: boolean) =>
      await withCoworkRuntimeBootstrapLock(
        { home, version: "2026-06-22", retryDelayMs: 5 },
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (wait) {
            entered.resolve();
            await firstCanFinish;
          }
          active -= 1;
        },
      );

    const first = run(true);
    await entered.promise;
    const second = run(false);
    try {
      await Bun.sleep(25);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst();
      await Promise.all([first, second]);
    }
    expect(maxActive).toBe(1);
  });

  test("refuses legacy locks without deleting their contents", async () => {
    const home = await temporaryHome();
    const lockDir = path.join(home, ".cowork", "runtime", ".bootstrap.lock");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        pid: 999_999,
        token: "dead-owner",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })}\n`,
    );

    await expect(
      withCoworkRuntimeBootstrapLock(
        {
          home,
          version: "2026-06-22",
          retryDelayMs: 5,
        },
        async () => {
          throw new Error("Must not enter a legacy owner's critical section");
        },
      ),
    ).rejects.toThrow(/legacy.*lock/i);
    expect(JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8")).token).toBe(
      "dead-owner",
    );
  });

  test("adopts a recognized abandoned barrier in place, even when its pid is alive", async () => {
    const home = await temporaryHome();
    const lockDir = path.join(home, ".cowork", "runtime", ".bootstrap.lock");
    const marker = path.join(lockDir, "owner.json");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      marker,
      JSON.stringify({
        protocol: "cowork-runtime-sqlite-v1",
        pid: process.pid,
        token: "abandoned",
        startedAt: new Date().toISOString(),
        updatedAt: "sqlite-transaction-owned",
      }),
    );
    const before = await fs.stat(lockDir);
    const markerBefore = await fs.stat(marker);
    await withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22" }, async () => {
      expect((await fs.stat(lockDir)).ino).toBe(before.ino);
      expect((await fs.stat(marker)).ino).toBe(markerBefore.ino);
      expect(JSON.parse(await fs.readFile(marker, "utf8")).token).not.toBe("abandoned");
    });
    await expect(fs.lstat(lockDir)).rejects.toThrow();
  });

  test.each(["empty", "invalid-marker", "foreign-entry"])(
    "preserves an unrecognized %s barrier rather than reclaiming it",
    async (kind) => {
      const home = await temporaryHome();
      const lockDir = path.join(home, ".cowork", "runtime", ".bootstrap.lock");
      await fs.mkdir(lockDir, { recursive: true });
      if (kind !== "empty") {
        await fs.writeFile(
          path.join(lockDir, "owner.json"),
          kind === "invalid-marker"
            ? "{"
            : JSON.stringify({
                protocol: "cowork-runtime-sqlite-v1",
                pid: process.pid,
                token: "foreign",
                startedAt: new Date().toISOString(),
                updatedAt: "sqlite-transaction-owned",
              }),
        );
      }
      if (kind === "foreign-entry") await fs.writeFile(path.join(lockDir, "heartbeat"), "");
      const before = await fs.readdir(lockDir);
      await expect(
        withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22" }, async () => "unsafe"),
      ).rejects.toThrow(/legacy.*lock/i);
      expect(await fs.readdir(lockDir)).toEqual(before);
    },
  );

  test("never cleans up a replacement directory after callback ownership is lost", async () => {
    const home = await temporaryHome();
    const lockDir = path.join(home, ".cowork", "runtime", ".bootstrap.lock");
    await expect(
      withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22" }, async () => {
        await fs.rename(lockDir, `${lockDir}.saved`);
        await fs.mkdir(lockDir);
        await fs.writeFile(path.join(lockDir, "owner.json"), "foreign owner");
      }),
    ).rejects.toThrow(/legacy.*lock/i);
    expect(await fs.readFile(path.join(lockDir, "owner.json"), "utf8")).toBe("foreign owner");
  });

  test.skipIf(hostPlatform() === "win32")(
    "a paused live process retains both SQLite and legacy-visible ownership",
    async () => {
      const home = await temporaryHome();
      const owner = Bun.spawn({
        cmd: [process.execPath, worker, home, "hold"],
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        await expectWorkerLocked(owner);
        owner.kill("SIGSTOP");
        await expect(
          withCoworkRuntimeBootstrapLock(
            { home, version: "2026-06-22", acquireTimeoutMs: 50, retryDelayMs: 5 },
            async () => "unsafe",
          ),
        ).rejects.toThrow(/timed out/i);
        const legacy = Bun.spawn({
          cmd: [process.execPath, worker, home, "legacy-attempt"],
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await legacy.exited).not.toBe(0);
        expect(await new Response(legacy.stderr).text()).toContain("Legacy lock timed out");
      } finally {
        owner.kill("SIGKILL");
        await owner.exited;
      }
    },
  );

  test("rejects expired and cross-home lifecycle capabilities", async () => {
    const home = await temporaryHome();
    const otherHome = await temporaryHome();
    let releasedLock!: RuntimeBootstrapLock;
    await withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22" }, async (lock) => {
      releasedLock = lock;
      expect(
        await withCoworkRuntimeBootstrapLock(
          { home, version: "2026-06-22", lock },
          async () => "nested",
        ),
      ).toBe("nested");
      await expect(
        withCoworkRuntimeBootstrapLock(
          { home: otherHome, version: "2026-06-22", lock },
          async () => "wrong home",
        ),
      ).rejects.toThrow(/another home/);
    });
    await expect(
      withCoworkRuntimeBootstrapLock(
        { home, version: "2026-06-22", lock: releasedLock },
        async () => "expired",
      ),
    ).rejects.toThrow(/expired/);
  });

  test("recovers after owner death and serializes concurrent recovering processes", async () => {
    const home = await temporaryHome();
    const owner = Bun.spawn({
      cmd: [process.execPath, worker, home, "hold"],
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = owner.stdout.getReader();
      try {
        const message = await reader.read();
        expect(new TextDecoder().decode(message.value)).toContain("locked");
      } finally {
        reader.releaseLock();
      }
      await expect(
        withCoworkRuntimeBootstrapLock(
          { home, version: "2026-06-22", acquireTimeoutMs: 50, retryDelayMs: 5 },
          async () => {
            throw new Error("Live child still owns the lock");
          },
        ),
      ).rejects.toThrow(/timed out/i);
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
    }
    const abandoned = JSON.parse(
      await fs.readFile(
        path.join(home, ".cowork", "runtime", ".bootstrap.lock", "owner.json"),
        "utf8",
      ),
    );
    expect(abandoned.protocol).toBe("cowork-runtime-sqlite-v1");
    expect(abandoned.pid).toBe(owner.pid);
    const contenders = ["a", "b", "c"].map((id) =>
      Bun.spawn({
        cmd: [process.execPath, worker, home, id],
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    expect(
      await Promise.all(
        contenders.map(async (child) => ({
          exitCode: await child.exited,
          stderr: await new Response(child.stderr).text(),
        })),
      ),
    ).toEqual(Array.from({ length: 3 }, () => ({ exitCode: 0, stderr: "" })));
  });

  test("does not retry callback errors that happen to use EEXIST", async () => {
    const home = await temporaryHome();
    let attempts = 0;
    const error = Object.assign(new Error("callback conflict"), { code: "EEXIST" });

    await expect(
      withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22" }, async () => {
        attempts += 1;
        throw error;
      }),
    ).rejects.toBe(error);

    expect(attempts).toBe(1);
  });

  test("serializes bootstrap work across processes", async () => {
    const home = await temporaryHome();
    const processes = ["a", "b", "c"].map((id) =>
      Bun.spawn({
        cmd: [process.execPath, worker, home, id],
        stdout: "ignore",
        stderr: "pipe",
      }),
    );

    const results = await Promise.all(
      processes.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    );

    expect(results).toEqual([
      { exitCode: 0, stderr: "" },
      { exitCode: 0, stderr: "" },
      { exitCode: 0, stderr: "" },
    ]);
  });
});
