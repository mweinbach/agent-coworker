import os from "node:os";
import path from "node:path";

import { resolveDesktopRendererUrl } from "./rendererUrl";
import { assertPathWithinRoots } from "./validation";

type TrustedSenderOpts = {
  isPackaged: boolean;
  electronRendererUrl: string | undefined;
  desktopRendererPort: string | undefined;
};

export function isTrustedDesktopSenderUrl(senderUrl: string, opts: TrustedSenderOpts): boolean {
  if (!senderUrl) {
    return false;
  }

  if (opts.isPackaged) {
    return senderUrl.startsWith("file://");
  }

  const { url: trustedUrl } = resolveDesktopRendererUrl(opts.electronRendererUrl, opts.desktopRendererPort);

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

export function resolveAllowedDirectoryPath(workspaceRoots: string[], requestedPath: string): string {
  return assertPathWithinRoots(workspaceRoots, requestedPath, "path");
}

export function resolveAllowedPath(workspaceRoots: string[], requestedPath: string): string {
  return assertPathWithinRoots(workspaceRoots, requestedPath, "path");
}

/**
 * Workspace roots plus Cowork agent homes where skills and config commonly live.
 * Used for `revealPath` and `openPath` targets outside the active workspace
 * (e.g. ~/.cowork/skills, ~/.agent/skills).
 */
export function getRevealOpenPathRoots(workspaceRoots: string[]): string[] {
  const home = os.homedir();
  const extra: string[] = [path.join(home, ".cowork"), path.join(home, ".agent")];
  const builtin = process.env.COWORK_BUILTIN_DIR?.trim();
  if (builtin) {
    extra.push(path.resolve(builtin));
  }
  return [...workspaceRoots, ...extra];
}

export function resolveAllowedRevealOrOpenPath(workspaceRoots: string[], requestedPath: string): string {
  return assertPathWithinRoots(getRevealOpenPathRoots(workspaceRoots), requestedPath, "path");
}

export function resolveAllowedOpenPath(workspaceRoots: string[], requestedPath: string): string {
  return resolveAllowedRevealOrOpenPath(workspaceRoots, requestedPath);
}
