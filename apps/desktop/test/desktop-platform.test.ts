import { describe, expect, test } from "bun:test";

import {
  getDesktopPlatformInfo,
  isLinux,
  isMacos,
  isWindows,
  normalizePlatform,
} from "../src/lib/desktopPlatform";
import { setupJsdom } from "./jsdomHarness";

type DesktopRootDataset = Partial<
  Record<
    | "platform"
    | "sidebarTitlebandMode"
    | "topbarControlPlacement"
    | "usesNativeGlass"
    | "disableCssBlur"
    | "captionButtonReserve"
    | "collapsedLeftRailWidth"
    | "topbarToolbarGap",
    string
  >
>;

function readPlatformInfoWithDataset(dataset: DesktopRootDataset) {
  const harness = setupJsdom();
  try {
    Object.assign(document.documentElement.dataset, dataset);
    return getDesktopPlatformInfo();
  } finally {
    harness.restore();
  }
}

function withoutDocument(run: () => void) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  delete (globalThis as Record<string, unknown>).document;
  try {
    run();
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, "document", documentDescriptor);
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
  test("returns a stable fallback when document is unavailable", () => {
    withoutDocument(() => {
      expect(getDesktopPlatformInfo()).toEqual({
        platform: "other",
        rawPlatform: "other",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "inline",
        usesNativeGlass: false,
        disableCssBlur: false,
        captionButtonReserve: 0,
        collapsedLeftRailWidth: 0,
        topbarToolbarGap: 0,
      });
    });
  });

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
        captionButtonReserve: 0,
        collapsedLeftRailWidth: 0,
        topbarToolbarGap: 0,
      });

      root.dataset.platform = "win32";
      expect(getDesktopPlatformInfo()).toEqual({
        platform: "windows",
        rawPlatform: "win32",
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: false,
        disableCssBlur: false,
        captionButtonReserve: 136,
        collapsedLeftRailWidth: 84,
        topbarToolbarGap: 6,
      });

      root.dataset.platform = "linux";
      expect(getDesktopPlatformInfo()).toEqual({
        platform: "linux",
        rawPlatform: "linux",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "inline",
        usesNativeGlass: false,
        disableCssBlur: false,
        captionButtonReserve: 0,
        collapsedLeftRailWidth: 0,
        topbarToolbarGap: 6,
      });
    } finally {
      harness.restore();
    }
  });

  test("prefers IPC chrome attributes over platform defaults", () => {
    expect(
      readPlatformInfoWithDataset({
        platform: "win32",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "inline",
        usesNativeGlass: "true",
        disableCssBlur: "true",
      }),
    ).toEqual({
      platform: "windows",
      rawPlatform: "win32",
      sidebarTitlebandMode: "topbar",
      topbarControlPlacement: "inline",
      usesNativeGlass: true,
      disableCssBlur: true,
      captionButtonReserve: 136,
      collapsedLeftRailWidth: 84,
      topbarToolbarGap: 6,
    });
  });

  test("reads chrome metrics from IPC dataset attributes", () => {
    expect(
      readPlatformInfoWithDataset({
        platform: "win32",
        captionButtonReserve: "120",
        collapsedLeftRailWidth: "72",
        topbarToolbarGap: "8",
      }),
    ).toEqual({
      platform: "windows",
      rawPlatform: "win32",
      sidebarTitlebandMode: "native",
      topbarControlPlacement: "left-rail",
      usesNativeGlass: false,
      disableCssBlur: false,
      captionButtonReserve: 120,
      collapsedLeftRailWidth: 72,
      topbarToolbarGap: 8,
    });
  });

  test("reads renderer chrome attrs from the document root dataset", () => {
    expect(
      readPlatformInfoWithDataset({
        platform: "linux",
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: "true",
        disableCssBlur: "true",
      }),
    ).toEqual({
      platform: "linux",
      rawPlatform: "linux",
      sidebarTitlebandMode: "native",
      topbarControlPlacement: "left-rail",
      usesNativeGlass: true,
      disableCssBlur: true,
      captionButtonReserve: 0,
      collapsedLeftRailWidth: 0,
      topbarToolbarGap: 6,
    });
  });

  test("keeps web chrome attrs as non-native inline controls", () => {
    expect(
      readPlatformInfoWithDataset({
        platform: "web",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "inline",
        usesNativeGlass: "false",
        disableCssBlur: "false",
      }),
    ).toEqual({
      platform: "other",
      rawPlatform: "web",
      sidebarTitlebandMode: "topbar",
      topbarControlPlacement: "inline",
      usesNativeGlass: false,
      disableCssBlur: false,
      captionButtonReserve: 0,
      collapsedLeftRailWidth: 0,
      topbarToolbarGap: 0,
    });
  });
});
