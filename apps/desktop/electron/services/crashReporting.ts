import os from "node:os";
import { app } from "electron";
import { resolveTelemetryConsent } from "../../../../src/telemetry/config";
import {
  type CrashReportingEnv,
  type CrashReportingSdk,
  type CrashReportingStatus,
  captureError,
  initCrashReporting,
  resolveCrashReportingConfig,
} from "../../../../src/telemetry/crashReporting";
import type { PersistedPrivacyTelemetrySettings } from "../../src/app/types";
import { writeLocalLog } from "./localLogs";

let processHandlersRegistered = false;
let operatorEnv: CrashReportingEnv | null = null;

function appVersion(): string {
  return app.getVersion().trim() || "unknown";
}

function resolveDesktopMainCrashReportingConfig(
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

function applyCrashReportingProcessEnv(
  config: ReturnType<typeof resolveDesktopMainCrashReportingConfig>,
  env: NodeJS.ProcessEnv = process.env,
): void {
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

function registerMainCrashReportingHandlers(): void {
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
  // Snapshot lazily, after public build configuration is applied at startup.
  // The effective process values below must not become opt-ins on the next call.
  operatorEnv ??= { ...process.env };
  applyCrashReportingProcessEnv(
    resolveDesktopMainCrashReportingConfig(privacyTelemetrySettings, operatorEnv),
  );
  const settings = resolveTelemetryConsent({
    settings: privacyTelemetrySettings,
    env: operatorEnv,
    isPackaged: app.isPackaged,
  });

  const status = await initCrashReporting({
    component: "electron-main",
    enabled: settings.crashReportsEnabled,
    env: operatorEnv,
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
    detail: status.detail,
    enabled: status.enabled,
    dsnConfigured: status.dsnConfigured,
  });
  return status;
}

export { captureError as captureCrashReportingError };
