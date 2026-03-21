import { describe, expect, test } from "bun:test";
import type { BrowserWindow } from "electron";

import {
  applyPlatformWindowCreated,
  getPlatformBrowserWindowOptions,
  macosBrowserWindowOptions,
  shouldUseMacosNativeGlass,
  syncWindowChromeAppearance,
} from "../electron/services/windowEnhancements";

function createWindowStub() {
  return {
    setTitleBarOverlayCalls: [] as unknown[],
    setVibrancyCalls: [] as unknown[],
    setWindowButtonVisibilityCalls: [] as unknown[],
    setMenuCalls: [] as unknown[],
    setTitleBarOverlay(overlay: unknown) {
      this.setTitleBarOverlayCalls.push(overlay);
    },
    setVibrancy(value: unknown) {
      this.setVibrancyCalls.push(value);
    },
    setWindowButtonVisibility(value: unknown) {
      this.setWindowButtonVisibilityCalls.push(value);
    },
    setMenu(value: unknown) {
      this.setMenuCalls.push(value);
    },
  };
}

describe("getPlatformBrowserWindowOptions", () => {
  test("returns title bar overlay options on Windows", () => {
    expect(getPlatformBrowserWindowOptions("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#5a4736",
        height: 48,
      },
    });
  });

  test("uses a light symbol color for dark Windows themes", () => {
    expect(getPlatformBrowserWindowOptions("win32", { useDarkColors: true })).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#f6ece0",
        height: 48,
      },
    });
  });

  test("returns title bar overlay options on Linux", () => {
    expect(getPlatformBrowserWindowOptions("linux")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#5a4736",
        height: 48,
      },
    });
  });

  test("uses a light symbol color for dark Linux themes", () => {
    expect(getPlatformBrowserWindowOptions("linux", { useDarkColors: true })).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#f6ece0",
        height: 48,
      },
    });
  });

  test("adds native vibrancy options on macOS when glass is enabled", () => {
    const options = getPlatformBrowserWindowOptions("darwin");
    expect(options.titleBarStyle).toBe("hiddenInset");
    expect(options.trafficLightPosition).toEqual({ x: 14, y: 14 });
    expect(options.transparent).toBe(true);
    expect(options.vibrancy).toBe("sidebar");
    expect(options.visualEffectState).toBe("active");
  });

  test("can disable native glass on macOS", () => {
    const options = getPlatformBrowserWindowOptions("darwin", { useMacosNativeGlass: false });
    expect(options.transparent).toBe(false);
    expect(options.vibrancy).toBeUndefined();
    expect(options.visualEffectState).toBeUndefined();
  });
});

describe("macosBrowserWindowOptions (alias)", () => {
  test("delegates to getPlatformBrowserWindowOptions", () => {
    expect(macosBrowserWindowOptions("linux")).toEqual(getPlatformBrowserWindowOptions("linux"));
  });
});

describe("shouldUseMacosNativeGlass", () => {
  test("defaults to enabled on macOS and disabled elsewhere", () => {
    expect(shouldUseMacosNativeGlass("darwin", {})).toBe(true);
    expect(shouldUseMacosNativeGlass("win32", {})).toBe(false);
  });

  test("disables glass when reduced transparency is preferred", () => {
    expect(
      shouldUseMacosNativeGlass("darwin", {}, { prefersReducedTransparency: true }),
    ).toBe(false);
  });

  test("respects explicit environment overrides", () => {
    expect(shouldUseMacosNativeGlass("darwin", { COWORK_MACOS_NATIVE_GLASS: "0" })).toBe(false);
    expect(shouldUseMacosNativeGlass("darwin", { COWORK_MACOS_NATIVE_GLASS: "false" })).toBe(false);
    expect(shouldUseMacosNativeGlass("darwin", { COWORK_MACOS_NATIVE_GLASS: "1" })).toBe(true);
  });
});

describe("syncWindowChromeAppearance", () => {
  test("updates Linux titlebar overlay colors", () => {
    const win = createWindowStub();
    syncWindowChromeAppearance(win as unknown as BrowserWindow, {
      platform: "linux",
      useDarkColors: true,
    });
    expect(win.setTitleBarOverlayCalls).toEqual([
      {
        color: "#00000000",
        symbolColor: "#f6ece0",
        height: 48,
      },
    ]);
  });

  test("updates Windows titlebar overlay colors", () => {
    const win = createWindowStub();
    syncWindowChromeAppearance(win as unknown as BrowserWindow, {
      platform: "win32",
      useDarkColors: true,
    });
    expect(win.setTitleBarOverlayCalls).toEqual([
      {
        color: "#00000000",
        symbolColor: "#f6ece0",
        height: 48,
      },
    ]);
  });

  test("updates macOS vibrancy without dynamic imports", () => {
    const win = createWindowStub();
    syncWindowChromeAppearance(win as unknown as BrowserWindow, {
      platform: "darwin",
      useMacosNativeGlass: true,
    });
    expect(win.setVibrancyCalls).toEqual(["sidebar"]);
  });

  test("clears macOS vibrancy when native glass is disabled", () => {
    const win = createWindowStub();
    syncWindowChromeAppearance(win as unknown as BrowserWindow, {
      platform: "darwin",
      useMacosNativeGlass: false,
    });
    expect(win.setVibrancyCalls).toEqual([null]);
  });

  test("applies post-create window tweaks per platform", () => {
    const macWindow = createWindowStub();
    applyPlatformWindowCreated(macWindow as unknown as BrowserWindow, "darwin");
    expect(macWindow.setWindowButtonVisibilityCalls).toEqual([true]);
    expect(macWindow.setMenuCalls).toEqual([]);

    const windowsWindow = createWindowStub();
    applyPlatformWindowCreated(windowsWindow as unknown as BrowserWindow, "win32");
    expect(windowsWindow.setWindowButtonVisibilityCalls).toEqual([]);
    expect(windowsWindow.setMenuCalls).toEqual([null]);

    const linuxWindow = createWindowStub();
    applyPlatformWindowCreated(linuxWindow as unknown as BrowserWindow, "linux");
    expect(linuxWindow.setWindowButtonVisibilityCalls).toEqual([]);
    expect(linuxWindow.setMenuCalls).toEqual([null]);
  });
});
