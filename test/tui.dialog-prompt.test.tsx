import { describe, expect, test } from "bun:test";

import {
  resolveDialogPromptSubmitValue,
  shouldDismissDialogPromptForKey,
} from "../apps/TUI/ui/dialog-prompt";

describe("DialogPrompt helpers", () => {
  test("Enter submission resolves a typed API key", () => {
    expect(resolveDialogPromptSubmitValue("sk-ant-123")).toBe("sk-ant-123");
  });

  test("Enter submission ignores whitespace-only input", () => {
    expect(resolveDialogPromptSubmitValue("   \t  ")).toBeNull();
  });

  test("Escape key maps to dismiss behavior", () => {
    expect(shouldDismissDialogPromptForKey("escape")).toBe(true);
    expect(shouldDismissDialogPromptForKey("enter")).toBe(false);
  });
});
