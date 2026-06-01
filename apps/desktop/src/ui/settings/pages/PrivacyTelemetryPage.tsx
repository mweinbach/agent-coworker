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
  const crashReportingConfig = window.cowork?.crashReporting ?? null;
  const crashStatus = !crashReportingConfig?.dsnConfigured
    ? { label: "Not configured", variant: "outline" as const }
    : settings.crashReportsEnabled
      ? { label: "Enabled", variant: "secondary" as const }
      : { label: "Disabled", variant: "outline" as const };
  const productAnalyticsConfig = window.cowork?.productAnalytics ?? null;
  const productAnalyticsStatus = !productAnalyticsConfig?.keyConfigured
    ? { label: "Not configured", variant: "outline" as const }
    : settings.productAnalyticsEnabled
      ? { label: "Enabled", variant: "secondary" as const }
      : { label: "Disabled", variant: "outline" as const };

  return (
    <SettingsPage>
      <SettingsSection
        title="Privacy & Telemetry"
        description="Cowork is local-first. These toggles only control optional cloud reporting. Disabling them must prevent network telemetry from starting."
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
            <div className="flex items-center gap-2">
              <Badge variant={productAnalyticsStatus.variant}>{productAnalyticsStatus.label}</Badge>
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
      </SettingsSection>
    </SettingsPage>
  );
}
