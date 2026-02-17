import { describe, expect, test } from "bun:test";

import {
  filterFeedForDeveloperMode,
  reasoningLabelForMode,
  reasoningPreviewText,
  shouldToggleReasoningExpanded,
} from "../src/ui/ChatView";

describe("desktop reasoning UI helpers", () => {
  test("maps reasoning mode to labels", () => {
    expect(reasoningLabelForMode("reasoning")).toBe("Reasoning");
    expect(reasoningLabelForMode("summary")).toBe("Summary");
  });

  test("builds collapsed preview from first lines", () => {
    expect(reasoningPreviewText("line 1\nline 2", 3)).toBe("line 1\nline 2");
    expect(reasoningPreviewText("line 1\nline 2\nline 3\nline 4", 3)).toBe("line 1\nline 2\nline 3...");
  });

  test("keyboard toggle helper only allows Enter and Space", () => {
    expect(shouldToggleReasoningExpanded("Enter")).toBe(true);
    expect(shouldToggleReasoningExpanded(" ")).toBe(true);
    expect(shouldToggleReasoningExpanded("Spacebar")).toBe(true);
    expect(shouldToggleReasoningExpanded("Escape")).toBe(false);
  });

  test("hides system feed entries unless developer mode is enabled", () => {
    const feed = [
      { id: "a", kind: "system", ts: "2024-01-01T00:00:00.000Z", line: "[server_hello]" },
      { id: "b", kind: "message", role: "assistant" as const, ts: "2024-01-01T00:00:01.000Z", text: "hi" },
    ];

    expect(filterFeedForDeveloperMode(feed, false)).toEqual([
      { id: "b", kind: "message", role: "assistant", ts: "2024-01-01T00:00:01.000Z", text: "hi" },
    ]);
    expect(filterFeedForDeveloperMode(feed, true)).toEqual(feed);
  });
});
