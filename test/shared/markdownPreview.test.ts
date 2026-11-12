import { describe, expect, test } from "bun:test";

import {
  buildMarkdownPreviewText,
  normalizeReasoningMarkdown,
} from "../../src/shared/markdownPreview";

describe("shared markdown preview", () => {
  test("normalizeReasoningMarkdown leaves well-formed markdown untouched", () => {
    expect(normalizeReasoningMarkdown("  **Heading**\r\nBody  ")).toBe("**Heading**\nBody");
    expect(normalizeReasoningMarkdown("   ")).toBe("");
  });

  test("normalizeReasoningMarkdown splits concatenated bold chunks and drops the outer wrapper", () => {
    expect(
      normalizeReasoningMarkdown("**Filtering the queue****Identifying affected projects**"),
    ).toBe("Filtering the queue\n\nIdentifying affected projects");
    expect(normalizeReasoningMarkdown("__First____Second__")).toBe("First\n\nSecond");
  });

  test("normalizeReasoningMarkdown keeps a partial wrapper when the stream is not fully wrapped", () => {
    expect(normalizeReasoningMarkdown("**Checking a****Verifying b**\nLooks good.")).toBe(
      "**Checking a\n\nVerifying b**\nLooks good.",
    );
  });

  test("buildMarkdownPreviewText skips leading standalone headings and truncates", () => {
    expect(buildMarkdownPreviewText("## Plan\n**Step**\nDo the thing\nThen more\nAnd more")).toBe(
      "Do the thing Then more…",
    );
    expect(buildMarkdownPreviewText("**Only heading**")).toBe("**Only heading**");
    expect(buildMarkdownPreviewText("")).toBe("");
    expect(buildMarkdownPreviewText("x".repeat(200), 2, 10)).toBe(`${"x".repeat(9)}…`);
  });
});
