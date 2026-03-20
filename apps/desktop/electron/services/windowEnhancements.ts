import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

const MACOS_TRAFFIC_LIGHT_POSITION = { x: 14, y: 14 } as const;
const WINDOWS_TITLE_BAR_HEIGHT = 48;
const WINDOWS_LIGHT_SYMBOL_COLOR = "#5a4736";
const WINDOWS_DARK_SYMBOL_COLOR = "#f6ece0";

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function windowsTitleBarOverlay(
  useDarkColors: boolean,
): Parameters<BrowserWindow["setTitleBarOverlay"]>[0] {
  return {
    color: "#00000000",
    symbolColor: useDarkColors ? WINDOWS_DARK_SYMBOL_COLOR : WINDOWS_LIGHT_SYMBOL_COLOR,
    height: WINDOWS_TITLE_BAR_HEIGHT,
  };
}

export function shouldUseMacosNativeGlass(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  options: { prefersReducedTransparency?: boolean } = {},
): boolean {
  if (platform !== "darwin") {
    return false;
  }
  if (options.prefersReducedTransparency) {
    return false;
  }
  return parseBooleanEnv(env.COWORK_MACOS_NATIVE_GLASS, true);
}

export function macosBrowserWindowOptions(
  platform: NodeJS.Platform = process.platform,
  options: {
    useDarkColors?: boolean;
    useMacosNativeGlass?: boolean;
  } = {},
): Partial<BrowserWindowConstructorOptions> {
  const useDarkColors = options.useDarkColors ?? false;
  const useMacosNativeGlass =
    options.useMacosNativeGlass ?? shouldUseMacosNativeGlass(platform);

  if (platform === "darwin") {
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
  }

  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: windowsTitleBarOverlay(useDarkColors),
    };
  }

  return {};
}

export function syncWindowChromeAppearance(
  win: BrowserWindow,
  options: {
    platform?: NodeJS.Platform;
    useDarkColors?: boolean;
    useMacosNativeGlass?: boolean;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const useDarkColors = options.useDarkColors ?? false;
  const useMacosNativeGlass =
    options.useMacosNativeGlass ?? shouldUseMacosNativeGlass(platform);

  if (platform === "win32") {
    try {
      win.setTitleBarOverlay(windowsTitleBarOverlay(useDarkColors));
    } catch {
      // Ignore older Windows versions that do not support dynamic overlay updates.
    }
    return;
  }

  if (platform === "darwin") {
    try {
      win.setVibrancy(useMacosNativeGlass ? "sidebar" : null);
    } catch {
      // Ignore environments where vibrancy cannot be changed at runtime.
    }
  }
}
