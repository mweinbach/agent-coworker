import { describe, expect, test } from "bun:test";

import {
  googleMultimodalPartTypeForMime,
  isBinaryMediaMimeType,
  isGoogleMultimodalProvider,
  mimeTypeFromPath,
  multimodalPartLabel,
} from "../../src/shared/multimodalMime";

describe("mimeTypeFromPath", () => {
  test("maps known media extensions case-insensitively and rejects unknowns", () => {
    expect(mimeTypeFromPath("/tmp/photo.PNG")).toBe("image/png");
    expect(mimeTypeFromPath("notes.JPEG")).toBe("image/jpeg");
    expect(mimeTypeFromPath("clip.mov")).toBe("video/quicktime");
    expect(mimeTypeFromPath("brief.PDF")).toBe("application/pdf");
    expect(mimeTypeFromPath("notes.txt")).toBeNull();
    expect(mimeTypeFromPath("archive")).toBeNull();
  });
});

describe("isBinaryMediaMimeType", () => {
  test("treats image, audio, video, and PDF as binary media", () => {
    expect(isBinaryMediaMimeType("image/png")).toBe(true);
    expect(isBinaryMediaMimeType("AUDIO/MPEG")).toBe(true);
    expect(isBinaryMediaMimeType("video/mp4")).toBe(true);
    expect(isBinaryMediaMimeType("application/pdf")).toBe(true);
    expect(isBinaryMediaMimeType("text/plain")).toBe(false);
    expect(isBinaryMediaMimeType("application/json")).toBe(false);
  });
});

describe("googleMultimodalPartTypeForMime", () => {
  test("sends images only when the model supports image input", () => {
    expect(
      googleMultimodalPartTypeForMime("image/png", {
        modelSupportsImages: true,
        isGoogleProvider: false,
      }),
    ).toBe("image");
    expect(
      googleMultimodalPartTypeForMime("image/png", {
        modelSupportsImages: false,
        isGoogleProvider: true,
      }),
    ).toBeNull();
  });

  test("keeps audio, video, and PDF on Google and rejects them elsewhere", () => {
    const google = { modelSupportsImages: true, isGoogleProvider: true };
    const other = { modelSupportsImages: true, isGoogleProvider: false };

    expect(googleMultimodalPartTypeForMime("audio/mpeg", google)).toBe("audio");
    expect(googleMultimodalPartTypeForMime("video/mp4", google)).toBe("video");
    expect(googleMultimodalPartTypeForMime("application/pdf", google)).toBe("document");
    expect(googleMultimodalPartTypeForMime("audio/mpeg", other)).toBeNull();
    expect(googleMultimodalPartTypeForMime("application/pdf", other)).toBeNull();
    expect(googleMultimodalPartTypeForMime("text/plain", google)).toBeNull();
  });
});

describe("provider and label helpers", () => {
  test("identifies the Google provider and labels multimodal parts", () => {
    expect(isGoogleMultimodalProvider({ provider: "google" })).toBe(true);
    expect(isGoogleMultimodalProvider({ provider: "openai" })).toBe(false);
    expect(multimodalPartLabel("image")).toBe("Image");
    expect(multimodalPartLabel("document")).toBe("PDF");
  });
});
