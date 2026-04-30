import type { BrowserWindow } from "electron";

import type { WindowChromeModule } from "./types";
import { getPlatformChrome, getTitlebarSymbolColor } from "./platformChrome";

function linuxTitleBarOverlay(
  useDarkColors: boolean,
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  const chrome = getPlatformChrome("linux");
  return {
    color: "#00000000",
    symbolColor: getTitlebarSymbolColor(useDarkColors),
    height: chrome.titlebarHeight,
  };
}

const linuxWindowChrome: WindowChromeModule = {
  getBrowserWindowOptions({ useDarkColors }) {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: linuxTitleBarOverlay(useDarkColors),
    };
  },

  applyWindowCreated(win) {
    win.setMenu(null);
  },

  syncAppearance(win, { useDarkColors }) {
    try {
      win.setTitleBarOverlay(linuxTitleBarOverlay(useDarkColors));
    } catch {
      // Some Linux/Wayland/GTK combinations do not support dynamic overlay updates.
    }
  },
};

export default linuxWindowChrome;
