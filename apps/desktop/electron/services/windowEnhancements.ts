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
  isGlassSupported?: () => boolean;
  addView?: (
    handle: Buffer,
    options?: {
      cornerRadius?: number;
      tintColor?: string;
      opaque?: boolean;
    },
  ) => number;
}

interface ApplyMacosPremiumEnhancementsOptions {
  platform?: NodeJS.Platform;
  importModule?: ModuleImporter;
  warn?: WarnFn;
  superBrowserWindowKitLicense?: string;
}

export function macosBrowserWindowOptions(
  platform: NodeJS.Platform = process.platform,
): Partial<BrowserWindowConstructorOptions> {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
      transparent: true,
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
    return viewId >= 0;
  } catch (error) {
    warn("electron-liquid-glass enhancement unavailable", error);
    return false;
  }
}

export async function applyMacosPremiumEnhancements(
  win: BrowserWindow,
  options: ApplyMacosPremiumEnhancementsOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin") {
    return;
  }

  const importModule = options.importModule ?? defaultImporter;
  const warn = options.warn ?? defaultWarn;
  const license = options.superBrowserWindowKitLicense ?? process.env.COWORK_SBWK_LICENSE?.trim();

  const cornerEnhancementApplied = await applySuperBrowserWindowKit(win, importModule, warn, license);
  const glassEnhancementApplied = await applyLiquidGlass(win, importModule, warn);

  if (!cornerEnhancementApplied && !glassEnhancementApplied) {
    warn("Using native macOS BrowserWindow appearance fallback");
  }
}
