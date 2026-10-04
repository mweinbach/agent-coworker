import { describe, expect, test } from "bun:test";
import { contentText } from "../src/shared/messageContent";

describe("contentText", () => {
  test("trims strings, joins textual parts, prefers text over inputText, and ignores non-textual values", () => {
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

    for (const v of [
      undefined,
      null,
      42,
      { text: "nope" },
      ["", { text: "   " }, { inputText: "\n" }],
    ]) {
      expect(contentText(v)).toBe("");
    }

    expect(contentText([{ text: "visible", inputText: "hidden" }])).toBe("visible");
    expect(contentText([{ text: "   ", inputText: "fallback" }])).toBe("fallback");
  });
});
