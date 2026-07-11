import type { WindowsBackgroundMaterial } from "../../src/lib/desktopApi";
import { NATIVE_THEME_TOKENS } from "../../src/styles/tokens/native";
import { getPlatformChrome } from "./windowChrome/platformChrome";

/** Solid shell tint behind web content (no Electron imports — safe for unit tests). */
export function desktopShellBackgroundColor(useDarkColors: boolean): string {
  return useDarkColors
    ? NATIVE_THEME_TOKENS.shellSurface.dark
    : NATIVE_THEME_TOKENS.shellSurface.light;
}

export function windowsBackgroundMaterialForPlatform(
  platform: NodeJS.Platform,
): WindowsBackgroundMaterial | undefined {
  const chrome = getPlatformChrome(platform);
  return chrome.windowMaterial;
}

export type WindowChromePaintInput = {
  platform: NodeJS.Platform;
  useDarkColors: boolean;
  useMacosNativeGlass: boolean;
  backgroundColor?: string;
  backgroundMaterial?: WindowsBackgroundMaterial;
};

export type WindowChromePaint = {
  backgroundColor: string;
  backgroundMaterial?: WindowsBackgroundMaterial;
};

/**
 * Pure window background + Windows material selection. Main process resolves nativeTheme
 * and glass flags, then calls this.
 */
export function resolveWindowChromePaint(input: WindowChromePaintInput): WindowChromePaint {
  const { platform, useDarkColors, useMacosNativeGlass } = input;
  const backgroundMaterial =
    input.backgroundMaterial ?? windowsBackgroundMaterialForPlatform(platform);
  const backgroundColor =
    input.backgroundColor ??
    (platform === "darwin" && useMacosNativeGlass
      ? NATIVE_THEME_TOKENS.transparentSurface
      : desktopShellBackgroundColor(useDarkColors));

  return {
    backgroundColor,
    ...(backgroundMaterial ? { backgroundMaterial } : {}),
  };
}
