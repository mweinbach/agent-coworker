import { useEffect, useState } from "react";

import { useAppStore } from "../../../app/store";
import type { PrivacyTelemetrySettings } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Switch } from "../../../components/ui/switch";
import type { TelemetryStatusEntry, TelemetryStatusSnapshot } from "../../../lib/desktopApi";
import { getTelemetryStatus } from "../../../lib/desktopCommands";
import { SettingsPage, SettingsRow, SettingsSection } from "../SettingsPrimitives";

function badgeVariantForStatus(status: TelemetryStatusEntry["status"]) {
  if (status === "enabled" || status === "metadata_only" || status === "full_payload") {
    return "secondary" as const;
  }
  if (status === "connected" || status === "upload_configured") {
    return "secondary" as const;
  }
  if (status === "error") {
    return "destructive" as const;
  }
  return "outline" as const;
}

function statusBadge(entry: TelemetryStatusEntry) {
  return <Badge variant={badgeVariantForStatus(entry.status)}>{entry.label}</Badge>;
}

function entry(
  label: TelemetryStatusEntry["label"],
  status: TelemetryStatusEntry["status"],
  configured: boolean,
  enabled: boolean,
): TelemetryStatusEntry {
  return { label, status, configured, enabled };
}

function fallbackTelemetryStatus(settings: PrivacyTelemetrySettings): TelemetryStatusSnapshot {
  const crashReportingConfig =
    typeof window === "undefined" ? null : (window.cowork?.crashReporting ?? null);
  const productAnalyticsConfig =
    typeof window === "undefined" ? null : (window.cowork?.productAnalytics ?? null);
  const crashReports = !settings.crashReportsEnabled
    ? entry("Disabled", "disabled", Boolean(crashReportingConfig?.dsnConfigured), false)
    : crashReportingConfig?.dsnConfigured
      ? entry("Enabled", "enabled", true, true)
      : entry("Not configured", "not_configured", false, false);
  const productAnalytics = !settings.productAnalyticsEnabled
    ? entry("Disabled", "disabled", Boolean(productAnalyticsConfig?.keyConfigured), false)
    : productAnalyticsConfig?.keyConfigured
      ? entry("Enabled", "enabled", true, true)
      : entry("Not configured", "not_configured", false, false);
  const aiTraces = !settings.aiTraceTelemetryEnabled
    ? entry("Disabled", "disabled", false, false)
    : settings.aiTracePayloadsEnabled
      ? entry("Full payload", "full_payload", true, true)
      : entry("Metadata only", "metadata_only", true, true);
  const diagnosticsUpload = !settings.diagnosticsUploadEnabled
    ? entry("Disabled", "disabled", false, false)
    : entry("Local only", "local_only", false, false);
  return {
    globalKillSwitchActive: false,
    crashReports,
    productAnalytics,
    aiTraces,
    diagnosticsUpload,
    cloudSync: entry("Disabled", "disabled", false, false),
  };
}

export function PrivacyTelemetryPage() {
  const settings = useAppStore((s) => s.privacyTelemetrySettings);
  const setCrashReportsEnabled = useAppStore((s) => s.setCrashReportsEnabled);
  const setProductAnalyticsEnabled = useAppStore((s) => s.setProductAnalyticsEnabled);
  const setAiTraceTelemetryEnabled = useAppStore((s) => s.setAiTraceTelemetryEnabled);
  const setAiTracePayloadsEnabled = useAppStore((s) => s.setAiTracePayloadsEnabled);
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryStatusSnapshot | null>(() =>
    typeof window === "undefined" ? null : (window.cowork?.telemetryStatus ?? null),
  );

  useEffect(() => {
    let cancelled = false;
    setTelemetryStatus(fallbackTelemetryStatus(settings));
    void getTelemetryStatus({ privacyTelemetrySettings: settings })
      .then((status) => {
        if (!cancelled) {
          setTelemetryStatus(status);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settings]);

  const status = telemetryStatus ?? fallbackTelemetryStatus(settings);

  return (
    <SettingsPage>
      <SettingsSection
        title="Privacy & Telemetry"
        description="Cowork is local-first. These toggles only control optional reporting and AI diagnostics. Disabling them must prevent network telemetry from starting."
      >
        {status.globalKillSwitchActive ? (
          <SettingsRow
            title="Global kill switch"
            description="COWORK_DISABLE_NETWORK_TELEMETRY is active. Network telemetry is disabled."
            control={<Badge variant="destructive">Disabled</Badge>}
          />
        ) : null}
        <SettingsRow
          title="Crash reports"
          description="Sends crash/error reports and basic technical metadata."
          control={
            <div className="flex items-center gap-2">
              {statusBadge(status.crashReports)}
              <Switch
                checked={settings.crashReportsEnabled}
                aria-label="Crash reports"
                onCheckedChange={setCrashReportsEnabled}
              />
            </div>
          }
        />
        <SettingsRow
          title="Anonymous product analytics"
          description="Sends event counts like app opened, workspace added, turn completed. Never sends prompts, file contents, shell commands, or file paths."
          control={
            <div className="flex items-center gap-2">
              {statusBadge(status.productAnalytics)}
              <Switch
                checked={settings.productAnalyticsEnabled}
                aria-label="Anonymous product analytics"
                onCheckedChange={setProductAnalyticsEnabled}
              />
            </div>
          }
        />
        <SettingsRow
          title="AI trace diagnostics"
          description="Sends high-level model/turn/tool timing metadata for debugging AI behavior."
          control={
            <div className="flex items-center gap-2">
              {statusBadge(status.aiTraces)}
              <Switch
                checked={settings.aiTraceTelemetryEnabled}
                aria-label="AI trace diagnostics"
                onCheckedChange={setAiTraceTelemetryEnabled}
              />
            </div>
          }
        />
        <SettingsRow
          title="Include prompts and responses in AI traces"
          description="Off by default. Only available when AI trace diagnostics is enabled. Strong warning: this may include prompts, responses, commands, logs, file paths or names, and other content."
          control={
            <Switch
              checked={settings.aiTracePayloadsEnabled}
              disabled={!settings.aiTraceTelemetryEnabled}
              aria-label="Include prompts and responses in AI traces"
              onCheckedChange={setAiTracePayloadsEnabled}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  );
}
