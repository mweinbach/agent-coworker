import { describe, expect, test } from "bun:test";
import {
  decodeBase64Strict,
  formatAttachmentDisplayText,
  formatUserInputDisplayText,
} from "../src/shared/attachments";

describe("decodeBase64Strict", () => {
  test("decodes canonical padded and unpadded payloads", () => {
    expect(decodeBase64Strict("aGVsbG8=")?.toString("utf8")).toBe("hello");
    expect(decodeBase64Strict("aGVsbG8")?.toString("utf8")).toBe("hello");
    expect(decodeBase64Strict("YQ==")?.toString("utf8")).toBe("a");
    expect(decodeBase64Strict("YQ")?.toString("utf8")).toBe("a");
  });

  test("rejects empty, whitespace, and illegal alphabet", () => {
    expect(decodeBase64Strict("")).toBeNull();
    expect(decodeBase64Strict("aGVsbG8=\n")).toBeNull();
    expect(decodeBase64Strict("!not-base64!")).toBeNull();
    expect(decodeBase64Strict("aGVsbG8_")).toBeNull();
    expect(decodeBase64Strict("aGVsbG8-")).toBeNull();
  });

  test("rejects mid-string padding and non-canonical last bits", () => {
    expect(decodeBase64Strict("aGVs=bG8=")).toBeNull();
    expect(decodeBase64Strict("Y")).toBeNull();
    expect(decodeBase64Strict("YR==")).toBeNull();
  });
});

describe("attachment display text", () => {
  test("joins visible filenames and ignores blanks", () => {
    expect(formatAttachmentDisplayText([])).toBe("");
    expect(formatAttachmentDisplayText(["  ", ""])).toBe("");
    expect(formatAttachmentDisplayText(["notes.txt"])).toBe("[notes.txt]");
    expect(formatAttachmentDisplayText([" a.png ", "", "b.pdf"])).toBe("[a.png, b.pdf]");
  });

  test("formats user input with optional attachments", () => {
    expect(formatUserInputDisplayText("  hello  ")).toBe("hello");
    expect(formatUserInputDisplayText("   ", ["shot.png"])).toBe("[shot.png]");
    expect(formatUserInputDisplayText("Review this", ["shot.png", "notes.txt"])).toBe(
      "Review this\n\nAttached: [shot.png, notes.txt]",
    );
  });
});
