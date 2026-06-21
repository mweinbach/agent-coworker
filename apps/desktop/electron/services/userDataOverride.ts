import fs from "node:fs";
import path from "node:path";

import type * as Electron from "electron";

export const ELECTRON_USER_DATA_DIR_ENV = "COWORK_ELECTRON_USER_DATA_DIR";

export type ElectronUserDataDirOverrideResult =
  | { applied: false }
  | { applied: true; path: string };

type ElectronUserDataDirApp = Pick<Electron.App, "isPackaged" | "setPath">;

export function applyElectronUserDataDirOverride(
  app: ElectronUserDataDirApp,
  env: NodeJS.ProcessEnv = process.env,
): ElectronUserDataDirOverrideResult {
  const rawPath = env[ELECTRON_USER_DATA_DIR_ENV]?.trim();
  if (!rawPath) return { applied: false };

  if (app.isPackaged) {
    throw new Error(`${ELECTRON_USER_DATA_DIR_ENV} is only supported in desktop dev/test builds.`);
  }

  const resolvedPath = path.resolve(rawPath);
  fs.mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
  const canonicalPath = fs.realpathSync.native(resolvedPath);
  app.setPath("userData", canonicalPath);
  return { applied: true, path: canonicalPath };
}
