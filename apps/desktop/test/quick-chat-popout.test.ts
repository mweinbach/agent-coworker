import { describe, expect, test } from "bun:test";

import { canPopOutQuickChatThread } from "../src/lib/quickChatPopout";

describe("quick chat pop-out guard", () => {
  test("rejects unsent draft threads", () => {
    expect(canPopOutQuickChatThread({ draft: true })).toBe(false);
  });

  test("allows persisted threads", () => {
    expect(canPopOutQuickChatThread({ draft: false })).toBe(true);
    expect(canPopOutQuickChatThread({})).toBe(true);
  });
});
