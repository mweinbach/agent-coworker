import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findInstalledElectronExecutable } from "../scripts/ensureElectronInstalled";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

describe("Electron startup preflight", () => {
  test("runs before electron-vite launch commands", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts["electron:ensure"]).toBe("bun scripts/ensureElectronInstalled.ts");
    expect(manifest.scripts.dev).toContain(
      "bun run electron:ensure && bun run electron-vite -- dev",
    );
    expect(manifest.scripts.preview).toContain(
      "bun run electron:ensure && bun run electron-vite -- preview",
    );
    expect(manifest.scripts.build).toContain(
      "bun run electron:ensure && bun run electron-vite -- build",
    );
    expect(manifest.scripts["build:dir"]).toContain(
      "bun run electron:ensure && bun run electron-vite -- build",
    );
  });

  test("detects when Electron's executable is missing", () => {
    const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-electron-preflight-"));
    fs.writeFileSync(path.join(moduleDir, "path.txt"), "Electron.app/Contents/MacOS/Electron");

    try {
      expect(findInstalledElectronExecutable(moduleDir)).toBeNull();
    } finally {
      fs.rmSync(moduleDir, { force: true, recursive: true });
    }
  });

  test("returns Electron executable path when path.txt and binary are present", () => {
    const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-electron-preflight-"));
    const executablePath = path.join(moduleDir, "dist", "Electron.app", "Contents", "MacOS");
    fs.mkdirSync(executablePath, { recursive: true });
    fs.writeFileSync(path.join(executablePath, "Electron"), "");
    fs.writeFileSync(path.join(moduleDir, "path.txt"), "Electron.app/Contents/MacOS/Electron");

    try {
      expect(findInstalledElectronExecutable(moduleDir)).toBe(
        path.join(moduleDir, "dist", "Electron.app", "Contents", "MacOS", "Electron"),
      );
    } finally {
      fs.rmSync(moduleDir, { force: true, recursive: true });
    }
  });
});
