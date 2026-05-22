import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPathEqualOrInside } from "./pathBoundary";
import { resolveDesktopRendererUrl } from "./rendererUrl";
import { assertPathWithinRoots } from "./validation";

type TrustedSenderOpts = {
  isPackaged: boolean;
  electronRendererUrl: string | undefined;
  desktopRendererPort: string | undefined;
  packagedRendererDir?: string;
};

export function isTrustedDesktopSenderUrl(senderUrl: string, opts: TrustedSenderOpts): boolean {
  if (!senderUrl) {
    return false;
  }

  if (opts.isPackaged) {
    if (!senderUrl.startsWith("file://")) {
      return false;
    }
    if (!opts.packagedRendererDir) {
      return false;
    }
    try {
      const parsed = new URL(senderUrl);
      if (parsed.protocol !== "file:") {
        return false;
      }
      const resolvedPath = path.resolve(fileURLToPath(parsed));
      return isPathEqualOrInside(opts.packagedRendererDir, resolvedPath);
    } catch {
      return false;
    }
  }

  const { url: trustedUrl } = resolveDesktopRendererUrl(
    opts.electronRendererUrl,
    opts.desktopRendererPort,
  );

  try {
    const sender = new URL(senderUrl);
    const trusted = new URL(trustedUrl);
    return (
      sender.protocol === trusted.protocol &&
      sender.hostname === trusted.hostname &&
      sender.port === trusted.port
    );
  } catch {
    return false;
  }
}

export function resolveAllowedDirectoryPath(
  workspaceRoots: string[],
  requestedPath: string,
): string {
  return assertPathWithinRoots(workspaceRoots, requestedPath, "path");
}

export function resolveAllowedPath(workspaceRoots: string[], requestedPath: string): string {
  return assertPathWithinRoots(workspaceRoots, requestedPath, "path");
}

export function getSaveExportSourceRoots(workspaceRoots: string[]): string[] {
  const home = os.homedir();
  return [...workspaceRoots, path.join(home, ".cowork", "research")];
}

export function resolveAllowedSaveExportSourcePath(
  workspaceRoots: string[],
  requestedPath: string,
): string {
  return assertPathWithinRoots(getSaveExportSourceRoots(workspaceRoots), requestedPath, "path");
}

/**
 * Workspace roots plus Cowork agent homes where skills and config commonly live.
 * Used for `revealPath` targets outside the active workspace
 * (e.g. ~/.cowork/skills).
 *
 * `builtinSkillRoots` should match server `builtInDir` / `COWORK_BUILTIN_DIR`
 * (see `resolveDesktopBuiltinSkillRootsForReveal`); pass a freshly resolved list
 * per invocation so env / packaged paths stay accurate.
 */
export function getRevealPathRoots(
  workspaceRoots: string[],
  builtinSkillRoots: string[] = [],
): string[] {
  const home = os.homedir();
  const extra: string[] = [path.join(home, ".cowork")];
  for (const root of builtinSkillRoots) {
    const trimmed = root.trim();
    if (trimmed.length > 0) {
      extra.push(path.resolve(trimmed));
    }
  }
  return [...workspaceRoots, ...extra];
}

/**
 * Validates paths for reveal-in-folder IPC.
 * Unlike `shell.openPath`, `shell.showItemInFolder` only opens the file manager,
 * so reveal can safely allow skill/config homes outside the active workspace.
 */
export function resolveAllowedRevealPath(
  workspaceRoots: string[],
  requestedPath: string,
  builtinSkillRoots: string[] = [],
): string {
  return assertPathWithinRoots(
    getRevealPathRoots(workspaceRoots, builtinSkillRoots),
    requestedPath,
    "path",
  );
}
