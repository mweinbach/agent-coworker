import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Switch } from "../../../components/ui/switch";
import { SettingsPage, SettingsRow, SettingsSection } from "../SettingsPrimitives";

export function PrivacyTelemetryPage() {
  const settings = useAppStore((s) => s.privacyTelemetrySettings);
  const setCrashReportsEnabled = useAppStore((s) => s.setCrashReportsEnabled);
  const setProductAnalyticsEnabled = useAppStore((s) => s.setProductAnalyticsEnabled);
  const setAiTraceTelemetryEnabled = useAppStore((s) => s.setAiTraceTelemetryEnabled);
  const setAiTracePayloadsEnabled = useAppStore((s) => s.setAiTracePayloadsEnabled);
  const setDiagnosticsUploadEnabled = useAppStore((s) => s.setDiagnosticsUploadEnabled);
  const setCloudSyncEnabled = useAppStore((s) => s.setCloudSyncEnabled);
  const crashReportingConfig = window.cowork?.crashReporting ?? null;
  const crashStatus = !crashReportingConfig?.dsnConfigured
    ? { label: "Not configured", variant: "outline" as const }
    : settings.crashReportsEnabled
      ? { label: "Enabled", variant: "secondary" as const }
      : { label: "Disabled", variant: "outline" as const };

  return (
    <SettingsPage>
      <SettingsSection
        title="Privacy & Telemetry"
        description="Cowork is local-first. These toggles only control optional cloud reporting/sync. Disabling them must prevent network telemetry from starting."
      >
        <SettingsRow
          title="Crash reports"
          description="Sends crash/error reports and basic technical metadata."
          control={
            <div className="flex items-center gap-2">
              <Badge variant={crashStatus.variant}>{crashStatus.label}</Badge>
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
            <Switch
              checked={settings.productAnalyticsEnabled}
              aria-label="Anonymous product analytics"
              onCheckedChange={setProductAnalyticsEnabled}
            />
          }
        />
        <SettingsRow
          title="AI trace diagnostics"
          description="Sends high-level model/turn/tool timing metadata for debugging AI behavior."
          control={
            <Switch
              checked={settings.aiTraceTelemetryEnabled}
              aria-label="AI trace diagnostics"
              onCheckedChange={setAiTraceTelemetryEnabled}
            />
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
        <SettingsRow
          title="Diagnostic log uploads"
          description="Allows user-initiated upload of redacted diagnostic bundles. No automatic upload."
          control={
            <Switch
              checked={settings.diagnosticsUploadEnabled}
              aria-label="Diagnostic log uploads"
              onCheckedChange={setDiagnosticsUploadEnabled}
            />
          }
        />
        <SettingsRow
          title="Cloud sync"
          description="Syncs selected settings/data only when configured and explicitly enabled. No repository contents."
          control={
            <Switch
              checked={settings.cloudSyncEnabled}
              aria-label="Cloud sync"
              onCheckedChange={setCloudSyncEnabled}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  );
}
