import {
  formatAttachmentDisplayText,
  getAttachmentCountValidationMessage,
  getAttachmentUploadByteLengthValidationMessage,
} from "../../../../src/shared/attachments";

import type { FileAttachmentInput } from "./store.helpers/jsonRpcSocket";

const BASE64_BINARY_CHUNK_SIZE = 0x8000;
const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;
type AttachmentCountLike = { length: number };
type AttachmentSizeLike = { size: number };
type AttachmentValidationInput = AttachmentCountLike | readonly AttachmentSizeLike[];

function getAttachmentLength(input?: AttachmentValidationInput): number {
  return Array.isArray(input) ? input.length : input?.length ?? 0;
}

function getAttachmentByteLengths(input?: AttachmentValidationInput): number[] {
  return Array.isArray(input) ? input.map((attachment) => attachment.size) : [];
}

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
  existingAttachments?: AttachmentValidationInput,
  selectedFiles?: AttachmentValidationInput,
): string | null {
  const totalCount = getAttachmentLength(existingAttachments) + getAttachmentLength(selectedFiles);
  if (totalCount === 0) {
    return null;
  }
  return getAttachmentCountValidationMessage(totalCount)
    ?? getAttachmentUploadByteLengthValidationMessage([
      ...getAttachmentByteLengths(existingAttachments),
      ...getAttachmentByteLengths(selectedFiles),
    ]);
}

export function getAttachmentUploadValidationMessage(byteLength: number): string | null {
  return getAttachmentUploadByteLengthValidationMessage([byteLength]);
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
