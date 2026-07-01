import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionDbWriteCoordinator } from "../../src/server/sessionDb/writeCoordinator";

// Chaos scenario 7: the session DB write lock is contended. A competing writer
// must wait, and if it cannot acquire within its budget it must fail cleanly and
// record the wait/timeout so the health endpoint can surface db.lockWaitMs.
// Contention is driven with a fake clock so no real time elapses.

async function makeTmpRootDir(prefix = "db-lock-chaos-"): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(home, ".cowork");
  await fs.mkdir(rootDir, { recursive: true });
  return rootDir;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for condition");
}

/** Mirror of the db projection in ServerRuntime.getHealthSnapshot(). */
function projectDbHealth(diagnostics: { maxWaitMs: number }, ok: boolean): {
  ok: boolean;
  lockWaitMs?: number;
} {
  return {
    ok,
    ...(diagnostics.maxWaitMs > 0 ? { lockWaitMs: diagnostics.maxWaitMs } : {}),
  };
}

describe("chaos: session DB write-lock contention", () => {
  test("scenario 7: a contended writer times out cleanly and records the wait", async () => {
    const rootDir = await makeTmpRootDir();
    const lockDir = path.join(rootDir, "locks", "session-db-write.lock");

    // First writer holds the lock for the duration of the test (real clock).
    const holder = new SessionDbWriteCoordinator({ rootDir });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holderPromise = holder.runExclusive("holder", async () => {
      await held;
    });
    await waitFor(() => pathExists(lockDir));

    // Contender uses a fake clock so its acquire budget is exhausted instantly.
    let nowMs = 1_000_000;
    const contender = new SessionDbWriteCoordinator({
      rootDir,
      retryDelayMs: 50,
      acquireTimeoutMs: 100,
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    });

    await expect(
      contender.runExclusive("contender", async () => "unreachable"),
    ).rejects.toThrow(/Timed out acquiring session DB write lock/);

    const diagnostics = contender.getDiagnostics();
    expect(diagnostics.timeoutCount).toBe(1);
    expect(diagnostics.waitCount).toBeGreaterThanOrEqual(1);
    expect(diagnostics.maxWaitMs).toBeGreaterThanOrEqual(100);

    // The health endpoint surfaces the wait via db.lockWaitMs.
    expect(projectDbHealth(diagnostics, true)).toEqual({ ok: true, lockWaitMs: diagnostics.maxWaitMs });

    release();
    await holderPromise;
  });

  test("classifies SQLite 'database is locked' failures without masking the error", async () => {
    const rootDir = await makeTmpRootDir();
    const coordinator = new SessionDbWriteCoordinator({ rootDir });

    await expect(
      coordinator.runExclusive("write", async () => {
        throw new Error("database is locked while committing");
      }),
    ).rejects.toThrow(/database is locked/);

    expect(coordinator.getDiagnostics().sqliteLockErrorCount).toBe(1);
  });

  test("a pristine coordinator has no lock wait, so health omits lockWaitMs", async () => {
    const rootDir = await makeTmpRootDir();
    const coordinator = new SessionDbWriteCoordinator({ rootDir });

    // Before any acquire, every counter is zero and health omits lockWaitMs.
    const pristine = coordinator.getDiagnostics();
    expect(pristine.maxWaitMs).toBe(0);
    expect(pristine.timeoutCount).toBe(0);
    expect(pristine.sqliteLockErrorCount).toBe(0);
    expect(projectDbHealth(pristine, true)).toEqual({ ok: true });

    // A successful uncontended write stays healthy: no timeouts, no lock errors.
    // (maxWaitMs may pick up a sub-millisecond acquire cost, which is not
    // contention — so we assert on the failure counters, not the wait timer.)
    const value = await coordinator.runExclusive("write", async () => "ok");
    expect(value).toBe("ok");
    const afterWrite = coordinator.getDiagnostics();
    expect(afterWrite.timeoutCount).toBe(0);
    expect(afterWrite.sqliteLockErrorCount).toBe(0);
  });
});
