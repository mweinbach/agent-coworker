import os from "node:os";
import { app } from "electron";

import {
  type CrashReportingEnv,
  type CrashReportingSdk,
  type CrashReportingStatus,
  captureError,
  initCrashReporting,
  resolveCrashReportingConfig,
  shutdownCrashReporting,
} from "../../../../src/telemetry/crashReporting";
import { resolveTelemetryConsent } from "../../../../src/telemetry/config";
import { type PersistedPrivacyTelemetrySettings } from "../../src/app/types";
import { writeLocalLog } from "./localLogs";

let processHandlersRegistered = false;

function appVersion(): string {
  return app.getVersion().trim() || "unknown";
}

export function resolveDesktopMainCrashReportingConfig(
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null,
  env: CrashReportingEnv = process.env,
) {
  const settings = resolveTelemetryConsent({
    settings: privacyTelemetrySettings,
    env,
    isPackaged: app.isPackaged,
  });
  return resolveCrashReportingConfig({
    component: "electron-main",
    enabled: settings.crashReportsEnabled,
    env,
    fallbackRelease: appVersion(),
    appVersion: appVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
}

export function applyCrashReportingProcessEnv(
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const config = resolveDesktopMainCrashReportingConfig(privacyTelemetrySettings, env);
  env.COWORK_CRASH_REPORTS_ENABLED = config.enabled ? "true" : "false";

  if (config.dsn) {
    env.COWORK_SENTRY_DSN = config.dsn;
  } else {
    delete env.COWORK_SENTRY_DSN;
  }

  if (config.release) {
    env.COWORK_RELEASE = config.release;
  }
  env.COWORK_SENTRY_ENVIRONMENT = config.environment;
}

export function registerMainCrashReportingHandlers(): void {
  if (processHandlersRegistered) {
    return;
  }
  processHandlersRegistered = true;

  process.on("uncaughtExceptionMonitor", (error) => {
    captureError(error, {
      tags: { operation: "unhandled_exception" },
    });
  });

  process.on("unhandledRejection", (reason) => {
    captureError(reason, {
      tags: { operation: "unhandled_rejection" },
      extra: { reasonType: typeof reason },
    });
  });
}

export async function initElectronMainCrashReporting(
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null,
): Promise<CrashReportingStatus> {
  applyCrashReportingProcessEnv(privacyTelemetrySettings);
  const settings = resolveTelemetryConsent({
    settings: privacyTelemetrySettings,
    env: process.env,
    isPackaged: app.isPackaged,
  });
  if (!settings.crashReportsEnabled) {
    await shutdownCrashReporting();
  }

  const status = await initCrashReporting({
    component: "electron-main",
    enabled: settings.crashReportsEnabled,
    env: process.env,
    fallbackRelease: appVersion(),
    appVersion: appVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    homeDir: os.homedir(),
    tags: {
      component: "electron-main",
      platform: process.platform,
      arch: process.arch,
      appVersion: appVersion(),
      packaged: app.isPackaged,
    },
    loadSdk: async () => {
      const sdk = await import("@sentry/electron/main");
      return sdk as unknown as CrashReportingSdk;
    },
  });

  if (status.initialized) {
    registerMainCrashReportingHandlers();
  }
  writeLocalLog("desktop-main.log", "info", "crash-reporting", "crash reporting status", {
    initialized: status.initialized,
    reason: status.reason,
    enabled: status.enabled,
    dsnConfigured: status.dsnConfigured,
  });
  return status;
}

export { captureError as captureCrashReportingError };
