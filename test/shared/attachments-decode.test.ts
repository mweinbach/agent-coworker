import { describe, expect, test } from "bun:test";

import {
  decodeBase64Strict,
  formatUserInputDisplayText,
  getAttachmentByteLengthValidationMessage,
  getAttachmentCountValidationMessage,
  getAttachmentUploadByteLengthValidationMessage,
  getAttachmentValidationMessage,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_ATTACHMENT_UPLOAD_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
} from "../../src/shared/attachments";

describe("decodeBase64Strict", () => {
  test("accepts canonical base64 and rejects empty, padded-mid, and non-canonical values", () => {
    expect(decodeBase64Strict("aGVsbG8=")?.toString("utf8")).toBe("hello");
    expect(decodeBase64Strict("aGVsbG8")?.toString("utf8")).toBe("hello");
    expect(decodeBase64Strict("")).toBeNull();
    expect(decodeBase64Strict("Y")).toBeNull();
    expect(decodeBase64Strict("aGVs=bG8=")).toBeNull();
    expect(decodeBase64Strict("aGVsbG8=\n")).toBeNull();
    expect(decodeBase64Strict("YR==")).toBeNull();
  });
});

describe("attachment size and count gates", () => {
  test("reject oversize singles, combined inline totals, and too many files", () => {
    expect(getAttachmentCountValidationMessage()).toBeNull();
    expect(getAttachmentCountValidationMessage(MAX_TURN_ATTACHMENT_COUNT)).toBeNull();
    expect(getAttachmentCountValidationMessage(MAX_TURN_ATTACHMENT_COUNT + 1)).toBe(
      `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`,
    );

    expect(getAttachmentByteLengthValidationMessage()).toBeNull();
    expect(getAttachmentByteLengthValidationMessage([])).toBeNull();
    expect(getAttachmentByteLengthValidationMessage([MAX_ATTACHMENT_INLINE_BYTE_SIZE])).toBeNull();
    expect(getAttachmentByteLengthValidationMessage([MAX_ATTACHMENT_INLINE_BYTE_SIZE + 1])).toBe(
      "File too large to send inline (max 25MB)",
    );
    expect(
      getAttachmentByteLengthValidationMessage([MAX_ATTACHMENT_INLINE_BYTE_SIZE - 10, 20]),
    ).toBe("Inline attachments too large in total (max 25MB combined)");

    expect(
      getAttachmentUploadByteLengthValidationMessage([MAX_ATTACHMENT_UPLOAD_BYTE_SIZE]),
    ).toBeNull();
    expect(
      getAttachmentUploadByteLengthValidationMessage([MAX_ATTACHMENT_UPLOAD_BYTE_SIZE + 1]),
    ).toBe("File too large to upload (max 100MB)");
  });

  test("validates inline attachments from base64 string lengths", () => {
    expect(getAttachmentValidationMessage()).toBeNull();
    expect(getAttachmentValidationMessage([])).toBeNull();
    expect(
      getAttachmentValidationMessage(
        Array.from({ length: MAX_TURN_ATTACHMENT_COUNT + 1 }, (_, index) => ({
          contentBase64: `n${index}`,
        })),
      ),
    ).toBe(`Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`);
  });
});

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
