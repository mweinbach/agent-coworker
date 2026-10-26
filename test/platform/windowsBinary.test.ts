import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isNativeWindowsBinary, readWindowsPeMachine } from "../../src/platform/windowsBinary";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeBinary(machine: number): { filePath: string; bytes: Buffer } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pe-test-"));
  roots.push(root);
  const filePath = path.join(root, "binary.exe");
  const bytes = Buffer.alloc(134);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 0x3c);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(machine, 132);
  fs.writeFileSync(filePath, bytes);
  return { filePath, bytes };
}

describe("Windows native binary inspection", () => {
  test.each([
    ["arm64", 0xaa64],
    ["x64", 0x8664],
    ["ia32", 0x14c],
  ] as const)("accepts only the matching %s machine", (arch, machine) => {
    const { filePath } = writeBinary(machine);
    expect(readWindowsPeMachine(filePath)).toBe(machine);
    expect(isNativeWindowsBinary(filePath, arch)).toBe(true);
    for (const other of ["arm64", "x64", "ia32"].filter((value) => value !== arch)) {
      expect(isNativeWindowsBinary(filePath, other)).toBe(false);
    }
  });

  test.each([0xa641, 0xa64e])("rejects mixed ARM64 machine %i", (machine) => {
    const { filePath } = writeBinary(machine);
    expect(isNativeWindowsBinary(filePath, "arm64")).toBe(false);
  });

  test("rejects malformed, truncated, missing, and non-PE executables", () => {
    const { filePath, bytes } = writeBinary(0xaa64);
    for (const offset of [0, 32, 0xffffffff]) {
      bytes.writeUInt32LE(offset, 0x3c);
      fs.writeFileSync(filePath, bytes);
      expect(readWindowsPeMachine(filePath)).toBeNull();
    }
    fs.writeFileSync(filePath, bytes.subarray(0, 63));
    expect(readWindowsPeMachine(filePath)).toBeNull();
    bytes.writeUInt32LE(128, 0x3c);
    bytes.writeUInt32LE(0, 128);
    fs.writeFileSync(filePath, bytes);
    expect(readWindowsPeMachine(filePath)).toBeNull();
    fs.writeFileSync(filePath, "#!/bin/sh\n");
    expect(readWindowsPeMachine(filePath)).toBeNull();
    fs.unlinkSync(filePath);
    expect(readWindowsPeMachine(filePath)).toBeNull();
    expect(isNativeWindowsBinary(filePath, "unsupported")).toBe(false);
  });
});
