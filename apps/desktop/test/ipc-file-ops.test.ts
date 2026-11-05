import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/scratchRoots";
import { resolveAllowedEntryPath } from "../electron/services/ipcSecurity";

describe("IPC file ops validation", () => {
  test("resolveAllowedEntryPath prevents trash/rename escapes", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-fileops-"));
    const workspaceRoot = await fs.realpath(tempRoot);
    try {
      const targetPath = path.join(workspaceRoot, "some_file.txt");

      // Should allow resolving inside root
      const resolved = resolveAllowedEntryPath([workspaceRoot], targetPath);
      expect(resolved).toBe(targetPath);

      // Should reject outside
      const outsidePath = path.join(workspaceRoot, "..", "evil.txt");
      expect(() => resolveAllowedEntryPath([workspaceRoot], outsidePath)).toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("entry mutations reject outside-root ancestor links", async () => {
    const temporaryPath = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "cowork-fileops-boundary-"),
    );
    const root = await fs.realpath(temporaryPath);
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    try {
      const link = path.join(workspace, "linked-directory");
      await fs.symlink(outside, link, "junction");
      expect(resolveAllowedEntryPath([workspace], link)).toBe(link);
      expect(() =>
        resolveAllowedEntryPath([workspace], path.join(link, "outside-file.txt")),
      ).toThrow("outside allowed workspace roots");
    } finally {
      await fs.rm(temporaryPath, { recursive: true, force: true });
    }
  });
});
