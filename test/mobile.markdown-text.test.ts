import { describe, expect, test } from "bun:test";

import {
  parseRichBlocks,
  type RichBlock,
} from "../apps/mobile/src/components/thread/markdownParser";

describe("mobile markdown parser", () => {
  test("keeps prose mixed into a Sources section instead of discarding it", () => {
    const text = [
      "Before the sources.",
      "Sources:",
      "[Reference](https://example.com/reference)",
      "Do not deploy yet.",
      "[Second reference](https://example.com/second)",
    ].join("\n");

    expect(parseRichBlocks(text)).toEqual([{ type: "paragraph", content: text }]);
  });

  test("does not duplicate the prelude when a Sources section has no recognized links", () => {
    const text = "Before the sources.\nSources\nReferences are not available yet.";

    expect(parseRichBlocks(text)).toEqual([{ type: "paragraph", content: text }]);
  });

  test("preserves unsupported source links rather than silently dropping them", () => {
    const text = "Sources\n[Reference](https://example.com)\n[Local notes](file:///notes.txt)";

    expect(parseRichBlocks(text)).toEqual([{ type: "paragraph", content: text }]);
  });

  test("converts a complete source list and includes its prelude only once", () => {
    expect(
      parseRichBlocks("Before the sources.\nSources\n- [Reference](https://example.com)"),
    ).toEqual([
      { type: "paragraph", content: "Before the sources." },
      { type: "sources", items: [{ label: "Reference", href: "https://example.com" }] },
    ]);
  });

  test("parses standalone `---` lines as horizontal-rule blocks (not paragraphs)", () => {
    const blocks = parseRichBlocks(["first", "", "---", "", "second"].join("\n"));
    expect(blocks).toEqual([
      { type: "paragraph", content: "first" },
      { type: "horizontal-rule" },
      { type: "paragraph", content: "second" },
    ]);
  });

  test("treats multiple `---` separators as distinct horizontal-rule blocks", () => {
    const text = ["a", "", "---", "", "b", "", "---", "", "c"].join("\n");
    const blocks = parseRichBlocks(text);
    expect(blocks).toEqual([
      { type: "paragraph", content: "a" },
      { type: "horizontal-rule" },
      { type: "paragraph", content: "b" },
      { type: "horizontal-rule" },
      { type: "paragraph", content: "c" },
    ]);
  });

  test("recognizes `***` and `___` as horizontal rules", () => {
    expect(parseRichBlocks("***")).toEqual([{ type: "horizontal-rule" }]);
    expect(parseRichBlocks("___")).toEqual([{ type: "horizontal-rule" }]);
    expect(parseRichBlocks("- - -")).toEqual([{ type: "horizontal-rule" }]);
    expect(parseRichBlocks("* * *")).toEqual([{ type: "horizontal-rule" }]);
  });

  test("does not match `--` (too short) or `---x` (trailing content) as a horizontal rule", () => {
    expect(parseRichBlocks("--")).toEqual([{ type: "paragraph", content: "--" }]);
    expect(parseRichBlocks("---x")).toEqual([{ type: "paragraph", content: "---x" }]);
    expect(parseRichBlocks("x---")).toEqual([{ type: "paragraph", content: "x---" }]);
  });

  test("does not treat `---` inside a multi-line paragraph as a rule", () => {
    const blocks = parseRichBlocks(["before", "---", "after"].join("\n"));
    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: ["before", "---", "after"].join("\n"),
      },
    ]);
  });

  test("preserves inline em-dash text like `text---more` as a paragraph", () => {
    const blocks = parseRichBlocks("Some text---more text here");
    expect(blocks).toEqual([{ type: "paragraph", content: "Some text---more text here" }]);
  });

  test("keeps code blocks intact and does not coerce `---` inside code into a rule", () => {
    const text = "Intro\n\n```\n---\nstill-code\n```\n\nOutro";
    const blocks = parseRichBlocks(text);
    expect(blocks.map((block: RichBlock) => block.type)).toEqual([
      "paragraph",
      "code",
      "paragraph",
    ]);
  });

  test("handles a message that previously triggered duplicate React keys for `paragraph:---`", () => {
    const text = [
      "first paragraph",
      "",
      "---",
      "",
      "middle paragraph",
      "",
      "---",
      "",
      "trailing paragraph",
    ].join("\n");
    const blocks = parseRichBlocks(text);
    expect(blocks.filter((block) => block.type === "horizontal-rule")).toHaveLength(2);
    expect(blocks.filter((block) => block.type === "paragraph")).toHaveLength(3);
  });
});
