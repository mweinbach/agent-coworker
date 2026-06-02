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
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
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

function parseOverflowThresholdDraft(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function libreOfficeBadge(status: LibreOfficeRuntimeDiagnostic | null): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  if (!status) return { label: "Not checked", variant: "secondary" };
  if (status.status === "available") return { label: "Available", variant: "default" };
  if (status.status === "disabled") return { label: "Disabled", variant: "outline" };
  return { label: "Unavailable", variant: "destructive" };
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
  const libreOfficeState = libreOfficeBadge(libreOfficeStatus);
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
    <div className="space-y-5">
      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <div className="flex items-start justify-between gap-3 max-[720px]:flex-col">
            <div>
              <CardTitle>Diagnostics Bundle</CardTitle>
              <CardDescription>Local logs and redacted technical metadata.</CardDescription>
            </div>
            <Badge
              variant={privacyTelemetrySettings.diagnosticsUploadEnabled ? "secondary" : "outline"}
            >
              Uploads {privacyTelemetrySettings.diagnosticsUploadEnabled ? "allowed" : "off"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
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

          <div className="rounded-xl border border-border/70 bg-muted/15 p-4 text-xs">
            <div className="font-medium text-foreground">Last bundle</div>
            <div className="mt-1 break-all text-muted-foreground">
              {diagnosticsBundle?.path ?? "No bundle created yet."}
            </div>
            {diagnosticsStatus ? (
              <div className="mt-2 text-muted-foreground">{diagnosticsStatus}</div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>File Explorer</CardTitle>
          <CardDescription>Configure how files are displayed in the workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
            <div>
              <div className="text-sm font-medium">Show hidden files</div>
              <div className="text-xs text-muted-foreground">
                Display dotfiles and other hidden system files.
              </div>
            </div>
            <Switch
              checked={showHiddenFiles}
              aria-label="Show hidden files"
              onCheckedChange={setShowHiddenFiles}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>System & Debugging</CardTitle>
          <CardDescription>Internal visibility and event tracking.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
            <div>
              <div className="text-sm font-medium">Developer mode</div>
              <div className="text-xs text-muted-foreground">
                Show internal system notices in the chat feed.
              </div>
            </div>
            <Switch
              checked={developerMode}
              aria-label="Enable developer mode"
              onCheckedChange={setDeveloperMode}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <div className="flex items-start justify-between gap-3 max-[720px]:flex-col">
            <div>
              <CardTitle>LibreOffice Runtime</CardTitle>
              <CardDescription>Managed document conversion health.</CardDescription>
            </div>
            <Badge variant={libreOfficeState.variant}>
              {libreOfficeHealthy ? (
                <CheckCircle2Icon aria-hidden="true" />
              ) : libreOfficeStatus ? (
                <TriangleAlertIcon aria-hidden="true" />
              ) : null}
              {libreOfficeState.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 text-xs text-muted-foreground md:grid-cols-2">
            <div>
              <div className="text-sm font-medium text-foreground">Shim</div>
              <div className="break-all">{libreOfficeStatus?.shimPath ?? "Not checked"}</div>
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">Resolved executable</div>
              <div className="break-all">{libreOfficeStatus?.resolvedPath ?? "Not checked"}</div>
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">Version</div>
              <div>{libreOfficeStatus?.version ?? "Not checked"}</div>
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">PDF smoke test</div>
              <div className="break-words">{smokeSummary(libreOfficeStatus)}</div>
            </div>
          </div>
          {libreOfficeStatus ? (
            <div className="text-xs text-muted-foreground">{libreOfficeStatus.message}</div>
          ) : null}
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={libreOfficeChecking || !workspace}
              onClick={() => void runLibreOfficeCheck()}
            >
              {libreOfficeChecking ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              Check runtime
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Onboarding</CardTitle>
          <CardDescription>Re-run the first-time setup walkthrough.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            aria-label="Run onboarding again"
            onClick={() => startOnboarding()}
          >
            Run onboarding again
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Large Tool Output Handling</CardTitle>
          <CardDescription>
            Save very large tool output to scratch files instead of keeping all of it inline.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!workspace ? (
            <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
              Add a workspace to configure large tool output handling.
            </div>
          ) : (
            <>
              {workspacePickerEnabled && workspaceTargets.length > 1 && activeWorkspaceTarget ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Workspace</div>
                  <Select
                    value={activeWorkspaceTarget.id}
                    onValueChange={handleWorkspaceTargetChange}
                  >
                    <SelectTrigger aria-label="Developer workspace">
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
                </div>
              ) : null}

              <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                <div className="text-sm font-medium text-foreground">
                  {activeWorkspaceTarget?.label ?? workspace.name}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {activeWorkspaceTarget?.targetPath ?? workspace.path}
                </div>
              </div>

              <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                <div>
                  <div className="text-sm font-medium">
                    Save oversized tool output to scratch files
                  </div>
                  <div className="text-xs text-muted-foreground">
                    When enabled, oversized text or JSON-like tool results are saved to disk instead
                    of filling up the chat history. Cowork keeps a fixed inline preview.
                  </div>
                </div>
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
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">
                  Spill after this many characters
                </div>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label="Spill after this many characters"
                  value={overflowThresholdDraft}
                  disabled={!overflowEnabled}
                  onChange={(event) => setOverflowThresholdDraft(event.target.value)}
                />
                <div className="text-xs text-muted-foreground">
                  Once a result spills, Cowork keeps the first 5,000 characters inline and saves the
                  rest to <code>{workspace.path}/.ModelScratchpad</code>. Default:{" "}
                  {DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS.toLocaleString()} characters.
                </div>
                {overflowThresholdError ? (
                  <div className="text-xs text-destructive">{overflowThresholdError}</div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Set the threshold to <code>0</code> to spill immediately while still keeping the
                    preview.
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
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
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
