import { type BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme } from "electron";

import { hostPlatform } from "../../../../src/platform/host";
import type {
  SetWindowAppearanceInput,
  SystemAppearance,
  WindowsBackgroundMaterial,
} from "../../src/lib/desktopApi";
import type { CaptionSymbolTone } from "../../src/styles/tokens/native";
import { resolveWindowChromePaint } from "./windowAppearancePaint";
import { shouldUseMacosNativeGlass, syncWindowChromeAppearance } from "./windowEnhancements";

export function getSystemAppearanceSnapshot(): SystemAppearance {
  return {
    platform: hostPlatform(),
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
  backgroundColor?: string;
  backgroundMaterial?: WindowsBackgroundMaterial;
  captionSymbolTone?: CaptionSymbolTone;
};

export type WindowAppearanceProfile = {
  backgroundColor?: (useDarkColors: boolean) => string;
  backgroundMaterial?: WindowsBackgroundMaterial;
  captionSymbolTone?: (useDarkColors: boolean) => CaptionSymbolTone;
  useMacosNativeGlass?: boolean;
};

const windowAppearanceProfiles = new WeakMap<BrowserWindow, WindowAppearanceProfile>();

function resolveWindowAppearance(
  options: {
    platform?: NodeJS.Platform;
    useMacosNativeGlass?: boolean;
    useDarkColors?: boolean;
    backgroundColor?: string;
    backgroundMaterial?: WindowsBackgroundMaterial;
  } = {},
): ResolvedWindowAppearance {
  const platform = options.platform ?? hostPlatform();
  const useDarkColors = options.useDarkColors ?? nativeTheme.shouldUseDarkColors;
  const useMacosNativeGlass =
    options.useMacosNativeGlass ??
    shouldUseMacosNativeGlass(platform, process.env, {
      prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    });

  return resolveWindowChromePaint({
    platform,
    useDarkColors,
    useMacosNativeGlass,
    backgroundColor: options.backgroundColor,
    backgroundMaterial: options.backgroundMaterial,
  });
}

export function registerWindowAppearanceProfile(
  win: BrowserWindow,
  profile: WindowAppearanceProfile,
): void {
  windowAppearanceProfiles.set(win, profile);
}

export function getInitialWindowAppearanceOptions(
  options: {
    platform?: NodeJS.Platform;
    useMacosNativeGlass?: boolean;
    useDarkColors?: boolean;
    backgroundColor?: string;
    backgroundMaterial?: WindowsBackgroundMaterial;
  } = {},
): Pick<BrowserWindowConstructorOptions, "show" | "backgroundColor" | "backgroundMaterial"> {
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
  platform: NodeJS.Platform = hostPlatform(),
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
  const platform = options.platform ?? hostPlatform();
  const useDarkColors = options.useDarkColors ?? nativeTheme.shouldUseDarkColors;
  const profile = windowAppearanceProfiles.get(win);
  const useMacosNativeGlass = profile?.useMacosNativeGlass ?? options.useMacosNativeGlass;
  const { backgroundColor, backgroundMaterial } = resolveWindowAppearance({
    ...options,
    platform,
    useDarkColors,
    useMacosNativeGlass,
    backgroundColor: profile?.backgroundColor?.(useDarkColors) ?? options.backgroundColor,
    backgroundMaterial: profile?.backgroundMaterial ?? options.backgroundMaterial,
  });

  win.setBackgroundColor(backgroundColor);

  if (backgroundMaterial) {
    setWindowBackgroundMaterial(win, backgroundMaterial, platform);
  }

  syncWindowChromeAppearance(win, {
    platform,
    useDarkColors,
    useMacosNativeGlass,
    backgroundColor,
    captionSymbolTone: profile?.captionSymbolTone?.(useDarkColors) ?? options.captionSymbolTone,
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

export function applyWindowAppearance(
  win: BrowserWindow,
  opts: SetWindowAppearanceInput,
): SystemAppearance {
  if (opts.themeSource) {
    nativeTheme.themeSource = opts.themeSource;
  }
  syncWindowAppearance(win, {
    backgroundMaterial: opts.backgroundMaterial,
    useDarkColors: nativeTheme.shouldUseDarkColors,
    useMacosNativeGlass: shouldUseMacosNativeGlass(hostPlatform(), process.env, {
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
