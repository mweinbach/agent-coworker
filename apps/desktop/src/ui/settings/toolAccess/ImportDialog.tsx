import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FolderInputIcon,
  PackageIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";

import { useAppStore } from "../../../app/store";
import { operationKey } from "../../../app/store.helpers";
import { isOneOffChatWorkspace, type OperationState } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Spinner } from "../../../components/ui/spinner";
import { pickDirectory } from "../../../lib/desktopCommands";
import { cn } from "../../../lib/utils";
import type { ImportableItem, ImportableKind, ImportSource } from "../../../lib/wsProtocol";
import { OperationFeedback } from "../../OperationFeedback";
import { SettingsEmptyState } from "../SettingsPrimitives";

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
  return (
    p
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || p
  );
}

function SourceToggle({ tab, onSelect }: { tab: ImportTab; onSelect: (next: ImportTab) => void }) {
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
  workspaceScopeAvailable,
  operation,
  onImport,
}: {
  item: ImportableItem;
  kind: ImportableKind;
  globalPending: boolean;
  workspacePending: boolean;
  workspaceScopeAvailable: boolean;
  operation?: OperationState;
  onImport: (item: ImportableItem, targetScope: "workspace" | "user") => void;
}) {
  const hasDiagnostics = item.diagnostics.length > 0;
  const installedEverywhere = item.alreadyInstalledGlobal && item.alreadyInstalledWorkspace;

  return (
    <div className="py-3.5">
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
          {workspaceScopeAvailable ? (
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
          ) : null}
        </div>
      )}
      <OperationFeedback operation={operation} className="mt-2.5" />
    </div>
  );
}

/** Pick a local folder and copy its bundle into Global or Workspace. */
function FolderImportPanel({
  kind,
  workspaceScopeAvailable,
}: {
  kind: ImportableKind;
  workspaceScopeAvailable: boolean;
}) {
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
      const result =
        kind === "skill"
          ? await installSkills(folderPath, targetScope === "user" ? "global" : "project")
          : await installPlugins(folderPath, targetScope);
      if (result.ok) {
        setSuccess(`Copied to ${targetScope === "user" ? "Global" : "Workspace"}.`);
      } else {
        setError(result.error.message);
      }
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
        <div className="py-3.5">
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
            {workspaceScopeAvailable ? (
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
            ) : null}
          </div>
        </div>
      ) : (
        <SettingsEmptyState
          icon={<FolderInputIcon />}
          title={
            <>
              Select a folder that contains a{" "}
              {kind === "plugin" ? "plugin bundle" : <code>SKILL.md</code>}.
            </>
          }
        />
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

export function ImportDialog({ workspaceId, kind }: { workspaceId: string; kind: ImportableKind }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ImportTab>("claude");

  const runtime = useAppStore((state) => state.workspaceRuntimeById[workspaceId]);
  const listImportable = useAppStore((state) => state.listImportable);
  const importPlugin = useAppStore((state) => state.importPlugin);
  const importSkill = useAppStore((state) => state.importSkill);
  const operationsByKey = useAppStore((state) => state.operationsByKey);
  const anchorWorkspace = useAppStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
  );
  // One-off chat anchors have no project directory, so imports can only
  // target the Global (user) scope.
  const workspaceScopeAvailable = !isOneOffChatWorkspace(anchorWorkspace);

  const homeSource: ImportSource | null = tab === "folder" ? null : tab;
  const state = homeSource
    ? (runtime?.importItemsByKey?.[importKey(homeSource, kind)] ?? null)
    : null;
  const pendingKeys = runtime?.importPendingKeys ?? {};
  const importPending = Object.values(pendingKeys).some((pending) => pending === true);
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
      <Button variant="outline" size="sm" type="button" onClick={openDialog}>
        <DownloadIcon data-icon="inline-start" />
        Import
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && importPending) return;
          setOpen(nextOpen);
        }}
      >
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]">
          <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
            <DialogTitle>Import {noun}s</DialogTitle>
            <DialogDescription>
              Bring {noun}s from Claude Code (<code>~/.claude</code>), Codex (<code>~/.codex</code>
              ), or a local folder into Cowork.
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
              <FolderImportPanel kind={kind} workspaceScopeAvailable={workspaceScopeAvailable} />
            ) : isLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Spinner /> Scanning {SOURCE_LABELS[tab]}…
              </div>
            ) : state?.error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {state.error}
              </div>
            ) : !state?.homeExists ? (
              <SettingsEmptyState
                icon={<PackageIcon />}
                title={`No ${SOURCE_LABELS[tab]} installation found`}
                description={
                  <>
                    Expected it at <code>~/.{tab}</code>.
                  </>
                }
              />
            ) : items.length === 0 ? (
              <SettingsEmptyState
                icon={kind === "plugin" ? <PackageIcon /> : <SparklesIcon />}
                title={`No importable ${noun}s found`}
                description={`Nothing to import from ${SOURCE_LABELS[tab]}.`}
              />
            ) : (
              <div className="flex flex-col divide-y divide-border/40">
                {items.map((item) => {
                  const globalOperation =
                    operationsByKey[
                      operationKey("import", item.kind, item.source, item.id, "user")
                    ];
                  const workspaceOperation =
                    operationsByKey[
                      operationKey("import", item.kind, item.source, item.id, "workspace")
                    ];
                  const operation = [globalOperation, workspaceOperation].find(
                    (candidate) => candidate?.status === "pending" || candidate?.status === "error",
                  );
                  return (
                    <ImportItemCard
                      key={`${item.source}:${item.id}`}
                      item={item}
                      kind={kind}
                      globalPending={
                        pendingKeys[itemPendingKey(item, "user")] === true ||
                        globalOperation?.status === "pending"
                      }
                      workspacePending={
                        pendingKeys[itemPendingKey(item, "workspace")] === true ||
                        workspaceOperation?.status === "pending"
                      }
                      workspaceScopeAvailable={workspaceScopeAvailable}
                      operation={operation}
                      onImport={onImport}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
