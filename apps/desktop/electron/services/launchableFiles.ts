import fs from "node:fs/promises";
import path from "node:path";

import { hostPlatform } from "../../../../src/platform/host";

// Extensions the OS shell executes (or hands to an interpreter/installer) instead of opening as a
// document. Kept per platform so ordinary files, like `.js` on macOS, don't prompt needlessly.
const WINDOWS_LAUNCHABLE_EXTENSIONS = new Set([
  ".appref-ms",
  ".application",
  ".bat",
  ".cmd",
  ".com",
  ".cpl",
  ".exe",
  ".gadget",
  ".hta",
  ".inf",
  ".jar",
  ".js",
  ".jse",
  ".library-ms",
  ".lnk",
  ".msc",
  ".msi",
  ".msix",
  ".msp",
  ".pif",
  ".ps1",
  ".reg",
  ".scf",
  ".scr",
  ".search-ms",
  ".settingcontent-ms",
  ".url",
  ".vbe",
  ".vbs",
  ".ws",
  ".wsc",
  ".wsf",
  ".wsh",
]);

const DARWIN_LAUNCHABLE_EXTENSIONS = new Set([
  ".action",
  ".app",
  ".applescript",
  ".command",
  ".fileloc",
  ".inetloc",
  ".jar",
  ".mpkg",
  ".pkg",
  ".prefpane",
  ".scpt",
  ".scptd",
  ".terminal",
  ".tool",
  ".webloc",
  ".workflow",
]);

const LINUX_LAUNCHABLE_EXTENSIONS = new Set([".appimage", ".desktop", ".jar", ".run"]);

// Interpreted scripts: a user's file association (Python launcher, Git Bash, AutoHotkey, ...)
// can run these directly, and we can't cheaply inspect that association, so always confirm.
const SCRIPT_EXTENSIONS = new Set([
  ".ahk",
  ".au3",
  ".bash",
  ".csh",
  ".fish",
  ".ksh",
  ".lua",
  ".php",
  ".pl",
  ".pm",
  ".psm1",
  ".py",
  ".pyc",
  ".pyw",
  ".pyz",
  ".r",
  ".rb",
  ".sh",
  ".tcl",
  ".zsh",
]);

function launchableExtensionsFor(platform: NodeJS.Platform): ReadonlySet<string> {
  switch (platform) {
    case "win32":
      return WINDOWS_LAUNCHABLE_EXTENSIONS;
    case "darwin":
      return DARWIN_LAUNCHABLE_EXTENSIONS;
    default:
      return LINUX_LAUNCHABLE_EXTENSIONS;
  }
}

/**
 * Whether handing `filePath` to `shell.openPath` would run code rather than open a document.
 * Agent tools can write into the workspace (inside their sandbox), and opening such a file from
 * the app runs it outside that sandbox, so callers must confirm with the user first. On POSIX a
 * regular file with any execute bit counts too: macOS opens those in Terminal and runs them.
 */
export async function isLaunchableFile(
  filePath: string,
  platform: NodeJS.Platform = hostPlatform(),
): Promise<boolean> {
  const extension = path.extname(filePath).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension) || launchableExtensionsFor(platform).has(extension)) {
    return true;
  }
  if (platform === "win32") {
    return false;
  }
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
