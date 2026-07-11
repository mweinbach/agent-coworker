import type { BrowserWindow } from "electron";
import { desktopShellBackgroundColor } from "../windowAppearancePaint";
import { getPlatformChrome, getTitlebarSymbolColor } from "./platformChrome";
import type { WindowChromeModule } from "./types";

function linuxTitleBarOverlay(
  useDarkColors: boolean,
  backgroundColor?: string,
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  const chrome = getPlatformChrome("linux");
  return {
    color: backgroundColor ?? desktopShellBackgroundColor(useDarkColors),
    symbolColor: getTitlebarSymbolColor(useDarkColors),
    height: chrome.titlebarHeight,
  };
}

const linuxWindowChrome: WindowChromeModule = {
  getBrowserWindowOptions({ backgroundColor, useDarkColors }) {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: linuxTitleBarOverlay(useDarkColors, backgroundColor),
    };
  },

  applyWindowCreated(win) {
    win.setMenu(null);
  },

  syncAppearance(win, { backgroundColor, useDarkColors }) {
    try {
      win.setTitleBarOverlay(linuxTitleBarOverlay(useDarkColors, backgroundColor));
    } catch {
      // Some Linux/Wayland/GTK combinations do not support dynamic overlay updates.
    }
  },
};

export default linuxWindowChrome;
