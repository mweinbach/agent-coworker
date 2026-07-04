import path from "node:path";
import { pathToFileURL } from "node:url";

import type * as Electron from "electron";

import {
  DESKTOP_MEDIA_PROTOCOL_SCHEME,
  decodeDesktopMediaUrl,
  desktopMediaMimeType,
  isDesktopMediaImagePath,
} from "../../src/lib/mediaProtocol";

/**
 * Resolves a `cowork-media:` request URL to the absolute image path it may
 * serve, or null when the request is malformed, escapes via traversal
 * segments, or targets a non-image file. Pure so tests can cover it directly.
 */
export function resolveDesktopMediaRequestPath(requestUrl: string): string | null {
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
  return resolved;
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
): void {
  protocol.handle(DESKTOP_MEDIA_PROTOCOL_SCHEME, async (request) => {
    const absPath = resolveDesktopMediaRequestPath(request.url);
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
