import path from "node:path";

import type { AgentConfig } from "../types";

export type MultimodalContentPartType = "image" | "audio" | "video" | "document";

export function isGoogleMultimodalProvider(config: Pick<AgentConfig, "provider">): boolean {
  return config.provider === "google";
}

export function mimeTypeFromPath(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".avi":
      return "video/x-msvideo";
    case ".mkv":
      return "video/x-matroska";
    case ".pdf":
      return "application/pdf";
    default:
      return null;
  }
}

export function isBinaryMediaMimeType(mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  return (
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime === "application/pdf"
  );
}

export function googleMultimodalPartTypeForMime(
  mimeType: string,
  opts: { modelSupportsImages: boolean; isGoogleProvider: boolean },
): MultimodalContentPartType | null {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) {
    return opts.modelSupportsImages ? "image" : null;
  }
  if (!opts.isGoogleProvider) {
    return null;
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime === "application/pdf") {
    return "document";
  }
  return null;
}

export function multimodalPartLabel(partType: MultimodalContentPartType): string {
  switch (partType) {
    case "image":
      return "Image";
    case "audio":
      return "Audio";
    case "video":
      return "Video";
    case "document":
      return "PDF";
  }
}
