import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import { DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS } from "../../../lib/wsProtocol";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";

function toBoolean(checked: boolean | "indeterminate"): boolean {
  return checked === true;
}

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

  const showHiddenFiles = useAppStore((s) => s.showHiddenFiles);
  const setShowHiddenFiles = useAppStore((s) => s.setShowHiddenFiles);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const persistedOverflowThreshold = workspace?.defaultToolOutputOverflowChars ?? DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS;
  const overflowUsesInheritedDefault = workspace?.defaultToolOutputOverflowChars === undefined;
  const overflowEnabled = workspace ? workspace.defaultToolOutputOverflowChars !== null : false;
  const [overflowThresholdDraft, setOverflowThresholdDraft] = useState(String(persistedOverflowThreshold));

  useEffect(() => {
    setOverflowThresholdDraft(String(workspace?.defaultToolOutputOverflowChars ?? DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS));
  }, [workspace?.id, workspace?.defaultToolOutputOverflowChars]);

  const parsedOverflowThreshold = parseOverflowThresholdDraft(overflowThresholdDraft);
  const overflowThresholdError =
    overflowEnabled && parsedOverflowThreshold === null ? "Use a non-negative whole number." : null;
  const overflowThresholdDirty =
    overflowEnabled &&
    parsedOverflowThreshold !== null &&
    parsedOverflowThreshold !== persistedOverflowThreshold;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Developer</h1>
        <p className="text-sm text-muted-foreground">Advanced settings and debugging tools.</p>
      </div>

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
            <Checkbox
              checked={showHiddenFiles}
              aria-label="Show hidden files"
              onCheckedChange={(checked) => setShowHiddenFiles(toBoolean(checked))}
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
            <Checkbox
              checked={developerMode}
              aria-label="Enable developer mode"
              onCheckedChange={(checked) => setDeveloperMode(toBoolean(checked))}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Workspace Tool Output Spill Files</CardTitle>
          <CardDescription>
            Advanced workspace default for spilling oversized text tool results into <code>.ModelScratchpad</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!workspace ? (
            <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
              Add a workspace to configure tool output overflow spill files.
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
                  <div className="text-sm font-medium">Enable spill files</div>
                  <div className="text-xs text-muted-foreground">
                    When enabled, oversized text or JSON-like tool results are saved into workspace-local scratch files
                    after the threshold is crossed. Cowork keeps a fixed inline preview and writes the full result to disk.
                  </div>
                </div>
                <Checkbox
                  checked={overflowEnabled}
                  aria-label="Enable tool output overflow spill files"
                  onCheckedChange={(checked) => {
                    const nextEnabled = toBoolean(checked);
                    setOverflowThresholdDraft(String(workspace.defaultToolOutputOverflowChars ?? DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS));
                    void updateWorkspaceDefaults(
                      workspace.id,
                      nextEnabled
                        ? { clearDefaultToolOutputOverflowChars: true }
                        : { defaultToolOutputOverflowChars: null },
                    );
                  }}
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">Character threshold</div>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label="Tool output overflow character threshold"
                  value={overflowThresholdDraft}
                  disabled={!overflowEnabled}
                  onChange={(event) => setOverflowThresholdDraft(event.target.value)}
                />
                <div className="text-xs text-muted-foreground">
                  Threshold is measured against the serialized tool result that would otherwise be sent back into model
                  context. Once a result spills, Cowork still keeps the first 5,000 characters inline and saves the
                  rest. Default trigger: {DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS.toLocaleString()} characters.
                </div>
                {overflowThresholdError ? (
                  <div className="text-xs text-destructive">{overflowThresholdError}</div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Spill files are written as UTF-8 text into <code>{workspace.path}/.ModelScratchpad</code>. Set the
                    threshold to <code>0</code> to spill immediately while still keeping that 5,000-character preview.
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
                    setOverflowThresholdDraft(String(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS));
                    void updateWorkspaceDefaults(workspace.id, {
                      clearDefaultToolOutputOverflowChars: true,
                    });
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
