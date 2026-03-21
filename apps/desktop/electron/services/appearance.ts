import { BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme } from "electron";

import type {
  SetWindowAppearanceInput,
  SystemAppearance,
  WindowsBackgroundMaterial,
} from "../../src/lib/desktopApi";
import {
  shouldUseMacosNativeGlass,
  syncWindowChromeAppearance,
} from "./windowEnhancements";
import { resolveWindowChromePaint } from "./windowAppearancePaint";

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

type ResolvedWindowAppearance = {
  backgroundColor: string;
  backgroundMaterial?: WindowsBackgroundMaterial;
};

type SyncWindowAppearanceOptions = {
  platform?: NodeJS.Platform;
  useMacosNativeGlass?: boolean;
  useDarkColors?: boolean;
  backgroundMaterial?: WindowsBackgroundMaterial;
};

function resolveWindowAppearance(options: {
  platform?: NodeJS.Platform;
  useMacosNativeGlass?: boolean;
  useDarkColors?: boolean;
  backgroundMaterial?: WindowsBackgroundMaterial;
} = {}): ResolvedWindowAppearance {
  const platform = options.platform ?? process.platform;
  const useDarkColors = options.useDarkColors ?? nativeTheme.shouldUseDarkColors;
  const useMacosNativeGlass =
    options.useMacosNativeGlass
    ?? shouldUseMacosNativeGlass(platform, process.env, {
      prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    });

  return resolveWindowChromePaint({
    platform,
    useDarkColors,
    useMacosNativeGlass,
    backgroundMaterial: options.backgroundMaterial,
  });
}

export function getInitialWindowAppearanceOptions(options: {
  platform?: NodeJS.Platform;
  useMacosNativeGlass?: boolean;
  useDarkColors?: boolean;
} = {}): Pick<BrowserWindowConstructorOptions, "show" | "backgroundColor" | "backgroundMaterial"> {
  const { backgroundColor, backgroundMaterial } = resolveWindowAppearance(options);

  return {
    show: false,
    backgroundColor,
    ...(backgroundMaterial ? { backgroundMaterial } : {}),
  };
}

function setWindowBackgroundMaterial(
  win: BrowserWindow,
  material: WindowsBackgroundMaterial,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    return;
  }
  try {
    win.setBackgroundMaterial(material);
  } catch {
    // Older Windows versions and configurations may not support every material.
  }
}

export function syncWindowAppearance(
  win: BrowserWindow,
  options: SyncWindowAppearanceOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const { backgroundColor, backgroundMaterial } = resolveWindowAppearance({
    ...options,
    platform,
  });

  if (platform !== "linux") {
    win.setBackgroundColor(backgroundColor);
  }

  if (backgroundMaterial) {
    setWindowBackgroundMaterial(win, backgroundMaterial, platform);
  }

  syncWindowChromeAppearance(win, {
    platform,
    useDarkColors: options.useDarkColors,
    useMacosNativeGlass: options.useMacosNativeGlass,
  });
}

export function applySystemAppearanceToWindow(
  win: BrowserWindow,
  appearance: SystemAppearance,
): void {
  const platform = appearance.platform as NodeJS.Platform;
  syncWindowAppearance(win, {
    platform,
    useDarkColors: appearance.shouldUseDarkColors,
    useMacosNativeGlass: shouldUseMacosNativeGlass(platform, process.env, {
      prefersReducedTransparency: appearance.prefersReducedTransparency,
    }),
  });
}

export function applyWindowAppearance(win: BrowserWindow, opts: SetWindowAppearanceInput): SystemAppearance {
  if (opts.themeSource) {
    nativeTheme.themeSource = opts.themeSource;
  }
  syncWindowAppearance(win, {
    backgroundMaterial: opts.backgroundMaterial,
    useDarkColors: nativeTheme.shouldUseDarkColors,
    useMacosNativeGlass: shouldUseMacosNativeGlass(process.platform, process.env, {
      prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    }),
  });
  return getSystemAppearanceSnapshot();
}

export function registerSystemAppearanceListener(
  send: (appearance: SystemAppearance) => void,
): () => void {
  const handler = () => send(getSystemAppearanceSnapshot());
  nativeTheme.on("updated", handler);
  return () => nativeTheme.off("updated", handler);
}
