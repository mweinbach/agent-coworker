export const MAX_ATTACHMENT_BASE64_SIZE = 10 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_COUNT = 8;
export const MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE = 15 * 1024 * 1024;

export function getAttachmentValidationMessage(
  attachments?: readonly Pick<{ contentBase64: string }, "contentBase64">[],
): string | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }
  if (attachments.length > MAX_TURN_ATTACHMENT_COUNT) {
    return `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`;
  }

  let totalBase64Size = 0;
  for (const attachment of attachments) {
    if (attachment.contentBase64.length > MAX_ATTACHMENT_BASE64_SIZE) {
      return "File too large (max ~7.5MB)";
    }
    totalBase64Size += attachment.contentBase64.length;
    if (totalBase64Size > MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE) {
      return "Attachments too large in total (max ~15MB combined)";
    }
  }

  return null;
}

export function formatAttachmentDisplayText(fileNames: readonly string[]): string {
  const visibleNames = fileNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (visibleNames.length === 0) {
    return "";
  }
  return `[${visibleNames.join(", ")}]`;
}
