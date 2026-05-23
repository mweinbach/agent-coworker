import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DesktopPlatformInfo } from "../src/lib/desktopPlatform";
import { getSettingsDragZoneStyle, getSettingsGroups } from "../src/ui/settings/SettingsShell";

function makePlatformInfo(overrides: Partial<DesktopPlatformInfo> = {}): DesktopPlatformInfo {
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
    expect(pageIds).toContain("experiments");
    expect(pageIds).toContain("models");
    expect(pageIds).toContain("toolAccess");
    expect(pageIds).not.toContain("openAiNativeConnectors");
  });

  test("consolidates tool surfaces into Tool Access", () => {
    const pageIds = getSettingsGroups(true).flatMap((group) => group.pages.map((page) => page.id));
    expect(pageIds).toContain("toolAccess");
    expect(pageIds).not.toContain("mcp");
    expect(pageIds).not.toContain("openAiNativeConnectors");
  });

  test("hides development-only settings in packaged builds", () => {
    const pageIds = getSettingsGroups(false, { includeDevelopmentPages: false }).flatMap((group) =>
      group.pages.map((page) => page.id),
    );
    expect(pageIds).not.toContain("experiments");
    expect(pageIds).toContain("diagnostics");
    expect(pageIds).not.toContain("remoteAccess");
    expect(pageIds).toContain("models");
    expect(pageIds).not.toContain("openAiNativeConnectors");
  });

  test("hides remote access when the feature is disabled", () => {
    const pageIds = getSettingsGroups(false).flatMap((group) => group.pages.map((page) => page.id));
    expect(pageIds).not.toContain("remoteAccess");
    expect(pageIds).toContain("experiments");
  });

  test("getSettingsGroups omits development pages when requested", () => {
    const pageIds = getSettingsGroups(true, { includeDevelopmentPages: false }).flatMap((group) =>
      group.pages.map((page) => page.id),
    );
    expect(pageIds).toContain("remoteAccess");
    expect(pageIds).not.toContain("experiments");
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
    ).toEqual({ "--settings-sidebar-width": "280px" });
  });

  test("places the macOS settings back button below the traffic light strip", () => {
    const darwinCss = readFileSync(
      resolve(import.meta.dir, "../src/styles/platform/darwin.css"),
      "utf8",
    );

    expect(darwinCss).toMatch(
      /:root\[data-platform="darwin"\]\s+\.settings-shell__nav\s*\{[^}]*z-index:\s*81;/s,
    );
    expect(darwinCss).toMatch(
      /\.settings-shell__nav-titleband\s*\{[^}]*min-height:\s*calc\(var\(--platform-titlebar-height\)\s*\+\s*2\.75rem\);[^}]*padding-top:\s*var\(--platform-titlebar-height\);/s,
    );
    expect(darwinCss).toMatch(
      /\.settings-shell__nav-titleband-row\s*\{[^}]*padding-left:\s*0\.75rem;/s,
    );
  });
});
