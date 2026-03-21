import type { WindowsBackgroundMaterial } from "../../src/lib/desktopApi";

export const LIGHT_SHELL_BACKGROUND = "#e7dfd4";
export const DARK_SHELL_BACKGROUND = "#1f1913";

/** Solid shell tint behind web content (no Electron imports — safe for unit tests). */
export function desktopShellBackgroundColor(useDarkColors: boolean): string {
  return useDarkColors ? DARK_SHELL_BACKGROUND : LIGHT_SHELL_BACKGROUND;
}

export function windowsBackgroundMaterialForPlatform(
  platform: NodeJS.Platform,
): WindowsBackgroundMaterial | undefined {
  if (platform !== "win32") {
    return undefined;
  }
  return "mica";
}

export type WindowChromePaintInput = {
  platform: NodeJS.Platform;
  useDarkColors: boolean;
  useMacosNativeGlass: boolean;
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
    platform === "darwin" && useMacosNativeGlass
      ? "#00000000"
      : desktopShellBackgroundColor(useDarkColors);

  return {
    backgroundColor,
    ...(backgroundMaterial ? { backgroundMaterial } : {}),
  };
}
