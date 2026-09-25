import { describe, expect, test } from "bun:test";
import type { FileAttachment } from "../../src/server/jsonrpc/routes/shared";
import {
  getUploadedMultimodalAttachmentValidationMessage,
  shouldInjectLargeMultimodalOutputGuidance,
} from "../../src/server/session/turnExecution/attachmentGuidancePolicy";
import { MAX_ATTACHMENT_INLINE_BYTE_SIZE } from "../../src/shared/attachments";

const pdf: FileAttachment = {
  filename: "brief.pdf",
  mimeType: "application/pdf",
  contentBase64: "AA==",
};

const image: FileAttachment = {
  filename: "shot.png",
  mimeType: "image/png",
  contentBase64: "AA==",
};

const audio: FileAttachment = {
  filename: "clip.mp3",
  mimeType: "audio/mpeg",
  contentBase64: "AA==",
};

const googleImages = { modelSupportsImages: true, isGoogleProvider: true };
const otherImages = { modelSupportsImages: true, isGoogleProvider: false };

describe("shouldInjectLargeMultimodalOutputGuidance", () => {
  test("injects only for Google audio, video, or PDF when the user asks to extract", () => {
    expect(
      shouldInjectLargeMultimodalOutputGuidance("transcribe this", [pdf], undefined, otherImages),
    ).toBe(false);
    expect(
      shouldInjectLargeMultimodalOutputGuidance("transcribe this", [], undefined, googleImages),
    ).toBe(false);
    expect(shouldInjectLargeMultimodalOutputGuidance("hello", [pdf], undefined, googleImages)).toBe(
      false,
    );
    expect(
      shouldInjectLargeMultimodalOutputGuidance(
        "transcribe this",
        [image],
        undefined,
        googleImages,
      ),
    ).toBe(false);
    expect(
      shouldInjectLargeMultimodalOutputGuidance(
        "extract the minutes",
        [pdf],
        undefined,
        googleImages,
      ),
    ).toBe(true);
    expect(
      shouldInjectLargeMultimodalOutputGuidance(
        "please transcribe",
        [audio],
        undefined,
        googleImages,
      ),
    ).toBe(true);
    expect(
      shouldInjectLargeMultimodalOutputGuidance(
        "",
        [pdf],
        [{ type: "text", text: "OCR this document" }],
        googleImages,
      ),
    ).toBe(true);
  });
});

describe("getUploadedMultimodalAttachmentValidationMessage", () => {
  test("rewrites inline size errors for uploaded multimodal files", () => {
    expect(getUploadedMultimodalAttachmentValidationMessage([])).toBeNull();
    expect(
      getUploadedMultimodalAttachmentValidationMessage([MAX_ATTACHMENT_INLINE_BYTE_SIZE + 1]),
    ).toBe("Uploaded multimodal file too large to send to the model (max 25MB)");
    expect(
      getUploadedMultimodalAttachmentValidationMessage([MAX_ATTACHMENT_INLINE_BYTE_SIZE - 10, 20]),
    ).toBe("Uploaded multimodal attachments too large to send to the model (max 25MB combined)");
    expect(
      getUploadedMultimodalAttachmentValidationMessage(Array.from({ length: 9 }, () => 1)),
    ).toBe("Too many file attachments (max 8)");
  });
});
