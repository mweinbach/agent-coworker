import { describe, expect, test } from "bun:test";

import {
  getCurrentPlatformChrome,
  getPlatformChrome,
  getTitlebarSymbolColor,
} from "../electron/services/windowChrome/platformChrome";

describe("getPlatformChrome", () => {
  test("returns macOS chrome contract", () => {
    const chrome = getPlatformChrome("darwin");
    expect(chrome.platform).toBe("macos");
    expect(chrome.titlebarHeight).toBe(38);
    expect(chrome.dragStripHeight).toBe(10);
    expect(chrome.leftNativeReserve).toBe(86);
    expect(chrome.rightNativeReserve).toBe(0);
    expect(chrome.captionButtonReserve).toBe(0);
    expect(chrome.trafficLightPosition).toEqual({ x: 14, y: 14 });
    expect(chrome.windowMaterial).toBeUndefined();
    expect(chrome.sidebarTitlebandMode).toBe("topbar");
    expect(chrome.topbarControlPlacement).toBe("sidebar");
    expect(chrome.usesNativeGlass).toBe(true);
    expect(chrome.disableCssBlur).toBe(true);
  });

  test("returns Windows chrome contract", () => {
    const chrome = getPlatformChrome("win32");
    expect(chrome.platform).toBe("windows");
    expect(chrome.titlebarHeight).toBe(48);
    expect(chrome.dragStripHeight).toBe(10);
    expect(chrome.leftNativeReserve).toBe(0);
    expect(chrome.rightNativeReserve).toBe(136);
    expect(chrome.captionButtonReserve).toBe(136);
    expect(chrome.trafficLightPosition).toBeUndefined();
    expect(chrome.windowMaterial).toBe("mica");
    expect(chrome.sidebarTitlebandMode).toBe("native");
    expect(chrome.topbarControlPlacement).toBe("left-rail");
    expect(chrome.usesNativeGlass).toBe(false);
    expect(chrome.disableCssBlur).toBe(false);
  });

  test("returns Linux chrome contract", () => {
    const chrome = getPlatformChrome("linux");
    expect(chrome.platform).toBe("linux");
    expect(chrome.titlebarHeight).toBe(48);
    expect(chrome.dragStripHeight).toBe(10);
    expect(chrome.leftNativeReserve).toBe(0);
    expect(chrome.rightNativeReserve).toBe(192);
    expect(chrome.captionButtonReserve).toBe(0);
    expect(chrome.trafficLightPosition).toBeUndefined();
    expect(chrome.windowMaterial).toBeUndefined();
    expect(chrome.sidebarTitlebandMode).toBe("topbar");
    expect(chrome.topbarControlPlacement).toBe("inline");
    expect(chrome.usesNativeGlass).toBe(false);
    expect(chrome.disableCssBlur).toBe(false);
  });

  test("returns fallback chrome for unknown platforms", () => {
    const chrome = getPlatformChrome("freebsd");
    expect(chrome.platform).toBe("other");
    expect(chrome.titlebarHeight).toBe(48);
    expect(chrome.leftNativeReserve).toBe(0);
    expect(chrome.rightNativeReserve).toBe(0);
    expect(chrome.captionButtonReserve).toBe(0);
    expect(chrome.usesNativeGlass).toBe(false);
  });
});

describe("getCurrentPlatformChrome", () => {
  test("returns a contract for the current platform", () => {
    const chrome = getCurrentPlatformChrome();
    expect(["macos", "windows", "linux", "other"]).toContain(chrome.platform);
    expect(chrome.titlebarHeight).toBeGreaterThan(0);
  });
});

describe("getTitlebarSymbolColor", () => {
  test("returns light symbol color for light themes", () => {
    expect(getTitlebarSymbolColor(false)).toBe("#556041");
  });

  test("returns dark symbol color for dark themes", () => {
    expect(getTitlebarSymbolColor(true)).toBe("#eef0dc");
  });
});
