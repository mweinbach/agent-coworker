import { describe, expect, test } from "bun:test";

import {
  hasVisibleAssistantText,
  makeItemId,
  normalizeReasoningText,
  normalizeToolArgsFromInput,
  normalizeTranscriptReplayText,
  occurrenceItemId,
  readPartString,
  reasoningModeFromPart,
} from "../../src/server/projection/shared";

describe("projection shared helpers", () => {
  test("occurrenceItemId keeps the base id through the first occurrence", () => {
    expect(occurrenceItemId("tool:search", 0)).toBe("tool:search");
    expect(occurrenceItemId("tool:search", 1)).toBe("tool:search");
    expect(occurrenceItemId("tool:search", 2)).toBe("tool:search:2");
    expect(makeItemId("assistant", "turn-1")).toBe("assistant:turn-1");
  });

  test("readPartString and reasoningModeFromPart fail closed on blank values", () => {
    expect(readPartString(undefined, "text")).toBeNull();
    expect(readPartString({ text: "   " }, "text")).toBeNull();
    expect(readPartString({ text: 12 }, "text")).toBeNull();
    expect(readPartString({ text: " visible " }, "text")).toBe(" visible ");

    expect(reasoningModeFromPart(undefined)).toBe("reasoning");
    expect(reasoningModeFromPart({ mode: "summary" })).toBe("summary");
    expect(reasoningModeFromPart({ mode: " Summary " })).toBe("reasoning");
    expect(reasoningModeFromPart({ mode: "thinking" })).toBe("reasoning");
  });

  test("transcript replay collapses CRLF and excess blank lines", () => {
    expect(normalizeTranscriptReplayText("  hello \r\n\r\n\r\n  world \n")).toBe("hello\n\nworld");
    expect(normalizeReasoningText("   ")).toBeNull();
    expect(normalizeReasoningText("  think  ")).toBe("think");
    expect(hasVisibleAssistantText("\n\t")).toBe(false);
    expect(hasVisibleAssistantText("ok")).toBe(true);
  });

  test("normalizeToolArgsFromInput merges parsed objects and drops stale input", () => {
    expect(
      normalizeToolArgsFromInput('{"path":"/tmp/a","force":true}', {
        input: "stale",
        toolName: "read",
      }),
    ).toEqual({
      toolName: "read",
      path: "/tmp/a",
      force: true,
    });
  });

  test("normalizeToolArgsFromInput keeps raw input when JSON is not an object", () => {
    expect(normalizeToolArgsFromInput("[1,2]", { input: "old", name: "search" })).toEqual({
      name: "search",
      input: "[1,2]",
    });
    expect(normalizeToolArgsFromInput("not-json")).toEqual({ input: "not-json" });
    expect(normalizeToolArgsFromInput("42", ["already-an-array"])).toEqual({ input: "42" });
    expect(normalizeToolArgsFromInput("")).toEqual({ input: "" });
  });
});
