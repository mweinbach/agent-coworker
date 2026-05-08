import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import {
  type DesktopPlatformInfo,
  getDesktopPlatformInfo,
  isLinux,
  isMacos,
  isWindows,
  normalizePlatform,
} from "../src/lib/desktopPlatform";
import { useDesktopPlatform } from "../src/lib/useDesktopPlatform";
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
  test("reads Windows chrome attributes from the document root", () => {
    const harness = setupJsdom();
    try {
      const root = harness.dom.window.document.documentElement;
      root.dataset.platform = "win32";
      root.dataset.sidebarTitlebandMode = "native";
      root.dataset.topbarControlPlacement = "left-rail";
      root.dataset.usesNativeGlass = "true";
      root.dataset.disableCssBlur = "true";

      expect(getDesktopPlatformInfo()).toEqual({
        platform: "windows",
        rawPlatform: "win32",
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: true,
        disableCssBlur: true,
      });
    } finally {
      harness.restore();
    }
  });

  test("applies platform defaults when chrome attributes are absent", () => {
    const harness = setupJsdom();
    try {
      const root = harness.dom.window.document.documentElement;

      root.dataset.platform = "darwin";
      expect(getDesktopPlatformInfo()).toMatchObject({
        platform: "macos",
        rawPlatform: "darwin",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "sidebar",
        usesNativeGlass: true,
        disableCssBlur: true,
      });

      root.dataset.platform = "win32";
      expect(getDesktopPlatformInfo()).toMatchObject({
        platform: "windows",
        rawPlatform: "win32",
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: false,
        disableCssBlur: false,
      });

      root.dataset.platform = "linux";
      expect(getDesktopPlatformInfo()).toMatchObject({
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
});

describe("useDesktopPlatform", () => {
  test("updates when observed platform attributes change", async () => {
    const harness = setupJsdom();
    const seen: DesktopPlatformInfo[] = [];

    function Probe() {
      seen.push(useDesktopPlatform());
      return null;
    }

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const rootElement = harness.dom.window.document.documentElement;
      rootElement.dataset.platform = "linux";

      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(Probe));
      });

      await act(async () => {
        rootElement.dataset.platform = "win32";
        rootElement.dataset.sidebarTitlebandMode = "native";
        rootElement.dataset.topbarControlPlacement = "left-rail";
        rootElement.dataset.disableCssBlur = "true";
        await Promise.resolve();
      });

      expect(seen.at(-1)).toEqual({
        platform: "windows",
        rawPlatform: "win32",
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: false,
        disableCssBlur: true,
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
