import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  COWORK_RUNTIME_INSTRUCTIONS_HEADING,
  checksumFromText,
  ensureCoworkRuntimeReady,
  renderCoworkRuntimeInstructions,
} from "../src/coworkRuntime";
import { assertRuntimeVersion } from "../src/coworkRuntime/platform";
import { scratchRoots } from "../src/platform/sandbox/policy";

const temporaryRoots: string[] = [];
const VERSION = "2026-06-22";

async function tempHome(): Promise<string> {
  const root = scratchRoots()[0];
  if (!root) throw new Error("No platform scratch root is available for tests");
  const dir = await fs.mkdtemp(path.join(root, "cowork-ensure-ready-"));
  temporaryRoots.push(dir);
  return path.join(dir, "home");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("assertRuntimeVersion", () => {
  test("accepts calendar ISO dates and rejects malformed or impossible days", () => {
    expect(() => assertRuntimeVersion(VERSION)).not.toThrow();
    expect(() => assertRuntimeVersion(`runtime-${VERSION}`)).toThrow(/ISO date/);
    expect(() => assertRuntimeVersion("2026-02-30")).toThrow(/valid calendar date/);
  });
});

describe("checksumFromText", () => {
  const digest = "a".repeat(64);

  test("parses a bare or named SHA-256 line, lowercases hex, and rejects bad inputs", () => {
    expect(checksumFromText(`  ${digest.toUpperCase()}  \nignored`, "runtime.zip")).toBe(digest);
    expect(checksumFromText(`${digest} *runtime.zip`, "runtime.zip")).toBe(digest);
    expect(() => checksumFromText("not-a-hash", "runtime.zip")).toThrow(/not valid SHA-256/);
    expect(() => checksumFromText(`${digest} other.zip`, "runtime.zip")).toThrow(
      /names other.zip, expected runtime.zip/,
    );
  });
});

describe("ensureCoworkRuntimeReady fail-closed bootstrap", () => {
  test.each([
    ["no checksum configured", undefined, /No checksum configured/],
    ["invalid sidecar checksum", "not-a-hash\n", /not valid SHA-256/],
  ] as const)("fails closed when local archive has %s", async (_label, sidecar, expectedLog) => {
    const home = await tempHome();
    const archivePath = path.join(path.dirname(home), "runtime.zip");
    const logs: string[] = [];
    await fs.writeFile(archivePath, "not-a-real-archive");
    if (sidecar !== undefined) await fs.writeFile(`${archivePath}.sha256`, sidecar);

    await expect(
      ensureCoworkRuntimeReady({
        homedir: home,
        env: {},
        version: VERSION,
        archivePath,
        allowNetwork: false,
        execute: false,
        log: (line) => logs.push(line),
      }),
    ).resolves.toBeNull();
    expect(logs.some((line) => expectedLog.test(line))).toBe(true);
    await expect(fs.stat(path.join(home, ".cowork", "runtime", VERSION))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("returns null when network bootstrap is disabled and no runtime is installed", async () => {
    const home = await tempHome();
    const logs: string[] = [];
    await expect(
      ensureCoworkRuntimeReady({
        homedir: home,
        env: {},
        version: VERSION,
        allowNetwork: false,
        execute: false,
        log: (line) => logs.push(line),
      }),
    ).resolves.toBeNull();
    expect(logs.some((line) => /unavailable and network bootstrap is disabled/i.test(line))).toBe(
      true,
    );
  });
});

describe("renderCoworkRuntimeInstructions", () => {
  test("omits the prompt block until node_modules is present and includes the wired binaries", () => {
    expect(renderCoworkRuntimeInstructions(undefined)).toBeNull();
    expect(renderCoworkRuntimeInstructions({ COWORK_RUNTIME_NODE: "/runtime/node" })).toBeNull();
    const text = renderCoworkRuntimeInstructions({
      cowork_runtime_node_modules: "/runtime/node_modules",
      COWORK_RUNTIME_NODE: "/runtime/node",
      COWORK_RUNTIME_PYTHON: "/runtime/python",
      COWORK_RUNTIME_SOFFICE: "/runtime/soffice",
    });
    for (const snippet of [
      COWORK_RUNTIME_INSTRUCTIONS_HEADING,
      "`/runtime/node`",
      "`/runtime/python`",
      "`/runtime/soffice`",
      "headless-only soffice launcher",
    ]) {
      expect(text).toContain(snippet);
    }
  });
});
