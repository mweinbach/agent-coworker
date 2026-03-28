export const MAX_TURN_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_INLINE_BYTE_SIZE = 25 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_UPLOAD_BYTE_SIZE = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_BASE64_SIZE = getBase64SizeFromByteLength(MAX_ATTACHMENT_INLINE_BYTE_SIZE);
export const MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE = getBase64SizeFromByteLength(MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE);
export const MAX_ATTACHMENT_UPLOAD_BASE64_SIZE = getBase64SizeFromByteLength(MAX_ATTACHMENT_UPLOAD_BYTE_SIZE);
const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/]*$/;

export function getBase64SizeFromByteLength(byteLength: number): number {
  return Math.ceil(Math.max(0, byteLength) / 3) * 4;
}

export function decodeBase64Strict(value: string): Buffer | null {
  if (value.length === 0 || value.includes("=") && !/=+$/.test(value)) {
    return null;
  }

  const unpadded = value.replace(/=+$/, "");
  if (!BASE64_BODY_PATTERN.test(unpadded) || unpadded.length % 4 === 1) {
    return null;
  }

  const normalized = unpadded.padEnd(unpadded.length + ((4 - (unpadded.length % 4)) % 4), "=");
  if (!decodedBase64RoundTrips(normalized)) {
    return null;
  }

  return Buffer.from(normalized, "base64");
}

function decodedBase64RoundTrips(value: string): boolean {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "");
  } catch {
    return false;
  }
}

export function getAttachmentCountValidationMessage(count?: number): string | null {
  if ((count ?? 0) > MAX_TURN_ATTACHMENT_COUNT) {
    return `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`;
  }
  return null;
}

export function getAttachmentValidationMessageForBase64Sizes(
  base64Sizes?: readonly number[],
): string | null {
  if (!base64Sizes || base64Sizes.length === 0) {
    return null;
  }
  const attachmentCountMessage = getAttachmentCountValidationMessage(base64Sizes.length);
  if (attachmentCountMessage) {
    return attachmentCountMessage;
  }

  let totalBase64Size = 0;
  for (const base64Size of base64Sizes) {
    if (base64Size > MAX_ATTACHMENT_BASE64_SIZE) {
      return "File too large to send inline (max 25MB)";
    }
    totalBase64Size += base64Size;
    if (totalBase64Size > MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE) {
      return "Inline attachments too large in total (max 25MB combined)";
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
  const attachmentCountMessage = getAttachmentCountValidationMessage(byteLengths.length);
  if (attachmentCountMessage) {
    return attachmentCountMessage;
  }

  let totalByteLength = 0;
  for (const byteLength of byteLengths) {
    if (byteLength > MAX_ATTACHMENT_INLINE_BYTE_SIZE) {
      return "File too large to send inline (max 25MB)";
    }
    totalByteLength += byteLength;
    if (totalByteLength > MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE) {
      return "Inline attachments too large in total (max 25MB combined)";
    }
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
