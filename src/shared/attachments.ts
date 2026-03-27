export const MAX_ATTACHMENT_BASE64_SIZE = 10 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_COUNT = 8;
export const MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE = 15 * 1024 * 1024;

export function getBase64SizeFromByteLength(byteLength: number): number {
  return Math.ceil(Math.max(0, byteLength) / 3) * 4;
}

export function getAttachmentValidationMessageForBase64Sizes(
  base64Sizes?: readonly number[],
): string | null {
  if (!base64Sizes || base64Sizes.length === 0) {
    return null;
  }
  if (base64Sizes.length > MAX_TURN_ATTACHMENT_COUNT) {
    return `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`;
  }

  let totalBase64Size = 0;
  for (const base64Size of base64Sizes) {
    if (base64Size > MAX_ATTACHMENT_BASE64_SIZE) {
      return "File too large (max ~7.5MB)";
    }
    totalBase64Size += base64Size;
    if (totalBase64Size > MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE) {
      return "Attachments too large in total (max ~15MB combined)";
    }
  }

  return null;
}

export function getAttachmentByteLengthValidationMessage(
  byteLengths?: readonly number[],
): string | null {
  if (!byteLengths || byteLengths.length === 0) {
    return null;
  }
  return getAttachmentValidationMessageForBase64Sizes(
    byteLengths.map((byteLength) => getBase64SizeFromByteLength(byteLength)),
  );
}

export function getAttachmentTotalBase64Size(
  attachments?: readonly Pick<{ contentBase64: string }, "contentBase64">[],
): number {
  if (!attachments || attachments.length === 0) {
    return 0;
  }
  return attachments.reduce((total, attachment) => total + attachment.contentBase64.length, 0);
}

export function getAttachmentValidationMessage(
  attachments?: readonly Pick<{ contentBase64: string }, "contentBase64">[],
): string | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }
  return getAttachmentValidationMessageForBase64Sizes(
    attachments.map((attachment) => attachment.contentBase64.length),
  );
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
