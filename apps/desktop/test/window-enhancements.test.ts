import { describe, expect, test } from "bun:test";
import type { BrowserWindow } from "electron";

import {
  applyMacosPremiumEnhancements,
  macosBrowserWindowOptions,
} from "../electron/services/windowEnhancements";

function createWindowStub() {
  return {
    getNativeWindowHandle: () => Buffer.from("01", "hex"),
  };
}

describe("macosBrowserWindowOptions", () => {
  test("returns title bar overlay options on Windows", () => {
    expect(macosBrowserWindowOptions("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#5a4736",
        height: 48,
      },
    });
  });

  test("returns an empty object on Linux", () => {
    expect(macosBrowserWindowOptions("linux")).toEqual({});
  });

  test("adds hidden inset title bar and traffic lights on macOS", () => {
    const options = macosBrowserWindowOptions("darwin");
    expect(options.titleBarStyle).toBe("hiddenInset");
    expect(options.trafficLightPosition).toEqual({ x: 14, y: 14 });
    expect(options.transparent).toBe(true);
  });
});

describe("applyMacosPremiumEnhancements", () => {
  test("does not load optional modules on non-macOS", async () => {
    let importCalls = 0;
    await applyMacosPremiumEnhancements(createWindowStub() as BrowserWindow, {
      platform: "linux",
      importModule: async () => {
        importCalls += 1;
        return {};
      },
    });
    expect(importCalls).toBe(0);
  });

  test("applies both super-browser-window-kit and liquid glass on macOS when available", async () => {
    const calls: string[] = [];
    await applyMacosPremiumEnhancements(createWindowStub() as BrowserWindow, {
      platform: "darwin",
      warn: () => {},
      importModule: async (specifier) => {
        if (specifier === "super-browser-window-kit") {
          return {
            default: {
              enableWindowCornerCustomization: () => {
                calls.push("corner:enable");
                return true;
              },
              setWindowCornerRadius: (_handle: Buffer, radius: number) => {
                calls.push(`corner:radius:${String(radius)}`);
                return true;
              },
            },
          };
        }

        if (specifier === "electron-liquid-glass") {
          return {
            default: {
              isGlassSupported: () => true,
              addView: (_handle: Buffer, options?: { cornerRadius?: number }) => {
                calls.push(`glass:add:${String(options?.cornerRadius)}`);
                return 7;
              },
            },
          };
        }

        throw new Error(`Unexpected module import: ${specifier}`);
      },
    });

    expect(calls).toEqual(["corner:enable", "corner:radius:16", "glass:add:16"]);
  });

  test("falls back to liquid glass when super-browser-window-kit is unavailable", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];

    await applyMacosPremiumEnhancements(createWindowStub() as BrowserWindow, {
      platform: "darwin",
      warn: (message) => warnings.push(message),
      importModule: async (specifier) => {
        if (specifier === "super-browser-window-kit") {
          throw new Error("module unavailable");
        }
        if (specifier === "electron-liquid-glass") {
          return {
            default: {
              addView: () => {
                calls.push("glass:applied");
                return 1;
              },
            },
          };
        }
        throw new Error(`Unexpected module import: ${specifier}`);
      },
    });

    expect(calls).toEqual(["glass:applied"]);
    expect(warnings.some((warning) => warning.includes("super-browser-window-kit"))).toBe(true);
  });
});
