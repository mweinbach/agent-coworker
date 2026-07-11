import type { WindowsBackgroundMaterial } from "../../src/lib/desktopApi";
import { getPlatformChrome } from "./windowChrome/platformChrome";

const LIGHT_SHELL_BACKGROUND = "#dfe2cc";
const DARK_SHELL_BACKGROUND = "#171d13";

/** Solid shell tint behind web content (no Electron imports — safe for unit tests). */
export function desktopShellBackgroundColor(useDarkColors: boolean): string {
  return useDarkColors ? DARK_SHELL_BACKGROUND : LIGHT_SHELL_BACKGROUND;
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
      ? "#00000000"
      : desktopShellBackgroundColor(useDarkColors));

  return {
    backgroundColor,
    ...(backgroundMaterial ? { backgroundMaterial } : {}),
  };
}
