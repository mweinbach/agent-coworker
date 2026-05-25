import { describe, expect, test } from "bun:test";

import {
  parseRichBlocks,
  type RichBlock,
} from "../apps/mobile/src/components/thread/markdownParser";

describe("mobile markdown parser", () => {
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
    expect(blocks).toEqual([
      { type: "paragraph", content: "Some text---more text here" },
    ]);
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
