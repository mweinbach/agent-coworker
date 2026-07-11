import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindow } from "electron";

import {
  CANVAS_DOCUMENT_COLORS,
  CANVAS_SPREADSHEET_COLORS,
  getCanvasCaptionSymbolTone,
  getCanvasNativeBackgroundColor,
} from "../src/lib/canvasAppearance";
import { getNativeCaptionSymbolColor, NATIVE_THEME_TOKENS } from "../src/styles/tokens/native";
import { createElectronMock } from "./helpers/mockElectron";

mock.module("electron", () => createElectronMock());

const { registerWindowAppearanceProfile, syncWindowAppearance } = await import(
  "../electron/services/appearance"
);

function createWindowStub() {
  return {
    backgroundColorCalls: [] as string[],
    backgroundMaterialCalls: [] as unknown[],
    titleBarOverlayCalls: [] as unknown[],
    vibrancyCalls: [] as unknown[],
    setBackgroundColor(color: string) {
      this.backgroundColorCalls.push(color);
    },
    setBackgroundMaterial(material: unknown) {
      this.backgroundMaterialCalls.push(material);
    },
    setTitleBarOverlay(overlay: unknown) {
      this.titleBarOverlayCalls.push(overlay);
    },
    setVibrancy(value: unknown) {
      this.vibrancyCalls.push(value);
    },
  };
}

describe("syncWindowAppearance", () => {
  test("applies the resolved solid shell background on Linux", () => {
    const win = createWindowStub();

    syncWindowAppearance(win as unknown as BrowserWindow, {
      platform: "linux",
      useDarkColors: false,
    });

    expect(win.backgroundColorCalls).toEqual([NATIVE_THEME_TOKENS.shellSurface.light]);
    expect(win.backgroundMaterialCalls).toEqual([]);
    expect(win.titleBarOverlayCalls).toEqual([
      {
        color: NATIVE_THEME_TOKENS.shellSurface.light,
        symbolColor: NATIVE_THEME_TOKENS.captionSymbol.dark,
        height: 48,
      },
    ]);
  });

  test("keeps a Canvas profile synchronized across live light and dark updates", () => {
    const win = createWindowStub();
    registerWindowAppearanceProfile(win as unknown as BrowserWindow, {
      backgroundColor: (useDarkColors) => getCanvasNativeBackgroundColor("notes.md", useDarkColors),
      captionSymbolTone: (useDarkColors) => getCanvasCaptionSymbolTone("notes.md", useDarkColors),
      useMacosNativeGlass: false,
    });

    syncWindowAppearance(win as unknown as BrowserWindow, {
      platform: "linux",
      useDarkColors: false,
    });
    syncWindowAppearance(win as unknown as BrowserWindow, {
      platform: "linux",
      useDarkColors: true,
    });

    expect(win.backgroundColorCalls).toEqual([
      CANVAS_DOCUMENT_COLORS.light.background,
      CANVAS_DOCUMENT_COLORS.dark.background,
    ]);
    expect(win.titleBarOverlayCalls).toEqual([
      {
        color: CANVAS_DOCUMENT_COLORS.light.background,
        symbolColor: NATIVE_THEME_TOKENS.captionSymbol.dark,
        height: 48,
      },
      {
        color: CANVAS_DOCUMENT_COLORS.dark.background,
        symbolColor: NATIVE_THEME_TOKENS.captionSymbol.light,
        height: 48,
      },
    ]);
  });

  test("keeps dark spreadsheet caption symbols on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const win = createWindowStub();
      registerWindowAppearanceProfile(win as unknown as BrowserWindow, {
        backgroundColor: (useDarkColors) =>
          getCanvasNativeBackgroundColor("report.xlsx", useDarkColors),
        captionSymbolTone: (useDarkColors) =>
          getCanvasCaptionSymbolTone("report.xlsx", useDarkColors),
        useMacosNativeGlass: false,
        ...(platform === "win32" ? { backgroundMaterial: "none" as const } : {}),
      });

      syncWindowAppearance(win as unknown as BrowserWindow, {
        platform,
        useDarkColors: true,
      });

      expect(win.backgroundColorCalls).toEqual([CANVAS_SPREADSHEET_COLORS.background]);
      expect(win.titleBarOverlayCalls).toEqual([
        {
          color:
            platform === "win32"
              ? NATIVE_THEME_TOKENS.transparentSurface
              : CANVAS_SPREADSHEET_COLORS.background,
          symbolColor: getNativeCaptionSymbolColor("dark"),
          height: 48,
        },
      ]);
    }
  });

  test("keeps macOS spreadsheet Canvas opaque and delegates controls to traffic lights", () => {
    const win = createWindowStub();
    registerWindowAppearanceProfile(win as unknown as BrowserWindow, {
      backgroundColor: (useDarkColors) =>
        getCanvasNativeBackgroundColor("report.xlsx", useDarkColors),
      captionSymbolTone: (useDarkColors) =>
        getCanvasCaptionSymbolTone("report.xlsx", useDarkColors),
      useMacosNativeGlass: false,
    });

    syncWindowAppearance(win as unknown as BrowserWindow, {
      platform: "darwin",
      useDarkColors: true,
    });

    expect(win.backgroundColorCalls).toEqual([CANVAS_SPREADSHEET_COLORS.background]);
    expect(win.titleBarOverlayCalls).toEqual([]);
    expect(win.vibrancyCalls).toEqual([null]);
  });
});
