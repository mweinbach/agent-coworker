import type { BrowserWindow } from "electron";

import type { WindowChromeModule } from "./types";
import { getPlatformChrome, getTitlebarSymbolColor } from "./platformChrome";

function windowsTitleBarOverlay(
  useDarkColors: boolean,
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  const chrome = getPlatformChrome("win32");
  return {
    color: "#00000000",
    symbolColor: getTitlebarSymbolColor(useDarkColors),
    height: chrome.titlebarHeight,
  };
}

const windowsWindowChrome: WindowChromeModule = {
  getBrowserWindowOptions({ useDarkColors }) {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: windowsTitleBarOverlay(useDarkColors),
    };
  },

  applyWindowCreated(win) {
    win.setMenu(null);
  },

  syncAppearance(win, { useDarkColors }) {
    try {
      win.setTitleBarOverlay(windowsTitleBarOverlay(useDarkColors));
    } catch {
      // Ignore older Windows versions that do not support dynamic overlay updates.
    }
  },
};

export default windowsWindowChrome;
