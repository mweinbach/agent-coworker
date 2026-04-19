import { describe, expect, test } from "bun:test";

import {
  desktopShellBackgroundColor,
  resolveWindowChromePaint,
  windowsBackgroundMaterialForPlatform,
} from "../electron/services/windowAppearancePaint";

describe("windowsBackgroundMaterialForPlatform", () => {
  test("is only defined on Windows", () => {
    expect(windowsBackgroundMaterialForPlatform("win32")).toBe("mica");
    expect(windowsBackgroundMaterialForPlatform("darwin")).toBeUndefined();
    expect(windowsBackgroundMaterialForPlatform("linux")).toBeUndefined();
  });
});

describe("desktopShellBackgroundColor", () => {
  test("tracks light vs dark shell presets", () => {
    expect(desktopShellBackgroundColor(false)).toBe("#dfe2cc");
    expect(desktopShellBackgroundColor(true)).toBe("#171d13");
  });
});

describe("resolveWindowChromePaint", () => {
  test("keeps Linux appearance isolated from macOS glass and Windows mica", () => {
    expect(
      resolveWindowChromePaint({
        platform: "linux",
        useDarkColors: false,
        useMacosNativeGlass: true,
      }),
    ).toEqual({
      backgroundColor: "#dfe2cc",
    });

    expect(
      resolveWindowChromePaint({
        platform: "linux",
        useDarkColors: true,
        useMacosNativeGlass: true,
      }),
    ).toEqual({
      backgroundColor: "#171d13",
    });
  });

  test("uses transparent background on macOS when native glass is enabled", () => {
    expect(
      resolveWindowChromePaint({
        platform: "darwin",
        useDarkColors: false,
        useMacosNativeGlass: true,
      }),
    ).toEqual({
      backgroundColor: "#00000000",
    });
  });

  test("uses opaque shell background on macOS when native glass is disabled", () => {
    expect(
      resolveWindowChromePaint({
        platform: "darwin",
        useDarkColors: true,
        useMacosNativeGlass: false,
      }),
    ).toEqual({
      backgroundColor: "#171d13",
    });
  });

  test("applies Windows mica without forcing macOS-style transparency", () => {
    expect(
      resolveWindowChromePaint({
        platform: "win32",
        useDarkColors: false,
        useMacosNativeGlass: true,
      }),
    ).toEqual({
      backgroundColor: "#dfe2cc",
      backgroundMaterial: "mica",
    });
  });
});
