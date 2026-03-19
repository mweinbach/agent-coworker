import { BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme } from "electron";

import type {
  SetWindowAppearanceInput,
  SystemAppearance,
  WindowsBackgroundMaterial,
} from "../../src/lib/desktopApi";
import { shouldUseMacosLiquidGlass } from "./windowEnhancements";

const LIGHT_SHELL_BACKGROUND = "#e7dfd4";
const DARK_SHELL_BACKGROUND = "#1f1913";

export function defaultDesktopShellBackgroundColor(
  useDarkColors: boolean = nativeTheme.shouldUseDarkColors,
): string {
  return useDarkColors ? DARK_SHELL_BACKGROUND : LIGHT_SHELL_BACKGROUND;
}

export function getSystemAppearanceSnapshot(): SystemAppearance {
  return {
    platform: process.platform,
    themeSource: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    shouldUseDarkColorsForSystemIntegratedUI: nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
    shouldUseHighContrastColors: nativeTheme.shouldUseHighContrastColors,
    shouldUseInvertedColorScheme: nativeTheme.shouldUseInvertedColorScheme,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    inForcedColorsMode: nativeTheme.inForcedColorsMode,
  };
}

export function defaultWindowsBackgroundMaterial(
  platform: NodeJS.Platform = process.platform,
): WindowsBackgroundMaterial | undefined {
  if (platform !== "win32") {
    return undefined;
  }
  return "mica";
}

export function getInitialWindowAppearanceOptions(options: {
  platform?: NodeJS.Platform;
  useMacosLiquidGlass?: boolean;
  useDarkColors?: boolean;
} = {}): Pick<BrowserWindowConstructorOptions, "show" | "backgroundColor" | "backgroundMaterial"> {
  const platform = options.platform ?? process.platform;
  const useDarkColors = options.useDarkColors ?? nativeTheme.shouldUseDarkColors;
  const useMacosLiquidGlass = options.useMacosLiquidGlass ?? shouldUseMacosLiquidGlass(platform);

  const backgroundColor =
    platform === "darwin" && useMacosLiquidGlass
      ? "#00000000"
      : defaultDesktopShellBackgroundColor(useDarkColors);

  const backgroundMaterial = defaultWindowsBackgroundMaterial(platform);

  return {
    show: false,
    backgroundColor,
    ...(backgroundMaterial ? { backgroundMaterial } : {}),
  };
}

function setWindowBackgroundMaterial(win: BrowserWindow, material: WindowsBackgroundMaterial): void {
  if (process.platform !== "win32") {
    return;
  }
  try {
    win.setBackgroundMaterial(material);
  } catch {
    // Older Windows versions and configurations may not support every material.
  }
}

export function applyInitialWindowAppearance(win: BrowserWindow): void {
  const material = defaultWindowsBackgroundMaterial();
  if (!material) {
    return;
  }
  setWindowBackgroundMaterial(win, material);
}

export function applyWindowAppearance(win: BrowserWindow, opts: SetWindowAppearanceInput): SystemAppearance {
  if (opts.themeSource) {
    nativeTheme.themeSource = opts.themeSource;
  }
  if (opts.backgroundMaterial) {
    setWindowBackgroundMaterial(win, opts.backgroundMaterial);
  }
  return getSystemAppearanceSnapshot();
}

export function registerSystemAppearanceListener(
  send: (appearance: SystemAppearance) => void,
): () => void {
  const handler = () => send(getSystemAppearanceSnapshot());
  nativeTheme.on("updated", handler);
  return () => nativeTheme.off("updated", handler);
}
