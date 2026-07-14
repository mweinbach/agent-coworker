import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useAppStore } from "../src/app/store";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import type { DesktopPlatformInfo } from "../src/lib/desktopPlatform";
import { requestDesktopRailCommand } from "../src/lib/desktopRailCommands";
import { OverlayStackProvider } from "../src/ui/OverlayStack";
import {
  getSettingsDragZoneStyle,
  getSettingsGroups,
  SETTINGS_PAGE_ALIASES,
  SettingsShell,
} from "../src/ui/settings/SettingsShell";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const defaultStoreState = useAppStore.getState();

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

  test("keeps overlay navigation opaque above the backdrop", () => {
    const css = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");
    expect(css).toMatch(
      /:root \.settings-shell__nav\[data-presentation="overlay"\]\s*\{[^}]*background:\s*var\(--sidebar-bg\);/s,
    );
  });

  test.serial(
    "narrow-tier settings navigation is a focus-managed drawer toggled by the rail command",
    async () => {
      const harness = setupJsdom({
        includeAnimationFrame: true,
        extraGlobals: { [DESKTOP_API_OVERRIDE_KEY]: createDesktopApiMock() },
        setupWindow: (dom) => {
          // Below the shared narrow breakpoint the left nav must present as an
          // overlay drawer instead of an inline column.
          Object.defineProperty(dom.window, "innerWidth", {
            configurable: true,
            value: 640,
          });
        },
      });
      const setSettingsPage = mock(() => {});
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        useAppStore.setState({
          ...defaultStoreState,
          settingsPage: "updates",
          setSettingsPage,
        } as Partial<ReturnType<typeof useAppStore.getState>> as ReturnType<
          typeof useAppStore.getState
        >);
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          root?.render(createElement(OverlayStackProvider, null, createElement(SettingsShell)));
        });

        const shell = container.querySelector<HTMLElement>(".settings-shell");
        expect(shell?.dataset.layoutTier).toBe("narrow");

        const toggle = container.querySelector<HTMLButtonElement>(
          '[aria-label="Open settings navigation"]',
        );
        if (!toggle) throw new Error("missing settings navigation toggle");
        expect(toggle.getAttribute("aria-expanded")).toBe("false");

        const drawerIsOpen = () => {
          const drawer = harness.dom.window.document.querySelector<HTMLElement>(
            '[role="dialog"][aria-label="Settings navigation"]',
          );
          return drawer !== null && drawer.getAttribute("aria-hidden") !== "true";
        };
        expect(drawerIsOpen()).toBe(false);

        // Opening from the header toggle reveals the drawer and moves focus in.
        await act(async () => toggle.click());
        await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));
        expect(drawerIsOpen()).toBe(true);
        const closeButton = harness.dom.window.document.querySelector<HTMLButtonElement>(
          '[aria-label="Close Settings navigation"]',
        );
        expect(closeButton).toBe(harness.dom.window.document.activeElement as HTMLButtonElement);

        // The desktop rail command toggles the same drawer.
        await act(async () => {
          requestDesktopRailCommand("toggle-sidebar");
        });
        await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));
        expect(drawerIsOpen()).toBe(false);

        await act(async () => {
          requestDesktopRailCommand("toggle-sidebar");
        });
        await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));
        expect(drawerIsOpen()).toBe(true);

        // Selecting a page routes the selection and dismisses the overlay.
        const drawer = harness.dom.window.document.querySelector<HTMLElement>(
          '[role="dialog"][aria-label="Settings navigation"]',
        );
        const usageButton = Array.from(drawer?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent?.trim() === "Usage",
        );
        if (!usageButton) throw new Error("missing Usage nav button");
        await act(async () => usageButton.click());
        await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));

        expect(setSettingsPage).toHaveBeenCalledWith("usage");
        expect(drawerIsOpen()).toBe(false);
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        useAppStore.setState(defaultStoreState);
        harness.restore();
      }
    },
  );

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
