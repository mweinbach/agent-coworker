import { describe, expect, test } from "bun:test";

import { getAttachmentPickerValidationMessage } from "../src/app/attachmentInputs";
import { MAX_TURN_ATTACHMENT_COUNT } from "../../../src/shared/attachments";

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
});
