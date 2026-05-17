import { describe, expect, test } from "bun:test";

import {
  getDesktopPlatformInfo,
  isLinux,
  isMacos,
  isWindows,
  normalizePlatform,
} from "../src/lib/desktopPlatform";
import { setupJsdom } from "./jsdomHarness";

function withoutGlobalDocument(callback: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  delete (globalThis as Record<string, unknown>).document;
  try {
    callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "document", descriptor);
    }
  }
}

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
  test("returns safe defaults when no document is available", () => {
    withoutGlobalDocument(() => {
      expect(getDesktopPlatformInfo()).toEqual({
        platform: "other",
        rawPlatform: "other",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "inline",
        usesNativeGlass: false,
        disableCssBlur: false,
      });
    });
  });

  test("reads explicit Windows chrome attributes from the document root", () => {
    const harness = setupJsdom();
    try {
      const root = harness.dom.window.document.documentElement;
      root.dataset.platform = "win32";
      root.dataset.sidebarTitlebandMode = "native";
      root.dataset.topbarControlPlacement = "left-rail";
      root.dataset.usesNativeGlass = "false";
      root.dataset.disableCssBlur = "false";

      expect(getDesktopPlatformInfo()).toEqual({
        platform: "windows",
        rawPlatform: "win32",
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: false,
        disableCssBlur: false,
      });
    } finally {
      harness.restore();
    }
  });

  test("applies macOS chrome defaults when App has only set the platform", () => {
    const harness = setupJsdom();
    try {
      harness.dom.window.document.documentElement.dataset.platform = "darwin";

      expect(getDesktopPlatformInfo()).toEqual({
        platform: "macos",
        rawPlatform: "darwin",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "sidebar",
        usesNativeGlass: true,
        disableCssBlur: true,
      });
    } finally {
      harness.restore();
    }
  });

  test("prefers Linux chrome attributes over generic topbar defaults", () => {
    const harness = setupJsdom();
    try {
      const root = harness.dom.window.document.documentElement;
      root.dataset.platform = "linux";
      root.dataset.sidebarTitlebandMode = "native";
      root.dataset.topbarControlPlacement = "left-rail";
      root.dataset.usesNativeGlass = "true";
      root.dataset.disableCssBlur = "true";

      expect(getDesktopPlatformInfo()).toEqual({
        platform: "linux",
        rawPlatform: "linux",
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: true,
        disableCssBlur: true,
      });
    } finally {
      harness.restore();
    }
  });
});
