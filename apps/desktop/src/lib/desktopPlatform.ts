/**
 * Desktop platform detection and normalization for renderer components.
 *
 * Reads `data-platform` from the document root (set in App.tsx from
 * SystemAppearance) and normalizes to a stable DesktopPlatform enum.
 *
 * Platform naming convention:
 * - `data-platform` / Node / Electron use raw OS ids: `darwin`, `win32`, `linux`
 * - Renderer TypeScript uses normalized ids: `macos`, `windows`, `linux`, `other`
 * - CSS selectors target raw values (`:root[data-platform="win32"]`)
 * - Components should use `useDesktopPlatform()` / `DesktopPlatformInfo.platform`
 *
 * This replaces scattered `process.platform === "darwin"` checks throughout
 * the renderer. Components should prefer these normalized values over
 * raw platform strings.
 */

export type DesktopPlatform = "macos" | "windows" | "linux" | "other";

export type SidebarTitlebandMode = "native" | "topbar";
export type TopbarControlPlacement = "left-rail" | "sidebar" | "inline";

export type DesktopPlatformInfo = {
  platform: DesktopPlatform;
  rawPlatform: string;
  sidebarTitlebandMode: SidebarTitlebandMode;
  topbarControlPlacement: TopbarControlPlacement;
  usesNativeGlass: boolean;
  disableCssBlur: boolean;
  captionButtonReserve: number;
  collapsedLeftRailWidth: number;
  topbarToolbarGap: number;
};

/**
 * Map raw Node.js platform string to normalized DesktopPlatform.
 */
export function normalizePlatform(raw: string | undefined): DesktopPlatform {
  switch (raw) {
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

function readPlatformMetric(datasetValue: string | undefined, fallback: number): number {
  if (datasetValue === undefined || datasetValue === "") {
    return fallback;
  }
  const parsed = Number.parseFloat(datasetValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultCaptionButtonReserve(platform: DesktopPlatform): number {
  return platform === "windows" ? 136 : 0;
}

function defaultCollapsedLeftRailWidth(platform: DesktopPlatform): number {
  return platform === "windows" ? 84 : 0;
}

function defaultTopbarToolbarGap(platform: DesktopPlatform): number {
  if (platform === "macos" || platform === "other") {
    return 0;
  }
  return 6;
}

/**
 * Read the current platform info from document root attributes.
 *
 * Safe to call during SSR — returns a sensible fallback when document
 * is unavailable.
 */
export function getDesktopPlatformInfo(): DesktopPlatformInfo {
  if (typeof document === "undefined") {
    return {
      platform: "other",
      rawPlatform: "other",
      sidebarTitlebandMode: "topbar",
      topbarControlPlacement: "inline",
      usesNativeGlass: false,
      disableCssBlur: false,
      captionButtonReserve: 0,
      collapsedLeftRailWidth: 0,
      topbarToolbarGap: 0,
    };
  }

  const root = document.documentElement;
  const rawPlatform = root.dataset.platform ?? "other";
  const platform = normalizePlatform(rawPlatform);

  // Read mode from data attrs set by App.tsx, fall back to sensible defaults
  const sidebarTitlebandMode =
    (root.dataset.sidebarTitlebandMode as SidebarTitlebandMode | undefined) ??
    defaultSidebarTitlebandMode(platform);
  const topbarControlPlacement =
    (root.dataset.topbarControlPlacement as TopbarControlPlacement | undefined) ??
    defaultTopbarControlPlacement(platform);
  const usesNativeGlass = root.dataset.usesNativeGlass === "true" || platform === "macos";
  const disableCssBlur = root.dataset.disableCssBlur === "true" || platform === "macos";
  const captionButtonReserve = readPlatformMetric(
    root.dataset.captionButtonReserve,
    defaultCaptionButtonReserve(platform),
  );
  const collapsedLeftRailWidth = readPlatformMetric(
    root.dataset.collapsedLeftRailWidth,
    defaultCollapsedLeftRailWidth(platform),
  );
  const topbarToolbarGap = readPlatformMetric(
    root.dataset.topbarToolbarGap,
    defaultTopbarToolbarGap(platform),
  );

  return {
    platform,
    rawPlatform,
    sidebarTitlebandMode,
    topbarControlPlacement,
    usesNativeGlass,
    disableCssBlur,
    captionButtonReserve,
    collapsedLeftRailWidth,
    topbarToolbarGap,
  };
}

function defaultSidebarTitlebandMode(platform: DesktopPlatform): SidebarTitlebandMode {
  return platform === "windows" ? "native" : "topbar";
}

function defaultTopbarControlPlacement(platform: DesktopPlatform): TopbarControlPlacement {
  if (platform === "macos") return "sidebar";
  if (platform === "windows") return "left-rail";
  return "inline";
}

/**
 * Convenience booleans for platform checks in components.
 */
export function isMacos(info: DesktopPlatformInfo): boolean {
  return info.platform === "macos";
}

export function isWindows(info: DesktopPlatformInfo): boolean {
  return info.platform === "windows";
}

export function isLinux(info: DesktopPlatformInfo): boolean {
  return info.platform === "linux";
}

export function resolveCollapsedLeftRailWidth(info: DesktopPlatformInfo): number {
  if (info.collapsedLeftRailWidth > 0) {
    return info.collapsedLeftRailWidth;
  }
  return info.platform === "windows" ? 84 : 0;
}
