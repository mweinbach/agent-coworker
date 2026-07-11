import { useEffect, useState } from "react";

import { useAppStore } from "../../../app/store";
import { operationKey } from "../../../app/store.helpers/operations";
import type { PrivacyTelemetrySettings } from "../../../app/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Switch } from "../../../components/ui/switch";
import type { TelemetryStatusEntry, TelemetryStatusSnapshot } from "../../../lib/desktopApi";
import { getTelemetryStatus } from "../../../lib/desktopCommands";
import { OperationFeedback } from "../../OperationFeedback";
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
  const operationsByKey = useAppStore((s) => s.operationsByKey);
  const setCrashReportsEnabled = useAppStore((s) => s.setCrashReportsEnabled);
  const setProductAnalyticsEnabled = useAppStore((s) => s.setProductAnalyticsEnabled);
  const setAiTraceTelemetryEnabled = useAppStore((s) => s.setAiTraceTelemetryEnabled);
  const setAiTracePayloadsEnabled = useAppStore((s) => s.setAiTracePayloadsEnabled);
  const setDiagnosticsUploadEnabled = useAppStore((s) => s.setDiagnosticsUploadEnabled);
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
  const crashReportsOperation = operationsByKey[operationKey("privacy-telemetry", "crash-reports")];
  const productAnalyticsOperation =
    operationsByKey[operationKey("privacy-telemetry", "product-analytics")];
  const aiTracesOperation = operationsByKey[operationKey("privacy-telemetry", "ai-traces")];
  const aiTracePayloadsOperation =
    operationsByKey[operationKey("privacy-telemetry", "ai-trace-payloads")];
  const diagnosticsUploadOperation =
    operationsByKey[operationKey("privacy-telemetry", "diagnostics-upload")];

  return (
    <SettingsPage>
      <SettingsSection
        title="Privacy & Telemetry"
        description="Cowork is local-first. Every network telemetry and diagnostics-upload permission is off by default. Each control is independent, and disabling it prevents future collection by that path."
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
          description="Sends scrubbed errors, stack traces, app version, platform, and architecture to the configured Sentry destination. The scrubber removes payload- and credential-keyed fields, redacts local paths, and filters common labeled or token-shaped secrets from free-form errors."
          control={
            <div className="flex items-center gap-2">
              {statusBadge(status.crashReports)}
              <Switch
                checked={settings.crashReportsEnabled}
                disabled={crashReportsOperation?.status === "pending"}
                aria-label="Crash reports"
                onCheckedChange={(enabled) => {
                  void setCrashReportsEnabled(enabled);
                }}
              />
            </div>
          }
        >
          <OperationFeedback operation={crashReportsOperation} />
        </SettingsRow>
        <SettingsRow
          title="Anonymous product analytics"
          description="Sends fixed event names, safe counts, app version, platform, and feature states to the configured PostHog destination. It excludes prompts, responses, file contents, paths, commands, credentials, email, usernames, and machine names."
          control={
            <div className="flex items-center gap-2">
              {statusBadge(status.productAnalytics)}
              <Switch
                checked={settings.productAnalyticsEnabled}
                disabled={productAnalyticsOperation?.status === "pending"}
                aria-label="Anonymous product analytics"
                onCheckedChange={(enabled) => {
                  void setProductAnalyticsEnabled(enabled);
                }}
              />
            </div>
          }
        >
          <OperationFeedback operation={productAnalyticsOperation} />
        </SettingsRow>
        <SettingsRow
          title="AI trace diagnostics"
          description="Sends model, provider, turn/tool timing, token counts, and status metadata to the configured Langfuse/OpenTelemetry destination. Content stays excluded unless full-payload traces are separately enabled. Changes apply when each workspace server next starts."
          control={
            <div className="flex items-center gap-2">
              {statusBadge(status.aiTraces)}
              <Switch
                checked={settings.aiTraceTelemetryEnabled}
                disabled={aiTracesOperation?.status === "pending"}
                aria-label="AI trace diagnostics"
                onCheckedChange={(enabled) => {
                  void setAiTraceTelemetryEnabled(enabled);
                }}
              />
            </div>
          }
        >
          <OperationFeedback operation={aiTracesOperation} />
        </SettingsRow>
        <SettingsRow
          title="Include prompts and responses in AI traces"
          description="Off by default. Full payloads can include system prompts, messages, responses, tool inputs and outputs, commands, logs, and file paths or names. Secret-keyed option fields are redacted, but credentials typed into messages or returned content may still be included."
          control={
            settings.aiTracePayloadsEnabled ? (
              <Switch
                checked
                disabled={aiTracePayloadsOperation?.status === "pending"}
                aria-label="Include prompts and responses in AI traces"
                onCheckedChange={(enabled) => {
                  if (!enabled) {
                    void setAiTracePayloadsEnabled(false);
                  }
                }}
              />
            ) : (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Switch
                    checked={false}
                    disabled={
                      !settings.aiTraceTelemetryEnabled ||
                      aiTracePayloadsOperation?.status === "pending"
                    }
                    aria-label="Include prompts and responses in AI traces"
                  />
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Enable full-payload AI traces?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Future AI calls may send prompts, responses, tool inputs and outputs,
                      commands, logs, and file paths or names to the configured
                      Langfuse/OpenTelemetry destination. Secret-keyed option fields are redacted,
                      but credentials inside message or response content may still be sent. The
                      destination owner controls retention; disabling this later stops future
                      full-payload capture after each workspace server restarts, but does not delete
                      data already received.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep metadata only</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => {
                        void setAiTracePayloadsEnabled(true);
                      }}
                    >
                      Enable full payloads
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )
          }
        >
          <OperationFeedback operation={aiTracePayloadsOperation} />
        </SettingsRow>
        <SettingsRow
          title="Diagnostics upload"
          description="Allows a separately confirmed upload of a locally created, redacted diagnostics bundle to the configured support endpoint. Turning this on never creates or uploads a bundle by itself. Local bundles remain on this device until you delete them; the endpoint owner controls uploaded retention."
          control={
            <div className="flex items-center gap-2">
              {statusBadge(status.diagnosticsUpload)}
              <Switch
                checked={settings.diagnosticsUploadEnabled}
                disabled={diagnosticsUploadOperation?.status === "pending"}
                aria-label="Diagnostics upload"
                onCheckedChange={(enabled) => {
                  void setDiagnosticsUploadEnabled(enabled);
                }}
              />
            </div>
          }
        >
          <OperationFeedback operation={diagnosticsUploadOperation} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Retention and control"
        description="These settings stop future collection; they do not remotely erase data already sent."
      >
        <SettingsRow
          title="External retention"
          description="Sentry, PostHog, Langfuse/OpenTelemetry, and support-upload retention is controlled by the configured destination owner. Cowork does not receive a remote deletion receipt when you turn a setting off."
        />
        <SettingsRow
          title="Global network kill switch"
          description="COWORK_DISABLE_NETWORK_TELEMETRY disables crash reports, product analytics, AI traces, diagnostics uploads, and cloud sync in every process. Local logs and local diagnostics bundle creation remain available."
        />
      </SettingsSection>
    </SettingsPage>
  );
}
