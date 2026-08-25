import { describe, expect, test } from "bun:test";

import {
  getAttachmentByteLengthValidationMessage,
  getAttachmentCountValidationMessage,
  getAttachmentUploadByteLengthValidationMessage,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_ATTACHMENT_UPLOAD_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE,
} from "../src/shared/attachments";

describe("attachment size validation", () => {
  test("getAttachmentCountValidationMessage allows the cap and rejects one more", () => {
    expect(getAttachmentCountValidationMessage()).toBeNull();
    expect(getAttachmentCountValidationMessage(MAX_TURN_ATTACHMENT_COUNT)).toBeNull();
    expect(getAttachmentCountValidationMessage(MAX_TURN_ATTACHMENT_COUNT + 1)).toBe(
      `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`,
    );
  });

  test("inline byte-length checks reject a single oversized file before totaling", () => {
    expect(getAttachmentByteLengthValidationMessage()).toBeNull();
    expect(getAttachmentByteLengthValidationMessage([])).toBeNull();
    expect(getAttachmentByteLengthValidationMessage([MAX_ATTACHMENT_INLINE_BYTE_SIZE])).toBeNull();
    expect(getAttachmentByteLengthValidationMessage([MAX_ATTACHMENT_INLINE_BYTE_SIZE + 1])).toBe(
      "File too large to send inline (max 25MB)",
    );
  });

  test("inline byte-length checks reject a combined total over 25MB", () => {
    const half = Math.floor(MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE / 2) + 1;
    expect(getAttachmentByteLengthValidationMessage([half, half])).toBe(
      "Inline attachments too large in total (max 25MB combined)",
    );
  });

  test("inline count is enforced before size so a ninth file is not a size error", () => {
    const sizes = Array.from({ length: MAX_TURN_ATTACHMENT_COUNT + 1 }, () => 1);
    expect(getAttachmentByteLengthValidationMessage(sizes)).toBe(
      `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`,
    );
  });

  test("upload byte-length checks use the 100MB cap and ignore combined totals", () => {
    expect(getAttachmentUploadByteLengthValidationMessage()).toBeNull();
    expect(
      getAttachmentUploadByteLengthValidationMessage([MAX_ATTACHMENT_UPLOAD_BYTE_SIZE]),
    ).toBeNull();
    expect(
      getAttachmentUploadByteLengthValidationMessage([MAX_ATTACHMENT_UPLOAD_BYTE_SIZE + 1]),
    ).toBe("File too large to upload (max 100MB)");
    expect(
      getAttachmentUploadByteLengthValidationMessage([
        MAX_ATTACHMENT_UPLOAD_BYTE_SIZE,
        MAX_ATTACHMENT_UPLOAD_BYTE_SIZE,
      ]),
    ).toBeNull();
  });
});
