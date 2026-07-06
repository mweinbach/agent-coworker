import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeSourceFingerprint,
  parsePrebuiltLock,
  type WinSandboxPrebuiltLock,
} from "../scripts/winSandboxPrebuilt";

async function writeCrate(crateDir: string, lineEnding: "\n" | "\r\n"): Promise<void> {
  const body = ["[package]", 'name = "test"', ""].join(lineEnding);
  const main = ["fn main() {", '    println!("hi");', "}", ""].join(lineEnding);
  await fs.mkdir(path.join(crateDir, "src"), { recursive: true });
  await fs.mkdir(path.join(crateDir, "vendor", "sub"), { recursive: true });
  await fs.writeFile(path.join(crateDir, "Cargo.toml"), body);
  await fs.writeFile(path.join(crateDir, "Cargo.lock"), body);
  await fs.writeFile(path.join(crateDir, "build.rs"), main);
  await fs.writeFile(path.join(crateDir, "codex-windows-sandbox-setup.manifest"), body);
  await fs.writeFile(path.join(crateDir, "src", "main.rs"), main);
  await fs.writeFile(path.join(crateDir, "vendor", "sub", "lib.rs"), main);
}

const VALID_LOCK: WinSandboxPrebuiltLock = {
  schemaVersion: 1,
  tag: "win-sandbox-v0.2.0",
  sourceFingerprint: "a".repeat(64),
  targets: {
    "x86_64-pc-windows-msvc": {
      zipName: "win-sandbox-x86_64-pc-windows-msvc.zip",
      zipSha256: "b".repeat(64),
      files: {
        "cowork-win-sandbox.exe": "c".repeat(64),
        "codex-windows-sandbox-setup.exe": "d".repeat(64),
        "codex-command-runner.exe": "e".repeat(64),
      },
    },
  },
};

describe("windows sandbox prebuilt fingerprint", () => {
  test("is invariant to CRLF vs LF checkouts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-win-sandbox-fp-"));
    try {
      const lfDir = path.join(root, "lf");
      const crlfDir = path.join(root, "crlf");
      await writeCrate(lfDir, "\n");
      await writeCrate(crlfDir, "\r\n");

      const lfFingerprint = await computeSourceFingerprint(lfDir);
      const crlfFingerprint = await computeSourceFingerprint(crlfDir);
      expect(lfFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(crlfFingerprint).toBe(lfFingerprint);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("ignores docs but tracks build inputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-win-sandbox-fp-"));
    try {
      const crateDir = path.join(root, "crate");
      await writeCrate(crateDir, "\n");
      const baseline = await computeSourceFingerprint(crateDir);

      await fs.writeFile(path.join(crateDir, "README.md"), "docs change\n");
      await fs.writeFile(path.join(crateDir, "UPSTREAM.md"), "docs change\n");
      expect(await computeSourceFingerprint(crateDir)).toBe(baseline);

      await fs.writeFile(path.join(crateDir, "src", "main.rs"), "fn main() { /* edited */ }\n");
      expect(await computeSourceFingerprint(crateDir)).not.toBe(baseline);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("windows sandbox prebuilt lock parsing", () => {
  test("round-trips a valid lock", () => {
    expect(parsePrebuiltLock(JSON.stringify(VALID_LOCK))).toEqual(VALID_LOCK);
  });

  test.each([
    ["invalid JSON", "not json"],
    ["wrong schema version", JSON.stringify({ ...VALID_LOCK, schemaVersion: 2 })],
    ["empty tag", JSON.stringify({ ...VALID_LOCK, tag: "" })],
    [
      "non-hex source fingerprint",
      JSON.stringify({ ...VALID_LOCK, sourceFingerprint: "not-a-hash" }),
    ],
    [
      "unknown rust target",
      JSON.stringify({
        ...VALID_LOCK,
        targets: { "x86_64-unknown-linux-gnu": VALID_LOCK.targets["x86_64-pc-windows-msvc"] },
      }),
    ],
    [
      "non-hex file hash",
      JSON.stringify({
        ...VALID_LOCK,
        targets: {
          "x86_64-pc-windows-msvc": {
            ...VALID_LOCK.targets["x86_64-pc-windows-msvc"],
            files: { "cowork-win-sandbox.exe": "nope" },
          },
        },
      }),
    ],
    [
      "empty files map",
      JSON.stringify({
        ...VALID_LOCK,
        targets: {
          "x86_64-pc-windows-msvc": {
            ...VALID_LOCK.targets["x86_64-pc-windows-msvc"],
            files: {},
          },
        },
      }),
    ],
    [
      "missing zip hash",
      JSON.stringify({
        ...VALID_LOCK,
        targets: {
          "x86_64-pc-windows-msvc": {
            ...VALID_LOCK.targets["x86_64-pc-windows-msvc"],
            zipSha256: undefined,
          },
        },
      }),
    ],
  ])("rejects a lock with %s", (_label, raw) => {
    expect(parsePrebuiltLock(raw)).toBeNull();
  });
});
