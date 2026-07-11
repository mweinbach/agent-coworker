import type { BrowserWindow } from "electron";
import { desktopShellBackgroundColor } from "../windowAppearancePaint";
import { getPlatformChrome, getTitlebarSymbolColor } from "./platformChrome";
import type { WindowChromeContext, WindowChromeModule } from "./types";

function linuxTitleBarOverlay(
  useDarkColors: boolean,
  captionSymbolTone: WindowChromeContext["captionSymbolTone"],
  backgroundColor?: string,
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  const chrome = getPlatformChrome("linux");
  return {
    color: backgroundColor ?? desktopShellBackgroundColor(useDarkColors),
    symbolColor: getTitlebarSymbolColor(captionSymbolTone),
    height: chrome.titlebarHeight,
  };
}

const linuxWindowChrome: WindowChromeModule = {
  getBrowserWindowOptions({ backgroundColor, captionSymbolTone, useDarkColors }) {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: linuxTitleBarOverlay(useDarkColors, captionSymbolTone, backgroundColor),
    };
  },

  applyWindowCreated(win) {
    win.setMenu(null);
  },

  syncAppearance(win, { backgroundColor, captionSymbolTone, useDarkColors }) {
    try {
      win.setTitleBarOverlay(
        linuxTitleBarOverlay(useDarkColors, captionSymbolTone, backgroundColor),
      );
    } catch {
      // Some Linux/Wayland/GTK combinations do not support dynamic overlay updates.
    }
  },
};

export default linuxWindowChrome;
