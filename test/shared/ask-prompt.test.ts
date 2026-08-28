import { describe, expect, test } from "bun:test";

import {
  normalizeAskOptions,
  normalizeAskQuestion,
  shouldRenderAskOptions,
} from "../../src/shared/askPrompt";

describe("normalizeAskQuestion", () => {
  test("returns an empty string for non-string input", () => {
    expect(normalizeAskQuestion(undefined)).toBe("");
    expect(normalizeAskQuestion({ question: "nope" })).toBe("");
    expect(normalizeAskQuestion(["choose"])).toBe("");
  });

  test("strips a trailing raw stream part and a leading question prefix", () => {
    expect(
      normalizeAskQuestion('Which file? raw stream part: {"type":"response.output_text.delta"}'),
    ).toBe("Which file?");
    expect(normalizeAskQuestion("question:   Keep the change?")).toBe("Keep the change?");
  });

  test("extracts an embedded JSON question string and decodes escapes", () => {
    expect(normalizeAskQuestion('prefix "question": "Use the \\"docs\\" skill?" suffix')).toBe(
      'Use the "docs" skill?',
    );
  });

  test("collapses whitespace and truncates at maxChars", () => {
    expect(normalizeAskQuestion("  one   \n two\t three  ")).toBe("one two three");
    expect(normalizeAskQuestion("abcdefghij", 8)).toBe("abcdefg...");
    expect(normalizeAskQuestion("abcdefg", 8)).toBe("abcdefg");
  });
});

describe("normalizeAskOptions", () => {
  test("returns an empty list for non-string arrays", () => {
    expect(normalizeAskOptions(undefined)).toEqual([]);
    expect(normalizeAskOptions("yes")).toEqual([]);
    expect(normalizeAskOptions([1, "ok"])).toEqual([]);
  });

  test("drops raw payloads, over-long, and punctuation-heavy options", () => {
    expect(
      normalizeAskOptions([
        "raw stream part: {",
        '{"type":"response.function_call"}',
        "includes response.output_text noise",
        "obfuscation token blob",
        "x".repeat(221),
        `${"n".repeat(91)}`,
        "thisIsACamelCaseToolNameWithBracketsXXX()",
        'xxxxxxxxxxxxxxxxxx{"a":1}',
        "Keep this option",
      ]),
    ).toEqual(["Keep this option"]);
  });

  test("dedupes after normalize, truncates long readable options, and caps at six", () => {
    const longReadable = `${"word ".repeat(30)}end`;
    const options = [
      "  Yes  ",
      "Yes",
      "No",
      longReadable,
      "Maybe",
      "Later",
      "Skip",
      "Extra seventh",
    ];

    const normalized = normalizeAskOptions(options);
    expect(normalized).toHaveLength(6);
    expect(normalized[0]).toBe("Yes");
    expect(normalized[1]).toBe("No");
    expect(normalized[2]?.endsWith("...")).toBe(true);
    expect(normalized[2]?.length).toBe(142);
    expect(normalized.slice(3)).toEqual(["Maybe", "Later", "Skip"]);
  });
});

describe("shouldRenderAskOptions", () => {
  test("only renders a chooser when two or more options remain", () => {
    expect(shouldRenderAskOptions([])).toBe(false);
    expect(shouldRenderAskOptions(["only"])).toBe(false);
    expect(shouldRenderAskOptions(["a", "b"])).toBe(true);
  });
});
