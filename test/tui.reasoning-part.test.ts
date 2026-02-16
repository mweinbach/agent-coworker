import { describe, expect, test } from "bun:test";

import {
  reasoningPreviewText,
  shouldToggleReasoningExpanded,
} from "../apps/TUI/component/message/reasoning-part";

describe("TUI reasoning part helpers", () => {
  test("preview keeps full text when within max lines", () => {
    expect(reasoningPreviewText("line 1\nline 2", 3)).toBe("line 1\nline 2");
  });

  test("preview truncates and appends ellipsis when over max lines", () => {
    expect(reasoningPreviewText("line 1\nline 2\nline 3\nline 4", 3)).toBe("line 1\nline 2\nline 3...");
  });

  test("keyboard toggle helper allows Enter and Space", () => {
    expect(shouldToggleReasoningExpanded("enter")).toBe(true);
    expect(shouldToggleReasoningExpanded("space")).toBe(true);
    expect(shouldToggleReasoningExpanded(" ")).toBe(true);
    expect(shouldToggleReasoningExpanded("escape")).toBe(false);
  });
});
