import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import * as platformExec from "../src/platform/exec";
import * as platformFs from "../src/platform/fs";
import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";
import * as childProcess from "../src/utils/execFileCompat";
import { type EnsureRipgrepOptions, ensureRipgrep } from "../src/utils/ripgrep";

type Failure = "checksum404" | "archive404" | "download" | "checksum" | "extract";
type InstallPhase = "download" | "extract" | "copy";
type PhaseGate = {
  phase: InstallPhase;
  entered: PromiseWithResolvers<AbortSignal | undefined>;
  release: PromiseWithResolvers<void>;
};

const archive = "fixture ripgrep archive";
const checksum = createHash("sha256").update(archive).digest("hex");
const realMkdtemp = fs.mkdtemp.bind(fs);
const realRm = fs.rm.bind(fs);
const realCopyFile = fs.copyFile.bind(fs);
const realRename = fs.rename.bind(fs);
const realReplaceExecutableAtomic = platformFs.replaceExecutableAtomic;
const restoreMocks: Array<() => void> = [];
const releases: Array<() => void> = [];
const installations: Array<Promise<string>> = [];
const attemptCleanup = new Map<string, PromiseWithResolvers<void>>();
let root: string;
let homedir: string;
let installPath: string;
let attemptRoots: string[];
let failure: Failure | undefined;
let previousOverride: string | undefined;
let extractionCalls: number;
let cleanupFails: boolean;
let phaseGate: PhaseGate | undefined;
let requestSignals: Array<AbortSignal | undefined>;
let copyTargets: string[];
let afterCopy: ((target: string, index: number) => Promise<void>) | undefined;
let responseOverride: ((url: string) => Response | undefined) | undefined;

function blockPhase(phase: InstallPhase): PhaseGate {
  const gate = {
    phase,
    entered: Promise.withResolvers<AbortSignal | undefined>(),
    release: Promise.withResolvers<void>(),
  };
  releases.push(() => gate.release.resolve());
  phaseGate = gate;
  return gate;
}

