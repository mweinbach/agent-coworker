import { DownloadIcon } from "lucide-react";
import { useState } from "react";

import { useAppStore } from "../../app/store";
import type { ImportableItem, ImportableKind, ImportSource } from "../../lib/wsProtocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Spinner } from "../../components/ui/spinner";

const SOURCE_LABELS: Record<ImportSource, string> = {
  claude: "Claude",
  codex: "Codex",
};

function importKey(source: ImportSource, kind: ImportableKind): string {
  return `${source}:${kind}`;
}

function itemPendingKey(item: ImportableItem, targetScope: "workspace" | "user"): string {
  return `${item.kind}:${item.source}:${item.id}:${targetScope}`;
}

export function ImportDialog({
  workspaceId,
  kind,
}: {
  workspaceId: string;
  kind: ImportableKind;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<ImportSource>("claude");

  const runtime = useAppStore((state) => state.workspaceRuntimeById[workspaceId]);
  const listImportable = useAppStore((state) => state.listImportable);
  const importPlugin = useAppStore((state) => state.importPlugin);
  const importSkill = useAppStore((state) => state.importSkill);

  const state = runtime?.importItemsByKey[importKey(source, kind)] ?? null;
  const pendingKeys = runtime?.importPendingKeys ?? {};

  const noun = kind === "plugin" ? "plugin" : "skill";

  const selectSource = (next: ImportSource) => {
    setSource(next);
    void listImportable(next, kind);
  };

  const openDialog = () => {
    setOpen(true);
    void listImportable(source, kind);
  };

  const doImport = (item: ImportableItem, targetScope: "workspace" | "user") => {
    if (kind === "plugin") {
      void importPlugin(item, targetScope);
    } else {
      void importSkill(item, targetScope);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="rounded-full px-4"
        type="button"
        onClick={openDialog}
      >
        <DownloadIcon className="mr-1.5 h-4 w-4" />
        Import
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Import {noun}s</DialogTitle>
            <DialogDescription>
              Bring {noun}s you already have in Claude Code (`~/.claude`) or Codex (`~/.codex`) into
              Cowork.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Import from:</span>
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              {(Object.keys(SOURCE_LABELS) as ImportSource[]).map((candidate) => (
                <Button
                  key={candidate}
                  type="button"
                  size="sm"
                  variant={source === candidate ? "secondary" : "ghost"}
                  className="rounded-none"
                  onClick={() => selectSource(candidate)}
                >
                  {SOURCE_LABELS[candidate]}
                </Button>
              ))}
            </div>
          </div>

          <div className="mt-2 min-h-40">
            {state?.loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Spinner /> Scanning {SOURCE_LABELS[source]}…
              </div>
            ) : state && !state.homeExists ? (
              <div className="rounded-md border border-dashed border-border/60 bg-muted/10 py-10 text-center text-sm text-muted-foreground">
                No {SOURCE_LABELS[source]} installation found at{" "}
                <code>~/.{source}</code>.
              </div>
            ) : state && state.items.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/60 bg-muted/10 py-10 text-center text-sm text-muted-foreground">
                No importable {noun}s found in {SOURCE_LABELS[source]}.
              </div>
            ) : (
              <ScrollArea className="max-h-[360px] pr-3">
                <div className="space-y-2">
                  {state?.error ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                      {state.error}
                    </div>
                  ) : null}
                  {(state?.items ?? []).map((item) => {
                    const hasDiagnostics = item.diagnostics.length > 0;
                    const globalPending = pendingKeys[itemPendingKey(item, "user")] === true;
                    const workspacePending =
                      pendingKeys[itemPendingKey(item, "workspace")] === true;
                    return (
                      <div
                        key={`${item.source}:${item.id}`}
                        className="rounded-md border border-border/60 bg-background/40 px-3 py-2.5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium text-foreground">
                                {item.displayName}
                              </span>
                              {item.version ? (
                                <span className="text-[11px] text-muted-foreground">
                                  v{item.version}
                                </span>
                              ) : null}
                            </div>
                            <div className="truncate text-[11px] text-muted-foreground">
                              {item.id}
                            </div>
                          </div>
                          {item.alreadyInstalledGlobal && item.alreadyInstalledWorkspace ? (
                            <Badge variant="outline">Installed</Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                          {item.description}
                        </div>
                        {hasDiagnostics ? (
                          <div className="mt-2 space-y-1 text-[11px] text-destructive">
                            {item.diagnostics.map((diagnostic) => (
                              <div key={`${item.id}:${diagnostic.code}`}>{diagnostic.message}</div>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              type="button"
                              disabled={item.alreadyInstalledGlobal || globalPending}
                              onClick={() => doImport(item, "user")}
                            >
                              {item.alreadyInstalledGlobal ? "In Global" : "Import to Global"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              type="button"
                              disabled={item.alreadyInstalledWorkspace || workspacePending}
                              onClick={() => doImport(item, "workspace")}
                            >
                              {item.alreadyInstalledWorkspace
                                ? "In Workspace"
                                : "Import to Workspace"}
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
