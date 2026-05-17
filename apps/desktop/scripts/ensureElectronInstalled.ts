#!/usr/bin/env bun

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type ModuleRequire = ReturnType<typeof createRequire>;

export function findInstalledElectronExecutable(electronModuleDir: string): string | null {
  const pathFile = path.join(electronModuleDir, "path.txt");
  if (!fs.existsSync(pathFile)) {
    return null;
  }

  const executablePath = fs.readFileSync(pathFile, "utf8").trim();
  if (!executablePath) {
    return null;
  }

  const electronPath = path.join(electronModuleDir, "dist", executablePath);
  return fs.existsSync(electronPath) ? electronPath : null;
}

function ensureElectronInstalledWithRequire(moduleRequire: ModuleRequire, label: string): string {
  const electronEntryPath = moduleRequire.resolve("electron");
  const electronModuleDir = path.dirname(electronEntryPath);
  const installedPath = findInstalledElectronExecutable(electronModuleDir);
  if (installedPath) {
    process.env.ELECTRON_EXEC_PATH = installedPath;
    return installedPath;
  }

  console.log(`[desktop] Electron runtime missing for ${label}; installing Electron runtime...`);
  const electronPath = moduleRequire("electron") as unknown;
  if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
    throw new Error("Electron runtime install completed without a usable executable path");
  }

  process.env.ELECTRON_EXEC_PATH = electronPath;
  console.log(`[desktop] Electron runtime ready: ${electronPath}`);
  return electronPath;
}

export function ensureElectronInstalled(requireUrl = import.meta.url): string[] {
  const baseRequire = createRequire(requireUrl);
  const workspaceElectronVitePath = path.resolve(
    import.meta.dir,
    "../../../node_modules/electron-vite/bin/electron-vite.js",
  );
  const resolvers: Array<{ label: string; require: ModuleRequire }> = [
    { label: "desktop app", require: baseRequire },
  ];

  if (fs.existsSync(workspaceElectronVitePath)) {
    resolvers.push({
      label: "workspace electron-vite",
      require: createRequire(workspaceElectronVitePath),
    });
  }

  try {
    const electronViteEntryPath = baseRequire.resolve("electron-vite");
    resolvers.push({ label: "electron-vite", require: createRequire(electronViteEntryPath) });
  } catch {
    // electron-vite is not needed for callers that only want the app-local Electron runtime.
  }

  const seenModuleDirs = new Set<string>();
  const executablePaths: string[] = [];
  for (const resolver of resolvers) {
    const electronModuleDir = path.dirname(resolver.require.resolve("electron"));
    if (seenModuleDirs.has(electronModuleDir)) {
      continue;
    }
    seenModuleDirs.add(electronModuleDir);
    executablePaths.push(ensureElectronInstalledWithRequire(resolver.require, resolver.label));
  }

  return executablePaths;
}

if (import.meta.main) {
  ensureElectronInstalled();
}
