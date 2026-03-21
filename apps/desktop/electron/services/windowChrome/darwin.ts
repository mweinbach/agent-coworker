import type { WindowChromeModule } from "./types";

const MACOS_TRAFFIC_LIGHT_POSITION = { x: 14, y: 14 } as const;

const darwinWindowChrome: WindowChromeModule = {
  getBrowserWindowOptions({ useMacosNativeGlass }) {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
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
