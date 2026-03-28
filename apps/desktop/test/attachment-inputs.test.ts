import { describe, expect, test } from "bun:test";

import {
  getAttachmentPickerValidationMessage,
  getAttachmentUploadValidationMessage,
} from "../src/app/attachmentInputs";
import {
  MAX_ATTACHMENT_UPLOAD_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
} from "../../../src/shared/attachments";

describe("attachment picker validation", () => {
  test("rejects selections that exceed the attachment count limit", () => {
    expect(getAttachmentPickerValidationMessage(
      { length: MAX_TURN_ATTACHMENT_COUNT - 1 },
      { length: 2 },
    )).toBe(
      `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`,
    );
  });

  test("accepts selections within the attachment count limit", () => {
    expect(getAttachmentPickerValidationMessage(
      { length: MAX_TURN_ATTACHMENT_COUNT - 2 },
      { length: 2 },
    )).toBeNull();
  });

  test("rejects files that exceed the upload size limit before send preparation", () => {
    expect(getAttachmentPickerValidationMessage(
      [],
      [{ size: MAX_ATTACHMENT_UPLOAD_BYTE_SIZE + 1 }],
    )).toBe("File too large to upload (max 100MB)");
  });
});

describe("attachment send validation", () => {
  test("rejects oversized files before base64 encoding", () => {
    expect(getAttachmentUploadValidationMessage(MAX_ATTACHMENT_UPLOAD_BYTE_SIZE + 1)).toBe(
      "File too large to upload (max 100MB)",
    );
  });

  test("accepts files within the upload size limit", () => {
    expect(getAttachmentUploadValidationMessage(MAX_ATTACHMENT_UPLOAD_BYTE_SIZE)).toBeNull();
  });
});
