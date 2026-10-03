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

function scratchRoot(): string {
  const root = scratchRoots()[0];
  if (!root) throw new Error("No platform scratch root is available for tests");
  return root;
}

async function tempHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(scratchRoot(), "cowork-ensure-ready-"));
  temporaryRoots.push(root);
  return path.join(root, "home");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("assertRuntimeVersion", () => {
  test("accepts calendar ISO dates and rejects malformed or impossible days", () => {
    expect(() => assertRuntimeVersion("2026-06-22")).not.toThrow();
    expect(() => assertRuntimeVersion("runtime-2026-06-22")).toThrow(/ISO date/);
    expect(() => assertRuntimeVersion("2026-02-30")).toThrow(/valid calendar date/);
  });
});

describe("checksumFromText", () => {
  const digest = "a".repeat(64);

  test("parses a bare or named SHA-256 line and lowercases hex", () => {
    expect(checksumFromText(`  ${digest.toUpperCase()}  \nignored`, "runtime.zip")).toBe(digest);
    expect(checksumFromText(`${digest} *runtime.zip`, "runtime.zip")).toBe(digest);
  });

  test("rejects invalid text and a sidecar that names a different archive", () => {
    expect(() => checksumFromText("not-a-hash", "runtime.zip")).toThrow(/not valid SHA-256/);
    expect(() => checksumFromText(`${digest} other.zip`, "runtime.zip")).toThrow(
      /names other.zip, expected runtime.zip/,
    );
  });
});

describe("ensureCoworkRuntimeReady fail-closed bootstrap", () => {
  test("refuses a local archive when no checksum is configured or beside the file", async () => {
    const home = await tempHome();
    const archivePath = path.join(path.dirname(home), "runtime.zip");
    const logs: string[] = [];
    await fs.writeFile(archivePath, "not-a-real-archive");
    await expect(
      ensureCoworkRuntimeReady({
        homedir: home,
        env: {},
        version: "2026-06-22",
        archivePath,
        allowNetwork: false,
        execute: false,
        log: (line) => logs.push(line),
      }),
    ).resolves.toBeNull();
    expect(logs.some((line) => /No checksum configured/.test(line))).toBe(true);
    await expect(
      fs.stat(path.join(home, ".cowork", "runtime", "2026-06-22")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("uses a sidecar checksum and fails closed when that sidecar is invalid", async () => {
    const home = await tempHome();
    const archivePath = path.join(path.dirname(home), "runtime.zip");
    const logs: string[] = [];
    await fs.writeFile(archivePath, "not-a-real-archive");
    await fs.writeFile(`${archivePath}.sha256`, "not-a-hash\n");
    await expect(
      ensureCoworkRuntimeReady({
        homedir: home,
        env: {},
        version: "2026-06-22",
        archivePath,
        allowNetwork: false,
        execute: false,
        log: (line) => logs.push(line),
      }),
    ).resolves.toBeNull();
    expect(logs.some((line) => /not valid SHA-256/.test(line))).toBe(true);
    await expect(
      fs.stat(path.join(home, ".cowork", "runtime", "2026-06-22")),
    ).rejects.toMatchObject({
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
        version: "2026-06-22",
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
    expect(text).toContain(COWORK_RUNTIME_INSTRUCTIONS_HEADING);
    expect(text).toContain("`/runtime/node`");
    expect(text).toContain("`/runtime/python`");
    expect(text).toContain("`/runtime/soffice`");
    expect(text).toContain("headless-only soffice launcher");
  });
});
