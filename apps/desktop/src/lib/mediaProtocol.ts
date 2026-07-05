import { getExtensionLower, getFilePreviewKind, mimeForPreviewKind } from "./filePreviewKind";

/**
 * `cowork-media:` serves local image files to the renderer so assistant
 * markdown can embed them inline (e.g. `![chart](/abs/path/chart.png)`).
 * URLs carry the absolute path as a query param — mirroring the existing
 * `cowork-file:` link scheme — so Windows drive letters and UNC paths survive
 * URL parsing untouched.
 */
export const DESKTOP_MEDIA_PROTOCOL_SCHEME = "cowork-media";
const DESKTOP_MEDIA_PROTOCOL = `${DESKTOP_MEDIA_PROTOCOL_SCHEME}:`;

export function isAbsoluteDesktopPath(filePath: string): boolean {
  return (
    filePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")
  );
}

export function isDesktopMediaImagePath(filePath: string): boolean {
  return getFilePreviewKind(filePath) === "image";
}

export function encodeDesktopMediaUrl(absPath: string): string | null {
  if (!isAbsoluteDesktopPath(absPath) || !isDesktopMediaImagePath(absPath)) {
    return null;
  }
  return `${DESKTOP_MEDIA_PROTOCOL}//media?path=${encodeURIComponent(absPath)}`;
}

export function decodeDesktopMediaUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== DESKTOP_MEDIA_PROTOCOL) {
      return null;
    }
    const path = parsed.searchParams.get("path");
    if (!path || !isAbsoluteDesktopPath(path) || !isDesktopMediaImagePath(path)) {
      return null;
    }
    return path;
  } catch {
    return null;
  }
}

export function desktopMediaMimeType(filePath: string): string {
  return mimeForPreviewKind("image", getExtensionLower(filePath));
}
