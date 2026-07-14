import { mock } from "bun:test";

import type { DesktopApi } from "../../src/lib/desktopApi";
import { DESKTOP_API_OVERRIDE_KEY } from "../../src/lib/desktopApiOverride";
import type * as DesktopCommands from "../../src/lib/desktopCommands";
import { createDesktopCommandsMock } from "./mockDesktopCommands";

type DesktopCommandsModule = typeof DesktopCommands;

function getActiveDesktopApi(): DesktopApi | undefined {
  return (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] as
    | DesktopApi
    | undefined;
}

/**
 * Builds a desktopCommands module replacement that mirrors the real module's
 * DESKTOP_API_OVERRIDE_KEY seam for every export: each call resolves the
 * DesktopApi installed on globalThis at call time and falls back to inert
 * defaults when none is installed.
 *
 * Unlike a payload-specific `mock.module(..., () => createDesktopCommandsMock({...}))`,
 * this bridge is safe to leak across test files — with no override installed
 * it behaves like the default mock, and per-test overrides installed via
 * DESKTOP_API_OVERRIDE_KEY (the sanctioned DI seam) always take effect. It
 * also shields a file from module mocks leaked by earlier files, because
 * installing it re-points the shared module registry at the seam.
 */
function createFullDesktopCommandsBridge(): DesktopCommandsModule {
  const fallback = createDesktopCommandsMock();

  const bridged: Record<string, unknown> = {};
  for (const key of Object.keys(fallback)) {
    const fallbackValue = (fallback as Record<string, unknown>)[key];
    if (typeof fallbackValue !== "function") {
      bridged[key] = fallbackValue;
      continue;
    }
    bridged[key] = (...args: unknown[]) => {
      const active = getActiveDesktopApi() as unknown as Record<string, unknown> | undefined;
      const impl = active?.[key];
      if (typeof impl === "function") {
        return (impl as (...callArgs: unknown[]) => unknown).apply(active, args);
      }
      return (fallbackValue as (...callArgs: unknown[]) => unknown)(...args);
    };
  }

  // Mirror the real module's adapters where the module-level signature differs
  // from the DesktopApi bridge signature (see src/lib/desktopCommands.ts).
  bridged.readFile = async (opts: { path: string }): Promise<string> => {
    const active = getActiveDesktopApi();
    if (active) {
      return (await active.readFile(opts)).content;
    }
    return await fallback.readFile(opts);
  };
  bridged.showContextMenu = async (
    items: { id: string; label: string; enabled?: boolean }[],
  ): Promise<string | null> => {
    const active = getActiveDesktopApi();
    if (active) {
      return await active.showContextMenu({ items });
    }
    return await fallback.showContextMenu(items);
  };
  bridged.getDesktopFeatureFlags = (
    overrides?: Parameters<DesktopCommandsModule["getDesktopFeatureFlags"]>[0],
  ) => {
    const active = getActiveDesktopApi();
    if (active && typeof active.resolveDesktopFeatureFlags === "function") {
      return active.resolveDesktopFeatureFlags(overrides);
    }
    return fallback.getDesktopFeatureFlags(overrides);
  };
  bridged.isPackagedDesktopApp = (): boolean => {
    const active = getActiveDesktopApi();
    return active ? active.isPackaged === true : fallback.isPackagedDesktopApp();
  };
  bridged.isDesktopDemoMode = (): boolean => {
    const active = getActiveDesktopApi();
    return active ? active.demoMode === true : fallback.isDesktopDemoMode();
  };

  return bridged as unknown as DesktopCommandsModule;
}

/**
 * Installs the full bridge as the desktopCommands module. Call once at module
 * scope, before importing the store or components under test. Deliver the
 * per-test behavior by installing a DesktopApi (e.g. createDesktopApiMock)
 * on globalThis[DESKTOP_API_OVERRIDE_KEY] in beforeEach and deleting it in
 * afterEach.
 */
export function installDesktopCommandsBridge(): void {
  // Resolved relative to this helper file; targets apps/desktop/src/lib/desktopCommands.
  mock.module("../../src/lib/desktopCommands", () => createFullDesktopCommandsBridge());
}
