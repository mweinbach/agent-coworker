import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import * as platformExec from "../src/platform/exec";
import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";
import * as childProcess from "../src/utils/execFileCompat";
import { ensureRipgrep } from "../src/utils/ripgrep";

type Failure = "checksum404" | "archive404" | "download" | "checksum" | "extract";

const archive = "fixture ripgrep archive";
const checksum = createHash("sha256").update(archive).digest("hex");
const realMkdtemp = fs.mkdtemp.bind(fs);
const realRm = fs.rm.bind(fs);
const restoreMocks: Array<() => void> = [];
let root: string;
let homedir: string;
let installPath: string;
let attemptRoots: string[];
let failure: Failure | undefined;
let previousOverride: string | undefined;
let extractionCalls: number;
let cleanupFails: boolean;

beforeEach(async () => {
  root = await realMkdtemp(path.join(scratchRoots()[0]!, "ripgrep-install-test-"));
  homedir = path.join(root, "home");
  installPath = path.join(homedir, ".cowork", "bin", platformExec.binaryName("rg"));
  attemptRoots = [];
  failure = undefined;
  extractionCalls = 0;
  cleanupFails = false;
  previousOverride = process.env.COWORK_RIPGREP_PATH;
  delete process.env.COWORK_RIPGREP_PATH;

  const which = spyOn(platformExec, "which").mockReturnValue(null);
  restoreMocks.push(() => which.mockRestore());
  const mkdtemp = spyOn(fs, "mkdtemp").mockImplementation(async () => {
    const attempt = await realMkdtemp(path.join(root, "attempt-"));
    attemptRoots.push(attempt);
    return attempt;
  });
  restoreMocks.push(() => mkdtemp.mockRestore());
  const rm = spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (cleanupFails && attemptRoots.includes(String(target))) {
      throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    }
    await realRm(target, options);
  });
  restoreMocks.push(() => rm.mockRestore());
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    expect(url).toStartWith("https://github.com/BurntSushi/ripgrep/releases/download/");
    if (url.endsWith(".sha256")) {
      if (failure === "checksum404") return new Response("missing", { status: 404 });
      return new Response(failure === "checksum" ? "0".repeat(64) : checksum);
    }
    if (failure === "archive404") return new Response("missing", { status: 404 });
    if (failure === "download") throw new Error("download interrupted");
    return new Response(archive);
  });
  restoreMocks.push(() => fetch.mockRestore());
  const exec = spyOn(childProcess, "execFileCompat").mockImplementation(async (command, args) => {
    extractionCalls += 1;
    expect(["tar", "powershell.exe"]).toContain(command);
    const attempt = attemptRoots.at(-1)!;
    expect(args.join(" ")).toContain(path.join(attempt, "extract"));
    if (failure === "extract") {
      return { stdout: "", stderr: "invalid archive", exitCode: 1 };
    }
    const binaryDir = path.join(attempt, "extract", "ripgrep-fixture");
    await fs.mkdir(binaryDir, { recursive: true });
    await fs.writeFile(path.join(binaryDir, platformExec.binaryName("rg")), "fixture executable");
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  restoreMocks.push(() => exec.mockRestore());
});

afterEach(async () => {
  for (const restore of restoreMocks.splice(0).reverse()) restore();
  if (previousOverride === undefined) delete process.env.COWORK_RIPGREP_PATH;
  else process.env.COWORK_RIPGREP_PATH = previousOverride;
  await fs.rm(root, { recursive: true, force: true });
});

async function expectAttemptsRemoved(expectedAttempts: number): Promise<void> {
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
});
