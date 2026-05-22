import type { PlatformChromeInfo } from "./desktopApi";
import { getDesktopPlatformInfo } from "./desktopPlatform";

export function applyPlatformChromeToDocument(doc: Document, chrome: PlatformChromeInfo): void {  const root = doc.documentElement;
  root.style.setProperty("--platform-titlebar-height", `${chrome.titlebarHeight}px`);
  root.style.setProperty("--platform-drag-strip-height", `${chrome.dragStripHeight}px`);
  root.style.setProperty("--platform-left-native-reserve", `${chrome.leftNativeReserve}px`);
  root.style.setProperty("--platform-right-native-reserve", `${chrome.rightNativeReserve}px`);
  root.style.setProperty("--platform-caption-button-reserve", `${chrome.captionButtonReserve}px`);
  root.style.setProperty(
    "--platform-collapsed-left-rail-width",
    `${chrome.collapsedLeftRailWidth}px`,
  );
  root.style.setProperty("--platform-topbar-toolbar-gap", `${chrome.topbarToolbarGap}px`);
  root.dataset.captionButtonReserve = String(chrome.captionButtonReserve);
  root.dataset.collapsedLeftRailWidth = String(chrome.collapsedLeftRailWidth);
  root.dataset.topbarToolbarGap = String(chrome.topbarToolbarGap);
  root.dataset.sidebarTitlebandMode = chrome.sidebarTitlebandMode;
  root.dataset.topbarControlPlacement = chrome.topbarControlPlacement;
  root.dataset.usesNativeGlass = chrome.usesNativeGlass ? "true" : "false";
  root.dataset.disableCssBlur = chrome.disableCssBlur ? "true" : "false";
}

/** Sync layout CSS vars from platform defaults / IPC dataset attrs (no async wait). */
export function syncPlatformChromeCssVars(doc: Document): void {
  const info = getDesktopPlatformInfo();
  const root = doc.documentElement;
  root.style.setProperty("--platform-caption-button-reserve", `${info.captionButtonReserve}px`);
  root.style.setProperty(
    "--platform-collapsed-left-rail-width",
    `${info.collapsedLeftRailWidth}px`,
  );
  root.style.setProperty("--platform-topbar-toolbar-gap", `${info.topbarToolbarGap}px`);
}