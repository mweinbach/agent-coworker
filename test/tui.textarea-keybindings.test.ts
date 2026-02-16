import { describe, expect, test } from "bun:test";

import { getTextareaAction } from "../apps/TUI/component/textarea-keybindings";

describe("getTextareaAction", () => {
  test("maps Enter to submit", () => {
    expect(getTextareaAction("Enter", false, false, false)).toBe("submit");
    expect(getTextareaAction("enter", false, false, false)).toBe("submit");
  });

  test("maps Return to submit", () => {
    expect(getTextareaAction("Return", false, false, false)).toBe("submit");
    expect(getTextareaAction("return", false, false, false)).toBe("submit");
    expect(getTextareaAction("\r", false, false, false)).toBe("submit");
    expect(getTextareaAction("\n", false, false, false)).toBe("submit");
  });

  test("maps Shift+Enter to newline", () => {
    expect(getTextareaAction("Enter", false, true, false)).toBe("newline");
  });

  test("keeps existing Ctrl+J newline behavior", () => {
    expect(getTextareaAction("j", true, false, false)).toBe("newline");
  });
});
