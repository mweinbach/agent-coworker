import { describe, expect, test } from "bun:test";

import { contentText } from "../src/shared/messageContent";

describe("contentText", () => {
  test("trims strings and joins textual content parts", () => {
    expect(contentText("  hello  ")).toBe("hello");
    expect(
      contentText([
        "  first  ",
        { text: " second " },
        { inputText: " third " },
        { text: "   " },
        { inputText: "" },
        null,
        12,
        { other: "ignored" },
      ]),
    ).toBe("first\nsecond\nthird");
  });

  test("returns empty for non-textual values", () => {
    expect(contentText(undefined)).toBe("");
    expect(contentText(null)).toBe("");
    expect(contentText(42)).toBe("");
    expect(contentText({ text: "nope" })).toBe("");
    expect(contentText(["", { text: "   " }, { inputText: "\n" }])).toBe("");
  });

  test("prefers text over inputText on the same part", () => {
    expect(contentText([{ text: "visible", inputText: "hidden" }])).toBe("visible");
    expect(contentText([{ text: "   ", inputText: "fallback" }])).toBe("fallback");
  });
});
