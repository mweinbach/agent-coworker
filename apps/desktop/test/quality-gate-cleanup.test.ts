import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { hostPlatform } from "../../../src/platform/host";
import { scratchRoots } from "../../../src/platform/sandbox/policy";

type Fixture = (
  input: { qualityOptions: Record<string, unknown> },
  use: () => Promise<void>,
  testInfo: Record<string, unknown>,
) => Promise<void>;

let qualityFixture: Fixture;
let launchFails = false;
let closeFails = false;
let closeHangs = false;
let ignoreTermination = false;
let applicationProcess: ChildProcess | null = null;
let applicationExitObserved = false;
let applicationCloseCount = 0;
let recorderStopCount = 0;
let root: string;
let previousDisplay: string | undefined;
const attachments = new Map<string, string>();
const spawnOwnedChild = spawn;
const cleanupTestPlatform = hostPlatform();
const scratchRoot = scratchRoots(cleanupTestPlatform)[0];

mock.module("@playwright/test", () => ({
  expect,
  test: {
    extend: (definitions: { quality: Fixture }) => {
      qualityFixture = definitions.quality;
      return {};
    },
  },
  _electron: {
    launch: async ({ env }: { env: Record<string, string> }) => {
      await mkdir(env.COWORK_QUALITY_USER_DATA!, { recursive: true });
      if (launchFails) throw new Error("intentional Electron launch failure");
      const ownedProcess = spawnOwnedChild(
        process.execPath,
        [
          "--no-env-file",
          "-e",
          `${ignoreTermination ? 'process.on("SIGTERM", () => {});' : ""}
           process.stdout.write("ready"); setInterval(() => {}, 1000);`,
        ],
        { cwd: env.COWORK_QUALITY_USER_DATA, stdio: ["ignore", "pipe", "pipe"] },
      );
      applicationProcess = ownedProcess;
      ownedProcess.once("exit", () => {
        applicationExitObserved = true;
      });
      await once(ownedProcess.stdout!, "data");
      const page = {
        on: () => {},
        waitForURL: async () => {},
        waitForFunction: async () => {
          throw new Error("intentional missing renderer runtime");
        },
        isClosed: () => false,
        screenshot: async ({ path: outputPath }: { path: string }) => {
          await writeFile(outputPath, "partial-startup-screenshot");
        },
      };
      return {
        on: () => {},
        firstWindow: async () => page,
        evaluate: async () => null,
        context: () => ({
          addInitScript: async () => {},
          on: () => {},
          tracing: {
            start: async () => {},
            stop: async ({ path: outputPath }: { path: string }) => {
              await writeFile(outputPath, "partial-startup-trace");
            },
          },
        }),
        close: async () => {
          applicationCloseCount += 1;
          if (closeFails) throw new Error("intentional application close failure");
          if (closeHangs) return await new Promise<void>(() => {});
          const exited = once(ownedProcess, "exit");
          ownedProcess.kill("SIGTERM");
          await exited;
        },
        process: () => ownedProcess,
      };
    },
  },
}));
mock.module("electron", () => ({ default: "/quality-test/electron" }));
mock.module("../../../src/platform/host", () => ({ hostPlatform: () => "linux" }));
mock.module("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
      stdin: new Writable({
        write(_chunk, _encoding, done) {
          recorderStopCount += 1;
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0));
          done();
        },
      }),
      kill: () => {
        child.exitCode = 0;
        child.emit("exit", 0);
      },
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  },
}));

await import("../quality-gates/fixtures");

async function runFailedSetup() {
  return qualityFixture(
    {
      qualityOptions: {
        height: 820,
        mode: "light",
        scenario: "product",
        startupDelayMs: 0,
        width: 1_240,
      },
    },
    async () => {
      throw new Error("A failed setup must not reach the test body");
    },
    {
      outputPath: (...segments: string[]) => path.join(root, ...segments),
      attach: async (name: string, { path: filePath }: { path: string }) => {
        attachments.set(name, await readFile(filePath, "utf8"));
      },
      status: "passed",
      expectedStatus: "passed",
      retry: 0,
      titlePath: ["quality cleanup regression"],
    },
  );
}

describe("quality harness setup cleanup", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(scratchRoot, "cowork-quality-cleanup-"));
    previousDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ":quality-test";
    launchFails = false;
    closeFails = false;
    closeHangs = false;
    ignoreTermination = false;
    applicationProcess = null;
    applicationExitObserved = false;
    applicationCloseCount = 0;
    recorderStopCount = 0;
    attachments.clear();
  });

  afterEach(async () => {
    if (previousDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previousDisplay;
    if (applicationProcess?.exitCode === null && applicationProcess.signalCode === null) {
      const exited = once(applicationProcess, "exit");
      applicationProcess.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("closes Electron and recording and removes profiles after runtime readiness fails", async () => {
    await expect(runFailedSetup()).rejects.toThrow("Quality renderer did not install its runtime");
    expect(applicationCloseCount).toBe(1);
    expect(recorderStopCount).toBe(1);
    await expect(access(path.join(root, "runtime"))).rejects.toThrow();
    await expect(access(path.join(root, "user-data"))).rejects.toThrow();
    expect(attachments.get("quality-gate-diagnostics")).toContain("missing renderer runtime");
    expect(attachments.has("quality-gate-trace")).toBe(true);
  });

  test("cleans partial setup when Electron itself cannot launch", async () => {
    launchFails = true;
    await expect(runFailedSetup()).rejects.toThrow("intentional Electron launch failure");
    expect(applicationCloseCount).toBe(0);
    expect(recorderStopCount).toBe(1);
    await expect(access(path.join(root, "runtime"))).rejects.toThrow();
    await expect(access(path.join(root, "user-data"))).rejects.toThrow();
  });

  test("preserves the setup failure and still removes profiles if application close fails", async () => {
    closeFails = true;
    await expect(runFailedSetup()).rejects.toThrow("Quality renderer did not install its runtime");
    expect(recorderStopCount).toBe(1);
    expect(applicationExitObserved).toBe(true);
    if (cleanupTestPlatform !== "win32") {
      expect(applicationProcess?.signalCode).toBe("SIGTERM");
    }
    await expect(access(path.join(root, "runtime"))).rejects.toThrow();
    expect(attachments.get("quality-gate-diagnostics")).toContain("application close failure");
  });

  test("bounds a hung close and reaps the owned process, escalating on POSIX", async () => {
    closeHangs = true;
    ignoreTermination = cleanupTestPlatform !== "win32";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          runFailedSetup(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Cleanup did not finish within 4s")),
              4_000,
            );
          }),
        ]),
      ).rejects.toThrow("Quality renderer did not install its runtime");
    } finally {
      clearTimeout(timeout);
    }
    expect(applicationExitObserved).toBe(true);
    if (cleanupTestPlatform !== "win32") {
      expect(applicationProcess?.signalCode).toBe("SIGKILL");
    }
    expect(attachments.get("quality-gate-diagnostics")).toContain("Timed out closing Electron");
    await expect(access(path.join(root, "runtime"))).rejects.toThrow();
    await expect(access(path.join(root, "user-data"))).rejects.toThrow();
  });
});
