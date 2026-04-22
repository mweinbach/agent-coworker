import { describe, expect, test } from "bun:test";

import {
  captureQuickChatShortcut,
  DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
  formatQuickChatShortcutLabel,
  normalizeQuickChatShortcutAccelerator,
} from "../src/lib/quickChatShortcut";

describe("quick chat shortcut helpers", () => {
  test("normalizes invalid persisted accelerators back to the default", () => {
    expect(normalizeQuickChatShortcutAccelerator(undefined)).toBe(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
    expect(normalizeQuickChatShortcutAccelerator("Space")).toBe(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
    expect(normalizeQuickChatShortcutAccelerator("Shift+Meta")).toBe(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
  });

  test("normalizes supported accelerators into canonical tokens", () => {
    expect(normalizeQuickChatShortcutAccelerator(" alt + space ")).toBe("Alt+Space");
    expect(normalizeQuickChatShortcutAccelerator("cmdorctrl+shift+k")).toBe("CommandOrControl+Shift+K");
  });

  test("formats accelerators for display", () => {
    expect(formatQuickChatShortcutLabel("CommandOrControl+Shift+Space")).toBe("Command/Ctrl + Shift + Space");
    expect(formatQuickChatShortcutLabel("Alt+Space")).toBe("Alt + Space");
  });

  test("captures a shortcut from keyboard modifiers plus a final key", () => {
    expect(captureQuickChatShortcut({
      key: "Shift",
      code: "ShiftLeft",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    })).toEqual({ status: "pending" });

    expect(captureQuickChatShortcut({
      key: "k",
      code: "KeyK",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    })).toEqual({ status: "complete", accelerator: "CommandOrControl+Shift+K" });

    expect(captureQuickChatShortcut({
      key: " ",
      code: "Space",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    })).toEqual({ status: "complete", accelerator: "CommandOrControl+Shift+Space" });
  });

  test("rejects shortcut capture without modifiers", () => {
    expect(captureQuickChatShortcut({
      key: "k",
      code: "KeyK",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    })).toEqual({ status: "invalid", message: "Use at least one modifier key." });
  });
});
