import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FolderInputIcon,
  PackageIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";

import { useAppStore } from "../../app/store";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Spinner } from "../../components/ui/spinner";
import { pickDirectory } from "../../lib/desktopCommands";
import { cn } from "../../lib/utils";
import type { ImportableItem, ImportableKind, ImportSource } from "../../lib/wsProtocol";

type ImportTab = ImportSource | "folder";

const SOURCE_LABELS: Record<ImportSource, string> = {
  claude: "Claude",
  codex: "Codex",
};

const TAB_LABELS: Record<ImportTab, string> = {
  claude: "Claude",
  codex: "Codex",
  folder: "Folder",
};

function importKey(source: ImportSource, kind: ImportableKind): string {
  return `${source}:${kind}`;
}

function itemPendingKey(item: ImportableItem, targetScope: "workspace" | "user"): string {
  return `${item.kind}:${item.source}:${item.id}:${targetScope}`;
}

function basename(p: string): string {
  return p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;
}

function SourceToggle({
  tab,
  onSelect,
}: {
  tab: ImportTab;
  onSelect: (next: ImportTab) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-muted/60 p-1">
      {(Object.keys(TAB_LABELS) as ImportTab[]).map((candidate) => {
        const active = tab === candidate;
        return (
          <button
            key={candidate}
            type="button"
            onClick={() => onSelect(candidate)}
            className={cn(
              "rounded-md px-3 py-1 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {TAB_LABELS[candidate]}
          </button>
        );
      })}
    </div>
  );
}

function ImportItemCard({
  item,
  kind,
  globalPending,
  workspacePending,
  onImport,
}: {
  item: ImportableItem;
  kind: ImportableKind;
  globalPending: boolean;
  workspacePending: boolean;
  onImport: (item: ImportableItem, targetScope: "workspace" | "user") => void;
}) {
  const hasDiagnostics = item.diagnostics.length > 0;
  const installedEverywhere = item.alreadyInstalledGlobal && item.alreadyInstalledWorkspace;

  return (
    <div className="rounded-lg border border-border/55 bg-card/40 p-3.5 transition-colors hover:border-border/80 hover:bg-card/65">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted/40 text-muted-foreground">
          {kind === "plugin" ? (
            <PackageIcon className="h-4 w-4" />
          ) : (
            <SparklesIcon className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-sm text-foreground">
              {item.displayName}
            </span>
            {item.version ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">v{item.version}</span>
            ) : null}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{item.id}</div>
        </div>
        {installedEverywhere ? (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            Installed
          </Badge>
        ) : null}
      </div>

      {item.description ? (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {item.description}
        </p>
      ) : null}

      {hasDiagnostics ? (
        <div className="mt-2.5 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
          <AlertTriangleIcon className="mt-0.5 h-3 w-3 shrink-0" />
          <div className="space-y-0.5">
            {item.diagnostics.map((diagnostic) => (
              <div key={`${item.id}:${diagnostic.code}`}>{diagnostic.message}</div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            type="button"
            disabled={item.alreadyInstalledGlobal || globalPending}
            onClick={() => onImport(item, "user")}
          >
            {globalPending ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
            {item.alreadyInstalledGlobal ? "In Global" : "Import to Global"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={item.alreadyInstalledWorkspace || workspacePending}
            onClick={() => onImport(item, "workspace")}
          >
            {workspacePending ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
            {item.alreadyInstalledWorkspace ? "In Workspace" : "Import to Workspace"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Pick a local folder and copy its bundle into Global or Workspace. */
function FolderImportPanel({ kind }: { kind: ImportableKind }) {
  const installSkills = useAppStore((state) => state.installSkills);
  const installPlugins = useAppStore((state) => state.installPlugins);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [busyScope, setBusyScope] = useState<"user" | "workspace" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const noun = kind === "plugin" ? "plugin" : "skill";

  const chooseFolder = async () => {
    setError(null);
    setSuccess(null);
    try {
      const picked = await pickDirectory({ title: `Select a ${noun} folder to import` });
      if (picked) {
        setFolderPath(picked);
      }
    } catch {
      setError("Unable to open the folder picker.");
    }
  };

  const doImport = async (targetScope: "user" | "workspace") => {
    if (!folderPath) return;
    setError(null);
    setSuccess(null);
    setBusyScope(targetScope);
    try {
      if (kind === "skill") {
        await installSkills(folderPath, targetScope === "user" ? "global" : "project");
      } else {
        await installPlugins(folderPath, targetScope);
      }
      setSuccess(`Copied to ${targetScope === "user" ? "Global" : "Workspace"}.`);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : `Unable to import the selected folder. Make sure it contains a ${
              kind === "plugin" ? "plugin bundle" : "SKILL.md"
            }.`,
      );
    } finally {
      setBusyScope(null);
    }
  };

  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        type="button"
        className="w-full justify-center"
        onClick={() => void chooseFolder()}
      >
        <FolderInputIcon className="mr-1.5 h-4 w-4" />
        {folderPath ? "Choose a different folder" : `Choose a ${noun} folder…`}
      </Button>

      {folderPath ? (
        <div className="rounded-lg border border-border/55 bg-card/40 p-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted/40 text-muted-foreground">
              <FolderInputIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-sm text-foreground">
                {basename(folderPath)}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {folderPath}
              </div>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Copies this folder into Cowork — the original is not moved or symlinked.
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              type="button"
              disabled={busyScope !== null}
              onClick={() => void doImport("user")}
            >
              {busyScope === "user" ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
              Import to Global
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={busyScope !== null}
              onClick={() => void doImport("workspace")}
            >
              {busyScope === "workspace" ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
              Import to Workspace
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/10 py-12 text-center">
          <FolderInputIcon className="h-6 w-6 text-muted-foreground/60" />
          <div className="text-xs text-muted-foreground">
            Select a folder that contains a{" "}
            {kind === "plugin" ? "plugin bundle" : <code>SKILL.md</code>}.
          </div>
        </div>
      )}

      {error ? (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {success ? (
        <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-foreground">
          <CheckCircle2Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span>{success}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ImportDialog({
  workspaceId,
  kind,
}: {
  workspaceId: string;
  kind: ImportableKind;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ImportTab>("claude");

  const runtime = useAppStore((state) => state.workspaceRuntimeById[workspaceId]);
  const listImportable = useAppStore((state) => state.listImportable);
  const importPlugin = useAppStore((state) => state.importPlugin);
  const importSkill = useAppStore((state) => state.importSkill);

  const homeSource: ImportSource | null = tab === "folder" ? null : tab;
  const state = homeSource ? (runtime?.importItemsByKey[importKey(homeSource, kind)] ?? null) : null;
  const pendingKeys = runtime?.importPendingKeys ?? {};
  const noun = kind === "plugin" ? "plugin" : "skill";
  const items = state?.items ?? [];

  const selectTab = (next: ImportTab) => {
    setTab(next);
    if (next !== "folder") {
      void listImportable(next, kind);
    }
  };

  const openDialog = () => {
    setOpen(true);
    setTab("claude");
    void listImportable("claude", kind);
  };

  const onImport = (item: ImportableItem, targetScope: "workspace" | "user") => {
    if (kind === "plugin") {
      void importPlugin(item, targetScope);
    } else {
      void importSkill(item, targetScope);
    }
  };

  const isLoading = state === null || state.loading;

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
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]">
          <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
            <DialogTitle>Import {noun}s</DialogTitle>
            <DialogDescription>
              Bring {noun}s from Claude Code (<code>~/.claude</code>), Codex (<code>~/.codex</code>),
              or a local folder into Cowork.
            </DialogDescription>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Import from:</span>
                <SourceToggle tab={tab} onSelect={selectTab} />
              </div>
              {homeSource && !isLoading && state?.homeExists ? (
                <span className="text-xs text-muted-foreground">
                  {items.length} {items.length === 1 ? noun : `${noun}s`}
                </span>
              ) : null}
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {tab === "folder" ? (
              <FolderImportPanel kind={kind} />
            ) : isLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Spinner /> Scanning {SOURCE_LABELS[tab]}…
              </div>
            ) : !state?.homeExists ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/10 py-16 text-center">
                <PackageIcon className="h-6 w-6 text-muted-foreground/60" />
                <div className="text-sm font-medium text-foreground">
                  No {SOURCE_LABELS[tab]} installation found
                </div>
                <div className="text-xs text-muted-foreground">
                  Expected it at <code>~/.{tab}</code>.
                </div>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/10 py-16 text-center">
                {kind === "plugin" ? (
                  <PackageIcon className="h-6 w-6 text-muted-foreground/60" />
                ) : (
                  <SparklesIcon className="h-6 w-6 text-muted-foreground/60" />
                )}
                <div className="text-sm font-medium text-foreground">
                  No importable {noun}s found
                </div>
                <div className="text-xs text-muted-foreground">
                  Nothing to import from {SOURCE_LABELS[tab]}.
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                {state?.error ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {state.error}
                  </div>
                ) : null}
                {items.map((item) => (
                  <ImportItemCard
                    key={`${item.source}:${item.id}`}
                    item={item}
                    kind={kind}
                    globalPending={pendingKeys[itemPendingKey(item, "user")] === true}
                    workspacePending={pendingKeys[itemPendingKey(item, "workspace")] === true}
                    onImport={onImport}
                  />
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
