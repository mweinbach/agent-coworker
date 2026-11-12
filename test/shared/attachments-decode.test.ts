import { describe, expect, test } from "bun:test";
import {
  formatUserInputDisplayText,
  getAttachmentCountValidationMessage,
  getAttachmentUploadByteLengthValidationMessage,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_ATTACHMENT_UPLOAD_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
} from "../../src/shared/attachments";

describe("formatUserInputDisplayText", () => {
  test("renders text, attachment names, or both without blank names", () => {
    expect(formatUserInputDisplayText("  hello  ")).toBe("hello");
    expect(formatUserInputDisplayText("   ", [" notes.txt ", "", "shot.png"])).toBe(
      "[notes.txt, shot.png]",
    );
    expect(formatUserInputDisplayText("hello", ["notes.txt"])).toBe(
      "hello\n\nAttached: [notes.txt]",
    );
  });
});
