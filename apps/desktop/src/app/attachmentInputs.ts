import {
  formatAttachmentDisplayText,
  getAttachmentCountValidationMessage,
} from "../../../../src/shared/attachments";

import type { FileAttachmentInput } from "./store.helpers/jsonRpcSocket";

const BASE64_BINARY_CHUNK_SIZE = 0x8000;
const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;
type AttachmentCountLike = { length: number };

export function encodeArrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const binaryChunks: string[] = [];
  for (let index = 0; index < bytes.length; index += BASE64_BINARY_CHUNK_SIZE) {
    const chunk = bytes.subarray(index, index + BASE64_BINARY_CHUNK_SIZE);
    binaryChunks.push(String.fromCharCode(...chunk));
  }
  return btoa(binaryChunks.join(""));
}

export function buildAttachmentDisplayText(
  attachments?: readonly Pick<FileAttachmentInput, "filename">[],
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  return formatAttachmentDisplayText(attachments.map((attachment) => attachment.filename));
}

export function getAttachmentPickerValidationMessage(
  existingAttachments?: AttachmentCountLike,
  selectedFiles?: AttachmentCountLike,
): string | null {
  const totalCount = (existingAttachments?.length ?? 0) + (selectedFiles?.length ?? 0);
  if (totalCount === 0) {
    return null;
  }
  return getAttachmentCountValidationMessage(totalCount);
}

function hashString(value: string): string {
  let hash = FNV1A_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV1A_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildAttachmentSignature(attachments?: readonly FileAttachmentInput[]): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  return attachments
    .map((attachment) => {
      const payload = "contentBase64" in attachment ? attachment.contentBase64 : attachment.path;
      return `${attachment.filename}\u0000${attachment.mimeType}\u0000${hashString(payload)}`;
    })
    .join("\u0001");
}
