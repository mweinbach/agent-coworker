import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

import { hostPlatform } from "../../../../../src/platform/host";
import darwinWindowChrome from "./darwin";
import linuxWindowChrome from "./linux";
import { parseBooleanEnv } from "./shared";
import type { WindowChromeContext, WindowChromeModule, WindowChromeOptions } from "./types";
import windowsWindowChrome from "./win32";

const noopWindowChrome: WindowChromeModule = {
  getBrowserWindowOptions() {
    return {};
  },
};

function getWindowChromeModule(platform: NodeJS.Platform): WindowChromeModule {
  switch (platform) {
    case "darwin":
      return darwinWindowChrome;
    case "win32":
      return windowsWindowChrome;
    case "linux":
      return linuxWindowChrome;
    default:
      return noopWindowChrome;
  }
}

function resolveWindowChromeContext(
  platform: NodeJS.Platform,
  options: Omit<WindowChromeOptions, "platform"> = {},
): WindowChromeContext {
  const useDarkColors = options.useDarkColors ?? false;
  return {
    ...(options.backgroundColor ? { backgroundColor: options.backgroundColor } : {}),
    captionSymbolTone: options.captionSymbolTone ?? (useDarkColors ? "light" : "dark"),
    useDarkColors,
    useMacosNativeGlass: options.useMacosNativeGlass ?? shouldUseMacosNativeGlass(platform),
  };
}

export function shouldUseMacosNativeGlass(
  platform: NodeJS.Platform = hostPlatform(),
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

export function getPlatformBrowserWindowOptions(
  platform: NodeJS.Platform = hostPlatform(),
  options: Omit<WindowChromeOptions, "platform"> = {},
): Partial<BrowserWindowConstructorOptions> {
  return getWindowChromeModule(platform).getBrowserWindowOptions(
    resolveWindowChromeContext(platform, options),
  );
}

export function macosBrowserWindowOptions(
  platform: NodeJS.Platform = hostPlatform(),
  options: Omit<WindowChromeOptions, "platform"> = {},
): Partial<BrowserWindowConstructorOptions> {
  return getPlatformBrowserWindowOptions(platform, options);
}

export function applyPlatformWindowCreated(
  win: BrowserWindow,
  platform: NodeJS.Platform = hostPlatform(),
): void {
  getWindowChromeModule(platform).applyWindowCreated?.(win);
}

export function syncWindowChromeAppearance(
  win: BrowserWindow,
  options: WindowChromeOptions = {},
): void {
  const platform = options.platform ?? hostPlatform();
  getWindowChromeModule(platform).syncAppearance?.(
    win,
    resolveWindowChromeContext(platform, options),
  );
}
