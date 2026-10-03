import { describe, expect, test } from "bun:test";

import {
  normalizeAskOptions,
  normalizeAskQuestion,
  shouldRenderAskOptions,
} from "../../src/shared/askPrompt";

describe("normalizeAskQuestion", () => {
  test("returns empty for non-strings, blanks, and raw stream leftovers", () => {
    expect(normalizeAskQuestion(undefined)).toBe("");
    expect(normalizeAskQuestion(null)).toBe("");
    expect(normalizeAskQuestion(12)).toBe("");
    expect(normalizeAskQuestion("   ")).toBe("");
    expect(normalizeAskQuestion('raw stream part: {"type":"response.output"}')).toBe("");
  });

  test("strips a question prefix and extracts an embedded JSON question", () => {
    expect(normalizeAskQuestion("Question:  Focus on auth")).toBe("Focus on auth");
    expect(normalizeAskQuestion('prefix "question": "Focus on auth" suffix')).toBe("Focus on auth");
    expect(normalizeAskQuestion('{"question": "Say \\"hi\\""}')).toBe('Say "hi"');
  });

  test("collapses whitespace and truncates long questions", () => {
    expect(normalizeAskQuestion("  one   two\nthree  ")).toBe("one two three");
    const compact = "word ".repeat(100).trim();
    const normalized = normalizeAskQuestion(compact);
    expect(normalized.endsWith("...")).toBe(true);
    expect(normalized.length).toBe(482);
    expect(normalized.startsWith("word word")).toBe(true);
  });
});

describe("normalizeAskOptions", () => {
  test("drops unreadable, raw, oversized, and duplicate options", () => {
    expect(normalizeAskOptions(undefined)).toEqual([]);
    expect(normalizeAskOptions("Yes")).toEqual([]);
    expect(
      normalizeAskOptions([
        " Yes ",
        "",
        "Yes",
        "raw stream part: {",
        '{"type":"response.output"}',
        "response.completed",
        "token obfuscation value",
        "a".repeat(91),
        "a".repeat(221),
        "No",
      ]),
    ).toEqual(["Yes", "No"]);
  });

  test("truncates readable long options and caps the list at six", () => {
    const longReadable = "alpha ".repeat(24).trim();
    expect(longReadable.length).toBeGreaterThan(140);
    expect(longReadable.length).toBeLessThanOrEqual(220);

    const truncated = normalizeAskOptions([longReadable])[0];
    expect(truncated).toBe(`${longReadable.slice(0, 139)}...`);
    expect(truncated?.length).toBe(142);

    expect(normalizeAskOptions(["one", "two", "three", "four", "five", "six", "seven"])).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
    ]);
  });
});

describe("shouldRenderAskOptions", () => {
  test("requires at least two surviving options", () => {
    expect(shouldRenderAskOptions([])).toBe(false);
    expect(shouldRenderAskOptions(["Yes"])).toBe(false);
    expect(shouldRenderAskOptions(["Yes", "No"])).toBe(true);
  });
});
