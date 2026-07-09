import { describe, expect, test } from "bun:test";

import { applyMarkdownFormat } from "../src/lib/canvasMarkdownFormat";

describe("canvas markdown format", () => {
  test("wraps the current selection in bold markers", () => {
    const result = applyMarkdownFormat("hello world", 6, 11, "bold");
    expect(result.next).toBe("hello **world**");
    expect(result.selectionStart).toBe(8);
    expect(result.selectionEnd).toBe(13);
  });

  test("prefixes selected lines as a bullet list", () => {
    const result = applyMarkdownFormat("one\ntwo", 0, 7, "ul");
    expect(result.next).toBe("- one\n- two");
  });

  test("converts selected lines to a heading", () => {
    const result = applyMarkdownFormat("Title", 0, 5, "h2");
    expect(result.next).toBe("## Title");
  });
});
