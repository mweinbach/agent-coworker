import { existsSync } from "node:fs";
import path from "node:path";

type ResolveTrayIconPathOptions = {
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  resourcesPath?: string;
  pathExists?: (candidatePath: string) => boolean;
};

function resolveTrayIconFilename(platform: NodeJS.Platform): string {
  return platform === "win32" ? "icon.ico" : "icon.png";
}

export function resolveTrayIconPath(
  rootDir: string,
  options: ResolveTrayIconPathOptions = {},
): string {
  const isPackaged = options.isPackaged ?? process.env.COWORK_IS_PACKAGED === "true";
  const platform = options.platform ?? process.platform;
  const trayIconFilename = resolveTrayIconFilename(platform);
  if (isPackaged) {
    return path.join(options.resourcesPath ?? process.resourcesPath, "tray", trayIconFilename);
  }

  const pathExists = options.pathExists ?? existsSync;
  const candidates = [
    path.resolve(rootDir, "../../build", trayIconFilename),
    path.resolve(rootDir, "../build", trayIconFilename),
  ];
  return candidates.find((candidatePath) => pathExists(candidatePath)) ?? candidates[0];
}
