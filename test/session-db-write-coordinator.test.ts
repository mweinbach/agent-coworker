import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionDb } from "../src/server/sessionDb";
import { SessionDbWriteCoordinator } from "../src/server/sessionDb/writeCoordinator";
import { withGlobalTestLock } from "./shared/processLock";

type TelemetryEvent = {
  name: string;
  status: "ok" | "error";
  attributes?: Record<string, string | number | boolean>;
  durationMs?: number;
};

async function makeTmpCoworkHome(prefix = "session-db-write-coordinator-test-"): Promise<{
  rootDir: string;
  sessionsDir: string;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return { rootDir, sessionsDir };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for condition");
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

describe("SessionDbWriteCoordinator", () => {
  test("writes owner metadata and removes the lock on release", async () => {
    const paths = await makeTmpCoworkHome();
    const coordinator = new SessionDbWriteCoordinator({ rootDir: paths.rootDir });
    const lockDir = path.join(paths.rootDir, "locks", "session-db-write.lock");
    const ownerFile = path.join(lockDir, "owner.json");

    const value = await coordinator.runExclusive("unit_lock", async () => {
      const owner = JSON.parse(await fs.readFile(ownerFile, "utf-8")) as {
        pid: number;
        startedAt: string;
        updatedAt: string;
      };
      expect(owner.pid).toBe(process.pid);
      expect(typeof owner.startedAt).toBe("string");
      expect(typeof owner.updatedAt).toBe("string");
      return "ok";
    });

    expect(value).toBe("ok");
    expect(await pathExists(lockDir)).toBe(false);
  });

  test("waits for an existing writer and records lock wait telemetry", async () => {
    const paths = await makeTmpCoworkHome();
    const telemetry: TelemetryEvent[] = [];
    let releaseFirstWriter!: () => void;
    const firstWriterReleased = new Promise<void>((resolve) => {
      releaseFirstWriter = resolve;
    });
    const first = new SessionDbWriteCoordinator({
      rootDir: paths.rootDir,
      retryDelayMs: 10,
      acquireTimeoutMs: 2_000,
      emitTelemetry: (name, status, attributes, durationMs) => {
        telemetry.push({ name, status, attributes, durationMs });
      },
    });
    const second = new SessionDbWriteCoordinator({
      rootDir: paths.rootDir,
      retryDelayMs: 10,
      acquireTimeoutMs: 2_000,
      emitTelemetry: (name, status, attributes, durationMs) => {
        telemetry.push({ name, status, attributes, durationMs });
      },
    });
    const lockDir = path.join(paths.rootDir, "locks", "session-db-write.lock");

    const firstPromise = first.runExclusive("first_writer", async () => {
      await firstWriterReleased;
    });
    await waitFor(() => pathExists(lockDir));

    let secondEntered = false;
    const secondPromise = second.runExclusive("second_writer", async () => {
      secondEntered = true;
      return "second-done";
    });

    await Bun.sleep(50);
    expect(secondEntered).toBe(false);

    releaseFirstWriter();
    await firstPromise;
    expect(await secondPromise).toBe("second-done");

    expect(telemetry).toContainEqual(expect.objectContaining({
      name: "session.db.write_lock_wait",
      status: "ok",
      attributes: expect.objectContaining({
        operation: "second_writer",
      }),
    }));
    const waitEvent = telemetry.find((event) =>
      event.name === "session.db.write_lock_wait"
      && event.status === "ok"
      && event.attributes?.operation === "second_writer",
    );
    expect(Number(waitEvent?.attributes?.waitedMs ?? 0)).toBeGreaterThan(0);
  });

  test("recovers stale lock owners and records stale recovery telemetry", async () => {
    const paths = await makeTmpCoworkHome();
    const telemetry: TelemetryEvent[] = [];
    const lockDir = path.join(paths.rootDir, "locks", "session-db-write.lock");
    const ownerFile = path.join(lockDir, "owner.json");
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(ownerFile, `${JSON.stringify({
      pid: 999_999,
      startedAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    }, null, 2)}\n`, "utf-8");

    const coordinator = new SessionDbWriteCoordinator({
      rootDir: paths.rootDir,
      staleLockMs: 1_000,
      processAlive: () => false,
      emitTelemetry: (name, status, attributes, durationMs) => {
        telemetry.push({ name, status, attributes, durationMs });
      },
    });

    const result = await coordinator.runExclusive("stale_recovery", async () => "recovered");
    expect(result).toBe("recovered");
    expect(telemetry).toContainEqual(expect.objectContaining({
      name: "session.db.write_lock_wait",
      status: "ok",
      attributes: expect.objectContaining({
        operation: "stale_recovery",
        staleRecoveries: 1,
      }),
    }));
  });

  test("times out cleanly when a live writer never releases the lock", async () => {
    const paths = await makeTmpCoworkHome();
    const telemetry: TelemetryEvent[] = [];
    const lockDir = path.join(paths.rootDir, "locks", "session-db-write.lock");
    const ownerFile = path.join(lockDir, "owner.json");
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(ownerFile, `${JSON.stringify({
      pid: 123,
      startedAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    }, null, 2)}\n`, "utf-8");

    let nowMs = 0;
    const coordinator = new SessionDbWriteCoordinator({
      rootDir: paths.rootDir,
      acquireTimeoutMs: 20,
      retryDelayMs: 5,
      staleLockMs: 1_000,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      processAlive: () => true,
      emitTelemetry: (name, status, attributes, durationMs) => {
        telemetry.push({ name, status, attributes, durationMs });
      },
    });

    await expect(
      coordinator.runExclusive("timeout_writer", async () => "never"),
    ).rejects.toThrow("Timed out acquiring session DB write lock");

    expect(telemetry).toContainEqual(expect.objectContaining({
      name: "session.db.write_lock_wait",
      status: "error",
      attributes: expect.objectContaining({
        operation: "timeout_writer",
      }),
    }));
  });

  test("release tolerates crash-like lock removal while the writer is active", async () => {
    const paths = await makeTmpCoworkHome();
    const coordinator = new SessionDbWriteCoordinator({ rootDir: paths.rootDir });
    const lockDir = path.join(paths.rootDir, "locks", "session-db-write.lock");

    await coordinator.runExclusive("crash_cleanup", async () => {
      await fs.rm(lockDir, { recursive: true, force: true });
    });

    expect(await pathExists(lockDir)).toBe(false);
  });
});

describe("session DB shared write integration", () => {
  test("three harness processes can share the same session database without sqlite lock failures", async () => {
    await withGlobalTestLock("subprocess-env", async () => {
      const paths = await makeTmpCoworkHome("session-db-integration-");
      const workerPath = path.join(repoRoot(), "test", "fixtures", "session-db-worker.ts");
      const sessionIds = ["worker-a", "worker-b", "worker-c"];
      const outputPaths = sessionIds.map((sessionId) => path.join(paths.rootDir, `${sessionId}.json`));

      const processes = sessionIds.map((sessionId, index) =>
        Bun.spawn({
          cmd: [
            process.execPath,
            workerPath,
            paths.rootDir,
            paths.sessionsDir,
            sessionId,
            String(sessionIds.length),
            outputPaths[index]!,
          ],
          cwd: repoRoot(),
          stdout: "ignore",
          stderr: "pipe",
        }),
      );

      const outputs = await Promise.all(processes.map(async (proc, index) => {
        const [exitCode, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stderr).text(),
        ]);
        const outputPath = outputPaths[index]!;
        const output = exitCode === 0
          ? (await fs.readFile(outputPath, "utf-8")).trim()
          : "";

        return {
          sessionId: sessionIds[index],
          exitCode,
          output,
          stderr: stderr.trim(),
        };
      }));

      for (const output of outputs) {
        expect(output.exitCode).toBe(0);
        expect(output.stderr).toBe("");
        const parsed = JSON.parse(output.output) as {
          sessionId: string;
          visibleSessionIds: string[];
          telemetry: TelemetryEvent[];
        };
        expect(parsed.sessionId).toBe(output.sessionId);
        expect(parsed.visibleSessionIds).toEqual(sessionIds);
        expect(parsed.telemetry.some((event) => event.name === "session.db.sqlite_lock")).toBe(false);
        expect(parsed.telemetry.some((event) => event.status === "error")).toBe(false);
      }

      const db = await SessionDb.create({ paths });
      try {
        const sessions = db.listSessions().map((session) => session.sessionId).sort();
        expect(sessions).toEqual(sessionIds);
        for (const sessionId of sessionIds) {
          const record = db.getSessionRecord(sessionId);
          expect(record?.sessionId).toBe(sessionId);
          expect(record?.messageCount).toBe(1);
          expect(record?.lastEventSeq).toBe(4);
        }
      } finally {
        db.close();
      }
    });
  }, 20_000);
});
