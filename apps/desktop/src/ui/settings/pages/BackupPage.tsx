import { useEffect, useEffectEvent, useState } from "react";

import {
  AlertTriangleIcon,
  ArchiveIcon,
  ClockIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderOpenIcon,
  HardDriveIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";

import { useAppStore } from "../../../app/store";
import type {
  WorkspaceBackupDeltaEvent,
  WorkspaceBackupEntry,
  WorkspaceRecord,
  WorkspaceRuntime,
} from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { confirmAction, revealPath } from "../../../lib/desktopCommands";
import { cn } from "../../../lib/utils";
import { workspaceBackupActionKey } from "../../../app/store.helpers/backupActionKey";

type BackupPageProps = {
  workspace?: WorkspaceRecord | null;
  runtime?: WorkspaceRuntime | null;
  onRefresh?: () => Promise<void> | void;
  onCreateCheckpoint?: (targetSessionId: string) => Promise<void> | void;
  onRestoreOriginal?: (targetSessionId: string) => Promise<void> | void;
  onRestoreCheckpoint?: (targetSessionId: string, checkpointId: string) => Promise<void> | void;
  onDeleteCheckpoint?: (targetSessionId: string, checkpointId: string) => Promise<void> | void;
  onDeleteEntry?: (targetSessionId: string) => Promise<void> | void;
  onSetSessionBackupsEnabled?: (targetSessionId: string, enabled: boolean) => Promise<void> | void;
  onRevealFolder?: (path: string) => Promise<void> | void;
};

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0 B";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

function toBoolean(checked: boolean | "indeterminate"): boolean {
  return checked === true;
}

function backupTitle(entry: WorkspaceBackupEntry): string {
  if (entry.title?.trim()) return entry.title;
  if (entry.lifecycle === "deleted") return "Deleted session";
  return entry.targetSessionId;
}

function sortByUpdated(entries: WorkspaceBackupEntry[]): WorkspaceBackupEntry[] {
  return [...entries].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

function lifecycleBadgeClass(lifecycle: WorkspaceBackupEntry["lifecycle"]): string {
  if (lifecycle === "active") {
    return "border-emerald-700/25 bg-emerald-700/[0.04] text-emerald-700/80";
  }
  if (lifecycle === "deleted") {
    return "border-destructive/25 bg-destructive/[0.04] text-destructive/75";
  }
  return "border-border/50 bg-transparent text-muted-foreground";
}

function StatItem({ label, value, icon: Icon }: { label: string; value: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/45 bg-background/50 text-muted-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-medium text-foreground">{value}</div>
      </div>
    </div>
  );
}

type BackupSidebarProps = {
  entries: WorkspaceBackupEntry[];
  selectedTargetSessionId: string | null;
  selectedCheckpointId: string | null;
  loading: boolean;
  onSelectEntry: (targetSessionId: string) => void;
  onSelectCheckpoint: (targetSessionId: string, checkpointId: string) => void;
  onRefresh?: () => void;
};

function BackupSidebar({
  entries,
  selectedTargetSessionId,
  selectedCheckpointId,
  loading,
  onSelectEntry,
  onSelectCheckpoint,
  onRefresh,
}: BackupSidebarProps) {
  return (
    <div
      className="flex w-72 shrink-0 flex-col border-r border-border/80 bg-muted/14 sm:w-80"
      data-backup-rail="true"
    >
      <div className="flex items-center justify-between border-b border-border/70 bg-muted/10 px-4 py-3.5 shrink-0">
        <span className="text-sm font-semibold text-foreground">Backup History</span>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onRefresh?.()} disabled={loading}>
          <RefreshCwIcon className={cn("h-4 w-4 text-muted-foreground", loading ? "animate-spin" : "")} />
        </Button>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto bg-muted/6 p-4">
        {entries.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <ArchiveIcon className="h-8 w-8 mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No backups found.</p>
          </div>
        ) : null}

        {entries.map((entry) => {
          const isBackupSelected = entry.targetSessionId === selectedTargetSessionId && selectedCheckpointId === null;

          return (
            <div key={entry.targetSessionId} className="mb-1">
              <button
                onClick={() => onSelectEntry(entry.targetSessionId)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-all",
                  isBackupSelected
                    ? "border border-border/65 bg-background/72 font-medium text-foreground"
                    : "border border-transparent text-foreground hover:bg-background/35"
                )}
              >
                <FolderOpenIcon className={cn("h-4 w-4 shrink-0", isBackupSelected ? "text-foreground" : "text-muted-foreground")} />
                <span className="truncate flex-1">{backupTitle(entry)}</span>
                {entry.lifecycle === "active" ? (
                  <Badge variant="outline" className={cn("h-5 px-2 text-[10px] font-medium", lifecycleBadgeClass(entry.lifecycle))}>
                    Active
                  </Badge>
                ) : null}
                {entry.status === "failed" && <AlertTriangleIcon className="w-3.5 h-3.5 text-destructive shrink-0" />}
              </button>

              <div className="ml-4 border-l-2 border-border/40 pl-3 mt-0.5 space-y-0.5">
                {entry.checkpoints.length === 0 ? (
                  <div className="py-2 text-xs text-muted-foreground/70 pl-2">No checkpoints</div>
                ) : (
                  [...entry.checkpoints].reverse().map((cp) => {
                    const isCpSelected = entry.targetSessionId === selectedTargetSessionId && selectedCheckpointId === cp.id;
                    return (
                      <button
                        key={cp.id}
                        onClick={() => onSelectCheckpoint(entry.targetSessionId, cp.id)}
                        className={cn(
                          "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-all",
                          isCpSelected
                            ? "border border-border/55 bg-background/60 font-medium text-foreground"
                            : "border border-transparent text-muted-foreground hover:bg-background/28"
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FileTextIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
                          <span className="font-mono truncate">{cp.id}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type BackupDetailViewProps = {
  entry: WorkspaceBackupEntry;
  pendingActions: Record<string, boolean | undefined>;
  onCreateCheckpoint?: (targetSessionId: string) => void;
  onRestoreOriginal?: (targetSessionId: string) => void;
  onDeleteEntry?: (targetSessionId: string) => void;
  onRevealFolder: (path: string) => void;
};

function BackupDetailView({
  entry,
  pendingActions,
  onCreateCheckpoint,
  onRestoreOriginal,
  onDeleteEntry,
  onRevealFolder,
}: BackupDetailViewProps) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b border-border/70 bg-background/96 px-6 py-5">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border/45 bg-background/55 text-muted-foreground">
            <FolderOpenIcon className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Selected backup</div>
            <h2 className="text-lg font-semibold truncate">{backupTitle(entry)}</h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-sm text-muted-foreground">{entry.provider || "Unknown"} • {entry.model || "Unknown model"}</span>
              <Badge
                variant="outline"
                className={cn("h-5 text-[10px]", lifecycleBadgeClass(entry.lifecycle))}
              >
                {entry.lifecycle}
              </Badge>
              {entry.status === "failed" && (
                <Badge variant="outline" className="h-5 border-destructive/25 bg-destructive/5 text-[10px] text-destructive/80">Failed</Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="border-b border-border/60 bg-background/64 px-6 py-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <StatItem label="Created" value={formatTimestamp(entry.createdAt)} icon={ClockIcon} />
          <StatItem label="Last Updated" value={formatTimestamp(entry.updatedAt)} icon={RefreshCwIcon} />
          <StatItem label="Storage" value={formatBytes(entry.totalBytes)} icon={HardDriveIcon} />
          <StatItem label="Checkpoints" value={String(entry.checkpoints.length)} icon={DatabaseIcon} />
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-background/92 p-6">
        <div className="space-y-3">
          <div className="text-sm font-medium text-foreground">Backup Actions</div>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={() => onCreateCheckpoint?.(entry.targetSessionId)}
              disabled={entry.status !== "ready" || pendingActions[workspaceBackupActionKey("checkpoint", entry.targetSessionId)]}
            >
              <SaveIcon className="mr-2 h-4 w-4" />
              Create Checkpoint
            </Button>
            <Button
              variant="outline"
              className="border-border/70 text-foreground hover:border-border hover:bg-muted/30"
              onClick={async () => {
                const confirmed = await confirmAction({
                  title: "Restore Original State",
                  message: "Restore the workspace to before this session started?",
                  detail: "This overwrites current files. We will create a safety checkpoint first just in case.",
                  kind: "warning",
                  confirmLabel: "Restore",
                  cancelLabel: "Cancel",
                  defaultAction: "cancel",
                });
                if (confirmed) onRestoreOriginal?.(entry.targetSessionId);
              }}
              disabled={entry.status !== "ready" || pendingActions[workspaceBackupActionKey("restore-original", entry.targetSessionId)]}
            >
              <RotateCcwIcon className="mr-2 h-4 w-4 text-destructive/70" />
              Restore Original Workspace
            </Button>
            {entry.backupDirectory && (
              <Button variant="outline" onClick={() => onRevealFolder(entry.backupDirectory!)}>
                <FolderOpenIcon className="mr-2 h-4 w-4" />
                Reveal Folder
              </Button>
            )}
            <Button
              variant="outline"
              className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={async () => {
                const confirmed = await confirmAction({
                  title: "Delete Backup Entry",
                  message: `Delete all backup history for ${backupTitle(entry)}?`,
                  detail: entry.lifecycle === "active"
                    ? "The session will stay available, but backups for it will be disabled until you turn them back on."
                    : "This removes the stored backup folder for this session entry.",
                  kind: "warning",
                  confirmLabel: "Delete backup",
                  cancelLabel: "Cancel",
                  defaultAction: "cancel",
                });
                if (confirmed) onDeleteEntry?.(entry.targetSessionId);
              }}
              disabled={pendingActions[workspaceBackupActionKey("delete-entry", entry.targetSessionId)]}
            >
              <Trash2Icon className="mr-2 h-4 w-4" />
              Delete Backup Entry
            </Button>
          </div>
        </div>

        {entry.failureReason && (
          <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <strong>Backup Error:</strong> {entry.failureReason}
          </div>
        )}
      </div>
    </div>
  );
}

type CheckpointDeltaViewProps = {
  entry: WorkspaceBackupEntry;
  checkpoint: WorkspaceBackupEntry["checkpoints"][number];
  delta: WorkspaceBackupDeltaEvent | null;
  deltaLoading: boolean;
  deltaError: string | null;
  pendingActions: Record<string, boolean | undefined>;
  onRestoreCheckpoint?: (targetSessionId: string, checkpointId: string) => void;
  onDeleteCheckpoint?: (targetSessionId: string, checkpointId: string) => void;
};

function CheckpointDeltaView({
  entry,
  checkpoint,
  delta,
  deltaLoading,
  deltaError,
  pendingActions,
  onRestoreCheckpoint,
  onDeleteCheckpoint,
}: CheckpointDeltaViewProps) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/70 bg-background/96 px-6 py-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border/45 bg-background/55 text-muted-foreground">
            <FileTextIcon className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Checkpoint snapshot</div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-sm">Checkpoint <span className="ml-1 font-mono text-foreground/80">{checkpoint.id}</span></h2>
              {checkpoint.trigger !== "manual" && <Badge variant="outline" className="text-[9px] uppercase h-4 py-0">{checkpoint.trigger}</Badge>}
            </div>
            <div className="text-xs text-muted-foreground">Captured {formatTimestamp(checkpoint.createdAt)}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const confirmed = await confirmAction({
                title: "Restore Checkpoint",
                message: `Restore workspace to checkpoint ${checkpoint.id}?`,
                kind: "warning",
                confirmLabel: "Restore",
                cancelLabel: "Cancel",
                defaultAction: "cancel",
              });
              if (confirmed) onRestoreCheckpoint?.(entry.targetSessionId, checkpoint.id);
            }}
            disabled={entry.status !== "ready" || pendingActions[workspaceBackupActionKey("restore-checkpoint", entry.targetSessionId, checkpoint.id)]}
          >
            <RotateCcwIcon className="mr-2 h-3.5 w-3.5" />
            Restore
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={async () => {
              const confirmed = await confirmAction({
                title: "Delete Checkpoint",
                message: `Delete checkpoint ${checkpoint.id}?`,
                kind: "warning",
                confirmLabel: "Delete",
                cancelLabel: "Cancel",
                defaultAction: "cancel",
              });
              if (confirmed) onDeleteCheckpoint?.(entry.targetSessionId, checkpoint.id);
            }}
            disabled={entry.status !== "ready" || pendingActions[workspaceBackupActionKey("delete-checkpoint", entry.targetSessionId, checkpoint.id)]}
          >
            <Trash2Icon className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border/40 bg-background/64 px-6 py-3 text-xs shrink-0">
          <span className="text-muted-foreground flex items-center gap-2">
            Compared to baseline:
            <Badge variant="secondary" className="font-mono text-[10px]">{delta?.baselineLabel || "..."}</Badge>
          </span>
          {delta && (
            <div className="flex items-center gap-4 font-medium">
              <span className="text-emerald-700/80">+{delta.counts.added}</span>
              <span className="text-amber-700/80">~{delta.counts.modified}</span>
              <span className="text-destructive/75">-{delta.counts.deleted}</span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {deltaLoading && !delta ? (
            <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">Loading file changes...</div>
          ) : deltaError ? (
            <div className="m-6 p-4 text-sm text-destructive bg-destructive/10 rounded-md border border-destructive/20">{deltaError}</div>
          ) : delta?.files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <FileTextIcon className="h-8 w-8 mb-2 opacity-20" />
              <div className="text-sm">No file changes detected in this checkpoint.</div>
            </div>
          ) : delta ? (
            <div className="min-w-[500px]">
              <div className="sticky top-0 z-10 flex items-center border-b border-border/40 bg-background/95 px-6 py-2 text-xs font-medium text-muted-foreground backdrop-blur">
                <div className="flex-1">Name</div>
                <div className="w-24">Kind</div>
                <div className="w-24 text-right">Status</div>
              </div>
              <div className="divide-y divide-border/30">
                {delta.files.map(f => (
                  <div key={f.path} className="group flex items-center px-6 py-2.5 text-sm transition-colors hover:bg-muted/30">
                    <div className="flex-1 flex items-center gap-3 min-w-0 pr-4">
                      {f.kind === "directory" ? <FolderOpenIcon className="w-4 h-4 text-muted-foreground shrink-0" /> : <FileTextIcon className="w-4 h-4 text-muted-foreground shrink-0" />}
                      <span className="font-mono text-[13px] truncate" title={f.path}>{f.path}</span>
                    </div>
                    <div className="w-24 text-xs text-muted-foreground capitalize shrink-0">{f.kind}</div>
                    <div className="w-24 text-right shrink-0">
                      <Badge variant="outline" className={cn(
                        "text-[10px] uppercase h-5 py-0",
                        f.change === "added" ? "border-emerald-700/20 bg-emerald-700/[0.04] text-emerald-700/80 group-hover:bg-emerald-700/[0.07]" :
                        f.change === "modified" ? "border-amber-700/20 bg-amber-700/[0.04] text-amber-700/80 group-hover:bg-amber-700/[0.07]" :
                        "border-destructive/20 bg-destructive/[0.04] text-destructive/75 group-hover:bg-destructive/[0.07]"
                      )}>
                        {f.change}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
              {delta.truncated && (
                <div className="p-3 text-xs text-muted-foreground text-center border-t border-border/40 bg-muted/10">
                  List truncated. Showing partial file list, but counts reflect total changes.
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function BackupPage(props: BackupPageProps = {}) {
  const selectedWorkspaceIdFromStore = useAppStore((s) => s.selectedWorkspaceId);
  const workspacesFromStore = useAppStore((s) => s.workspaces);
  const runtimeByIdFromStore = useAppStore((s) => s.workspaceRuntimeById);
  const threadsFromStore = useAppStore((s) => s.threads);
  const threadRuntimeByIdFromStore = useAppStore((s) => s.threadRuntimeById);
  const selectWorkspaceFromStore = useAppStore((s) => s.selectWorkspace);
  const requestWorkspaceBackupsFromStore = useAppStore((s) => s.requestWorkspaceBackups);
  const requestWorkspaceBackupDeltaFromStore = useAppStore((s) => s.requestWorkspaceBackupDelta);
  const createWorkspaceBackupCheckpointFromStore = useAppStore((s) => s.createWorkspaceBackupCheckpoint);
  const restoreWorkspaceBackupOriginalFromStore = useAppStore((s) => s.restoreWorkspaceBackupOriginal);
  const restoreWorkspaceBackupCheckpointFromStore = useAppStore((s) => s.restoreWorkspaceBackupCheckpoint);
  const deleteWorkspaceBackupCheckpointFromStore = useAppStore((s) => s.deleteWorkspaceBackupCheckpoint);
  const deleteWorkspaceBackupEntryFromStore = useAppStore((s) => s.deleteWorkspaceBackupEntry);
  const setWorkspaceBackupSessionEnabledFromStore = useAppStore((s) => s.setWorkspaceBackupSessionEnabled);
  // During SSR (renderToStaticMarkup), hooks like useAppStore(selector) return default state
  // because there's no React store provider. Read directly from getState() as a fallback.
  const serverState = typeof window === "undefined" ? useAppStore.getState() : null;

  const selectedWorkspaceId = serverState?.selectedWorkspaceId ?? selectedWorkspaceIdFromStore;
  const workspaces = serverState?.workspaces ?? workspacesFromStore;
  const workspaceRuntimeById = serverState?.workspaceRuntimeById ?? runtimeByIdFromStore;
  const threads = serverState?.threads ?? threadsFromStore;
  const threadRuntimeById = serverState?.threadRuntimeById ?? threadRuntimeByIdFromStore;

  const workspaceList = props.workspace !== undefined ? (props.workspace ? [props.workspace] : []) : workspaces;
  const workspace = props.workspace !== undefined
    ? props.workspace
    : (selectedWorkspaceId
      ? workspaces.find((entry) => entry.id === selectedWorkspaceId) ?? workspaces[0] ?? null
      : workspaces[0] ?? null);
  const runtime = props.runtime !== undefined ? props.runtime : (workspace ? workspaceRuntimeById[workspace.id] ?? null : null);

  const refreshBackups = props.onRefresh
    ?? (workspace ? () => requestWorkspaceBackupsFromStore(workspace.id) : undefined);
  const createCheckpoint = props.onCreateCheckpoint
    ?? (workspace ? (targetSessionId: string) => createWorkspaceBackupCheckpointFromStore(workspace.id, targetSessionId) : undefined);
  const restoreOriginal = props.onRestoreOriginal
    ?? (workspace ? (targetSessionId: string) => restoreWorkspaceBackupOriginalFromStore(workspace.id, targetSessionId) : undefined);
  const restoreCheckpoint = props.onRestoreCheckpoint
    ?? (workspace ? (targetSessionId: string, checkpointId: string) => restoreWorkspaceBackupCheckpointFromStore(workspace.id, targetSessionId, checkpointId) : undefined);
  const deleteCheckpoint = props.onDeleteCheckpoint
    ?? (workspace ? (targetSessionId: string, checkpointId: string) => deleteWorkspaceBackupCheckpointFromStore(workspace.id, targetSessionId, checkpointId) : undefined);
  const deleteEntry = props.onDeleteEntry
    ?? (workspace ? (targetSessionId: string) => deleteWorkspaceBackupEntryFromStore(workspace.id, targetSessionId) : undefined);
  const setSessionBackupsEnabled = props.onSetSessionBackupsEnabled
    ?? (workspace ? (targetSessionId: string, enabled: boolean) => setWorkspaceBackupSessionEnabledFromStore(workspace.id, targetSessionId, enabled) : undefined);
  const revealFolder = props.onRevealFolder ?? (async (folderPath: string) => await revealPath({ path: folderPath }));

  const [selectedTargetSessionId, setSelectedTargetSessionId] = useState<string | null>(null);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);

  const runInitialRefresh = useEffectEvent(() => {
    if (!workspace) return;
    if (props.onRefresh) {
      void props.onRefresh();
      return;
    }
    void requestWorkspaceBackupsFromStore(workspace.id);
  });

  useEffect(() => {
    if (!workspace?.id || !runtime?.controlSessionId) return;
    runInitialRefresh();
  }, [workspace?.id, runtime?.controlSessionId]);

  const entries = runtime?.workspaceBackups ?? [];
  const sortedEntries = sortByUpdated(entries);
  const activeTargetSessionId = selectedTargetSessionId ?? sortedEntries[0]?.targetSessionId ?? null;

  useEffect(() => {
    const selectedEntry = activeTargetSessionId
      ? sortedEntries.find((entry) => entry.targetSessionId === activeTargetSessionId) ?? null
      : null;

    if (selectedEntry && selectedCheckpointId) {
      const checkpointStillExists = selectedEntry.checkpoints.some((cp) => cp.id === selectedCheckpointId);
      if (!checkpointStillExists) setSelectedCheckpointId(null);
    }
  }, [sortedEntries, activeTargetSessionId, selectedCheckpointId]);

  const requestSelectedDelta = useEffectEvent(() => {
    if (!workspace?.id || !selectedTargetSessionId || !selectedCheckpointId) return;
    void requestWorkspaceBackupDeltaFromStore(workspace.id, selectedTargetSessionId, selectedCheckpointId);
  });

  useEffect(() => {
    if (!workspace?.id || !runtime?.controlSessionId || !activeTargetSessionId || !selectedCheckpointId) return;
    requestSelectedDelta();
  }, [workspace?.id, runtime?.controlSessionId, activeTargetSessionId, selectedCheckpointId]);

  if (!workspace) {
    return (
      <div className="space-y-5 px-6 py-6 max-[960px]:px-4 max-[960px]:py-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Workspace Backups</h1>
          <p className="text-sm text-muted-foreground">Manage backup history and restore points for your workspaces.</p>
        </div>
        <Card className="border-border/80 bg-card/85">
          <CardContent className="p-8 text-center">
            <ArchiveIcon className="h-12 w-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground">Select a workspace first to manage its backup history.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const pendingActions = runtime?.workspaceBackupPendingActionKeys ?? {};
  const loading = runtime?.workspaceBackupsLoading ?? false;
  const error = runtime?.workspaceBackupsError ?? null;
  const deltaPreview = runtime?.workspaceBackupDelta ?? null;
  const deltaError = runtime?.workspaceBackupDeltaError ?? null;
  const deltaLoading = runtime?.workspaceBackupDeltaLoading ?? false;

  const selectedEntry = sortedEntries.find((entry) => entry.targetSessionId === activeTargetSessionId);
  const selectedCp = selectedEntry?.checkpoints.find(c => c.id === selectedCheckpointId);
  const activeDelta = activeTargetSessionId
    && selectedCheckpointId
    && deltaPreview?.targetSessionId === activeTargetSessionId
    && deltaPreview?.checkpointId === selectedCheckpointId
    ? deltaPreview
    : null;
  const selectedThread = selectedEntry
    ? threads.find((thread) => (
        thread.workspaceId === workspace.id
          && threadRuntimeById[thread.id]?.sessionId === selectedEntry.targetSessionId
      )) ?? null
    : null;
  const selectedThreadRuntime = selectedThread ? threadRuntimeById[selectedThread.id] ?? null : null;
  const canToggleSelectedEntry = Boolean(
    selectedEntry
      && selectedEntry.lifecycle === "active"
      && selectedThreadRuntime?.sessionId,
  );
  const selectedBackupsEnabled = selectedThreadRuntime?.sessionConfig?.backupsEnabled ?? null;

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-5 px-6 pt-6 max-[960px]:gap-4 max-[960px]:px-4 max-[960px]:pt-4"
      data-backup-page="true"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 shrink-0">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Workspace Backups</h1>
          <p className="text-sm text-muted-foreground">Manage backup history and restore points for your workspaces.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-sm">
            <Checkbox
              checked={selectedBackupsEnabled ?? false}
              disabled={!canToggleSelectedEntry}
              onCheckedChange={(checked) => {
                if (!selectedEntry) return;
                void setSessionBackupsEnabled?.(selectedEntry.targetSessionId, toBoolean(checked));
              }}
            />
            <span className={canToggleSelectedEntry ? "text-foreground" : "text-muted-foreground"}>
              Session backups
            </span>
          </label>
          {workspaceList.length > 1 && props.workspace === undefined && (
            <Select value={workspace.id} onValueChange={(val) => { if (val !== workspace.id) void selectWorkspaceFromStore(val); }}>
              <SelectTrigger className="h-9 w-[200px] border-border/70 bg-background">
                <SelectValue placeholder="Select workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaceList.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive flex items-center gap-2 shrink-0">
          <AlertTriangleIcon className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Main Split-Pane Layout - Full Page */}
      <div
        className="mx-[-1.5rem] flex min-h-0 flex-1 overflow-hidden border-y border-border/70 bg-transparent max-[960px]:mx-[-1rem]"
        data-backup-split="true"
      >
        <BackupSidebar
          entries={sortedEntries}
          selectedTargetSessionId={selectedTargetSessionId}
          selectedCheckpointId={selectedCheckpointId}
          loading={loading}
          onSelectEntry={(id) => { setSelectedTargetSessionId(id); setSelectedCheckpointId(null); }}
          onSelectCheckpoint={(entryId, cpId) => { setSelectedTargetSessionId(entryId); setSelectedCheckpointId(cpId); }}
          onRefresh={() => void refreshBackups?.()}
        />

        {/* Content Area */}
        <div className="min-w-0 flex-1 overflow-hidden bg-background/92" data-backup-detail="true">
          {!selectedEntry ? (
            <div className="flex h-full flex-1 flex-col items-center justify-center space-y-4 bg-background/92 p-8 text-center text-muted-foreground">
              <ArchiveIcon className="h-16 w-16 opacity-20" />
              <p className="text-sm">Select a backup or checkpoint from the sidebar to inspect it.</p>
            </div>
          ) : selectedCheckpointId === null ? (
            <BackupDetailView
              entry={selectedEntry}
              pendingActions={pendingActions}
              onCreateCheckpoint={(id) => void createCheckpoint?.(id)}
              onRestoreOriginal={(id) => void restoreOriginal?.(id)}
              onDeleteEntry={(id) => void deleteEntry?.(id)}
              onRevealFolder={(p) => void revealFolder(p)}
            />
          ) : selectedCp ? (
            <CheckpointDeltaView
              entry={selectedEntry}
              checkpoint={selectedCp}
              delta={activeDelta}
              deltaLoading={deltaLoading}
              deltaError={deltaError}
              pendingActions={pendingActions}
              onRestoreCheckpoint={(sid, cpId) => void restoreCheckpoint?.(sid, cpId)}
              onDeleteCheckpoint={(sid, cpId) => void deleteCheckpoint?.(sid, cpId)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
