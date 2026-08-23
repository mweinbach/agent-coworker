import { describe, expect, test } from "bun:test";

import {
  googleMultimodalPartTypeForMime,
  isBinaryMediaMimeType,
  isGoogleMultimodalProvider,
  mimeTypeFromPath,
  multimodalPartLabel,
} from "../../src/shared/multimodalMime";

describe("multimodal MIME routing", () => {
  test("maps known extensions and leaves unknown paths untyped", () => {
    expect(mimeTypeFromPath("notes.webp")).toBe("image/webp");
    expect(mimeTypeFromPath("/tmp/clip.MP4")).toBe("video/mp4");
    expect(mimeTypeFromPath("brief.PDF")).toBe("application/pdf");
    expect(mimeTypeFromPath("voice.m4a")).toBe("audio/mp4");
    expect(mimeTypeFromPath("notes.txt")).toBeNull();
  });

  test("treats images, audio, video, and PDF as binary media", () => {
    expect(isBinaryMediaMimeType("image/png")).toBe(true);
    expect(isBinaryMediaMimeType("AUDIO/MPEG")).toBe(true);
    expect(isBinaryMediaMimeType("video/webm")).toBe(true);
    expect(isBinaryMediaMimeType("application/pdf")).toBe(true);
    expect(isBinaryMediaMimeType("text/plain")).toBe(false);
    expect(isBinaryMediaMimeType("application/json")).toBe(false);
  });

  test("keeps non-image Google parts off non-Google providers", () => {
    expect(
      googleMultimodalPartTypeForMime("audio/mpeg", {
        modelSupportsImages: true,
        isGoogleProvider: false,
      }),
    ).toBeNull();
    expect(
      googleMultimodalPartTypeForMime("video/mp4", {
        modelSupportsImages: true,
        isGoogleProvider: false,
      }),
    ).toBeNull();
    expect(
      googleMultimodalPartTypeForMime("application/pdf", {
        modelSupportsImages: true,
        isGoogleProvider: false,
      }),
    ).toBeNull();
    expect(
      googleMultimodalPartTypeForMime("image/png", {
        modelSupportsImages: true,
        isGoogleProvider: false,
      }),
    ).toBe("image");
  });

  test("routes Google audio, video, and PDF parts and honors image capability", () => {
    const google = { modelSupportsImages: true, isGoogleProvider: true };
    expect(googleMultimodalPartTypeForMime("audio/wav", google)).toBe("audio");
    expect(googleMultimodalPartTypeForMime("video/quicktime", google)).toBe("video");
    expect(googleMultimodalPartTypeForMime("application/pdf", google)).toBe("document");
    expect(
      googleMultimodalPartTypeForMime("image/webp", {
        modelSupportsImages: false,
        isGoogleProvider: true,
      }),
    ).toBeNull();
    expect(googleMultimodalPartTypeForMime("text/plain", google)).toBeNull();
  });

  test("labels part types for prompt/UI copy", () => {
    expect(multimodalPartLabel("image")).toBe("Image");
    expect(multimodalPartLabel("audio")).toBe("Audio");
    expect(multimodalPartLabel("video")).toBe("Video");
    expect(multimodalPartLabel("document")).toBe("PDF");
  });

  test("identifies Google as the multimodal provider", () => {
    expect(isGoogleMultimodalProvider({ provider: "google" })).toBe(true);
    expect(isGoogleMultimodalProvider({ provider: "openai" })).toBe(false);
  });
});
