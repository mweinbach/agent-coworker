import type { BrowserWindow } from "electron";
import { getPlatformChrome, getTitlebarSymbolColor } from "./platformChrome";
import type { WindowChromeModule } from "./types";

function windowsTitleBarOverlay(
  useDarkColors: boolean,
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  const chrome = getPlatformChrome("win32");
  // Electron requires an integer; keep overlay height identical to the renderer
  // title band (--platform-titlebar-height) so native caption buttons stay
  // vertically centered and do not extend past the custom top bar.
  return {
    color: "#00000000",
    symbolColor: getTitlebarSymbolColor(useDarkColors),
    height: Math.round(chrome.titlebarHeight),
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
