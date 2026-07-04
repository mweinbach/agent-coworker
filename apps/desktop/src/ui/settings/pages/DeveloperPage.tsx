import {
  ArchiveIcon,
  CheckCircle2Icon,
  CopyIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UploadCloudIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { resolveWorkspaceDisplayTargets } from "../../../app/workspaceDisplayTargets";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Spinner } from "../../../components/ui/spinner";
import { Switch } from "../../../components/ui/switch";
import type { CreateDiagnosticsBundleOutput } from "../../../lib/desktopApi";
import {
  confirmAction,
  copyText,
  createDiagnosticsBundle,
  openLogsFolder,
  revealDiagnosticsBundle,
  uploadDiagnosticsBundle,
} from "../../../lib/desktopCommands";
import {
  DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS,
  type LibreOfficeRuntimeDiagnostic,
} from "../../../lib/wsProtocol";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatusPill,
} from "../SettingsPrimitives";

function parseOverflowThresholdDraft(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function libreOfficeStatusPill(status: LibreOfficeRuntimeDiagnostic | null): {
  label: string;
  tone: "neutral" | "success" | "danger";
} {
  if (!status) return { label: "Not checked", tone: "neutral" };
  if (status.status === "available") return { label: "Available", tone: "success" };
  return { label: "Unavailable", tone: "danger" };
}

function smokeSummary(status: LibreOfficeRuntimeDiagnostic | null): string {
  if (!status?.smoke) return "Not run";
  if (!status.smoke.ok) return status.smoke.error ?? "Failed";
  const size = status.smoke.sizeBytes ? `${status.smoke.sizeBytes.toLocaleString()} bytes` : "PDF";
  return `${size} in ${status.smoke.durationMs.toLocaleString()}ms`;
}

export function DeveloperPage() {
  const privacyTelemetrySettings = useAppStore((s) => s.privacyTelemetrySettings);
  const desktopFeatures = useAppStore((s) => s.desktopFeatureFlags);
  const workspacePickerEnabled = desktopFeatures.workspacePicker !== false;
  const developerMode = useAppStore((s) => s.developerMode);
  const setDeveloperMode = useAppStore((s) => s.setDeveloperMode);
  const startOnboarding = useAppStore((s) => s.startOnboarding);

  const showHiddenFiles = useAppStore((s) => s.showHiddenFiles);
  const setShowHiddenFiles = useAppStore((s) => s.setShowHiddenFiles);
  const workspaces = useAppStore((s) => s.workspaces);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const checkLibreOfficeRuntime = useAppStore((s) => s.checkLibreOfficeRuntime);
  const [libreOfficeStatus, setLibreOfficeStatus] = useState<LibreOfficeRuntimeDiagnostic | null>(
    null,
  );
  const [libreOfficeChecking, setLibreOfficeChecking] = useState(false);
  const [diagnosticsBundle, setDiagnosticsBundle] = useState<CreateDiagnosticsBundleOutput | null>(
    null,
  );
  const [diagnosticsBusy, setDiagnosticsBusy] = useState<
    "create" | "upload" | "openLogs" | "copy" | null
  >(null);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);

  const { targets: workspaceTargets, activeTarget: activeWorkspaceTarget } = useMemo(
    () => resolveWorkspaceDisplayTargets(workspaces, selectedWorkspaceId),
    [selectedWorkspaceId, workspaces],
  );
  const workspace = useMemo(
    () =>
      activeWorkspaceTarget
        ? (workspaces.find((entry) => entry.id === activeWorkspaceTarget.workspaceId) ?? null)
        : null,
    [activeWorkspaceTarget, workspaces],
  );
  const workspaceRuntime = useMemo(
    () => (workspace ? (workspaceRuntimeById[workspace.id] ?? null) : null),
    [workspace, workspaceRuntimeById],
  );
  const inheritedOverflowThreshold =
    workspaceRuntime?.controlSessionConfig?.toolOutputOverflowChars;
  const overflowUsesInheritedDefault = workspace?.defaultToolOutputOverflowChars === undefined;
  const effectiveOverflowThreshold =
    workspace?.defaultToolOutputOverflowChars !== undefined
      ? workspace.defaultToolOutputOverflowChars
      : inheritedOverflowThreshold;
  const nextEnabledOverflowThreshold =
    typeof inheritedOverflowThreshold === "number"
      ? inheritedOverflowThreshold
      : DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS;
  const persistedOverflowThreshold =
    typeof effectiveOverflowThreshold === "number"
      ? effectiveOverflowThreshold
      : nextEnabledOverflowThreshold;
  const overflowEnabled = workspace ? effectiveOverflowThreshold !== null : false;
  const [overflowThresholdDraft, setOverflowThresholdDraft] = useState(
    String(persistedOverflowThreshold),
  );

  useEffect(() => {
    setOverflowThresholdDraft(String(persistedOverflowThreshold));
  }, [persistedOverflowThreshold]);

  const enableOverflowWithDefault = () => {
    if (!workspace) return;
    setOverflowThresholdDraft(String(nextEnabledOverflowThreshold));
    void updateWorkspaceDefaults(
      workspace.id,
      inheritedOverflowThreshold === null
        ? { defaultToolOutputOverflowChars: DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS }
        : { clearDefaultToolOutputOverflowChars: true },
    );
  };
  const handleWorkspaceTargetChange = (targetId: string) => {
    const target = workspaceTargets.find((entry) => entry.id === targetId);
    if (!target) return;
    void selectWorkspace(target.workspaceId);
  };

  const parsedOverflowThreshold = parseOverflowThresholdDraft(overflowThresholdDraft);
  const overflowThresholdError =
    overflowEnabled && parsedOverflowThreshold === null ? "Use a non-negative whole number." : null;
  const overflowThresholdDirty =
    overflowEnabled &&
    parsedOverflowThreshold !== null &&
    parsedOverflowThreshold !== persistedOverflowThreshold;
  const libreOfficePill = libreOfficeStatusPill(libreOfficeStatus);
  const libreOfficeHealthy = libreOfficeStatus?.status === "available";

  const runLibreOfficeCheck = async () => {
    setLibreOfficeChecking(true);
    try {
      const status = await checkLibreOfficeRuntime({ smoke: true });
      if (status) setLibreOfficeStatus(status);
    } finally {
      setLibreOfficeChecking(false);
    }
  };

  const createBundle = async () => {
    setDiagnosticsBusy("create");
    setDiagnosticsStatus(null);
    try {
      const bundle = await createDiagnosticsBundle();
      setDiagnosticsBundle(bundle);
      setDiagnosticsStatus("Diagnostics bundle created.");
      await revealDiagnosticsBundle({ path: bundle.path }).catch(() => {});
    } catch (error) {
      setDiagnosticsStatus(
        error instanceof Error ? error.message : "Unable to create diagnostics bundle.",
      );
    } finally {
      setDiagnosticsBusy(null);
    }
  };

  const copyDiagnosticSummary = async () => {
    if (!diagnosticsBundle) return;
    setDiagnosticsBusy("copy");
    try {
      await copyText(diagnosticsBundle.summary);
      setDiagnosticsStatus("Diagnostic summary copied.");
    } catch (error) {
      setDiagnosticsStatus(
        error instanceof Error ? error.message : "Unable to copy diagnostic summary.",
      );
    } finally {
      setDiagnosticsBusy(null);
    }
  };

  const uploadBundle = async () => {
    if (!diagnosticsBundle) return;
    if (!privacyTelemetrySettings.diagnosticsUploadEnabled) {
      setDiagnosticsStatus("Diagnostic log uploads are disabled.");
      return;
    }

    const confirmed = await confirmAction({
      title: "Upload diagnostics bundle?",
      message: "Upload the redacted diagnostics bundle to the configured support endpoint.",
      detail:
        "The bundle is generated locally and excludes transcripts, prompts, completions, file contents, shell output, workspace paths, and credentials.",
      kind: "warning",
      confirmLabel: "Upload",
      cancelLabel: "Cancel",
      defaultAction: "cancel",
    });
    if (!confirmed) {
      setDiagnosticsStatus("Diagnostics upload canceled.");
      return;
    }

    setDiagnosticsBusy("upload");
    try {
      const result = await uploadDiagnosticsBundle({
        path: diagnosticsBundle.path,
        confirmed: true,
      });
      const copyValue = result.url ?? result.diagnosticId;
      if (copyValue) {
        await copyText(copyValue);
      }
      setDiagnosticsStatus(
        copyValue ? `Diagnostics uploaded. ${result.url ? "URL" : "ID"} copied.` : result.message,
      );
    } catch (error) {
      setDiagnosticsStatus(error instanceof Error ? error.message : "Diagnostics upload failed.");
    } finally {
      setDiagnosticsBusy(null);
    }
  };

  return (
    <SettingsPage>
      <SettingsSection
        title="Diagnostics Bundle"
        description="Local logs and redacted technical metadata."
        action={
          <SettingsStatusPill
            tone={privacyTelemetrySettings.diagnosticsUploadEnabled ? "success" : "neutral"}
          >
            Uploads {privacyTelemetrySettings.diagnosticsUploadEnabled ? "allowed" : "off"}
          </SettingsStatusPill>
        }
      >
        <SettingsRow
          title="Bundle actions"
          description="Create a redacted bundle, open local logs, or copy the summary."
        >
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={diagnosticsBusy !== null}
              onClick={() => void createBundle()}
            >
              {diagnosticsBusy === "create" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ArchiveIcon data-icon="inline-start" />
              )}
              Create Diagnostics Bundle
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={diagnosticsBusy !== null}
              onClick={() => {
                setDiagnosticsBusy("openLogs");
                void openLogsFolder()
                  .then(() => setDiagnosticsStatus("Logs folder opened."))
                  .catch((error: unknown) =>
                    setDiagnosticsStatus(
                      error instanceof Error ? error.message : "Unable to open logs folder.",
                    ),
                  )
                  .finally(() => setDiagnosticsBusy(null));
              }}
            >
              {diagnosticsBusy === "openLogs" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FolderOpenIcon data-icon="inline-start" />
              )}
              Open Logs Folder
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!diagnosticsBundle || diagnosticsBusy !== null}
              onClick={() => void copyDiagnosticSummary()}
            >
              {diagnosticsBusy === "copy" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              Copy Diagnostic Summary
            </Button>
            {diagnosticsBundle?.uploadConfigured ? (
              <Button
                type="button"
                variant="outline"
                disabled={!diagnosticsBundle || diagnosticsBusy !== null}
                onClick={() => void uploadBundle()}
              >
                {diagnosticsBusy === "upload" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <UploadCloudIcon data-icon="inline-start" />
                )}
                Upload Bundle
              </Button>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Last bundle"
          description={
            <span className="break-all">{diagnosticsBundle?.path ?? "No bundle created yet."}</span>
          }
          meta={diagnosticsStatus}
        />
      </SettingsSection>

      <SettingsSection
        title="File Explorer"
        description="Configure how files are displayed in the workspace."
      >
        <SettingsRow
          title="Show hidden files"
          description="Display dotfiles and other hidden system files."
          control={
            <Switch
              checked={showHiddenFiles}
              aria-label="Show hidden files"
              onCheckedChange={setShowHiddenFiles}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="System & Debugging"
        description="Internal visibility and event tracking."
      >
        <SettingsRow
          title="Developer mode"
          description="Show internal system notices in the chat feed."
          control={
            <Switch
              checked={developerMode}
              aria-label="Enable developer mode"
              onCheckedChange={setDeveloperMode}
            />
          }
        />
        <SettingsRow
          title="Onboarding"
          description="Re-run the first-time setup walkthrough."
          control={
            <Button
              type="button"
              variant="outline"
              aria-label="Run onboarding again"
              onClick={async () => {
                const confirmed = await confirmAction({
                  title: "Run onboarding again",
                  message: "Restart the first-time setup walkthrough?",
                  detail: "Your workspaces and settings will be kept.",
                  confirmLabel: "Run onboarding",
                  cancelLabel: "Cancel",
                  kind: "info",
                  defaultAction: "cancel",
                });
                if (confirmed) startOnboarding();
              }}
            >
              Run onboarding again
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="LibreOffice"
        description="Managed headless document-rendering runtime."
        action={
          <>
            <SettingsStatusPill tone={libreOfficePill.tone}>
              {libreOfficeHealthy ? (
                <CheckCircle2Icon aria-hidden="true" className="size-3" />
              ) : libreOfficeStatus ? (
                <TriangleAlertIcon aria-hidden="true" className="size-3" />
              ) : null}
              {libreOfficePill.label}
            </SettingsStatusPill>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={libreOfficeChecking || !workspace}
              onClick={() => void runLibreOfficeCheck()}
            >
              {libreOfficeChecking ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              Check managed runtime
            </Button>
          </>
        }
      >
        <SettingsRow
          title="Resolved executable"
          description={
            <span className="break-all">{libreOfficeStatus?.resolvedPath ?? "Not checked"}</span>
          }
        />
        <SettingsRow
          title="Version"
          control={
            <span className="text-sm text-foreground">
              {libreOfficeStatus?.version ?? "Not checked"}
            </span>
          }
        />
        <SettingsRow
          title="PDF smoke test"
          description={<span className="break-words">{smokeSummary(libreOfficeStatus)}</span>}
          meta={libreOfficeStatus ? libreOfficeStatus.message : null}
        />
      </SettingsSection>

      <SettingsSection
        title="Large Tool Output Handling"
        description="Save very large tool output to scratch files instead of keeping all of it inline."
      >
        {!workspace ? (
          <SettingsRow
            title="No workspace available"
            description="Add a workspace to configure large tool output handling."
          />
        ) : (
          <>
            {workspacePickerEnabled && workspaceTargets.length > 1 && activeWorkspaceTarget ? (
              <SettingsRow
                title="Workspace"
                description={activeWorkspaceTarget.targetPath ?? workspace.path}
                control={
                  <Select
                    value={activeWorkspaceTarget.id}
                    onValueChange={handleWorkspaceTargetChange}
                  >
                    <SelectTrigger aria-label="Developer workspace" className="min-w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {workspaceTargets.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              />
            ) : (
              <SettingsRow
                title={activeWorkspaceTarget?.label ?? workspace.name}
                description={activeWorkspaceTarget?.targetPath ?? workspace.path}
              />
            )}

            <SettingsRow
              title="Save oversized tool output to scratch files"
              description="When enabled, oversized text or JSON-like tool results are saved to disk instead of filling up the chat history. Cowork keeps a fixed inline preview."
              control={
                <Switch
                  checked={overflowEnabled}
                  aria-label="Save oversized tool output to scratch files"
                  onCheckedChange={(checked) => {
                    if (checked) {
                      enableOverflowWithDefault();
                      return;
                    }
                    setOverflowThresholdDraft(String(persistedOverflowThreshold));
                    void updateWorkspaceDefaults(workspace.id, {
                      defaultToolOutputOverflowChars: null,
                    });
                  }}
                />
              }
            />

            <SettingsRow
              title="Spill after this many characters"
              description={
                <>
                  Once a result spills, Cowork keeps the first 5,000 characters inline and saves the
                  rest to <code>{workspace.path}/.ModelScratchpad</code>. Default:{" "}
                  {DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS.toLocaleString()} characters.
                </>
              }
            >
              <div className="max-w-md space-y-2">
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label="Spill after this many characters"
                  value={overflowThresholdDraft}
                  disabled={!overflowEnabled}
                  onChange={(event) => setOverflowThresholdDraft(event.target.value)}
                />
                {overflowThresholdError ? (
                  <div className="text-xs text-destructive">{overflowThresholdError}</div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Set the threshold to <code>0</code> to spill immediately while still keeping the
                    preview.
                  </div>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    disabled={!overflowThresholdDirty || !!overflowThresholdError}
                    onClick={() => {
                      if (parsedOverflowThreshold === null) return;
                      setOverflowThresholdDraft(String(parsedOverflowThreshold));
                      void updateWorkspaceDefaults(workspace.id, {
                        defaultToolOutputOverflowChars: parsedOverflowThreshold,
                      });
                    }}
                  >
                    Save threshold
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={overflowEnabled && overflowUsesInheritedDefault}
                    onClick={() => {
                      if (overflowEnabled) {
                        setOverflowThresholdDraft(String(nextEnabledOverflowThreshold));
                        void updateWorkspaceDefaults(workspace.id, {
                          clearDefaultToolOutputOverflowChars: true,
                        });
                        return;
                      }
                      enableOverflowWithDefault();
                    }}
                  >
                    {overflowEnabled ? "Inherit default" : "Enable default"}
                  </Button>
                </div>
              </div>
            </SettingsRow>
          </>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
