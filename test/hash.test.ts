import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sha256FileHex, sha256Hex } from "../src/utils/hash";

describe("sha256 helpers", () => {
  test("sha256Hex matches node:crypto for strings and bytes", () => {
    expect(sha256Hex("hello world")).toBe(createHash("sha256").update("hello world").digest("hex"));
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("sha256FileHex streams files and matches node:crypto", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-hash-"));
    const file = path.join(dir, "payload.bin");
    const payload = new Uint8Array(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    await fs.writeFile(file, payload);
    try {
      expect(await sha256FileHex(file)).toBe(createHash("sha256").update(payload).digest("hex"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
