import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findInstalledElectronExecutable } from "../scripts/ensureElectronInstalled";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

function readInstalledPackageManifest(packageName: string): {
  version: string;
  peerDependencies?: Record<string, string>;
} {
  return JSON.parse(fs.readFileSync(require.resolve(`${packageName}/package.json`), "utf8"));
}

describe("Electron startup preflight", () => {
  test("uses an electron-vite release compatible with the installed Vite version", () => {
    const electronVite = readInstalledPackageManifest("electron-vite");
    const vite = readInstalledPackageManifest("vite");
    const supportedViteRange = electronVite.peerDependencies?.vite;

    expect(supportedViteRange).toBeDefined();
    expect(Bun.semver.satisfies(vite.version, supportedViteRange ?? "")).toBeTrue();
  });

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
