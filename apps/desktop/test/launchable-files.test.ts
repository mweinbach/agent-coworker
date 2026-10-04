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
    expect(await isLaunchableFile("/ws/go.inetloc", "darwin")).toBe(true);
    expect(await isLaunchableFile("/ws/App.AppImage", "linux")).toBe(true);
    expect(await isLaunchableFile("/ws/install.run", "linux")).toBe(true);
    // A Linux desktop entry is not a Windows program, so it does not confirm there.
    expect(await isLaunchableFile("C:\\ws\\launcher.desktop", "win32")).toBe(false);
  });

  test("confirms the Windows name ShellExecute opens, not only the raw suffix", async () => {
    for (const filePath of [
      "C:\\ws\\go.hta",
      "C:\\ws\\open.url",
      "C:\\ws\\click.scf",
      "C:\\ws\\find.search-ms",
      "C:\\ws\\tune.settingcontent-ms",
      "C:\\ws\\libs.library-ms",
      "C:\\ws\\link.url.",
      "C:\\ws\\link.url ",
      "C:\\ws\\payload.HTA::$DATA",
      "C:\\ws\\search.scf:hidden",
      "C:\\ws\\tool.py.",
      "C:\\ws\\notes.txt:evil.exe",
    ]) {
      expect(await isLaunchableFile(filePath, "win32")).toBe(true);
    }
    expect(await isLaunchableFile("C:\\ws\\readme.md.", "win32")).toBe(false);
    expect(await isLaunchableFile("C:\\ws\\readme.md ", "win32")).toBe(false);
  });

  test("inspects POSIX files by mode and fails closed when the file can't be read", async () => {
    const dir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "launchable-"));
    try {
      const notes = path.join(dir, "notes.md");
      const script = path.join(dir, "run");
      const command = path.join(dir, "report.command");
      await fs.writeFile(notes, "hi", { mode: 0o644 });
      await fs.writeFile(script, "#!/bin/sh\n", { mode: 0o755 });
      await fs.writeFile(command, "echo hi\n", { mode: 0o644 });
      // macOS runs `.command`; the same non-executable file on Linux is a document.
      expect(await isLaunchableFile(command, "linux")).toBe(false);
      expect(await isLaunchableFile(command, "darwin")).toBe(true);
      expect(await isLaunchableFile(notes, "linux")).toBe(false);
      expect(await isLaunchableFile(script, "darwin")).toBe(true);
      // Ordinary source is not a macOS/Linux program just because Windows executes `.js`.
      const source = path.join(dir, "index.js");
      await fs.writeFile(source, "export {}", { mode: 0o644 });
      expect(await isLaunchableFile(source, "darwin")).toBe(false);
      expect(await isLaunchableFile(source, "linux")).toBe(false);
      // A trailing dot is part of the POSIX name, not a Windows-stripped `.url`.
      const dotted = path.join(dir, "notes.url.");
      await fs.writeFile(dotted, "[InternetShortcut]", { mode: 0o644 });
      expect(await isLaunchableFile(dotted, "darwin")).toBe(false);
      expect(await isLaunchableFile(dotted, "linux")).toBe(false);
      expect(await isLaunchableFile(script, "linux")).toBe(true);
      // Windows confirms by extension. The same no-extension executable is a document there.
      expect(await isLaunchableFile(script, "win32")).toBe(false);
      // Any execute bit counts, not only the owner's. Group/other +x still opens in Terminal.
      const otherExec = path.join(dir, "helper");
      await fs.writeFile(otherExec, "#!/bin/sh\n", { mode: 0o644 });
      await fs.chmod(otherExec, 0o647);
      expect(await isLaunchableFile(otherExec, "linux")).toBe(true);
      expect(await isLaunchableFile(otherExec, "darwin")).toBe(true);
      expect(await isLaunchableFile(otherExec, "win32")).toBe(false);
      // A directory is executable in the POSIX sense and must not prompt as a launched program.
      const folder = path.join(dir, "bin");
      await fs.mkdir(folder);
      await fs.chmod(folder, 0o755);
      expect(await isLaunchableFile(folder, "linux")).toBe(false);
      expect(await isLaunchableFile(folder, "darwin")).toBe(false);
      // A path that vanished may be recreated as an executable before the shell opens it.
      expect(await isLaunchableFile(path.join(dir, "missing-index.js"), "darwin")).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
