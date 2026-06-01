import type { CloudSyncStatus } from "../../../../src/sync/types";
import {
  resolveCloudSyncConfig,
  resolveTelemetryConfig,
  resolveTelemetryConsent,
  type TelemetryEnv,
} from "../../../../src/telemetry/config";
import type { PersistedState } from "../../src/app/types";
import type { TelemetryStatusEntry, TelemetryStatusSnapshot } from "../../src/lib/desktopApi";

function statusEntry(
  status: TelemetryStatusEntry["status"],
  configured: boolean,
  enabled: boolean,
  message?: string,
): TelemetryStatusEntry {
  const labels: Record<TelemetryStatusEntry["status"], TelemetryStatusEntry["label"]> = {
    disabled: "Disabled",
    not_configured: "Not configured",
    enabled: "Enabled",
    metadata_only: "Metadata only",
    full_payload: "Full payload",
    local_only: "Local only",
    upload_configured: "Upload configured",
    connected: "Connected",
    error: "Error",
  };
  return {
    label: labels[status],
    status,
    configured,
    enabled,
    ...(message ? { message } : {}),
  };
}

function aiTraceStatusEntry(opts: {
  consent: ReturnType<typeof resolveTelemetryConsent>;
  telemetry: ReturnType<typeof resolveTelemetryConfig>;
}): TelemetryStatusEntry {
  if (opts.telemetry.networkTelemetryDisabled || !opts.consent.aiTraceTelemetryEnabled) {
    return statusEntry("disabled", false, false);
  }

  const publicConfigReady = Boolean(
    opts.telemetry.aiTraces.baseUrl && opts.telemetry.aiTraces.publicKey,
  );
  if (!publicConfigReady) {
    return statusEntry("not_configured", false, false);
  }

  const status = opts.consent.aiTracePayloadsEnabled ? "full_payload" : "metadata_only";
  return statusEntry(status, true, true);
}

export function resolveDesktopTelemetryStatus(opts: {
  state?: PersistedState | null;
  env?: TelemetryEnv;
  isPackaged: boolean;
  appVersion: string;
  cloudSyncStatus?: CloudSyncStatus | null;
}): TelemetryStatusSnapshot {
  const env = opts.env ?? process.env;
  const consent = resolveTelemetryConsent({
    settings: opts.state?.privacyTelemetrySettings,
    env,
    isPackaged: opts.isPackaged,
  });
  const telemetry = resolveTelemetryConfig({
    consent,
    env,
    isPackaged: opts.isPackaged,
    appVersion: opts.appVersion,
    anonymousId: opts.state?.productAnalytics?.anonymousInstallationId,
    surface: "electron-renderer",
    includeSecrets: false,
  });
  const cloud = resolveCloudSyncConfig({
    persisted: opts.state?.cloudSync,
    env,
    lastStatus: opts.cloudSyncStatus,
    includeSecrets: false,
  });

  return {
    globalKillSwitchActive: telemetry.networkTelemetryDisabled,
    crashReports: statusEntry(
      telemetry.crashReports.status,
      telemetry.crashReports.dsnConfigured,
      telemetry.crashReports.enabled,
    ),
    productAnalytics: statusEntry(
      telemetry.productAnalytics.status,
      telemetry.productAnalytics.keyConfigured,
      telemetry.productAnalytics.enabled,
    ),
    aiTraces: aiTraceStatusEntry({ consent, telemetry }),
    diagnosticsUpload: statusEntry(
      telemetry.diagnosticsUpload.status,
      telemetry.diagnosticsUpload.uploadUrlConfigured,
      telemetry.diagnosticsUpload.enabled,
    ),
    cloudSync: statusEntry(
      cloud.status,
      cloud.provider === "custom" && Boolean(cloud.endpoint),
      cloud.enabled,
      cloud.message,
    ),
  };
}
