import { describe, expect, test } from "bun:test";
import type { BrowserWindow } from "electron";

import {
  applyMacosPremiumEnhancements,
  macosBrowserWindowOptions,
  shouldUseMacosLiquidGlass,
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

  test("can disable transparent windows for macOS fallback mode", () => {
    const options = macosBrowserWindowOptions("darwin", { useMacosLiquidGlass: false });
    expect(options.transparent).toBe(false);
  });
});

describe("shouldUseMacosLiquidGlass", () => {
  test("defaults to enabled on macOS and disabled elsewhere", () => {
    expect(shouldUseMacosLiquidGlass("darwin", {})).toBe(true);
    expect(shouldUseMacosLiquidGlass("win32", {})).toBe(false);
  });

  test("respects explicit environment overrides", () => {
    expect(shouldUseMacosLiquidGlass("darwin", { COWORK_MACOS_LIQUID_GLASS: "0" })).toBe(false);
    expect(shouldUseMacosLiquidGlass("darwin", { COWORK_MACOS_LIQUID_GLASS: "false" })).toBe(false);
    expect(shouldUseMacosLiquidGlass("darwin", { COWORK_MACOS_LIQUID_GLASS: "1" })).toBe(true);
  });
});

describe("applyMacosPremiumEnhancements", () => {
  test("does not load optional modules on non-macOS", async () => {
    let importCalls = 0;
    const result = await applyMacosPremiumEnhancements(createWindowStub() as BrowserWindow, {
      platform: "linux",
      importModule: async () => {
        importCalls += 1;
        return {};
      },
    });
    expect(result).toEqual({
      liquidGlassApplied: false,
      superBrowserWindowKitApplied: false,
    });
    expect(importCalls).toBe(0);
  });

  test("applies both super-browser-window-kit and liquid glass on macOS when available", async () => {
    const calls: string[] = [];
    await applyMacosPremiumEnhancements(createWindowStub() as BrowserWindow, {
      platform: "darwin",
      warn: () => {},
      enableSuperBrowserWindowKit: true,
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
              GlassMaterialVariant: {
                abuttedSidebar: 17,
              },
              isGlassSupported: () => true,
              addView: (_handle: Buffer, options?: { cornerRadius?: number }) => {
                calls.push(`glass:add:${String(options?.cornerRadius)}`);
                return 7;
              },
              unstable_setVariant: (_viewId: number, variant: number) => {
                calls.push(`glass:variant:${String(variant)}`);
              },
            },
          };
        }

        throw new Error(`Unexpected module import: ${specifier}`);
      },
    });

    expect(calls).toEqual(["glass:add:16", "glass:variant:17", "corner:enable", "corner:radius:16"]);
  });

  test("falls back to liquid glass when super-browser-window-kit is unavailable", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];

    await applyMacosPremiumEnhancements(createWindowStub() as BrowserWindow, {
      platform: "darwin",
      warn: (message) => warnings.push(message),
      enableSuperBrowserWindowKit: true,
      importModule: async (specifier) => {
        if (specifier === "super-browser-window-kit") {
          throw new Error("module unavailable");
        }
        if (specifier === "electron-liquid-glass") {
          return {
            default: {
              GlassMaterialVariant: {
                sidebar: 16,
              },
              addView: () => {
                calls.push("glass:applied");
                return 1;
              },
              unstable_setVariant: (_viewId: number, variant: number) => {
                calls.push(`glass:variant:${String(variant)}`);
              },
            },
          };
        }
        throw new Error(`Unexpected module import: ${specifier}`);
      },
    });

    expect(calls).toEqual(["glass:applied", "glass:variant:16"]);
    expect(warnings.some((warning) => warning.includes("super-browser-window-kit"))).toBe(true);
  });

  test("skips super-browser-window-kit by default", async () => {
    const calls: string[] = [];
    await applyMacosPremiumEnhancements(createWindowStub() as BrowserWindow, {
      platform: "darwin",
      warn: () => {},
      importModule: async (specifier) => {
        if (specifier === "electron-liquid-glass") {
          return {
            default: {
              GlassMaterialVariant: {
                abuttedSidebar: 17,
              },
              addView: () => {
                calls.push("glass:applied");
                return 1;
              },
              unstable_setVariant: (_viewId: number, variant: number) => {
                calls.push(`glass:variant:${String(variant)}`);
              },
            },
          };
        }
        if (specifier === "super-browser-window-kit") {
          calls.push("sbwk:imported");
          return { default: {} };
        }
        throw new Error(`Unexpected module import: ${specifier}`);
      },
    });

    expect(calls).toEqual(["glass:applied", "glass:variant:17"]);
  });
});
