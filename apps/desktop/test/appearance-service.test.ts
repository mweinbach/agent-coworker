import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";

const nativeTheme = Object.assign(new EventEmitter(), {
  themeSource: "system",
  shouldUseDarkColors: false,
  shouldUseDarkColorsForSystemIntegratedUI: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  prefersReducedTransparency: false,
  inForcedColorsMode: false,
});

mock.module("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  nativeTheme,
}));

const {
  applySystemAppearanceToWindow,
  defaultDesktopShellBackgroundColor,
  getInitialWindowAppearanceOptions,
  syncWindowAppearance,
} = await import("../electron/services/appearance");

function createWindowStub() {
  return {
    setBackgroundColorCalls: [] as unknown[],
    setBackgroundMaterialCalls: [] as unknown[],
    setTitleBarOverlayCalls: [] as unknown[],
    setVibrancyCalls: [] as unknown[],
    setBackgroundColor(value: unknown) {
      this.setBackgroundColorCalls.push(value);
    },
    setBackgroundMaterial(value: unknown) {
      this.setBackgroundMaterialCalls.push(value);
    },
    setTitleBarOverlay(value: unknown) {
      this.setTitleBarOverlayCalls.push(value);
    },
    setVibrancy(value: unknown) {
      this.setVibrancyCalls.push(value);
    },
  };
}

describe("desktop appearance service", () => {
  test("builds transparent macOS startup options only when glass is enabled", () => {
    expect(
      getInitialWindowAppearanceOptions({
        platform: "darwin",
        useMacosNativeGlass: true,
      }),
    ).toEqual({
      show: false,
      backgroundColor: "#00000000",
    });

    expect(
      getInitialWindowAppearanceOptions({
        platform: "darwin",
        useMacosNativeGlass: false,
        useDarkColors: true,
      }),
    ).toEqual({
      show: false,
      backgroundColor: defaultDesktopShellBackgroundColor(true),
    });
  });

  test("adds mica material to Windows startup options", () => {
    expect(
      getInitialWindowAppearanceOptions({
        platform: "win32",
      }),
    ).toEqual({
      show: false,
      backgroundColor: defaultDesktopShellBackgroundColor(false),
      backgroundMaterial: "mica",
    });
  });

  test("syncWindowAppearance keeps Windows background and titlebar updates isolated", () => {
    const win = createWindowStub();
    syncWindowAppearance(win as unknown as BrowserWindow, {
      platform: "win32",
      useDarkColors: true,
    });

    expect(win.setBackgroundColorCalls).toEqual([defaultDesktopShellBackgroundColor(true)]);
    expect(win.setBackgroundMaterialCalls).toEqual(["mica"]);
    expect(win.setTitleBarOverlayCalls).toEqual([
      {
        color: "#00000000",
        symbolColor: "#f6ece0",
        height: 48,
      },
    ]);
    expect(win.setVibrancyCalls).toEqual([]);
  });

  test("applySystemAppearanceToWindow disables macOS glass when transparency is reduced", () => {
    const win = createWindowStub();
    applySystemAppearanceToWindow(win as unknown as BrowserWindow, {
      platform: "darwin",
      themeSource: "system",
      shouldUseDarkColors: true,
      shouldUseDarkColorsForSystemIntegratedUI: true,
      shouldUseHighContrastColors: false,
      shouldUseInvertedColorScheme: false,
      prefersReducedTransparency: true,
      inForcedColorsMode: false,
    });

    expect(win.setBackgroundColorCalls).toEqual([defaultDesktopShellBackgroundColor(true)]);
    expect(win.setBackgroundMaterialCalls).toEqual([]);
    expect(win.setVibrancyCalls).toEqual([null]);
  });
});
