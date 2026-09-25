import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox/policy";
import { isLaunchableFile } from "../electron/services/launchableFiles";

describe("isLaunchableFile", () => {
  test("flags shell-executed types per platform", async () => {
    expect(await isLaunchableFile("C:\\ws\\index.js", "win32")).toBe(true);
    expect(await isLaunchableFile("C:\\ws\\Shortcut.LNK", "win32")).toBe(true);
    expect(await isLaunchableFile("C:\\ws\\notes.txt", "win32")).toBe(false);

    expect(await isLaunchableFile("/ws/report.command", "darwin")).toBe(true);
    expect(await isLaunchableFile("/ws/Tool.app", "darwin")).toBe(true);

    expect(await isLaunchableFile("/ws/launcher.desktop", "linux")).toBe(true);

    // Script types a file association may run directly count on every platform.
    expect(await isLaunchableFile("C:\\ws\\build.py", "win32")).toBe(true);
    expect(await isLaunchableFile("C:\\ws\\setup.SH", "win32")).toBe(true);
    expect(await isLaunchableFile("/ws/hotkeys.ahk", "darwin")).toBe(true);
  });

  test("inspects POSIX files by mode and fails closed when the file can't be read", async () => {
    const dir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "launchable-"));
    try {
      const notes = path.join(dir, "notes.md");
      const script = path.join(dir, "run");
      await fs.writeFile(notes, "hi", { mode: 0o644 });
      await fs.writeFile(script, "#!/bin/sh\n", { mode: 0o755 });
      expect(await isLaunchableFile(notes, "linux")).toBe(false);
      expect(await isLaunchableFile(script, "darwin")).toBe(true);
      // Directories are executable on POSIX; opening one must not prompt as a program.
      const folder = path.join(dir, "folder");
      await fs.mkdir(folder, { mode: 0o755 });
      expect(await isLaunchableFile(folder, "linux")).toBe(false);
      // A path that vanished may be recreated as an executable before the shell opens it.
      expect(await isLaunchableFile(path.join(dir, "missing-index.js"), "darwin")).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
