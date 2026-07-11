import type { BrowserWindow } from "electron";
import { NATIVE_THEME_TOKENS } from "../../../src/styles/tokens/native";
import { getPlatformChrome, getTitlebarSymbolColor } from "./platformChrome";
import type { WindowChromeContext, WindowChromeModule } from "./types";

function windowsTitleBarOverlay(
  captionSymbolTone: WindowChromeContext["captionSymbolTone"],
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  const chrome = getPlatformChrome("win32");
  // Electron requires an integer; keep overlay height identical to the renderer
  // title band (--platform-titlebar-height) so native caption buttons stay
  // vertically centered and do not extend past the custom top bar.
  return {
    color: NATIVE_THEME_TOKENS.transparentSurface,
    symbolColor: getTitlebarSymbolColor(captionSymbolTone),
    height: Math.round(chrome.titlebarHeight),
  };
}

const windowsWindowChrome: WindowChromeModule = {
  getBrowserWindowOptions({ captionSymbolTone }) {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: windowsTitleBarOverlay(captionSymbolTone),
    };
  },

  applyWindowCreated(win) {
    win.setMenu(null);
  },

  syncAppearance(win, { captionSymbolTone }) {
    try {
      win.setTitleBarOverlay(windowsTitleBarOverlay(captionSymbolTone));
    } catch {
      // Ignore older Windows versions that do not support dynamic overlay updates.
    }
  },
};

export default windowsWindowChrome;
