import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FileIcon,
  MoreVerticalIcon,
  Loader2Icon,
} from "lucide-react";

import { useAppStore } from "../../app/store";
import type { ExplorerEntry } from "../../app/types";
import { cn } from "../../lib/utils";
import { listDirectory, showContextMenu, confirmAction, showNotification, previewOSFile } from "../../lib/desktopCommands";

export type WorkspaceFileExplorerProps = {
  workspaceId: string;
  className?: string;
};

const AUTO_REFRESH_INTERVAL_MS = 1000;

type DirectorySnapshot = {
  entries: ExplorerEntry[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  fingerprint: string;
};

export type ExplorerTreeRow =
  | {
      kind: "entry";
      depth: number;
      entry: ExplorerEntry;
      expanded: boolean;
    }
  | {
      kind: "status";
      depth: number;
      path: string;
      status: "loading" | "error" | "empty";
      message: string;
    };

function sortExplorerEntries(entries: ExplorerEntry[]): ExplorerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  });
}

export function normalizeExplorerPath(input: string): string {
  if (!input) return "";
  const normalized = input.replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

export function buildDirectoryFingerprint(entries: ExplorerEntry[]): string {
  return entries
    .map((entry) => {
      const kind = entry.isDirectory ? "d" : "f";
      return `${normalizeExplorerPath(entry.path)}:${kind}:${entry.sizeBytes ?? "?"}:${entry.modifiedAtMs ?? "?"}:${entry.isHidden ? "h" : "v"}`;
    })
    .sort()
    .join("|");
}

export function buildExplorerRows(
  rootPath: string,
  expandedPaths: Set<string>,
  directoryByPath: Record<string, DirectorySnapshot>
): ExplorerTreeRow[] {
  const rows: ExplorerTreeRow[] = [];
  const normalizedRootPath = normalizeExplorerPath(rootPath);

  const visit = (directoryPath: string, depth: number, ancestry: Set<string>) => {
    if (ancestry.has(directoryPath)) return;
    const directory = directoryByPath[directoryPath];
    if (!directory) return;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(directoryPath);

    for (const entry of directory.entries) {
      const normalizedEntryPath = normalizeExplorerPath(entry.path);
      const expanded = entry.isDirectory && expandedPaths.has(normalizedEntryPath);

      rows.push({
        kind: "entry",
        depth,
        entry,
        expanded,
      });

      if (!entry.isDirectory || !expanded) continue;
      const childDirectory = directoryByPath[normalizedEntryPath];

      if (!childDirectory || childDirectory.loading) {
        rows.push({
          kind: "status",
          depth: depth + 1,
          path: normalizedEntryPath,
          status: "loading",
          message: "Loading…",
        });
        continue;
      }

      if (childDirectory.error) {
        rows.push({
          kind: "status",
          depth: depth + 1,
          path: normalizedEntryPath,
          status: "error",
          message: childDirectory.error,
        });
        continue;
      }

      if (childDirectory.entries.length === 0) {
        rows.push({
          kind: "status",
          depth: depth + 1,
          path: normalizedEntryPath,
          status: "empty",
          message: "Empty folder",
        });
        continue;
      }

      visit(normalizedEntryPath, depth + 1, nextAncestry);
    }
  };

  visit(normalizedRootPath, 0, new Set());
  return rows;
}

function formatEntrySize(sizeBytes: number | null): string {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "Unknown size";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const exponent = Math.min(Math.floor(Math.log(sizeBytes) / Math.log(1024)), units.length - 1);
  const value = sizeBytes / 1024 ** exponent;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function formatModifiedAt(modifiedAtMs: number | null): string {
  if (typeof modifiedAtMs !== "number" || !Number.isFinite(modifiedAtMs) || modifiedAtMs <= 0) {
    return "Unknown date";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(modifiedAtMs));
}

function formatPathLabel(path: string): string {
  const normalized = normalizeExplorerPath(path);
  if (!normalized) return "Root";
  if (normalized === "/") return "Root";
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function defaultDirectorySnapshot(): DirectorySnapshot {
  return {
    entries: [],
    loading: false,
    error: null,
    updatedAt: null,
    fingerprint: "",
  };
}

export const WorkspaceFileExplorer = memo(function WorkspaceFileExplorer({
  workspaceId,
  className,
}: WorkspaceFileExplorerProps) {
  const workspacePath = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path ?? null);
  const explorer = useAppStore((s) => s.workspaceExplorerById[workspaceId]);
  const showHiddenFiles = useAppStore((s) => s.showHiddenFiles);
  const refresh = useAppStore((s) => s.refreshWorkspaceFiles);
  const selectFile = useAppStore((s) => s.selectWorkspaceFile);
  const openFile = useAppStore((s) => s.openWorkspaceFile);
  const revealFile = useAppStore((s) => s.revealWorkspaceFile);
  const copyPath = useAppStore((s) => s.copyWorkspaceFilePath);
  const trashPath = useAppStore((s) => s.trashWorkspacePath);

  const [directoryByPath, setDirectoryByPath] = useState<Record<string, DirectorySnapshot>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  const latestRequestByPathRef = useRef<Record<string, number>>({});
  const requestCounterRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const scopeRef = useRef<string | null>(null);
  const rootPathRef = useRef<string>("");
  const expandedPathsRef = useRef<Set<string>>(new Set());

  const rootPath = useMemo(() => {
    const candidate = explorer?.rootPath ?? workspacePath ?? "";
    return normalizeExplorerPath(candidate);
  }, [explorer?.rootPath, workspacePath]);

  const selectedPath = useMemo(() => {
    const current = explorer?.selectedPath;
    return current ? normalizeExplorerPath(current) : null;
  }, [explorer?.selectedPath]);

  const treeRows = useMemo(
    () => buildExplorerRows(rootPath, expandedPaths, directoryByPath),
    [rootPath, expandedPaths, directoryByPath]
  );

  const rootSnapshot = directoryByPath[rootPath];
  const rootLabel = formatPathLabel(rootPath);

  useEffect(() => {
    rootPathRef.current = rootPath;
  }, [rootPath]);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  useEffect(() => {
    if (!explorer && workspacePath) {
      void refresh(workspaceId).catch(() => {});
    }
  }, [explorer, refresh, workspaceId, workspacePath]);

  const loadDirectory = useCallback(
    async (path: string, opts?: { background?: boolean }) => {
      const targetPath = normalizeExplorerPath(path);
      if (!targetPath) return;

      const requestId = ++requestCounterRef.current;
      latestRequestByPathRef.current[targetPath] = requestId;

      setDirectoryByPath((previous) => {
        const current = previous[targetPath];
        if (opts?.background && current) {
          return previous;
        }

        return {
          ...previous,
          [targetPath]: {
            ...(current ?? defaultDirectorySnapshot()),
            loading: true,
            error: null,
          },
        };
      });

      try {
        const listed = await listDirectory({ path: targetPath, includeHidden: showHiddenFiles });
        const entries = sortExplorerEntries(listed);
        if (latestRequestByPathRef.current[targetPath] !== requestId) return;

        setDirectoryByPath((previous) => ({
          ...previous,
          [targetPath]: {
            entries,
            loading: false,
            error: null,
            updatedAt: Date.now(),
            fingerprint: buildDirectoryFingerprint(entries),
          },
        }));
      } catch (error) {
        if (latestRequestByPathRef.current[targetPath] !== requestId) return;

        setDirectoryByPath((previous) => ({
          ...previous,
          [targetPath]: {
            ...(previous[targetPath] ?? defaultDirectorySnapshot()),
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [showHiddenFiles]
  );

  const refreshExpandedDirectories = useCallback(
    async () => {
      const currentRootPath = rootPathRef.current;
      if (!currentRootPath || syncInFlightRef.current) return;
      syncInFlightRef.current = true;

      try {
        const paths = new Set<string>([currentRootPath, ...expandedPathsRef.current]);
        await Promise.all(Array.from(paths).map((path) => loadDirectory(path, { background: true })));
        void refresh(workspaceId).catch(() => {});
      } finally {
        syncInFlightRef.current = false;
      }
    },
    [loadDirectory, refresh, workspaceId]
  );

  const toggleDirectory = useCallback(
    (path: string) => {
      const targetPath = normalizeExplorerPath(path);
      if (!targetPath) return;

      const isExpanded = expandedPathsRef.current.has(targetPath);
      setExpandedPaths((previous) => {
        const next = new Set(previous);
        if (isExpanded) {
          if (targetPath !== rootPathRef.current) {
            next.delete(targetPath);
          }
        } else {
          next.add(targetPath);
        }
        expandedPathsRef.current = next;
        return next;
      });

      if (!isExpanded) {
        void loadDirectory(targetPath).catch(() => {});
      }
    },
    [loadDirectory]
  );

  useEffect(() => {
    if (!rootPath) return;
    const scope = `${workspaceId}:${rootPath}`;
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;

    latestRequestByPathRef.current = {};
    const nextExpanded = new Set<string>([rootPath]);
    expandedPathsRef.current = nextExpanded;
    setExpandedPaths(nextExpanded);
    setDirectoryByPath({});
    selectFile(workspaceId, null);
    void loadDirectory(rootPath).catch(() => {});
  }, [loadDirectory, rootPath, selectFile, workspaceId]);

  useEffect(() => {
    if (!rootPath) return;
    void refreshExpandedDirectories();
  }, [rootPath, refreshExpandedDirectories, showHiddenFiles]);

  useEffect(() => {
    if (!rootPath) return;
    const interval = window.setInterval(() => {
      void refreshExpandedDirectories();
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [refreshExpandedDirectories, rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshExpandedDirectories();
      }
    };
    const onFocus = () => {
      void refreshExpandedDirectories();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshExpandedDirectories, rootPath]);

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent, entry: ExplorerEntry) => {
      e.preventDefault();
      e.stopPropagation();
      const targetPath = entry.path;
      const normalizedPath = normalizeExplorerPath(targetPath);
      selectFile(workspaceId, targetPath);

      const folderExpanded = entry.isDirectory && expandedPathsRef.current.has(normalizedPath);
      const openLabel = entry.isDirectory ? "Open Folder" : "Open File";

      const items = [
        ...(entry.isDirectory
          ? [{ id: folderExpanded ? "collapse" : "expand", label: folderExpanded ? "Collapse Folder" : "Expand Folder" }]
          : []),
        { id: "open", label: openLabel },
        { id: "reveal", label: "Reveal in Finder/Explorer" },
        { id: "copy", label: "Copy Full Path" },
        { id: "trash", label: "Move to Trash" },
      ];

      const action = await showContextMenu(items);
      if (!action) return;

      if (action === "open") {
        if (entry.isDirectory) {
          toggleDirectory(targetPath);
        } else {
          void openFile(workspaceId, targetPath, false).catch(() => {});
        }
      } else if (action === "expand" || action === "collapse") {
        toggleDirectory(targetPath);
      } else if (action === "reveal") {
        void revealFile(targetPath).catch(() => {});
      } else if (action === "copy") {
        void copyPath(targetPath).catch(() => {});
      } else if (action === "trash") {
        const confirmed = await confirmAction({
          title: "Move to Trash",
          message: `Are you sure you want to move this ${entry.isDirectory ? "directory" : "file"} to the trash?`,
          detail: targetPath,
          kind: "warning",
          confirmLabel: "Move to Trash",
          defaultAction: "cancel",
        });
        if (confirmed) {
          try {
            await trashPath(workspaceId, targetPath);
            void refreshExpandedDirectories();
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            void showNotification({
              title: "Move to Trash failed",
              body: detail || "Unable to move the selected item to Trash.",
            }).catch(() => {});
          }
        }
      }
    },
    [workspaceId, selectFile, openFile, toggleDirectory, revealFile, copyPath, trashPath, refreshExpandedDirectories]
  );

  const handleOpenEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (entry.isDirectory) {
        toggleDirectory(entry.path);
        return;
      }
      void openFile(workspaceId, entry.path, false).catch(() => {});
    },
    [openFile, toggleDirectory, workspaceId]
  );

  if (!workspacePath || !rootPath) {
    return (
      <div className={cn("flex items-center justify-center p-4 text-muted-foreground", className)}>
        <span className="text-xs">No workspace selected</span>
      </div>
    );
  }

  if (!rootSnapshot && treeRows.length === 0) {
    return (
      <div className={cn("flex items-center justify-center p-4 text-muted-foreground", className)}>
        <Loader2Icon className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-xs font-semibold tracking-wide text-muted-foreground/80 shrink-0">FILES</div>
          <div className="text-muted-foreground/40 text-xs shrink-0 font-light">/</div>
          <button
            type="button"
            className="truncate text-xs font-semibold text-foreground hover:underline focus:outline-none"
            onClick={() => void openFile(workspaceId, rootPath, false).catch(() => {})}
            title="Open in native explorer"
          >
            {rootLabel}
          </button>
        </div>
      </div>

      <div className="relative flex-1 overflow-y-auto p-1.5">
        {rootSnapshot?.error ? (
          <div className="rounded bg-destructive/10 p-3 text-center text-xs text-destructive">{rootSnapshot.error}</div>
        ) : treeRows.length === 0 && rootSnapshot?.loading ? (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
            <Loader2Icon className="mr-2 h-3.5 w-3.5 animate-spin" />
            Loading files…
          </div>
        ) : treeRows.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">This folder is empty</div>
        ) : (
          <div className="space-y-0.5">
            {treeRows.map((row) => {
              if (row.kind === "status") {
                return (
                  <div
                    key={`${row.path}:${row.status}`}
                    className={cn(
                      "flex items-center gap-1 rounded py-1 text-[10px]",
                      row.status === "error" ? "text-destructive" : "text-muted-foreground"
                    )}
                    style={{ paddingLeft: `${row.depth * 0.85 + 1.15}rem` }}
                  >
                    {row.status === "loading" ? <Loader2Icon className="h-3 w-3 animate-spin" /> : null}
                    <span className="truncate">{row.message}</span>
                  </div>
                );
              }

              const { entry, depth } = row;
              const normalizedPath = normalizeExplorerPath(entry.path);
              const isSelected = selectedPath === normalizedPath;
              const isDirectory = entry.isDirectory;
              const entryMeta = isDirectory
                ? `${entry.isHidden ? "Hidden folder" : "Folder"}`
                : `${formatEntrySize(entry.sizeBytes)} • ${formatModifiedAt(entry.modifiedAtMs)}${entry.isHidden ? " • hidden" : ""}`;

              return (
                <div
                  key={entry.path}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "group flex cursor-pointer items-center gap-1 rounded-md py-1.5 pr-1 text-xs transition-colors select-none",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    entry.isHidden && "opacity-70"
                  )}
                  style={{ paddingLeft: `${depth * 0.85 + 0.35}rem` }}
                  onClick={() => {
                    selectFile(workspaceId, entry.path);
                    if (!entry.isDirectory) {
                      void previewOSFile({ path: entry.path }).catch(() => {});
                    }
                  }}
                  onDoubleClick={() => handleOpenEntry(entry)}
                  onContextMenu={(event) => {
                    void handleContextMenu(event, entry);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleOpenEntry(entry);
                    }
                  }}
                  title={entry.path}
                >
                  {isDirectory ? (
                    <button
                      type="button"
                      aria-label={row.expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
                      className={cn(
                        "inline-flex h-5 w-5 items-center justify-center rounded transition-colors",
                        isSelected ? "hover:bg-accent-foreground/15" : "hover:bg-muted"
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleDirectory(entry.path);
                      }}
                    >
                      {row.expanded ? <ChevronDownIcon className="h-3.5 w-3.5" /> : <ChevronRightIcon className="h-3.5 w-3.5" />}
                    </button>
                  ) : (
                    <span className="inline-block h-5 w-5" aria-hidden />
                  )}

                  {isDirectory ? (
                    row.expanded ? (
                      <FolderOpenIcon className={cn("h-3.5 w-3.5 shrink-0", isSelected ? "text-accent-foreground" : "text-blue-500/85")} />
                    ) : (
                      <FolderIcon className={cn("h-3.5 w-3.5 shrink-0", isSelected ? "text-accent-foreground" : "text-blue-500/85")} />
                    )
                  ) : (
                    <FileIcon className="h-3.5 w-3.5 shrink-0" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{entry.name}</div>
                    <div className={cn("truncate text-[10px]", isSelected ? "text-accent-foreground/85" : "text-muted-foreground")}>
                      {entryMeta}
                    </div>
                  </div>

                  <button
                    type="button"
                    aria-label={`More options for ${entry.name}`}
                    className={cn(
                      "inline-flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity",
                      isSelected ? "opacity-100 hover:bg-accent-foreground/15" : "group-hover:opacity-100 hover:bg-muted"
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleContextMenu(event, entry);
                    }}
                  >
                    <MoreVerticalIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
