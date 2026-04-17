import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS } from "../../../lib/wsProtocol";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";

function parseOverflowThresholdDraft(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function DeveloperPage() {
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

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const workspaceRuntime = useMemo(
    () => (workspace ? workspaceRuntimeById[workspace.id] ?? null : null),
    [workspace?.id, workspaceRuntimeById],
  );
  const inheritedOverflowThreshold = workspaceRuntime?.controlSessionConfig?.toolOutputOverflowChars;
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
  const [overflowThresholdDraft, setOverflowThresholdDraft] = useState(String(persistedOverflowThreshold));

  useEffect(() => {
    setOverflowThresholdDraft(String(persistedOverflowThreshold));
  }, [persistedOverflowThreshold, workspace?.id]);

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

  const parsedOverflowThreshold = parseOverflowThresholdDraft(overflowThresholdDraft);
  const overflowThresholdError =
    overflowEnabled && parsedOverflowThreshold === null ? "Use a non-negative whole number." : null;
  const overflowThresholdDirty =
    overflowEnabled &&
    parsedOverflowThreshold !== null &&
    parsedOverflowThreshold !== persistedOverflowThreshold;

  return (
    <div className="space-y-5">
      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>File Explorer</CardTitle>
          <CardDescription>Configure how files are displayed in the workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
            <div>
              <div className="text-sm font-medium">Show hidden files</div>
              <div className="text-xs text-muted-foreground">Display dotfiles and other hidden system files.</div>
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
              <div className="text-xs text-muted-foreground">Show internal system notices in the chat feed.</div>
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
              {workspaces.length > 1 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Workspace</div>
                  <Select value={workspace.id} onValueChange={(value) => void selectWorkspace(value)}>
                    <SelectTrigger aria-label="Developer workspace">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {workspaces.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                <div className="text-sm font-medium text-foreground">{workspace.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">{workspace.path}</div>
              </div>

              <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                <div>
                  <div className="text-sm font-medium">Save oversized tool output to scratch files</div>
                  <div className="text-xs text-muted-foreground">
                    When enabled, oversized text or JSON-like tool results are saved to disk instead of filling up the chat history. Cowork keeps a fixed inline preview.
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
                <div className="text-sm font-medium text-foreground">Spill after this many characters</div>
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
                  Once a result spills, Cowork keeps the first 5,000 characters inline and saves the rest to <code>{workspace.path}/.ModelScratchpad</code>. Default: {DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS.toLocaleString()} characters.
                </div>
                {overflowThresholdError ? (
                  <div className="text-xs text-destructive">{overflowThresholdError}</div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Set the threshold to <code>0</code> to spill immediately while still keeping the preview.
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
