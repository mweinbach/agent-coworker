import { getPlatformChrome } from "./platformChrome";
import type { WindowChromeModule } from "./types";

const darwinWindowChrome: WindowChromeModule = {
  getBrowserWindowOptions({ useMacosNativeGlass }) {
    const chrome = getPlatformChrome("darwin");
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: chrome.trafficLightPosition,
      transparent: useMacosNativeGlass,
      ...(useMacosNativeGlass
        ? {
            vibrancy: "sidebar" as const,
            visualEffectState: "active" as const,
          }
        : {}),
    };
  },

  applyWindowCreated(win) {
    win.setWindowButtonVisibility(true);
  },

  syncAppearance(win, { useMacosNativeGlass }) {
    try {
      win.setVibrancy(useMacosNativeGlass ? "sidebar" : null);
    } catch {
      // Ignore environments where vibrancy cannot be changed at runtime.
    }
  },
};

export default darwinWindowChrome;
