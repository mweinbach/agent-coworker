import type { BrowserWindow } from "electron";

import type { WindowChromeModule } from "./types";

/** Match Windows overlay height so shared renderer topbar/drag CSS stays aligned. */
const LINUX_TITLE_BAR_HEIGHT = 48;
const LINUX_LIGHT_SYMBOL_COLOR = "#5a4736";
const LINUX_DARK_SYMBOL_COLOR = "#f6ece0";

function linuxTitleBarOverlay(
  useDarkColors: boolean,
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  return {
    color: "#00000000",
    symbolColor: useDarkColors ? LINUX_DARK_SYMBOL_COLOR : LINUX_LIGHT_SYMBOL_COLOR,
    height: LINUX_TITLE_BAR_HEIGHT,
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
