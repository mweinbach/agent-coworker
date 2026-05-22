import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindow } from "electron";

import { createElectronMock } from "./helpers/mockElectron";

mock.module("electron", () => createElectronMock());

const { syncWindowAppearance } = await import("../electron/services/appearance");

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
        color: "#00000000",
        symbolColor: "#556041",
        height: 48,
      },
    ]);
  });
});
