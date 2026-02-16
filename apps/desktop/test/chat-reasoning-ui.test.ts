import { describe, expect, test } from "bun:test";

import {
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
});
