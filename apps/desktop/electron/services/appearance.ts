import { BrowserWindow, nativeTheme } from "electron";

import type {
  SetWindowAppearanceInput,
  SystemAppearance,
  WindowsBackgroundMaterial,
} from "../../src/lib/desktopApi";

export function getSystemAppearanceSnapshot(): SystemAppearance {
  return {
    platform: process.platform,
    themeSource: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
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
