import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { isEnterWithoutIme, isImeComposing, isPlainEnterWithoutIme } from "../src/lib/keyboard";

describe("IME-safe submit shortcuts", () => {
  test("treats both composition state and legacy keyCode 229 as active IME input", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  test("never treats a composing Enter as a submit shortcut", () => {
    const baseEvent = {
      altKey: false,
      ctrlKey: false,
      key: "Enter",
      metaKey: false,
      shiftKey: false,
    };
    expect(
      isPlainEnterWithoutIme({
        ...baseEvent,
        nativeEvent: { isComposing: true },
      }),
    ).toBe(false);
    expect(
      isPlainEnterWithoutIme({
        ...baseEvent,
        nativeEvent: { isComposing: false, keyCode: 229 },
      }),
    ).toBe(false);
    expect(
      isPlainEnterWithoutIme({
        ...baseEvent,
        nativeEvent: { isComposing: false, keyCode: 13 },
      }),
    ).toBe(true);
    expect(
      isEnterWithoutIme({
        key: "Enter",
        nativeEvent: { isComposing: true },
      }),
    ).toBe(false);
  });

  test("keeps Chat, New Chat, and Canvas on the shared IME-safe Enter contract", async () => {
    const sources = await Promise.all(
      ["../src/ui/ChatView.tsx", "../src/ui/chat/NewChatLanding.tsx", "../src/ui/Canvas.tsx"].map(
        (path) => readFile(new URL(path, import.meta.url), "utf8"),
      ),
    );
    expect(sources[0]).toContain("isPlainEnterWithoutIme(event)");
    expect(sources[1]).toContain("isPlainEnterWithoutIme(event)");
    expect(sources[2]).toContain("isEnterWithoutIme(e)");
  });
});
