import type { BrowserWindow } from "electron";

import type { WindowChromeModule } from "./types";

/** Keep in sync with renderer: apps/desktop/src/styles/platform/win32.css (drag zone + .app-topbar--frame). */
const WINDOWS_TITLE_BAR_HEIGHT = 48;
const WINDOWS_LIGHT_SYMBOL_COLOR = "#5a4736";
const WINDOWS_DARK_SYMBOL_COLOR = "#f6ece0";

function windowsTitleBarOverlay(
  useDarkColors: boolean,
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  return {
    color: "#00000000",
    symbolColor: useDarkColors ? WINDOWS_DARK_SYMBOL_COLOR : WINDOWS_LIGHT_SYMBOL_COLOR,
    height: WINDOWS_TITLE_BAR_HEIGHT,
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
