import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox/policy";
import { isLaunchableFile } from "../electron/services/launchableFiles";

describe("isLaunchableFile", () => {
  test("flags shell-executed types per platform and normalizes Windows ShellExecute suffixes", async () => {
    for (const [filePath, platform, expected] of [
      ["C:\\ws\\index.js", "win32", true],
      ["C:\\ws\\Shortcut.LNK", "win32", true],
      ["C:\\ws\\build.py", "win32", true],
      ["C:\\ws\\setup.SH", "win32", true],
      ["C:\\ws\\go.hta", "win32", true],
      ["C:\\ws\\open.url", "win32", true],
      ["C:\\ws\\click.scf", "win32", true],
      ["C:\\ws\\find.search-ms", "win32", true],
      ["C:\\ws\\tune.settingcontent-ms", "win32", true],
      ["C:\\ws\\libs.library-ms", "win32", true],
      ["C:\\ws\\link.url.", "win32", true],
      ["C:\\ws\\link.url ", "win32", true],
      ["C:\\ws\\payload.HTA::$DATA", "win32", true],
      ["C:\\ws\\search.scf:hidden", "win32", true],
      ["C:\\ws\\tool.py.", "win32", true],
      ["C:\\ws\\notes.txt:evil.exe", "win32", true],
      ["C:\\ws\\notes.txt", "win32", false],
      ["C:\\ws\\launcher.desktop", "win32", false],
      ["C:\\ws\\readme.md.", "win32", false],
      ["C:\\ws\\readme.md ", "win32", false],
      ["/ws/report.command", "darwin", true],
      ["/ws/Tool.app", "darwin", true],
      ["/ws/hotkeys.ahk", "darwin", true],
      ["/ws/go.inetloc", "darwin", true],
      ["/ws/launcher.desktop", "linux", true],
      ["/ws/App.AppImage", "linux", true],
      ["/ws/install.run", "linux", true],
    ] as const) {
      expect(await isLaunchableFile(filePath, platform)).toBe(expected);
    }
  });

  test("inspects POSIX files by mode and fails closed when the file can't be read", async () => {
    const dir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "launchable-"));
    try {
      const notes = path.join(dir, "notes.md");
      const script = path.join(dir, "run");
      const command = path.join(dir, "report.command");
      const source = path.join(dir, "index.js");
      const dotted = path.join(dir, "notes.url.");
      const otherExec = path.join(dir, "helper");
      const folder = path.join(dir, "bin");
      await fs.writeFile(notes, "hi", { mode: 0o644 });
      await fs.writeFile(script, "#!/bin/sh\n", { mode: 0o755 });
      await fs.writeFile(command, "echo hi\n", { mode: 0o644 });
      await fs.writeFile(source, "export {}", { mode: 0o644 });
      await fs.writeFile(dotted, "[InternetShortcut]", { mode: 0o644 });
      await fs.writeFile(otherExec, "#!/bin/sh\n", { mode: 0o644 });
      await fs.chmod(otherExec, 0o647);
      await fs.mkdir(folder);
      await fs.chmod(folder, 0o755);

      for (const [target, platform, expected] of [
        [command, "linux", false],
        [command, "darwin", true],
        [notes, "linux", false],
        [script, "darwin", true],
        [script, "linux", true],
        [script, "win32", false],
        [source, "darwin", false],
        [source, "linux", false],
        [dotted, "darwin", false],
        [dotted, "linux", false],
        [otherExec, "linux", true],
        [otherExec, "darwin", true],
        [otherExec, "win32", false],
        [folder, "linux", false],
        [folder, "darwin", false],
        [path.join(dir, "missing-index.js"), "darwin", true],
      ] as const) {
        expect(await isLaunchableFile(target, platform)).toBe(expected);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
