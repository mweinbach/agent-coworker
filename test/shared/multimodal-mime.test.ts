import { describe, expect, test } from "bun:test";
import {
  googleMultimodalPartTypeForMime,
  isBinaryMediaMimeType,
  isGoogleMultimodalProvider,
  mimeTypeFromPath,
  multimodalPartLabel,
} from "../../src/shared/multimodalMime";

describe("multimodalMime", () => {
  test("maps known media extensions case-insensitively and rejects unknowns", () => {
    expect(mimeTypeFromPath("/tmp/photo.PNG")).toBe("image/png");
    expect(mimeTypeFromPath("notes.JPEG")).toBe("image/jpeg");
    expect(mimeTypeFromPath("clip.mov")).toBe("video/quicktime");
    expect(mimeTypeFromPath("brief.PDF")).toBe("application/pdf");
    expect(mimeTypeFromPath("notes.txt")).toBeNull();
    expect(mimeTypeFromPath("archive")).toBeNull();
  });

  test("treats image, audio, video, and PDF as binary media", () => {
    for (const mime of ["image/png", "AUDIO/MPEG", "video/mp4", "application/pdf"]) {
      expect(isBinaryMediaMimeType(mime)).toBe(true);
    }
    for (const mime of ["text/plain", "application/json"]) {
      expect(isBinaryMediaMimeType(mime)).toBe(false);
    }
  });

  test("routes images by model support and keeps audio/video/PDF on Google only", () => {
    const google = { modelSupportsImages: true, isGoogleProvider: true };
    const other = { modelSupportsImages: true, isGoogleProvider: false };

    expect(googleMultimodalPartTypeForMime("image/png", other)).toBe("image");
    expect(
      googleMultimodalPartTypeForMime("image/png", {
        modelSupportsImages: false,
        isGoogleProvider: true,
      }),
    ).toBeNull();
    expect(googleMultimodalPartTypeForMime("audio/mpeg", google)).toBe("audio");
    expect(googleMultimodalPartTypeForMime("video/mp4", google)).toBe("video");
    expect(googleMultimodalPartTypeForMime("application/pdf", google)).toBe("document");
    expect(googleMultimodalPartTypeForMime("audio/mpeg", other)).toBeNull();
    expect(googleMultimodalPartTypeForMime("application/pdf", other)).toBeNull();
    expect(googleMultimodalPartTypeForMime("text/plain", google)).toBeNull();
  });

  test("identifies the Google provider and labels multimodal parts", () => {
    expect(isGoogleMultimodalProvider({ provider: "google" })).toBe(true);
    expect(isGoogleMultimodalProvider({ provider: "openai" })).toBe(false);
    expect(multimodalPartLabel("image")).toBe("Image");
    expect(multimodalPartLabel("document")).toBe("PDF");
  });
});
