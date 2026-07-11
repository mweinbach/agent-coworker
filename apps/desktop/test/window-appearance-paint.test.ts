import { describe, expect, test } from "bun:test";
import {
  desktopShellBackgroundColor,
  resolveWindowChromePaint,
  windowsBackgroundMaterialForPlatform,
} from "../electron/services/windowAppearancePaint";
import { CANVAS_DOCUMENT_COLORS, CANVAS_SPREADSHEET_COLORS } from "../src/lib/canvasAppearance";
import { NATIVE_THEME_TOKENS } from "../src/styles/tokens/native";

describe("windowsBackgroundMaterialForPlatform", () => {
  test("is only defined on Windows", () => {
    expect(windowsBackgroundMaterialForPlatform("win32")).toBe("tabbed");
    expect(windowsBackgroundMaterialForPlatform("darwin")).toBeUndefined();
    expect(windowsBackgroundMaterialForPlatform("linux")).toBeUndefined();
  });
});

describe("desktopShellBackgroundColor", () => {
  test("tracks light vs dark shell presets", () => {
    expect(desktopShellBackgroundColor(false)).toBe(NATIVE_THEME_TOKENS.shellSurface.light);
    expect(desktopShellBackgroundColor(true)).toBe(NATIVE_THEME_TOKENS.shellSurface.dark);
  });
});

describe("resolveWindowChromePaint", () => {
  test("keeps Linux appearance isolated from macOS glass and Windows tabbed material", () => {
    expect(
      resolveWindowChromePaint({
        platform: "linux",
        useDarkColors: false,
        useMacosNativeGlass: true,
      }),
    ).toEqual({
      backgroundColor: NATIVE_THEME_TOKENS.shellSurface.light,
    });

    expect(
      resolveWindowChromePaint({
        platform: "linux",
        useDarkColors: true,
        useMacosNativeGlass: true,
      }),
    ).toEqual({
      backgroundColor: NATIVE_THEME_TOKENS.shellSurface.dark,
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
      backgroundColor: NATIVE_THEME_TOKENS.transparentSurface,
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
      backgroundColor: NATIVE_THEME_TOKENS.shellSurface.dark,
    });
  });

  test("applies Windows tabbed material without forcing macOS-style transparency", () => {
    expect(
      resolveWindowChromePaint({
        platform: "win32",
        useDarkColors: false,
        useMacosNativeGlass: true,
      }),
    ).toEqual({
      backgroundColor: NATIVE_THEME_TOKENS.shellSurface.light,
      backgroundMaterial: "tabbed",
    });
  });

  test("honors an explicit opaque Canvas background over native glass defaults", () => {
    expect(
      resolveWindowChromePaint({
        platform: "darwin",
        useDarkColors: true,
        useMacosNativeGlass: true,
        backgroundColor: CANVAS_DOCUMENT_COLORS.dark.background,
      }),
    ).toEqual({
      backgroundColor: CANVAS_DOCUMENT_COLORS.dark.background,
    });

    expect(
      resolveWindowChromePaint({
        platform: "win32",
        useDarkColors: false,
        useMacosNativeGlass: false,
        backgroundColor: CANVAS_SPREADSHEET_COLORS.background,
        backgroundMaterial: "none",
      }),
    ).toEqual({
      backgroundColor: CANVAS_SPREADSHEET_COLORS.background,
      backgroundMaterial: "none",
    });
  });
});
