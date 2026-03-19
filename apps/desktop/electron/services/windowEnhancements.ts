import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

const MACOS_TRAFFIC_LIGHT_POSITION = { x: 14, y: 14 } as const;
const MACOS_PREMIUM_CORNER_RADIUS = 16;

type ModuleImporter = (specifier: string) => Promise<unknown>;
type WarnFn = (message: string, error?: unknown) => void;

interface WindowKitLike {
  setLicense?: (license: string) => boolean;
  enableWindowCornerCustomization?: () => boolean;
  setWindowCornerRadius?: (handle: Buffer, radius?: number) => boolean;
}

interface LiquidGlassLike {
  GlassMaterialVariant?: {
    sidebar?: number;
    abuttedSidebar?: number;
  };
  isGlassSupported?: () => boolean;
  addView?: (
    handle: Buffer,
    options?: {
      cornerRadius?: number;
      tintColor?: string;
      opaque?: boolean;
    },
  ) => number;
  unstable_setVariant?: (viewId: number, variant: number) => void;
}

interface ApplyMacosPremiumEnhancementsOptions {
  platform?: NodeJS.Platform;
  importModule?: ModuleImporter;
  warn?: WarnFn;
  superBrowserWindowKitLicense?: string;
  enableSuperBrowserWindowKit?: boolean;
}

export interface MacosPremiumEnhancementResult {
  liquidGlassApplied: boolean;
  superBrowserWindowKitApplied: boolean;
}

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

export function shouldUseMacosLiquidGlass(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "darwin") {
    return false;
  }
  return parseBooleanEnv(env.COWORK_MACOS_LIQUID_GLASS, true);
}

export function macosBrowserWindowOptions(
  platform: NodeJS.Platform = process.platform,
  options: { useMacosLiquidGlass?: boolean } = {},
): Partial<BrowserWindowConstructorOptions> {
  const useMacosLiquidGlass = options.useMacosLiquidGlass ?? shouldUseMacosLiquidGlass(platform);

  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
      transparent: useMacosLiquidGlass,
    };
  }

  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000", // Transparent to show the app's background underneath
        symbolColor: "#5a4736", // Matches --muted for the warm theme
        height: 48, // Matches the h-12 (3rem) height of AppTopBar
      },
    };
  }

  return {};
}

function defaultImporter(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}

function defaultWarn(message: string, error?: unknown): void {
  if (!error) {
    console.warn(`[desktop] ${message}`);
    return;
  }
  console.warn(`[desktop] ${message}: ${String(error)}`);
}

function resolveDefaultExport(moduleValue: unknown): Record<string, unknown> | null {
  if (!moduleValue || typeof moduleValue !== "object") {
    return null;
  }

  const maybeDefault = (moduleValue as { default?: unknown }).default;
  if (!maybeDefault || typeof maybeDefault !== "object") {
    return null;
  }

  return maybeDefault as Record<string, unknown>;
}

async function applySuperBrowserWindowKit(
  win: BrowserWindow,
  importModule: ModuleImporter,
  warn: WarnFn,
  license: string | undefined,
): Promise<boolean> {
  try {
    const moduleValue = await importModule("super-browser-window-kit");
    const kit = resolveDefaultExport(moduleValue) as WindowKitLike | null;
    if (!kit) {
      return false;
    }

    if (license && typeof kit.setLicense === "function") {
      try {
        kit.setLicense(license);
      } catch (error) {
        warn("Unable to apply super-browser-window-kit license", error);
      }
    }

    if (typeof kit.enableWindowCornerCustomization === "function") {
      const enabled = kit.enableWindowCornerCustomization();
      if (enabled === false) {
        return false;
      }
    }

    if (typeof kit.setWindowCornerRadius !== "function") {
      return false;
    }

    kit.setWindowCornerRadius(win.getNativeWindowHandle(), MACOS_PREMIUM_CORNER_RADIUS);
    return true;
  } catch (error) {
    warn("super-browser-window-kit enhancement unavailable", error);
    return false;
  }
}

async function applyLiquidGlass(
  win: BrowserWindow,
  importModule: ModuleImporter,
  warn: WarnFn,
): Promise<boolean> {
  try {
    const moduleValue = await importModule("electron-liquid-glass");
    const liquidGlass = resolveDefaultExport(moduleValue) as LiquidGlassLike | null;
    if (!liquidGlass || typeof liquidGlass.addView !== "function") {
      return false;
    }

    if (
      typeof liquidGlass.isGlassSupported === "function" &&
      liquidGlass.isGlassSupported() === false
    ) {
      return false;
    }

    const viewId = liquidGlass.addView(win.getNativeWindowHandle(), {
      cornerRadius: MACOS_PREMIUM_CORNER_RADIUS,
    });
    if (viewId < 0) {
      return false;
    }

    const sidebarVariant =
      liquidGlass.GlassMaterialVariant?.abuttedSidebar ??
      liquidGlass.GlassMaterialVariant?.sidebar;
    if (typeof sidebarVariant === "number" && typeof liquidGlass.unstable_setVariant === "function") {
      try {
        liquidGlass.unstable_setVariant(viewId, sidebarVariant);
      } catch (error) {
        warn("electron-liquid-glass sidebar variant unavailable", error);
      }
    }

    return true;
  } catch (error) {
    warn("electron-liquid-glass enhancement unavailable", error);
    return false;
  }
}

export async function applyMacosPremiumEnhancements(
  win: BrowserWindow,
  options: ApplyMacosPremiumEnhancementsOptions = {},
): Promise<MacosPremiumEnhancementResult> {
  if ((options.platform ?? process.platform) !== "darwin") {
    return {
      liquidGlassApplied: false,
      superBrowserWindowKitApplied: false,
    };
  }

  const importModule = options.importModule ?? defaultImporter;
  const warn = options.warn ?? defaultWarn;
  const license = options.superBrowserWindowKitLicense ?? process.env.COWORK_SBWK_LICENSE?.trim();
  const useSbwk = options.enableSuperBrowserWindowKit ?? parseBooleanEnv(process.env.COWORK_ENABLE_SBWK, false);

  const glassEnhancementApplied = await applyLiquidGlass(win, importModule, warn);
  const cornerEnhancementApplied =
    glassEnhancementApplied && useSbwk
      ? await applySuperBrowserWindowKit(win, importModule, warn, license)
      : false;

  if (!cornerEnhancementApplied && !glassEnhancementApplied) {
    warn("Using native macOS BrowserWindow appearance fallback");
  }

  return {
    liquidGlassApplied: glassEnhancementApplied,
    superBrowserWindowKitApplied: cornerEnhancementApplied,
  };
}
