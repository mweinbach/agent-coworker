import {
  type CrashReportingSdk,
  captureError,
  initCrashReporting,
  setCrashReportingEnabled,
  shutdownCrashReporting,
} from "../../../../src/telemetry/crashReporting";
import type { DesktopCrashReportingConfig } from "./desktopApi";

function getDesktopCrashReportingConfig(): DesktopCrashReportingConfig | null {
  return typeof window === "undefined" ? null : (window.cowork?.crashReporting ?? null);
}

export async function initRendererCrashReporting(enabledOverride?: boolean): Promise<void> {
  const config = getDesktopCrashReportingConfig();
  if (!config) {
    return;
  }

  const enabled = enabledOverride ?? config.enabled;
  if (!enabled) {
    await shutdownCrashReporting();
    return;
  }

  await initCrashReporting({
    component: "electron-renderer",
    enabled,
    dsn: config.dsn,
    release: config.release,
    environment: config.environment,
    appVersion: config.appVersion,
    isPackaged: config.packaged,
    platform: config.platform,
    arch: config.arch,
    tags: {
      component: "electron-renderer",
      appVersion: config.appVersion,
      platform: config.platform,
    },
    loadSdk: async () => {
      const sdk = await import("@sentry/electron/renderer");
      return sdk as unknown as CrashReportingSdk;
    },
  });
}

export async function syncRendererCrashReportingPreference(enabled: boolean): Promise<void> {
  if (!enabled) {
    await setCrashReportingEnabled(false);
    return;
  }
  await initRendererCrashReporting(true);
}

export { captureError as captureRendererError };