async function pauseAtPhase(phase: InstallPhase, signal?: AbortSignal): Promise<void> {
  if (phaseGate?.phase !== phase) return;
  const gate = phaseGate;
  gate.entered.resolve(signal);
  if (!signal) return await gate.release.promise;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    gate.release.promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function startInstallation(
  options: EnsureRipgrepOptions,
  ensure: typeof ensureRipgrep = ensureRipgrep,
): Promise<string> {
  const installation = ensure(options);
  void installation.catch(() => {});
  installations.push(installation);
  return installation;
}

beforeEach(async () => {
  root = await realMkdtemp(path.join(scratchRoots()[0]!, "ripgrep-install-test-"));
  homedir = path.join(root, "home");
  installPath = path.join(homedir, ".cowork", "bin", platformExec.binaryName("rg"));
  attemptRoots = [];
  failure = undefined;
  extractionCalls = 0;
  cleanupFails = false;
  phaseGate = undefined;
  requestSignals = [];
  copyTargets = [];
  afterCopy = undefined;
  responseOverride = undefined;
  attemptCleanup.clear();
  previousOverride = process.env.COWORK_RIPGREP_PATH;
  delete process.env.COWORK_RIPGREP_PATH;

  const which = spyOn(platformExec, "which").mockReturnValue(null);
  restoreMocks.push(() => which.mockRestore());
  const mkdtemp = spyOn(fs, "mkdtemp").mockImplementation(async () => {
    const attempt = await realMkdtemp(path.join(root, "attempt-"));
    attemptRoots.push(attempt);
    attemptCleanup.set(attempt, Promise.withResolvers<void>());
    return attempt;
  });
  restoreMocks.push(() => mkdtemp.mockRestore());
  const rm = spyOn(fs, "rm").mockImplementation(async (target, options) => {
    try {
      if (cleanupFails && attemptRoots.includes(String(target))) {
        throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      }
      await realRm(target, options);
    } finally {
      attemptCleanup.get(String(target))?.resolve();
    }
  });
  restoreMocks.push(() => rm.mockRestore());
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const signal = init?.signal ?? undefined;
    requestSignals.push(signal);
    expect(url).toStartWith("https://github.com/BurntSushi/ripgrep/releases/download/");
    const override = responseOverride?.(url);
    if (override) return override;
    if (url.endsWith(".sha256")) {
      if (failure === "checksum404") return new Response("missing", { status: 404 });
      return new Response(failure === "checksum" ? "0".repeat(64) : checksum);
    }
    if (failure === "archive404") return new Response("missing", { status: 404 });
    if (failure === "download") throw new Error("download interrupted");
    await pauseAtPhase("download", signal);
    return new Response(archive);
  });
  restoreMocks.push(() => fetch.mockRestore());
  const exec = spyOn(childProcess, "execFileCompat").mockImplementation(
    async (command, args, options) => {
      extractionCalls += 1;
      expect(["tar", "powershell.exe"]).toContain(command);
      const attempt = attemptRoots.find((candidate) =>
        args.join(" ").includes(path.join(candidate, "extract")),
      );
      expect(attempt).toBeDefined();
      if (!attempt) throw new Error("Missing extraction attempt");
      try {
        await pauseAtPhase("extract", options?.signal);
      } catch (error) {
        if (options?.signal?.aborted) {
          return { stdout: "", stderr: "", exitCode: 130, errorCode: "ABORT_ERR" };
        }
        throw error;
      }
      if (failure === "extract") {
        return { stdout: "", stderr: "invalid archive", exitCode: 1 };
      }
      const binaryDir = path.join(attempt, "extract", "ripgrep-fixture");
      await fs.mkdir(binaryDir, { recursive: true });
      await fs.writeFile(path.join(binaryDir, platformExec.binaryName("rg")), "fixture executable");
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  );
  restoreMocks.push(() => exec.mockRestore());
  const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, target, mode) => {
    const index = copyTargets.push(String(target)) - 1;
    await pauseAtPhase("copy");
    await realCopyFile(source, target, mode);
    await afterCopy?.(String(target), index);
  });
  restoreMocks.push(() => copyFile.mockRestore());
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(installations.splice(0));
  await Promise.all([...attemptCleanup.values()].map((cleanup) => cleanup.promise));
  for (const restore of restoreMocks.splice(0).reverse()) restore();
  if (previousOverride === undefined) delete process.env.COWORK_RIPGREP_PATH;
  else process.env.COWORK_RIPGREP_PATH = previousOverride;
  await fs.rm(root, { recursive: true, force: true });
});

async function expectAttemptsRemoved(expectedAttempts: number): Promise<void> {
  await Promise.all([...attemptCleanup.values()].map((cleanup) => cleanup.promise));
  expect(attemptRoots).toHaveLength(expectedAttempts);
  expect((await fs.readdir(root)).filter((name) => name.startsWith("attempt-"))).toEqual([]);
}

