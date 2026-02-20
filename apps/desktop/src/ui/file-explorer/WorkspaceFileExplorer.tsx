import { memo, useCallback, useEffect, useState } from "react";

import {
  ChevronUpIcon,
  RefreshCwIcon,
  FolderIcon,
  FileIcon,
  MoreVerticalIcon,
  Loader2Icon,
} from "lucide-react";

import { useAppStore } from "../../app/store";
import { cn } from "../../lib/utils";
import { showContextMenu, confirmAction } from "../../lib/desktopCommands";

export type WorkspaceFileExplorerProps = {
  workspaceId: string;
  className?: string;
};

export const WorkspaceFileExplorer = memo(function WorkspaceFileExplorer({
  workspaceId,
  className,
}: WorkspaceFileExplorerProps) {
  const explorer = useAppStore((s) => s.workspaceExplorerById[workspaceId]);
  const refresh = useAppStore((s) => s.refreshWorkspaceFiles);
  const navigateUp = useAppStore((s) => s.navigateWorkspaceFilesUp);
  const selectFile = useAppStore((s) => s.selectWorkspaceFile);
  const openFile = useAppStore((s) => s.openWorkspaceFile);
  const revealFile = useAppStore((s) => s.revealWorkspaceFile);
  const copyPath = useAppStore((s) => s.copyWorkspaceFilePath);
  const trashPath = useAppStore((s) => s.trashWorkspacePath);

  useEffect(() => {
    if (!explorer) {
      void refresh(workspaceId).catch(() => {});
    }
  }, [explorer, refresh, workspaceId]);

  const handleRefresh = useCallback(() => {
    void refresh(workspaceId).catch(() => {});
  }, [refresh, workspaceId]);

  const handleUp = useCallback(() => {
    void navigateUp(workspaceId).catch(() => {});
  }, [navigateUp, workspaceId]);

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent, path: string, isDirectory: boolean) => {
      e.preventDefault();
      selectFile(workspaceId, path);

      const items = [
        { id: "open", label: "Open" },
        { id: "reveal", label: "Reveal in Finder/Explorer" },
        { id: "copy", label: "Copy Full Path" },
        { id: "trash", label: "Move to Trash" },
      ];

      const action = await showContextMenu(items);
      if (!action) return;

      if (action === "open") {
        void openFile(workspaceId, path, isDirectory).catch(() => {});
      } else if (action === "reveal") {
        void revealFile(path).catch(() => {});
      } else if (action === "copy") {
        void copyPath(path).catch(() => {});
      } else if (action === "trash") {
        const confirmed = await confirmAction({
          title: "Move to Trash",
          message: `Are you sure you want to move this ${isDirectory ? "directory" : "file"} to the trash?`,
          detail: path,
          kind: "warning",
          confirmLabel: "Move to Trash",
          defaultAction: "cancel",
        });
        if (confirmed) {
          void trashPath(workspaceId, path).catch(() => {});
        }
      }
    },
    [workspaceId, selectFile, openFile, revealFile, copyPath, trashPath]
  );

  if (!explorer) {
    return (
      <div className={cn("flex items-center justify-center p-4 text-muted-foreground", className)}>
        <Loader2Icon className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  const { rootPath, currentPath, entries, loading, error, selectedPath } = explorer;

  const isAtRoot = currentPath && rootPath && currentPath.length <= rootPath.length;

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", className)}>
      <div className="flex items-center gap-1 p-1 border-b border-border/50 bg-muted/20">
        <button
          className="p-1.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
          onClick={handleUp}
          disabled={isAtRoot || loading}
          title="Go Up"
        >
          <ChevronUpIcon className="h-3.5 w-3.5" />
        </button>
        <button
          className="p-1.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
          onClick={handleRefresh}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCwIcon className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
        <div className="flex-1 truncate px-2 text-xs font-medium text-muted-foreground">
          {currentPath ? (currentPath === rootPath ? "Root" : currentPath.split(/[/\\]/).pop()) : "Loading..."}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-1 relative">
        {error ? (
          <div className="p-3 text-center text-xs text-destructive bg-destructive/10 rounded">
            {error}
          </div>
        ) : entries.length === 0 && !loading ? (
          <div className="py-6 text-center text-xs text-muted-foreground">This folder is empty</div>
        ) : (
          <div className="space-y-0.5">
            {entries.map((entry) => {
              const isSelected = selectedPath === entry.path;
              return (
                <div
                  key={entry.path}
                  className={cn(
                    "flex items-center gap-2 rounded px-2 py-1.5 text-xs cursor-pointer select-none group",
                    isSelected ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    entry.isHidden && "opacity-60"
                  )}
                  onClick={() => selectFile(workspaceId, entry.path)}
                  onDoubleClick={() => openFile(workspaceId, entry.path, entry.isDirectory)}
                  onContextMenu={(e) => handleContextMenu(e, entry.path, entry.isDirectory)}
                  title={entry.path}
                >
                  {entry.isDirectory ? (
                    <FolderIcon className={cn("h-3.5 w-3.5 shrink-0", isSelected ? "text-accent-foreground" : "text-blue-500/80")} />
                  ) : (
                    <FileIcon className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="truncate flex-1">{entry.name}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});