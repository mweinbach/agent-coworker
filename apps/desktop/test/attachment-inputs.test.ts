import { describe, expect, test } from "bun:test";

import { getAttachmentPickerValidationMessage } from "../src/app/attachmentInputs";
import {
  getBase64SizeFromByteLength,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
} from "../../../src/shared/attachments";

describe("attachment picker validation", () => {
  test("rejects files that would exceed the per-file base64 limit before encoding", () => {
    const oversizedByteLength = Math.floor(MAX_ATTACHMENT_BASE64_SIZE / 4) * 3 + 1;

    expect(getAttachmentPickerValidationMessage([], [{ size: oversizedByteLength }])).toBe(
      "File too large (max ~7.5MB)",
    );
  });

  test("rejects files that would push the combined attachment payload over the turn limit", () => {
    const existingAttachments = [{ contentBase64: "a".repeat(MAX_ATTACHMENT_BASE64_SIZE) }];
    const remainingBase64Budget = MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE - MAX_ATTACHMENT_BASE64_SIZE;
    const oversizedCombinedByteLength = Math.floor(remainingBase64Budget / 4) * 3 + 1;

    expect(getAttachmentPickerValidationMessage(existingAttachments, [{ size: oversizedCombinedByteLength }])).toBe(
      "Attachments too large in total (max ~15MB combined)",
    );
  });

  test("accepts files whose encoded size stays exactly within the combined limit", () => {
    const existingAttachments = [{ contentBase64: "a".repeat(MAX_ATTACHMENT_BASE64_SIZE) }];
    const remainingBase64Budget = MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE - MAX_ATTACHMENT_BASE64_SIZE;
    const exactCombinedByteLength = Math.floor(remainingBase64Budget / 4) * 3;

    expect(getBase64SizeFromByteLength(exactCombinedByteLength)).toBe(remainingBase64Budget);
    expect(getAttachmentPickerValidationMessage(existingAttachments, [{ size: exactCombinedByteLength }])).toBeNull();
  });
});
