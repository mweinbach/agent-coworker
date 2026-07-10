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

  test("does not format the next line when a block selection ends with a newline", () => {
    const result = applyMarkdownFormat("one\ntwo\nthree", 0, 8, "ul");
    expect(result.next).toBe("- one\n- two\nthree");
    expect(result.selectionEnd).toBe(11);
  });

  test("preserves a document trailing newline without adding an empty list item", () => {
    const result = applyMarkdownFormat("one\ntwo\n", 0, 8, "ol");
    expect(result.next).toBe("1. one\n2. two\n");
  });

  test("converts selected lines to a heading", () => {
    const result = applyMarkdownFormat("Title", 0, 5, "h2");
    expect(result.next).toBe("## Title");
  });
});
