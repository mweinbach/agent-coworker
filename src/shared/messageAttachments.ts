import { supportsImageInput } from "../models/registry";
import type { ProviderName } from "../types";

export const USER_MESSAGE_ATTACHMENT_MAX_BASE64_SIZE = 10 * 1024 * 1024;

export const USER_MESSAGE_ATTACHMENT_KINDS = [
  "image",
  "audio",
  "video",
  "document",
] as const;

export type UserMessageAttachmentKind = (typeof USER_MESSAGE_ATTACHMENT_KINDS)[number];

export type UserMessageAttachmentDraft = {
  filename: string;
  mimeType: string;
  contentBase64: string;
};

export type UserMessageAttachment = {
  filename: string;
  mimeType: string;
  kind: UserMessageAttachmentKind;
  path?: string;
};

const GOOGLE_AUDIO_MIME_TYPES = new Set([
  "audio/wav",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
]);

const GOOGLE_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/mpeg",
  "video/mpg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/webm",
  "video/wmv",
  "video/3gpp",
]);

const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".wav": "audio/wav",
  ".mp3": "audio/mp3",
  ".aiff": "audio/aiff",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpg",
  ".mov": "video/mov",
  ".avi": "video/avi",
  ".flv": "video/x-flv",
  ".webm": "video/webm",
  ".wmv": "video/wmv",
  ".3gp": "video/3gpp",
  ".3gpp": "video/3gpp",
};

export function normalizeUserMessageAttachmentMimeType(mimeType: string): string {
  return mimeType.trim().toLowerCase();
}

export function inferUserMessageAttachmentMimeType(filename: string, mimeType?: string | null): string | null {
  const normalizedMimeType = mimeType ? normalizeUserMessageAttachmentMimeType(mimeType) : "";
  if (normalizedMimeType) return normalizedMimeType;

  const lastDotIndex = filename.lastIndexOf(".");
  if (lastDotIndex < 0) return null;
  const extension = filename.slice(lastDotIndex).toLowerCase();
  return EXTENSION_TO_MIME_TYPE[extension] ?? null;
}

export function classifyUserMessageAttachmentKind(mimeType: string): UserMessageAttachmentKind | null {
  const normalized = normalizeUserMessageAttachmentMimeType(mimeType);
  if (!normalized) return null;
  if (normalized.startsWith("image/")) return "image";
  if (GOOGLE_AUDIO_MIME_TYPES.has(normalized)) return "audio";
  if (GOOGLE_VIDEO_MIME_TYPES.has(normalized)) return "video";
  if (normalized === "application/pdf") return "document";
  return null;
}

export function supportsUserMessageAttachments(provider: ProviderName, modelId: string): boolean {
  return supportedUserMessageAttachmentKinds(provider, modelId).length > 0;
}

export function supportedUserMessageAttachmentKinds(
  provider: ProviderName,
  modelId: string,
): UserMessageAttachmentKind[] {
  const supported: UserMessageAttachmentKind[] = [];
  if (supportsImageInput(provider, modelId)) {
    supported.push("image");
  }
  if (provider === "google") {
    supported.push("audio", "video", "document");
  }
  return supported;
}

export function supportsUserMessageAttachmentMimeType(
  provider: ProviderName,
  modelId: string,
  mimeType: string,
): boolean {
  const kind = classifyUserMessageAttachmentKind(mimeType);
  if (!kind) return false;
  return supportedUserMessageAttachmentKinds(provider, modelId).includes(kind);
}

export function describeSupportedUserMessageAttachments(
  provider: ProviderName,
  modelId: string,
): string {
  const supportedKinds = supportedUserMessageAttachmentKinds(provider, modelId);
  if (supportedKinds.length === 0) return "none";
  return supportedKinds.join(", ");
}
