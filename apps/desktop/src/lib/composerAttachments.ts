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
  signature: string;
};

export function createComposerAttachmentFile(file: File): ComposerAttachmentFile {
  return {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    file,
    signature: `${file.name}\u0000${file.type}\u0000${file.size}\u0000${file.lastModified}`,
  };
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

export type PreparedComposerMessage = {
  text: string;
  attachments: FileAttachmentInput[] | undefined;
};

type DesktopUploadAttempt =
  | { attempted: false }
  | { attempted: true; uploaded: { filename: string; path: string } }
  | { attempted: true; error: string };

type ResolveComposerAttachmentOptions = {
  threadId?: string | null;
};

export async function resolveComposerAttachmentsForWorkspace(
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  attachments: readonly ComposerAttachmentFile[],
  options: ResolveComposerAttachmentOptions = {},
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

    const canInline =
      attachment.size <= MAX_ATTACHMENT_INLINE_BYTE_SIZE &&
      inlineByteLength + attachment.size <= MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE;
    if (canInline) {
      const buffer = await attachment.file.arrayBuffer();
      const base64 = encodeArrayBufferToBase64(buffer);
      inlineByteLength += attachment.size;
      resolvedAttachments.push({
        filename: attachment.filename,
        contentBase64: base64,
        mimeType: attachment.mimeType,
      });
      continue;
    }

    const desktopUpload = await tryCopyDesktopAttachmentToWorkspaceUploads(
      get,
      workspaceId,
      attachment,
      options.threadId ?? null,
    );
    let desktopUploadError: string | null = null;
    if (desktopUpload.attempted) {
      if ("uploaded" in desktopUpload) {
        resolvedAttachments.push({
          filename: desktopUpload.uploaded.filename,
          path: desktopUpload.uploaded.path,
          mimeType: attachment.mimeType,
        });
        continue;
      } else {
        desktopUploadError = desktopUpload.error;
      }
    }

    const buffer = await attachment.file.arrayBuffer();
    const base64 = encodeArrayBufferToBase64(buffer);
    const uploaded = await uploadJsonRpcWorkspaceFile(
      get,
      set,
      workspaceId,
      attachment.filename,
      base64,
    );
    if (!uploaded.path) {
      const reason = desktopUploadError
        ? `${desktopUploadError}; upload to the project folder failed`
        : "upload to the project folder failed";
      skippedNotes.push(buildAttachmentSkippedNote(attachment.filename, reason));
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

/**
 * Canonical attachment send policy for existing and new chats:
 * valid files are included, files rejected by a documented upload limit are
 * represented by an inline note, and infrastructure/read failures reject the
 * preparation so the revision-owned draft can be retried intact.
 */
export async function prepareComposerMessageForWorkspace(
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  text: string,
  attachments: readonly ComposerAttachmentFile[],
  options: ResolveComposerAttachmentOptions = {},
): Promise<PreparedComposerMessage> {
  if (attachments.length === 0) {
    return { text, attachments: undefined };
  }
  const resolved = await resolveComposerAttachmentsForWorkspace(
    get,
    set,
    workspaceId,
    attachments,
    options,
  );
  return {
    text: appendAttachmentSkippedNotes(text, resolved.skippedNotes),
    attachments: resolved.attachments.length > 0 ? resolved.attachments : undefined,
  };
}

async function tryCopyDesktopAttachmentToWorkspaceUploads(
  get: StoreGet,
  workspaceId: string,
  attachment: ComposerAttachmentFile,
  threadId: string | null,
): Promise<DesktopUploadAttempt> {
  const desktopApi = typeof window === "undefined" ? undefined : window.cowork;
  if (!desktopApi?.getPathForFile || !desktopApi.copyFileToWorkspaceUploads) {
    return { attempted: false };
  }

  const workspace = get().workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace?.path) {
    return { attempted: false };
  }

  const sourcePath = await desktopApi.getPathForFile(attachment.file);
  if (!sourcePath) {
    return { attempted: false };
  }

  try {
    const uploadsDirectory = resolveWorkspaceUploadsDirectory(get, workspaceId, threadId);
    const uploaded = await desktopApi.copyFileToWorkspaceUploads({
      workspacePath: workspace.path,
      sourcePath,
      filename: attachment.filename,
      ...(uploadsDirectory ? { uploadsDirectory } : {}),
    });
    return { attempted: true, uploaded };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      error: detail ? `copy to the project upload folder failed: ${detail}` : "copy failed",
    };
  }
}

function resolveWorkspaceUploadsDirectory(
  get: StoreGet,
  workspaceId: string,
  threadId: string | null,
): string | null {
  const state = get();
  const runtime = state.workspaceRuntimeById[workspaceId];
  const targetThreadId =
    threadId && state.threads.find((thread) => thread.id === threadId)?.workspaceId === workspaceId
      ? threadId
      : null;
  const threadRuntime = targetThreadId ? state.threadRuntimeById[targetThreadId] : null;
  const candidates: unknown[] = [
    threadRuntime?.sessionConfig,
    threadRuntime?.config,
    runtime?.controlSessionConfig,
    runtime?.controlConfig,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const value = (candidate as { uploadsDirectory?: unknown }).uploadsDirectory;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
