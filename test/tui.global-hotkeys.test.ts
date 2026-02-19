import { describe, expect, test } from "bun:test";

import { shouldSuspendGlobalHotkeys } from "../apps/TUI/app";

describe("TUI global hotkey gating", () => {
  test("suspends global hotkeys while an ask prompt is active", () => {
    expect(
      shouldSuspendGlobalHotkeys({
        pendingAsk: true,
        pendingApproval: false,
      })
    ).toBe(true);
  });

  test("suspends global hotkeys while an approval prompt is active", () => {
    expect(
      shouldSuspendGlobalHotkeys({
        pendingAsk: false,
        pendingApproval: true,
      })
    ).toBe(true);
  });

  test("keeps global hotkeys enabled when no prompt is active", () => {
    expect(
      shouldSuspendGlobalHotkeys({
        pendingAsk: false,
        pendingApproval: false,
      })
    ).toBe(false);
  });
});
