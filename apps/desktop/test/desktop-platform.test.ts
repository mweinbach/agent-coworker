import { describe, expect, test } from "bun:test";

import {
  getDesktopPlatformInfo,
  isLinux,
  isMacos,
  isWindows,
  normalizePlatform,
} from "../src/lib/desktopPlatform";
import { setupJsdom } from "./jsdomHarness";

describe("normalizePlatform", () => {
  test("maps darwin to macos", () => {
    expect(normalizePlatform("darwin")).toBe("macos");
  });

  test("maps win32 to windows", () => {
    expect(normalizePlatform("win32")).toBe("windows");
  });

  test("maps linux to linux", () => {
    expect(normalizePlatform("linux")).toBe("linux");
  });

  test("maps unknown to other", () => {
    expect(normalizePlatform("freebsd")).toBe("other");
    expect(normalizePlatform(undefined)).toBe("other");
  });
});

describe("platform booleans", () => {
  test("isMacos only returns true for macos", () => {
    expect(isMacos({ platform: "macos" } as never)).toBe(true);
    expect(isMacos({ platform: "windows" } as never)).toBe(false);
  });

  test("isWindows only returns true for windows", () => {
    expect(isWindows({ platform: "windows" } as never)).toBe(true);
    expect(isWindows({ platform: "macos" } as never)).toBe(false);
  });

  test("isLinux only returns true for linux", () => {
    expect(isLinux({ platform: "linux" } as never)).toBe(true);
    expect(isLinux({ platform: "other" } as never)).toBe(false);
  });
});

describe("getDesktopPlatformInfo", () => {
  test("uses platform-specific defaults before IPC chrome attributes are applied", () => {
    const harness = setupJsdom();
    try {
      const root = harness.dom.window.document.documentElement;

      root.dataset.platform = "darwin";
      expect(getDesktopPlatformInfo()).toEqual({
        platform: "macos",
        rawPlatform: "darwin",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "sidebar",
        usesNativeGlass: true,
        disableCssBlur: true,
      });

      root.dataset.platform = "win32";
      expect(getDesktopPlatformInfo()).toEqual({
        platform: "windows",
        rawPlatform: "win32",
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: false,
        disableCssBlur: false,
      });

      root.dataset.platform = "linux";
      expect(getDesktopPlatformInfo()).toEqual({
        platform: "linux",
        rawPlatform: "linux",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "inline",
        usesNativeGlass: false,
        disableCssBlur: false,
      });
    } finally {
      harness.restore();
    }
  });

  test("prefers IPC chrome attributes over platform defaults", () => {
    const harness = setupJsdom();
    try {
      const root = harness.dom.window.document.documentElement;
      root.dataset.platform = "win32";
      root.dataset.sidebarTitlebandMode = "topbar";
      root.dataset.topbarControlPlacement = "inline";
      root.dataset.usesNativeGlass = "true";
      root.dataset.disableCssBlur = "true";

      expect(getDesktopPlatformInfo()).toEqual({
        platform: "windows",
        rawPlatform: "win32",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "inline",
        usesNativeGlass: true,
        disableCssBlur: true,
      });
    } finally {
      harness.restore();
    }
  });
});
