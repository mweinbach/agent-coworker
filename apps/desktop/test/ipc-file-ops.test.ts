import { describe, expect, test } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { resolveAllowedPath, resolveAllowedDirectoryPath } from "../electron/services/ipcSecurity";
import { assertValidFileName } from "../electron/services/validation";

describe("IPC file ops validation", () => {
  test("assertValidFileName rejects slashes and dots", () => {
    expect(() => assertValidFileName("foo/bar", "name")).toThrow();
    expect(() => assertValidFileName("foo\\bar", "name")).toThrow();
    expect(() => assertValidFileName("..", "name")).toThrow();
    expect(() => assertValidFileName(".", "name")).toThrow();
    expect(() => assertValidFileName("foo\0bar", "name")).toThrow();
    
    expect(() => assertValidFileName("valid_name.txt", "name")).not.toThrow();
    expect(() => assertValidFileName(".hidden", "name")).not.toThrow();
  });

  test("resolveAllowedPath prevents trash/rename escapes", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-fileops-"));
    const workspaceRoot = await fs.realpath(tempRoot);
    try {
      const targetPath = path.join(workspaceRoot, "some_file.txt");
      
      // Should allow resolving inside root
      const resolved = resolveAllowedPath([workspaceRoot], targetPath);
      expect(resolved).toBe(targetPath);
      
      // Should reject outside
      const outsidePath = path.join(workspaceRoot, "..", "evil.txt");
      expect(() => resolveAllowedPath([workspaceRoot], outsidePath)).toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});