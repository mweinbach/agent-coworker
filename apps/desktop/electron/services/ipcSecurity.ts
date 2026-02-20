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
