import { useMemo, useState } from "react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";

function previewSummary(preview: NonNullable<ReturnType<typeof useAppStore.getState>["workspaceRuntimeById"][string]["selectedPluginPreview"]>) {
  const validCount = preview.candidates.filter((candidate) => candidate.diagnostics.length === 0).length;
  if (validCount === 0) {
    return "No valid plugins found";
  }
  return validCount === 1 ? "1 plugin ready" : `${validCount} plugins ready`;
}

export function InstallPluginDialog({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [sourceInput, setSourceInput] = useState("");

  const runtime = useAppStore((state) => state.workspaceRuntimeById[workspaceId]);
  const previewPluginInstall = useAppStore((state) => state.previewPluginInstall);
  const installPlugins = useAppStore((state) => state.installPlugins);

  const pluginPreview = runtime?.selectedPluginPreview ?? null;
  const pluginInstallInFlight = Object.keys(runtime?.skillMutationPendingKeys ?? {}).some((key) => key.startsWith("plugin:install:"));
  const pluginPreviewPending = runtime?.skillMutationPendingKeys["plugin:preview"] === true;

  const validPreviewCandidates = useMemo(
    () => pluginPreview?.candidates.filter((candidate) => candidate.diagnostics.length === 0) ?? [],
    [pluginPreview],
  );

  const handlePreview = async (targetScope: "workspace" | "user") => {
    if (!sourceInput.trim()) return;
    await previewPluginInstall(sourceInput, targetScope);
  };

  const handleInstall = async (targetScope: "workspace" | "user") => {
    if (!sourceInput.trim()) return;
    try {
      await installPlugins(sourceInput, targetScope);
      setOpen(false);
      setSourceInput("");
    } catch {
      // Control-session and mutation errors are surfaced via runtime state.
    }
  };

  return (
    <>
      <Button size="sm" className="rounded-full px-4" type="button" onClick={() => setOpen(true)}>
        + New plugin
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Install plugin from source</DialogTitle>
            <DialogDescription>
              Paste a GitHub URL, `owner/repo`, or local path containing a Codex plugin bundle.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Textarea
              className="min-h-24 w-full"
              placeholder="https://github.com/example/codex-plugin-repo"
              value={sourceInput}
              onChange={(event) => setSourceInput(event.target.value)}
            />
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void handlePreview("workspace")} type="button">
                  Preview in Workspace
                </Button>
                <Button variant="outline" size="sm" onClick={() => void handlePreview("user")} type="button">
                  Preview in Global
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={pluginInstallInFlight}
                  onClick={() => void handleInstall("workspace")}
                  type="button"
                >
                  Install to Workspace
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pluginInstallInFlight}
                  onClick={() => void handleInstall("user")}
                  type="button"
                >
                  Install to Global
                </Button>
              </div>
            </div>

            {pluginPreviewPending ? (
              <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Previewing plugin bundle…
              </div>
            ) : null}

            {pluginPreview ? (
              <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">{previewSummary(pluginPreview)}</div>
                <div className="mt-2 space-y-1.5">
                  {pluginPreview.candidates.map((candidate) => (
                    <div key={`${candidate.pluginId}:${candidate.relativeRootPath}`} className="rounded border border-border/60 bg-background/40 px-2.5 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">{candidate.displayName}</div>
                          <div className="truncate text-[11px] text-muted-foreground">{candidate.pluginId}</div>
                        </div>
                        <div className="shrink-0 text-[11px] text-muted-foreground">
                          {candidate.conflictsWithScope === "workspace"
                            ? "Workspace"
                            : candidate.conflictsWithScope === "user"
                              ? "Global"
                              : candidate.wouldBePrimary
                                ? "Primary"
                                : "Shadowed"}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">{candidate.description}</div>
                      {candidate.diagnostics.length > 0 ? (
                        <div className="mt-2 space-y-1 text-[11px] text-destructive">
                          {candidate.diagnostics.map((diagnostic) => (
                            <div key={`${candidate.pluginId}:${diagnostic.code}`}>{diagnostic.message}</div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                {pluginPreview.warnings.length > 0 ? (
                  <div className="mt-2 space-y-1 text-[11px] text-destructive">
                    {pluginPreview.warnings.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {runtime?.skillMutationError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {runtime.skillMutationError}
              </div>
            ) : null}
            {runtime?.pluginsError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {runtime.pluginsError}
              </div>
            ) : null}
            {pluginPreview && validPreviewCandidates.length === 0 ? (
              <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                Fix the preview issues before installing this plugin source.
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
