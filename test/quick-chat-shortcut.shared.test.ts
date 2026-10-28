import { describe, expect, test } from "bun:test";

import {
  captureQuickChatShortcut,
  DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
  formatQuickChatShortcutLabel,
  normalizeQuickChatShortcutAccelerator,
} from "../src/shared/quickChatShortcut";

describe("shared quick chat shortcut helpers", () => {
  test("falls back to the default accelerator for invalid values", () => {
    expect(normalizeQuickChatShortcutAccelerator(undefined)).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
    expect(normalizeQuickChatShortcutAccelerator("Space")).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
    expect(normalizeQuickChatShortcutAccelerator("Shift+Meta")).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
  });

  test("normalizes valid accelerators", () => {
    expect(normalizeQuickChatShortcutAccelerator(" alt + space ")).toBe("Alt+Space");
    expect(normalizeQuickChatShortcutAccelerator("cmdorctrl+shift+k")).toBe(
      "CommandOrControl+Shift+K",
    );
  });

  test("canonicalizes aliases and rejects duplicate or out-of-range keys", () => {
    expect(normalizeQuickChatShortcutAccelerator(null)).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
    expect(normalizeQuickChatShortcutAccelerator("")).toBe(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
    expect(normalizeQuickChatShortcutAccelerator("   ")).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
    expect(normalizeQuickChatShortcutAccelerator("Ctrl+Control+K")).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
    expect(normalizeQuickChatShortcutAccelerator("shift+f25")).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
    expect(normalizeQuickChatShortcutAccelerator("ctrl++")).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
    expect(normalizeQuickChatShortcutAccelerator("option+esc")).toBe("Alt+Escape");
    expect(normalizeQuickChatShortcutAccelerator("control+f24")).toBe("Ctrl+F24");
    expect(normalizeQuickChatShortcutAccelerator("alt+-")).toBe("Alt+Minus");
    expect(normalizeQuickChatShortcutAccelerator("ctrl+plus")).toBe("Ctrl+Plus");
    expect(normalizeQuickChatShortcutAccelerator("shift+pageup")).toBe("Shift+PageUp");
    expect(normalizeQuickChatShortcutAccelerator("alt+arrowdown")).toBe("Alt+Down");
    expect(normalizeQuickChatShortcutAccelerator("ctrl+7")).toBe("Ctrl+7");
    expect(normalizeQuickChatShortcutAccelerator("shift+alt+k")).toBe("Shift+Alt+K");
    expect(formatQuickChatShortcutLabel("Ctrl+F24")).toBe("Ctrl + F24");
    expect(formatQuickChatShortcutLabel("not-a-shortcut")).toBe("Command/Ctrl + Shift + Space");
  });

  test("captures layout-independent keys and keeps modifier-only input pending", () => {
    expect(
      captureQuickChatShortcut({
        key: "å",
        code: "KeyQ",
        metaKey: true,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ status: "complete", accelerator: "CommandOrControl+Ctrl+Q" });
    expect(
      captureQuickChatShortcut({
        key: "Unidentified",
        code: "Digit0",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ status: "complete", accelerator: "CommandOrControl+0" });
    expect(
      captureQuickChatShortcut({
        key: "ArrowDown",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toEqual({ status: "complete", accelerator: "Shift+Down" });
    expect(
      captureQuickChatShortcut({
        key: "+",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ status: "complete", accelerator: "CommandOrControl+Plus" });
    expect(
      captureQuickChatShortcut({
        key: "k",
        code: "KeyK",
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toEqual({ status: "complete", accelerator: "Alt+K" });
    expect(
      captureQuickChatShortcut({
        key: "F5",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ status: "invalid", message: "Use at least one modifier key." });
    expect(
      captureQuickChatShortcut({
        key: "Control",
        code: "ControlLeft",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ status: "pending" });
    expect(
      captureQuickChatShortcut({
        key: "Dead",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ status: "pending" });
  });

  test("captures Space-based shortcuts from keyboard events", () => {
    expect(
      captureQuickChatShortcut({
        key: " ",
        code: "Space",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toEqual({ status: "complete", accelerator: "CommandOrControl+Shift+Space" });
  });
});
