/**
 * Platform chrome contract — shared constants for native window behavior.
 *
 * This file defines the contract between Electron main process window chrome
 * and renderer layout. All platform-specific values live here so they can be
 * consumed by both processes and tested in isolation.
 *
 * Design principle: one visual language, three native shells.
 * - macOS: native traffic lights, hidden inset, vibrancy
 * - Windows: titleBarOverlay, caption buttons, Mica
 * - Linux: titleBarOverlay/fallback, opaque/translucency-safe
 */

import type { WindowsBackgroundMaterial } from "../../../src/lib/desktopApi";

export type DesktopPlatform = "macos" | "windows" | "linux" | "other";

export type PlatformChromeContract = {
  /** Platform identifier */
  platform: DesktopPlatform;

  /** Title bar height in pixels */
  titlebarHeight: number;

  /** Height of top-edge drag strip in pixels */
  dragStripHeight: number;

  /** Left-side native reserve (traffic lights / caption buttons) in pixels */
  leftNativeReserve: number;

  /** Right-side native reserve (caption buttons / window controls) in pixels */
  rightNativeReserve: number;

  /** Windows-specific: caption button reserve space */
  captionButtonReserve: number;

  /** macOS-specific: traffic light position {x, y} */
  trafficLightPosition?: { x: number; y: number };

  /** Windows-specific: background material */
  windowMaterial?: WindowsBackgroundMaterial;

  /** Sidebar titleband mode: 'native' (sidebar owns titleband) or 'topbar' (topbar owns) */
  sidebarTitlebandMode: "native" | "topbar";

  /** Topbar control placement: 'left-rail' (collapsed rail) or 'sidebar' (sidebar owns) */
  topbarControlPlacement: "left-rail" | "sidebar" | "inline";

  /** Whether the platform uses native glass/vibrancy */
  usesNativeGlass: boolean;

  /** Whether CSS blur should be disabled (to avoid stacking on native materials) */
  disableCssBlur: boolean;
};

function mapPlatformToDesktop(platform: NodeJS.Platform): DesktopPlatform {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

/**
 * macOS chrome contract.
 *
 * - Native traffic lights at fixed position
 * - Hidden inset titlebar style
 * - Vibrancy with sidebar material
 * - Sidebar controls live in SidebarCollapseControl (traffic light area)
 * - CSS blur disabled on vibrancy regions to avoid stacking
 */
const MACOS_CHROME: PlatformChromeContract = {
  platform: "macos",
  titlebarHeight: 38, // 2.375rem
  dragStripHeight: 10, // 0.625rem
  leftNativeReserve: 86, // Space for traffic lights + padding
  rightNativeReserve: 0,
  captionButtonReserve: 0,
  trafficLightPosition: { x: 14, y: 14 },
  windowMaterial: undefined,
  sidebarTitlebandMode: "topbar",
  topbarControlPlacement: "sidebar",
  usesNativeGlass: true,
  disableCssBlur: true,
};

/**
 * Windows chrome contract.
 *
 * - titleBarOverlay with transparent color
 * - Native caption buttons on right
 * - Tabbed material for background (Win11 app frame with stronger top hierarchy)
 * - Sidebar owns titleband when expanded; collapsed rail owns controls
 * - CSS blur enabled (no native vibrancy to stack against)
 */
const WINDOWS_CHROME: PlatformChromeContract = {
  platform: "windows",
  titlebarHeight: 48,
  dragStripHeight: 10, // 0.625rem
  leftNativeReserve: 0,
  rightNativeReserve: 136, // Caption button reserve
  captionButtonReserve: 136,
  trafficLightPosition: undefined,
  windowMaterial: "tabbed",
  sidebarTitlebandMode: "native",
  topbarControlPlacement: "left-rail",
  usesNativeGlass: false,
  disableCssBlur: false,
};

/**
 * Linux chrome contract.
 *
 * - titleBarOverlay where supported, opaque fallback otherwise
 * - Window controls vary by DE/WM
 * - Opaque shell by default (no Mica/vibrancy assumptions)
 * - Aligned with Windows overlay height for shared renderer CSS
 * - CSS blur enabled but should be tested per WM
 */
const LINUX_CHROME: PlatformChromeContract = {
  platform: "linux",
  titlebarHeight: 48, // Match Windows for shared CSS
  dragStripHeight: 10, // 0.625rem
  leftNativeReserve: 0,
  rightNativeReserve: 192, // Window control reserve (varies by DE)
  captionButtonReserve: 0,
  trafficLightPosition: undefined,
  windowMaterial: undefined,
  sidebarTitlebandMode: "topbar",
  topbarControlPlacement: "inline",
  usesNativeGlass: false,
  disableCssBlur: false,
};

/**
 * Fallback chrome for unknown platforms.
 */
const OTHER_CHROME: PlatformChromeContract = {
  platform: "other",
  titlebarHeight: 48,
  dragStripHeight: 10,
  leftNativeReserve: 0,
  rightNativeReserve: 0,
  captionButtonReserve: 0,
  trafficLightPosition: undefined,
  windowMaterial: undefined,
  sidebarTitlebandMode: "topbar",
  topbarControlPlacement: "inline",
  usesNativeGlass: false,
  disableCssBlur: false,
};

/**
 * Get the platform chrome contract for a given Node.js platform.
 */
export function getPlatformChrome(platform: NodeJS.Platform): PlatformChromeContract {
  const desktopPlatform = mapPlatformToDesktop(platform);
  switch (desktopPlatform) {
    case "macos":
      return MACOS_CHROME;
    case "windows":
      return WINDOWS_CHROME;
    case "linux":
      return LINUX_CHROME;
    default:
      return OTHER_CHROME;
  }
}

/**
 * Get the platform chrome contract for the current platform.
 */
export function getCurrentPlatformChrome(): PlatformChromeContract {
  return getPlatformChrome(process.platform as NodeJS.Platform);
}

const TITLEBAR_SYMBOL_COLOR_LIGHT = "#556041";
const TITLEBAR_SYMBOL_COLOR_DARK = "#eef0dc";

/**
 * Get symbol colors for titlebar overlay.
 */
export function getTitlebarSymbolColors(): {
  light: string;
  dark: string;
} {
  return {
    light: TITLEBAR_SYMBOL_COLOR_LIGHT,
    dark: TITLEBAR_SYMBOL_COLOR_DARK,
  };
}

/**
 * Get the appropriate symbol color for the current theme.
 */
export function getTitlebarSymbolColor(useDarkColors: boolean): string {
  return useDarkColors ? TITLEBAR_SYMBOL_COLOR_DARK : TITLEBAR_SYMBOL_COLOR_LIGHT;
}
