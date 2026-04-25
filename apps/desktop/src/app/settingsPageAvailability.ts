import type { DesktopFeatureFlags } from "../../../../src/shared/featureFlags";
import type { SettingsPageId } from "./types";

const DEVELOPMENT_ONLY_SETTINGS_PAGES = new Set<SettingsPageId>(["featureFlags"]);

export function isSettingsPageAvailable(
  page: SettingsPageId,
  opts: {
    desktopFeatures: DesktopFeatureFlags;
    packaged: boolean;
  },
): boolean {
  if (page === "remoteAccess" && opts.desktopFeatures.remoteAccess !== true) {
    return false;
  }

  if (opts.packaged && DEVELOPMENT_ONLY_SETTINGS_PAGES.has(page)) {
    return false;
  }

  return true;
}

export function includeDevelopmentSettings(packaged: boolean): boolean {
  return !packaged;
}
