export const MAX_TURN_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_INLINE_BYTE_SIZE = 25 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_UPLOAD_BYTE_SIZE = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_BASE64_SIZE = getBase64SizeFromByteLength(
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
);

function getBase64SizeFromByteLength(byteLength: number): number {
  return Math.ceil(Math.max(0, byteLength) / 3) * 4;
}

export function getAttachmentCountValidationMessage(count?: number): string | null {
  if ((count ?? 0) > MAX_TURN_ATTACHMENT_COUNT) {
    return `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`;
  }
  return null;
}

export function getAttachmentUploadByteLengthValidationMessage(
  byteLengths?: readonly number[],
): string | null {
  if (!byteLengths || byteLengths.length === 0) {
    return null;
  }

  for (const byteLength of byteLengths) {
    if (byteLength > MAX_ATTACHMENT_UPLOAD_BYTE_SIZE) {
      return "File too large to upload (max 100MB)";
    }
  }

  return null;
}

function getAttachmentTotalBase64Size(
  attachments?: readonly Pick<{ contentBase64: string }, "contentBase64">[],
): number {
  if (!attachments || attachments.length === 0) {
    return 0;
  }
  return attachments.reduce((total, attachment) => total + attachment.contentBase64.length, 0);
}

function formatAttachmentDisplayText(fileNames: readonly string[]): string {
  const visibleNames = fileNames.map((name) => name.trim()).filter((name) => name.length > 0);
  if (visibleNames.length === 0) {
    return "";
  }
  return `[${visibleNames.join(", ")}]`;
}

export function formatUserInputDisplayText(text: string, fileNames?: readonly string[]): string {
  const trimmed = text.trim();
  const attachmentText = fileNames ? formatAttachmentDisplayText(fileNames) : "";
  if (!trimmed) {
    return attachmentText;
  }
  if (!attachmentText) {
    return trimmed;
  }
  return `${trimmed}\n\nAttached: ${attachmentText}`;
}
