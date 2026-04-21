import { describe, expect, test } from "bun:test";

import {
  DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
  normalizeQuickChatShortcutAccelerator,
} from "../src/shared/quickChatShortcut";

describe("shared quick chat shortcut helpers", () => {
  test("falls back to the default accelerator for invalid values", () => {
    expect(normalizeQuickChatShortcutAccelerator(undefined)).toBe(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
    expect(normalizeQuickChatShortcutAccelerator("Space")).toBe(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
    expect(normalizeQuickChatShortcutAccelerator("Shift+Meta")).toBe(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
  });

  test("normalizes valid accelerators", () => {
    expect(normalizeQuickChatShortcutAccelerator(" alt + space ")).toBe("Alt+Space");
    expect(normalizeQuickChatShortcutAccelerator("cmdorctrl+shift+k")).toBe("CommandOrControl+Shift+K");
  });
});
