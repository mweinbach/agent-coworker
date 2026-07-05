import path from "node:path";
import { pathToFileURL } from "node:url";

import type * as Electron from "electron";

import {
  DESKTOP_MEDIA_PROTOCOL_SCHEME,
  decodeDesktopMediaUrl,
  desktopMediaMimeType,
  isDesktopMediaImagePath,
} from "../../src/lib/mediaProtocol";
import type { WorkspaceRootsAccess } from "../ipc/types";
import { resolveAllowedPath } from "./ipcSecurity";

/**
 * The subset of {@link WorkspaceRootsAccess} the media protocol handler needs:
 * the same approved-roots source of truth the file IPC surface
 * (openPath/readFileForPreview) validates against.
 */
export type DesktopMediaWorkspaceRoots = Pick<
  WorkspaceRootsAccess,
  "ensureApprovedWorkspaceRoots" | "getApprovedWorkspaceRoots"
>;

/**
 * Resolves a `cowork-media:` request URL to the absolute image path it may
 * serve, or null when the request is malformed, targets a non-image file, or
 * escapes the approved workspace roots (including via `..` traversal or
 * symlinks). Enforces the same boundary as the file IPC handlers
 * (`resolveAllowedPath`, which also admits the one-off chats home). Pure so
 * tests can cover it directly.
 */
export function resolveDesktopMediaRequestPath(
  requestUrl: string,
  approvedWorkspaceRoots: readonly string[],
): string | null {
  const decoded = decodeDesktopMediaUrl(requestUrl);
  if (!decoded) {
    return null;
  }
  // Normalize away any `..` traversal segments, then re-check that the file
  // we would actually read still looks like a displayable image.
  const resolved = path.resolve(decoded);
  if (!isDesktopMediaImagePath(resolved)) {
    return null;
  }
  // Rendered chat content must not read arbitrary local files: only serve
  // paths inside approved workspace roots, exactly like openPath /
  // readFileForPreview do across the IPC boundary.
  let bounded: string;
  try {
    bounded = resolveAllowedPath([...approvedWorkspaceRoots], resolved);
  } catch {
    return null;
  }
  // `resolveAllowedPath` realpath-normalizes, so a symlinked "image" could
  // resolve to a non-image target; re-validate the final path.
  if (!isDesktopMediaImagePath(bounded)) {
    return null;
  }
  return bounded;
}

/**
 * Must run before `app.whenReady()` resolves so the scheme can be fetched by
 * renderer subresources (e.g. `<img src="cowork-media://...">`).
 */
export function registerDesktopMediaSchemePrivileges(protocol: Electron.Protocol): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_MEDIA_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

export function registerDesktopMediaProtocolHandler(
  protocol: Electron.Protocol,
  net: typeof Electron.net,
  workspaceRoots: DesktopMediaWorkspaceRoots,
): void {
  protocol.handle(DESKTOP_MEDIA_PROTOCOL_SCHEME, async (request) => {
    let absPath: string | null = null;
    try {
      await workspaceRoots.ensureApprovedWorkspaceRoots();
      absPath = resolveDesktopMediaRequestPath(
        request.url,
        workspaceRoots.getApprovedWorkspaceRoots(),
      );
    } catch {
      absPath = null;
    }
    if (!absPath) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const fileResponse = await net.fetch(pathToFileURL(absPath).toString());
      if (!fileResponse.ok) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(fileResponse.body, {
        status: 200,
        headers: {
          "Content-Type": desktopMediaMimeType(absPath),
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}
