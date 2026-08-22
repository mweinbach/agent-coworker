import { describe, expect, test } from "bun:test";
import {
  getUploadedMultimodalAttachmentValidationMessage,
  shouldInjectLargeMultimodalOutputGuidance,
} from "../../src/server/session/turnExecution/attachmentGuidancePolicy";
import { MAX_ATTACHMENT_INLINE_BYTE_SIZE } from "../../src/shared/attachments";

const googleOpts = { modelSupportsImages: true, isGoogleProvider: true };
const pdf = { filename: "notes.pdf", mimeType: "application/pdf", contentBase64: "AAAA" };
const video = { filename: "clip.mp4", mimeType: "video/mp4", contentBase64: "AAAA" };
const image = { filename: "shot.png", mimeType: "image/png", contentBase64: "AAAA" };

describe("attachmentGuidancePolicy", () => {
  test("injects Google large-media guidance only for transcript-like requests", () => {
    expect(
      shouldInjectLargeMultimodalOutputGuidance(
        "please transcribe this",
        [pdf],
        undefined,
        googleOpts,
      ),
    ).toBe(true);
    expect(
      shouldInjectLargeMultimodalOutputGuidance(
        "extract the minutes",
        [video],
        undefined,
        googleOpts,
      ),
    ).toBe(true);
    expect(
      shouldInjectLargeMultimodalOutputGuidance(
        "hello",
        [pdf],
        [{ type: "text", text: "OCR this" }],
        googleOpts,
      ),
    ).toBe(true);

    expect(
      shouldInjectLargeMultimodalOutputGuidance("please transcribe this", [pdf], undefined, {
        modelSupportsImages: true,
        isGoogleProvider: false,
      }),
    ).toBe(false);
    expect(
      shouldInjectLargeMultimodalOutputGuidance(
        "please transcribe this",
        [image],
        undefined,
        googleOpts,
      ),
    ).toBe(false);
    expect(
      shouldInjectLargeMultimodalOutputGuidance("look at this", [pdf], undefined, googleOpts),
    ).toBe(false);
    expect(
      shouldInjectLargeMultimodalOutputGuidance("transcribe this", [], undefined, googleOpts),
    ).toBe(false);
  });

  test("rewrites Google inline size failures and leaves other messages unchanged", () => {
    expect(
      getUploadedMultimodalAttachmentValidationMessage([MAX_ATTACHMENT_INLINE_BYTE_SIZE + 1]),
    ).toBe("Uploaded multimodal file too large to send to the model (max 25MB)");
    expect(
      getUploadedMultimodalAttachmentValidationMessage([
        MAX_ATTACHMENT_INLINE_BYTE_SIZE - 1,
        MAX_ATTACHMENT_INLINE_BYTE_SIZE - 1,
      ]),
    ).toBe("Uploaded multimodal attachments too large to send to the model (max 25MB combined)");
    expect(getUploadedMultimodalAttachmentValidationMessage([])).toBeNull();
    expect(getUploadedMultimodalAttachmentValidationMessage([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(
      "Too many file attachments (max 8)",
    );
  });
});
