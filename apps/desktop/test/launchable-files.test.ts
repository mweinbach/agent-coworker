import { describe, expect, test } from "bun:test";

import { isLaunchableFile } from "../electron/services/launchableFiles";

describe("isLaunchableFile", () => {
  test("flags shell-executed types per platform", async () => {
    expect(await isLaunchableFile("C:\\ws\\index.js", "win32")).toBe(true);
    expect(await isLaunchableFile("C:\\ws\\Shortcut.LNK", "win32")).toBe(true);
    expect(await isLaunchableFile("C:\\ws\\notes.txt", "win32")).toBe(false);

    expect(await isLaunchableFile("/ws/report.command", "darwin")).toBe(true);
    expect(await isLaunchableFile("/ws/Tool.app", "darwin")).toBe(true);
    expect(await isLaunchableFile("/ws/missing-index.js", "darwin")).toBe(false);

    expect(await isLaunchableFile("/ws/launcher.desktop", "linux")).toBe(true);
    expect(await isLaunchableFile("/ws/missing-notes.md", "linux")).toBe(false);

    // Script types a file association may run directly count on every platform.
    expect(await isLaunchableFile("C:\\ws\\build.py", "win32")).toBe(true);
    expect(await isLaunchableFile("C:\\ws\\setup.SH", "win32")).toBe(true);
    expect(await isLaunchableFile("/ws/hotkeys.ahk", "darwin")).toBe(true);
  });
});
