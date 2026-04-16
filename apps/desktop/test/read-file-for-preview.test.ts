import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveAllowedPath } from "../electron/services/ipcSecurity";
import { readFileForPreviewInputSchema } from "../src/lib/desktopSchemas";

describe("readFileForPreview input schema", () => {
  test("accepts a plain path with no maxBytes", () => {
    const parsed = readFileForPreviewInputSchema.safeParse({ path: "/workspace/notes.md" });
    expect(parsed.success).toBe(true);
  });

  test("accepts a path with a positive maxBytes", () => {
    const parsed = readFileForPreviewInputSchema.safeParse({
      path: "/workspace/notes.md",
      maxBytes: 1024,
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an empty path", () => {
    const parsed = readFileForPreviewInputSchema.safeParse({ path: "" });
    expect(parsed.success).toBe(false);
  });

  test("rejects negative maxBytes", () => {
    const parsed = readFileForPreviewInputSchema.safeParse({
      path: "/workspace/notes.md",
      maxBytes: -1,
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects maxBytes above the 50MB cap", () => {
    const parsed = readFileForPreviewInputSchema.safeParse({
      path: "/workspace/notes.md",
      maxBytes: 60 * 1024 * 1024,
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects non-integer maxBytes", () => {
    const parsed = readFileForPreviewInputSchema.safeParse({
      path: "/workspace/notes.md",
      maxBytes: 1024.5,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("readFileForPreview path containment", () => {
  test("rejects paths that escape the workspace root", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-preview-path-"));
    const workspaceRoot = await fs.realpath(tempRoot);
    try {
      const escape = path.join(workspaceRoot, "..", "secret.txt");
      expect(() => resolveAllowedPath([workspaceRoot], escape)).toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects symlinks that point outside the workspace root", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-preview-symlink-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-preview-outside-"));
    try {
      const workspaceRoot = await fs.realpath(tempRoot);
      const outsideFile = path.join(await fs.realpath(outsideRoot), "secret.txt");
      await fs.writeFile(outsideFile, "secret", "utf8");

      const linkPath = path.join(workspaceRoot, "evil-link.txt");
      try {
        await fs.symlink(outsideFile, linkPath);
      } catch {
        // Symlink creation may be unavailable (e.g. Windows non-admin); skip.
        return;
      }

      expect(() => resolveAllowedPath([workspaceRoot], linkPath)).toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("allows resolving a regular file inside the workspace root", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-preview-allow-"));
    const workspaceRoot = await fs.realpath(tempRoot);
    try {
      const filePath = path.join(workspaceRoot, "ok.md");
      await fs.writeFile(filePath, "# hi", "utf8");

      const resolved = resolveAllowedPath([workspaceRoot], filePath);
      expect(resolved).toBe(filePath);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("readFileForPreview truncation behaviour", () => {
  // Mirrors the byte-slice + truncation contract enforced by the IPC handler in
  // electron/ipc/files.ts. If the handler logic changes, update both sides.
  async function readWithCap(absPath: string, maxBytes: number) {
    const stat = await fs.stat(absPath);
    const toRead = Math.min(maxBytes, stat.size);
    const fh = await fs.open(absPath, "r");
    try {
      const buffer = Buffer.alloc(toRead);
      const { bytesRead } = await fh.read(buffer, 0, toRead, 0);
      const slice = buffer.subarray(0, bytesRead);
      return {
        base64: slice.toString("base64"),
        byteLength: bytesRead,
        truncated: stat.size > bytesRead,
      };
    } finally {
      await fh.close();
    }
  }

  test("returns truncated:true when the file is larger than maxBytes", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-preview-trunc-"));
    try {
      const file = path.join(tempRoot, "big.bin");
      const contents = Buffer.alloc(2048, 0x41);
      await fs.writeFile(file, contents);

      const result = await readWithCap(file, 512);
      expect(result.byteLength).toBe(512);
      expect(result.truncated).toBe(true);
      expect(Buffer.from(result.base64, "base64").length).toBe(512);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("returns truncated:false when the file fits", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-preview-fit-"));
    try {
      const file = path.join(tempRoot, "small.bin");
      const contents = Buffer.from("hello world", "utf8");
      await fs.writeFile(file, contents);

      const result = await readWithCap(file, 1024);
      expect(result.byteLength).toBe(contents.length);
      expect(result.truncated).toBe(false);
      expect(Buffer.from(result.base64, "base64").toString("utf8")).toBe("hello world");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
