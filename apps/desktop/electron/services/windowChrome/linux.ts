import type { BrowserWindow } from "electron";
import { desktopShellBackgroundColor } from "../windowAppearancePaint";
import { getPlatformChrome, getTitlebarSymbolColor } from "./platformChrome";
import type { WindowChromeModule } from "./types";

function linuxTitleBarOverlay(
  useDarkColors: boolean,
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  const chrome = getPlatformChrome("linux");
  return {
    color: desktopShellBackgroundColor(useDarkColors),
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
