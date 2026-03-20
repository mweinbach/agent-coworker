import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

/**
 * Bundled harness assets (prompts, built-in skills) for packaged desktop builds.
 * Passed to the sidecar as `COWORK_BUILTIN_DIR`; must stay in sync with `ServerManager` spawn env.
 */
export function resolvePackagedBuiltinDistDir(): string | null {
  if (!app.isPackaged) {
    return null;
  }
  const dist = path.join(process.resourcesPath, "dist");
  return fs.existsSync(dist) ? dist : null;
}

/**
 * Directories that contain built-in / bundled skills for IPC `openPath` / `revealPath` allowlisting.
 * Includes `process.env.COWORK_BUILTIN_DIR` when set, and the packaged dist dir when running from an `.app` / installer.
 */
export function resolveDesktopBuiltinSkillRootsForReveal(): string[] {
  const roots: string[] = [];
  const fromEnv = process.env.COWORK_BUILTIN_DIR?.trim();
  if (fromEnv) {
    roots.push(path.resolve(fromEnv));
  }
  const packaged = resolvePackagedBuiltinDistDir();
  if (packaged) {
    const resolved = path.resolve(packaged);
    if (!roots.some((existing) => path.resolve(existing) === resolved)) {
      roots.push(resolved);
    }
  }
  return roots;
}
