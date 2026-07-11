import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindow } from "electron";

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
    setBackgroundColor(color: string) {
      this.backgroundColorCalls.push(color);
    },
    setBackgroundMaterial(material: unknown) {
      this.backgroundMaterialCalls.push(material);
    },
    setTitleBarOverlay(overlay: unknown) {
      this.titleBarOverlayCalls.push(overlay);
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

    expect(win.backgroundColorCalls).toEqual(["#dfe2cc"]);
    expect(win.backgroundMaterialCalls).toEqual([]);
    expect(win.titleBarOverlayCalls).toEqual([
      {
        color: "#dfe2cc",
        symbolColor: "#556041",
        height: 48,
      },
    ]);
  });

  test("keeps a Canvas profile synchronized across live light and dark updates", () => {
    const win = createWindowStub();
    registerWindowAppearanceProfile(win as unknown as BrowserWindow, {
      backgroundColor: (useDarkColors) => (useDarkColors ? "#2a3120" : "#f8f9f2"),
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

    expect(win.backgroundColorCalls).toEqual(["#f8f9f2", "#2a3120"]);
    expect(win.titleBarOverlayCalls).toEqual([
      {
        color: "#f8f9f2",
        symbolColor: "#556041",
        height: 48,
      },
      {
        color: "#2a3120",
        symbolColor: "#eef0dc",
        height: 48,
      },
    ]);
  });
});
