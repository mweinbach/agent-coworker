import { describe, expect, mock, test } from "bun:test";

const copyTextMock = mock(async (_text: string) => {});

mock.module("../src/lib/desktopCommands", () => ({
  copyText: copyTextMock,
}));

const { writeClipboardText } = await import("../src/lib/clipboard");

describe("writeClipboardText", () => {
  test("prefers the Electron desktop bridge over navigator.clipboard", async () => {
    copyTextMock.mockClear();
    copyTextMock.mockImplementation(async () => {});

    await writeClipboardText("hello from windows");

    expect(copyTextMock).toHaveBeenCalledTimes(1);
    expect(copyTextMock).toHaveBeenCalledWith("hello from windows");
  });

  test("falls back to navigator.clipboard when desktop bridge fails", async () => {
    copyTextMock.mockClear();
    copyTextMock.mockImplementation(async () => {
      throw new Error("no desktop api");
    });

    const writeText = mock(async (_text: string) => {});
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: { writeText },
      },
    });

    try {
      await writeClipboardText("fallback text");
      expect(writeText).toHaveBeenCalledWith("fallback text");
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: original,
      });
    }
  });
});
