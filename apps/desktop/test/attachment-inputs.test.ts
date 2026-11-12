import { describe, expect, test } from "bun:test";
import { MAX_ATTACHMENT_UPLOAD_BYTE_SIZE } from "../../../src/shared/attachments";
import { getAttachmentUploadValidationMessage } from "../src/app/attachmentInputs";

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
