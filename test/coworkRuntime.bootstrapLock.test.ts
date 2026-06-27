import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withCoworkRuntimeBootstrapLock } from "../src/coworkRuntime/bootstrapLock";

async function temporaryHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-bootstrap-lock-"));
}

describe("Cowork runtime bootstrap lock", () => {
  test("serializes bootstrap work sharing one home", async () => {
    const home = await temporaryHome();
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;

    const run = async (wait: boolean) =>
      await withCoworkRuntimeBootstrapLock(
        { home, version: "2026-06-22", retryDelayMs: 5, heartbeatMs: 5 },
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (wait) await firstCanFinish;
          active -= 1;
        },
      );

    const first = run(true);
    const lockDir = path.join(home, ".cowork", "runtime", ".bootstrap.lock");
    while (!(await fs.stat(lockDir).catch(() => null))) await Bun.sleep(5);
    const second = run(false);
    await Bun.sleep(25);
    expect(maxActive).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    await expect(fs.stat(lockDir)).rejects.toThrow();
  });

  test("recovers a lock owned by a dead process", async () => {
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

    const result = await withCoworkRuntimeBootstrapLock(
      {
        home,
        version: "2026-06-22",
        retryDelayMs: 5,
        processAlive: () => false,
      },
      async () => "recovered",
    );

    expect(result).toBe("recovered");
    await expect(fs.stat(lockDir)).rejects.toThrow();
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
    const worker = path.join(import.meta.dir, "fixtures", "runtime-bootstrap-lock-worker.ts");
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
