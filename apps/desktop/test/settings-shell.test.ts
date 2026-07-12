import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DesktopPlatformInfo } from "../src/lib/desktopPlatform";
import {
  getSettingsDragZoneStyle,
  getSettingsGroups,
  SETTINGS_PAGE_ALIASES,
} from "../src/ui/settings/SettingsShell";

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
    expect(pageIds).toContain("subagents");
    expect(pageIds).toContain("toolAccess");
    expect(pageIds).toContain("privacyTelemetry");
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
    expect(pageIds).toContain("privacyTelemetry");
    expect(pageIds).not.toContain("remoteAccess");
    expect(pageIds).toContain("models");
    expect(pageIds).toContain("subagents");
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
    expect(darwinCss).toMatch(
      /\.settings-shell__page-titleband\s*\{[^}]*min-height:\s*calc\(var\(--platform-titlebar-height\)\s*\+\s*2\.75rem\);[^}]*padding-top:\s*var\(--platform-titlebar-height\);/s,
    );
    expect(darwinCss).toMatch(
      /\.settings-shell__page-titleband\s*\{[^}]*box-shadow:\s*0 1px 0 var\(--border-subtle\);/s,
    );
  });

  test("carves settings header actions out of the native drag region", () => {
    const stylesCss = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");

    expect(stylesCss).toMatch(
      /\.settings-shell__header-actions,\s*\.settings-shell__header-actions \*\s*\{[^}]*-webkit-app-region:\s*no-drag\s*;/s,
    );
  });

  test("uses the shared narrow tier for a focus-managed settings navigation drawer", () => {
    const settingsSource = readFileSync(
      resolve(import.meta.dir, "../src/ui/settings/SettingsShell.tsx"),
      "utf8",
    );
    const stylesCss = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");

    expect(settingsSource).toContain("useAdaptiveLayout");
    expect(settingsSource).toContain("onDesktopRailCommand");
    expect(settingsSource).toContain('command !== "toggle-sidebar"');
    expect(settingsSource).toContain("setNavigationOpen((open) => !open)");
    expect(settingsSource).toContain('label="Settings navigation"');
    expect(settingsSource).toContain("Open settings navigation");
    expect(settingsSource).toContain("text-foreground/72");
    expect(settingsSource).not.toContain("text-foreground/58");
    expect(settingsSource).not.toContain("max-[860px]");
    expect(settingsSource).not.toContain("min-[861px]");
    expect(stylesCss).not.toContain("max-width: 860px");
    expect(stylesCss).not.toContain("min-width: 861px");
  });

  test("resolves legacy settings page ids to their canonical nav id", () => {
    const pageIds = getSettingsGroups(true).flatMap((group) => group.pages.map((page) => page.id));
    for (const [legacy, canonical] of Object.entries(SETTINGS_PAGE_ALIASES)) {
      // Every legacy alias must point at a page that actually exists in the nav.
      expect(pageIds).not.toContain(legacy);
      expect(pageIds).toContain(canonical);
    }
    expect(SETTINGS_PAGE_ALIASES.providers).toBe("models");
    expect(SETTINGS_PAGE_ALIASES.mcp).toBe("toolAccess");
    expect(SETTINGS_PAGE_ALIASES.openAiNativeConnectors).toBe("toolAccess");
    expect(SETTINGS_PAGE_ALIASES.workspaces).toBe("defaults");
    expect(SETTINGS_PAGE_ALIASES.memory).toBe("profileMemory");
    expect(SETTINGS_PAGE_ALIASES.featureFlags).toBe("experiments");
    expect(SETTINGS_PAGE_ALIASES.developer).toBe("diagnostics");
    expect(SETTINGS_PAGE_ALIASES.archivedChats).toBe("chats");
  });
});
