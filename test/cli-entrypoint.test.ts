import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const indexScript = path.resolve(import.meta.dir, "../src/index.ts");
const serverScript = path.resolve(import.meta.dir, "../src/server/index.ts");
const repoRoot = path.resolve(import.meta.dir, "..");

describe("CLI entrypoint startup error handling", () => {
  test("exits with code 1 when startup fails due to invalid directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-test-"));
    const tmpFile = path.join(tmpDir, "stderr.log");

    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, indexScript, "--dir", "/nonexistent_directory_test_path"],
        cwd: repoRoot,
        stderr: Bun.file(tmpFile),
      });

      const exitCode = await proc.exited;
      const stderr = await fs.readFile(tmpFile, "utf-8");

      expect(exitCode).toBe(1);
      expect(stderr).toContain("is not a directory");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Server entrypoint startup error handling", () => {
  test("server entrypoint exits with code 1 when startup fails due to invalid directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-test-"));
    const tmpFile = path.join(tmpDir, "stderr.log");

    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, serverScript, "--dir", "/nonexistent_directory_test_path"],
        cwd: repoRoot,
        stderr: Bun.file(tmpFile),
      });

      const exitCode = await proc.exited;
      const stderr = await fs.readFile(tmpFile, "utf-8");

      expect(exitCode).toBe(1);
      expect(stderr).toContain("is not a directory");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
