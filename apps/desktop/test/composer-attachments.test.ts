import { describe, expect, test } from "bun:test";
import {
  appendAttachmentSkippedNotes,
  buildAttachmentSkippedNote,
} from "../src/lib/composerAttachments";

describe("composerAttachments", () => {
  test("appendAttachmentSkippedNotes appends skipped attachment notes to the message", () => {
    const message = appendAttachmentSkippedNotes("Hello", [
      buildAttachmentSkippedNote("big.bin", "File too large to upload (max 100MB)"),
    ]);

    expect(message).toContain("Hello");
    expect(message).toContain('wanted to attach "big.bin"');
    expect(message).toContain("File too large to upload (max 100MB)");
  });

  test("appendAttachmentSkippedNotes returns only notes when the message is empty", () => {
    const message = appendAttachmentSkippedNotes("", [
      buildAttachmentSkippedNote("clip.mp4", "File too large to upload (max 100MB)"),
    ]);

    expect(message).toContain('wanted to attach "clip.mp4"');
  });
});
