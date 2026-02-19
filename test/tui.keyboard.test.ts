import { describe, expect, test } from "bun:test";

import { keyModifiersFromEvent, keyNameFromEvent, normalizeKeyName } from "../apps/TUI/util/keyboard";

describe("keyboard helpers", () => {
  test("normalizes enter aliases and control sequences", () => {
    expect(normalizeKeyName("Return")).toBe("enter");
    expect(normalizeKeyName("linefeed")).toBe("enter");
    expect(normalizeKeyName("\r")).toBe("enter");
    expect(normalizeKeyName("\n")).toBe("enter");
  });

  test("normalizes PageUp/PageDown aliases and ANSI sequences", () => {
    expect(normalizeKeyName("Page Up")).toBe("pageup");
    expect(normalizeKeyName("page_up")).toBe("pageup");
    expect(normalizeKeyName("prior")).toBe("pageup");
    expect(normalizeKeyName("Page-Down")).toBe("pagedown");
    expect(normalizeKeyName("pgdn")).toBe("pagedown");
    expect(normalizeKeyName("next")).toBe("pagedown");
    expect(normalizeKeyName("\u001b[5~")).toBe("pageup");
    expect(normalizeKeyName("\u001b[6~")).toBe("pagedown");
    expect(normalizeKeyName("\u001b[5;2~")).toBe("pageup");
    expect(normalizeKeyName("\u001b[6;2~")).toBe("pagedown");
  });

  test("normalizes event objects from name/key/code/sequence fields", () => {
    expect(keyNameFromEvent({ name: "return" })).toBe("enter");
    expect(keyNameFromEvent({ key: "Enter" })).toBe("enter");
    expect(keyNameFromEvent({ code: "KeyC" })).toBe("c");
    expect(keyNameFromEvent({ sequence: "\u0003" })).toBe("c");
  });

  test("infers modifiers from typical key event fields", () => {
    expect(
      keyModifiersFromEvent({
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
      })
    ).toEqual({ ctrl: true, shift: true, alt: false });
  });

  test("infers ctrl modifier from raw control-character sequences", () => {
    expect(keyModifiersFromEvent("\u0003")).toEqual({ ctrl: true, shift: false, alt: false });
    expect(keyModifiersFromEvent("\r")).toEqual({ ctrl: false, shift: false, alt: false });
  });
});
