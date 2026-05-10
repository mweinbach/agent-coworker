import type { PlatformChromeInfo } from "./desktopApi";

export function applyPlatformChromeToDocument(doc: Document, chrome: PlatformChromeInfo): void {
  const root = doc.documentElement;
  root.style.setProperty("--platform-titlebar-height", `${chrome.titlebarHeight}px`);
  root.style.setProperty("--platform-drag-strip-height", `${chrome.dragStripHeight}px`);
  root.style.setProperty("--platform-left-native-reserve", `${chrome.leftNativeReserve}px`);
  root.style.setProperty("--platform-right-native-reserve", `${chrome.rightNativeReserve}px`);
  root.style.setProperty("--platform-caption-button-reserve", `${chrome.captionButtonReserve}px`);
  root.dataset.sidebarTitlebandMode = chrome.sidebarTitlebandMode;
  root.dataset.topbarControlPlacement = chrome.topbarControlPlacement;
  root.dataset.usesNativeGlass = chrome.usesNativeGlass ? "true" : "false";
  root.dataset.disableCssBlur = chrome.disableCssBlur ? "true" : "false";
}
