import { describe, expect, test } from "bun:test";

import { getSettingsDragZoneStyle, getSettingsGroups } from "../src/ui/settings/SettingsShell";
import type { DesktopPlatformInfo } from "../src/lib/desktopPlatform";

function makePlatformInfo(
  overrides: Partial<DesktopPlatformInfo> = {},
): DesktopPlatformInfo {
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
    ...overrides,
  };
}

describe("settings shell", () => {
  test("shows remote access when the feature is enabled", () => {
    const pageIds = getSettingsGroups(true).flatMap((group) => group.pages.map((page) => page.id));
    expect(pageIds).toContain("remoteAccess");
    expect(pageIds).toContain("featureFlags");
    expect(pageIds).not.toContain("openAiNativeConnectors");
  });

  test("shows OpenAI native connectors only when the feature is enabled", () => {
    const pageIds = getSettingsGroups(true, { openAiNativeConnectorsAvailable: true }).flatMap(
      (group) => group.pages.map((page) => page.id),
    );
    expect(pageIds).toContain("openAiNativeConnectors");
  });

  test("hides development-only settings in packaged builds", () => {
    const pageIds = getSettingsGroups(false, { includeDevelopmentPages: false }).flatMap((group) =>
      group.pages.map((page) => page.id),
    );
    expect(pageIds).not.toContain("featureFlags");
    expect(pageIds).toContain("developer");
    expect(pageIds).not.toContain("remoteAccess");
    expect(pageIds).toContain("providers");
    expect(pageIds).not.toContain("openAiNativeConnectors");
  });

  test("hides remote access when the feature is disabled", () => {
    const pageIds = getSettingsGroups(false).flatMap((group) => group.pages.map((page) => page.id));
    expect(pageIds).not.toContain("remoteAccess");
    expect(pageIds).toContain("featureFlags");
  });

  test("getSettingsGroups omits development pages when requested", () => {
    const pageIds = getSettingsGroups(true, { includeDevelopmentPages: false }).flatMap((group) =>
      group.pages.map((page) => page.id),
    );
    expect(pageIds).toContain("remoteAccess");
    expect(pageIds).not.toContain("featureFlags");
  });

  test("offsets the settings drag zone right of the nav on native titleband platforms", () => {
    expect(getSettingsDragZoneStyle(280, makePlatformInfo())).toBeUndefined();
    expect(
      getSettingsDragZoneStyle(
        280,
        makePlatformInfo({
          platform: "windows",
          rawPlatform: "win32",
          sidebarTitlebandMode: "native",
        }),
      ),
    ).toEqual({ left: 280 });
  });
});
