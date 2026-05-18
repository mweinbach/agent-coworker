import {
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE,
} from "../../../../src/shared/attachments";
import {
  encodeArrayBufferToBase64,
  getAttachmentUploadValidationMessage,
} from "../app/attachmentInputs";
import type { StoreGet, StoreSet } from "../app/store.helpers";
import type { FileAttachmentInput } from "../app/store.helpers/jsonRpcSocket";
import { uploadJsonRpcWorkspaceFile } from "../app/store.helpers/jsonRpcSocket";

export type ComposerAttachmentFile = {
  filename: string;
  mimeType: string;
  size: number;
  file: File;
  previewUrl?: string;
  signature: string;
};

export function createComposerAttachmentFile(file: File): ComposerAttachmentFile {
  const previewUrl =
    file.type.startsWith("image/") && file instanceof Blob ? URL.createObjectURL(file) : undefined;
  return {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    file,
    previewUrl,
    signature: `${file.name}\u0000${file.type}\u0000${file.size}\u0000${file.lastModified}`,
  };
}

export function revokeComposerAttachmentPreview(attachment: ComposerAttachmentFile) {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function buildComposerAttachmentSignature(
  attachments: readonly ComposerAttachmentFile[],
): string {
  if (attachments.length === 0) {
    return "";
  }
  return attachments
    .map(
      (attachment) =>
        `${attachment.filename}\u0000${attachment.mimeType}\u0000${attachment.signature}`,
    )
    .join("\u0001");
}

export function buildAttachmentSkippedNote(filename: string, reason: string): string {
  return `[The user wanted to attach "${filename}" but it could not be included: ${reason}]`;
}

export function appendAttachmentSkippedNotes(
  message: string,
  skippedNotes: readonly string[],
): string {
  if (skippedNotes.length === 0) {
    return message;
  }
  const notesBlock = skippedNotes.join("\n");
  const trimmed = message.trim();
  return trimmed ? `${trimmed}\n\n${notesBlock}` : notesBlock;
}

export type ResolvedComposerAttachments = {
  attachments: FileAttachmentInput[];
  skippedNotes: string[];
};

export async function resolveComposerAttachmentsForWorkspace(
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  attachments: readonly ComposerAttachmentFile[],
): Promise<ResolvedComposerAttachments> {
  let inlineByteLength = 0;
  const resolvedAttachments: FileAttachmentInput[] = [];
  const skippedNotes: string[] = [];

  for (const attachment of attachments) {
    const uploadValidationMessage = getAttachmentUploadValidationMessage(attachment.size);
    if (uploadValidationMessage) {
      skippedNotes.push(buildAttachmentSkippedNote(attachment.filename, uploadValidationMessage));
      continue;
    }

    const buffer = await attachment.file.arrayBuffer();
    const base64 = encodeArrayBufferToBase64(buffer);
    const canInline =
      attachment.size <= MAX_ATTACHMENT_INLINE_BYTE_SIZE &&
      inlineByteLength + attachment.size <= MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE;
    if (canInline) {
      inlineByteLength += attachment.size;
      resolvedAttachments.push({
        filename: attachment.filename,
        contentBase64: base64,
        mimeType: attachment.mimeType,
      });
      continue;
    }

    const uploaded = await uploadJsonRpcWorkspaceFile(
      get,
      set,
      workspaceId,
      attachment.filename,
      base64,
    );
    if (!uploaded.path) {
      skippedNotes.push(
        buildAttachmentSkippedNote(attachment.filename, "upload to the project folder failed"),
      );
      continue;
    }
    resolvedAttachments.push({
      filename: uploaded.filename,
      path: uploaded.path,
      mimeType: attachment.mimeType,
    });
  }

  return { attachments: resolvedAttachments, skippedNotes };
}