describe("ripgrep installation cleanup", () => {
  test("removes the downloaded archive and extracted tree after publishing the binary", async () => {
    await expect(ensureRipgrep({ homedir })).resolves.toBe(installPath);
    expect(await fs.readFile(installPath, "utf8")).toBe("fixture executable");
    expect(extractionCalls).toBe(1);
    await expectAttemptsRemoved(1);
  });

  test.each([
    { failure: "checksum404", error: "no matching release asset found", extracts: false },
    { failure: "archive404", error: "no matching release asset found", extracts: false },
    { failure: "download", error: "download interrupted", extracts: false },
    { failure: "checksum", error: "Checksum mismatch", extracts: false },
    { failure: "extract", error: "invalid archive", extracts: true },
  ] as const)("removes every temporary attempt after $failure", async (scenario) => {
    failure = scenario.failure;
    await expect(ensureRipgrep({ homedir })).rejects.toThrow(scenario.error);
    const expectedAttempts = hostPlatform() === "linux" ? 2 : 1;
    expect(extractionCalls).toBe(scenario.extracts ? expectedAttempts : 0);
    await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectAttemptsRemoved(expectedAttempts);
  });

  test.each([
    { name: "successful publication", failure: undefined },
    { name: "checksum failure", failure: "checksum" },
  ] as const)("cleanup errors do not replace $name", async (scenario) => {
    failure = scenario.failure;
    cleanupFails = true;
    const logs: string[] = [];
    const installation = ensureRipgrep({ homedir, log: (line) => logs.push(line) });
    if (failure) {
      await expect(installation).rejects.toThrow("Checksum mismatch");
      expect(attemptRoots).toHaveLength(hostPlatform() === "linux" ? 2 : 1);
    } else {
      await expect(installation).resolves.toBe(installPath);
      expect(await fs.readFile(installPath, "utf8")).toBe("fixture executable");
    }
    expect(logs).toContainEqual(expect.stringContaining("cleanup denied"));
  });

  test.each(
    (["checksum", "archive"] as const).flatMap((phase) =>
      [404, 503].flatMap((status) =>
        (["pending", "rejected"] as const).map((cleanup) => ({ phase, status, cleanup })),
      ),
    ),
  )(
    "cancels discarded $phase HTTP $status bodies without waiting for $cleanup cleanup",
    async ({ phase, status, cleanup }) => {
      const cancelled: string[] = [];
      const cancellation = Promise.withResolvers<void>();
      releases.push(() => cancellation.resolve());
      responseOverride = (url) => {
        if (url.endsWith(".sha256") !== (phase === "checksum")) return undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            // The discarded response never produces data or closes on its own.
            cancel() {
              cancelled.push(url);
              return cleanup === "pending"
                ? cancellation.promise
                : Promise.reject(new Error("discarded body cleanup failed"));
            },
          }),
          { status },
        );
      };

      await expect(startInstallation({ homedir })).rejects.toThrow(
        status === 404 ? "no matching release asset found" : `HTTP ${status} fetching`,
      );
      const expectedAttempts = hostPlatform() === "linux" ? 2 : 1;
      expect(cancelled).toHaveLength(expectedAttempts);
      expect(extractionCalls).toBe(0);
      await expectAttemptsRemoved(expectedAttempts);
    },
  );
});

