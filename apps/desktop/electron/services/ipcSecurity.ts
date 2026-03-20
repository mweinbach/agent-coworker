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
 *
 * `builtinSkillRoots` should match server `builtInDir` / `COWORK_BUILTIN_DIR` (see `resolveDesktopBuiltinSkillRootsForReveal`).
 */
export function getRevealOpenPathRoots(workspaceRoots: string[], builtinSkillRoots: string[] = []): string[] {
  const home = os.homedir();
  const extra: string[] = [path.join(home, ".cowork"), path.join(home, ".agent")];
  for (const root of builtinSkillRoots) {
    const trimmed = root.trim();
    if (trimmed.length > 0) {
      extra.push(path.resolve(trimmed));
    }
  }
  return [...workspaceRoots, ...extra];
}

export function resolveAllowedRevealOrOpenPath(
  workspaceRoots: string[],
  requestedPath: string,
  builtinSkillRoots: string[] = [],
): string {
  return assertPathWithinRoots(getRevealOpenPathRoots(workspaceRoots, builtinSkillRoots), requestedPath, "path");
}

export function resolveAllowedOpenPath(
  workspaceRoots: string[],
  requestedPath: string,
  builtinSkillRoots: string[] = [],
): string {
  return resolveAllowedRevealOrOpenPath(workspaceRoots, requestedPath, builtinSkillRoots);
}
