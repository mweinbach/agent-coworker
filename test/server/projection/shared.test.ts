import { describe, expect, test } from "bun:test";

import {
  hasVisibleAssistantText,
  makeItemId,
  normalizeReasoningText,
  normalizeToolArgsFromInput,
  normalizeTranscriptReplayText,
  occurrenceItemId,
  reasoningModeFromPart,
} from "../../../src/server/projection/shared";

describe("conversation projection helpers", () => {
  test("occurrenceItemId suffixes only after the first occurrence", () => {
    expect(occurrenceItemId("msg", 0)).toBe("msg");
    expect(occurrenceItemId("msg", 1)).toBe("msg");
    expect(occurrenceItemId("msg", 2)).toBe("msg:2");
    expect(makeItemId("toolCall", "turn-1:read")).toBe("toolCall:turn-1:read");
  });

  test("normalizeTranscriptReplayText collapses CRLF, line padding, and extra blank lines", () => {
    expect(normalizeTranscriptReplayText("  hello \r\n\r\n\r\nworld\r  ")).toBe("hello\n\nworld");
    expect(normalizeTranscriptReplayText("\n\nonly\n\n\n")).toBe("only");
  });

  test("reasoning and assistant visibility treat whitespace as empty", () => {
    expect(normalizeReasoningText("  think  ")).toBe("think");
    expect(normalizeReasoningText(" \n ")).toBeNull();
    expect(hasVisibleAssistantText("  hi  ")).toBe(true);
    expect(hasVisibleAssistantText("\t")).toBe(false);
    expect(reasoningModeFromPart({ mode: "summary" })).toBe("summary");
    expect(reasoningModeFromPart({ mode: "reasoning" })).toBe("reasoning");
    expect(reasoningModeFromPart({})).toBe("reasoning");
  });

  test("normalizeToolArgsFromInput merges JSON objects and strips a stale input key", () => {
    expect(normalizeToolArgsFromInput('{"path":"/tmp/a"}', { input: "old", extra: 1 })).toEqual({
      extra: 1,
      path: "/tmp/a",
    });
    expect(normalizeToolArgsFromInput("not-json", { input: "old", extra: 1 })).toEqual({
      extra: 1,
      input: "not-json",
    });
    expect(normalizeToolArgsFromInput("[1,2]", { extra: 1 })).toEqual({
      extra: 1,
      input: "[1,2]",
    });
    expect(normalizeToolArgsFromInput("plain")).toEqual({ input: "plain" });
  });
});