describe("ripgrep concurrent installation", () => {
  test("does not remove another installer's shared-name staging file", async () => {
    await fs.mkdir(path.dirname(installPath), { recursive: true });
    const otherStage = `${installPath}.tmp`;
    await fs.writeFile(otherStage, "other installation in progress");

    await expect(startInstallation({ homedir })).resolves.toBe(installPath);
    expect(await fs.readFile(otherStage, "utf8")).toBe("other installation in progress");
    expect(await fs.readFile(installPath, "utf8")).toBe("fixture executable");
    expect(
      (await fs.readdir(path.dirname(installPath))).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  test("independent installers stage separately and converge on one executable", async () => {
    // Literal query specifiers give Bun separate module-local in-flight maps.
    const firstModule = await import("../src/utils/ripgrep.ts?concurrent-first" as string);
    const secondModule = await import("../src/utils/ripgrep.ts?concurrent-second" as string);
    const copied = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    for (const gate of release) releases.push(() => gate.resolve());
    afterCopy = async (_target, index) => {
      copied[index]?.resolve();
      await release[index]?.promise;
    };

    const first = startInstallation({ homedir }, firstModule.ensureRipgrep);
    await copied[0]!.promise;
    const second = startInstallation({ homedir }, secondModule.ensureRipgrep);
    await copied[1]!.promise;
    expect(copyTargets).toHaveLength(2);
    expect(new Set(copyTargets).size).toBe(2);

    release[0]!.resolve();
    await expect(first).resolves.toBe(installPath);
    release[1]!.resolve();
    await expect(second).resolves.toBe(installPath);
    expect(await fs.readFile(installPath, "utf8")).toBe("fixture executable");
    expect(
      (await fs.readdir(path.dirname(installPath))).filter((name) => name.includes(".tmp")),
    ).toEqual([]);
    await expectAttemptsRemoved(2);
  });

  test("restores a Windows aside after cancellation during executable promotion", async () => {
    const controller = new AbortController();
    let movedPeerAside = false;
    const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
      const sourcePath = String(source);
      const targetPath = String(target);
      if (sourcePath === installPath && targetPath.startsWith(`${installPath}.old-`)) {
        await fs.writeFile(installPath, "known-good peer executable");
        await realRename(source, target);
        movedPeerAside = true;
        return;
      }
      if (sourcePath.startsWith(`${installPath}.tmp-`) && targetPath === installPath) {
        controller.abort();
        throw Object.assign(new Error("staged executable is locked"), { code: "EPERM" });
      }
      await realRename(source, target);
    });
    restoreMocks.push(() => rename.mockRestore());
    const promote = spyOn(platformFs, "replaceExecutableAtomic").mockImplementation(
      (source, target, deps) =>
        realReplaceExecutableAtomic(source, target, { ...deps, platform: "win32" }),
    );
    restoreMocks.push(() => promote.mockRestore());

    await expect(startInstallation({ homedir, signal: controller.signal })).rejects.toThrow(
      /abort/i,
    );
    await expectAttemptsRemoved(1);
    expect(movedPeerAside).toBe(true);
    expect(await fs.readFile(installPath, "utf8")).toBe("known-good peer executable");
    const remaining = await fs.readdir(path.dirname(installPath));
    expect(remaining.filter((name) => name.includes(".tmp-") || name.includes(".old-"))).toEqual(
      [],
    );
  });
});

describe("ripgrep installation cancellation", () => {
  test("does not start work for an already-aborted caller", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(startInstallation({ homedir, signal: controller.signal })).rejects.toThrow(
      /abort/i,
    );
    expect(attemptRoots).toHaveLength(0);
    expect(requestSignals).toHaveLength(0);
    expect(extractionCalls).toBe(0);
  });

  test.each(["leader", "follower"] as const)(
    "cancelling the %s leaves the other caller's installation running",
    async (cancelledCaller) => {
      const gate = blockPhase("download");
      const leaderController = new AbortController();
      const followerController = new AbortController();
      const leader = startInstallation({ homedir, signal: leaderController.signal });
      const jobSignal = await gate.entered.promise;
      expect(jobSignal).toBeInstanceOf(AbortSignal);
      const follower = startInstallation({ homedir, signal: followerController.signal });
      const cancelled = cancelledCaller === "leader" ? leader : follower;
      const remaining = cancelledCaller === "leader" ? follower : leader;

      (cancelledCaller === "leader" ? leaderController : followerController).abort();
      await expect(cancelled).rejects.toThrow(/abort/i);
      expect(jobSignal!.aborted).toBe(false);
      gate.release.resolve();
      await expect(remaining).resolves.toBe(installPath);
      expect(extractionCalls).toBe(1);
      await expectAttemptsRemoved(1);
    },
  );

  test("a downloads-disabled caller does not join another caller's cold installation", async () => {
    const gate = blockPhase("download");
    const installation = startInstallation({ homedir });
    await gate.entered.promise;
    const readOnly = startInstallation({ homedir, disableDownload: true });

    const rejectedByPolicy = Promise.resolve(
      expect(readOnly).rejects.toThrow(/downloads are disabled/i),
    );
    void rejectedByPolicy.catch(() => {});
    await rejectedByPolicy;
    gate.release.resolve();
    await expect(installation).resolves.toBe(installPath);
    expect(extractionCalls).toBe(1);
  });

  test.each(["download", "extract", "copy"] as const)(
    "cancels the last waiter during %s, cleans up, and permits retry",
    async (phase) => {
      const gate = blockPhase(phase);
      const controller = new AbortController();
      const installation = startInstallation({ homedir, signal: controller.signal });
      const phaseSignal = await gate.entered.promise;
      const jobSignal = phase === "copy" ? requestSignals[0] : phaseSignal;
      expect(jobSignal).toBeInstanceOf(AbortSignal);

      controller.abort();
      await expect(installation).rejects.toThrow(/abort/i);
      expect(jobSignal!.aborted).toBe(true);
      gate.release.resolve();
      await expectAttemptsRemoved(1);
      await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
      const stagedFiles = await fs.readdir(path.dirname(installPath)).catch(() => []);
      expect(stagedFiles.filter((name) => name.includes(".tmp"))).toEqual([]);

      phaseGate = undefined;
      await expect(startInstallation({ homedir })).resolves.toBe(installPath);
      await expectAttemptsRemoved(2);
    },
  );
});
