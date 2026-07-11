import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  MoreVerticalIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { publishForegroundNotification, useAppStore } from "../../app/store";
import type { ExplorerEntry } from "../../app/types";
import { isOneOffChatWorkspace } from "../../app/types";
import { AccessibleIconButton, Button } from "../../components/ui/button";
import {
  clearDirectoryListingScope,
  confirmAction,
  invalidateDirectoryListing,
  isStaleDirectoryListingError,
  listDirectory,
  onWorkspaceFileChanged,
  showContextMenu,
  unwatchWorkspaceDirectory,
  watchWorkspaceDirectory,
} from "../../lib/desktopCommands";
import { isImeComposing } from "../../lib/keyboard";
import { cn } from "../../lib/utils";
import { recordDesktopRenderMetric } from "../renderDiagnostics";

export type WorkspaceFileExplorerProps = {
  active?: boolean;
  workspaceId: string;
  className?: string;
  commands?: WorkspaceFileExplorerCommands;
};

export type WorkspaceFileExplorerCommands = {
  clearDirectoryListingScope: typeof clearDirectoryListingScope;
  invalidateDirectoryListing: typeof invalidateDirectoryListing;
  isStaleDirectoryListingError: typeof isStaleDirectoryListingError;
  listDirectory: typeof listDirectory;
  onWorkspaceFileChanged: typeof onWorkspaceFileChanged;
  showContextMenu: typeof showContextMenu;
  unwatchWorkspaceDirectory: typeof unwatchWorkspaceDirectory;
  watchWorkspaceDirectory: typeof watchWorkspaceDirectory;
};

const DEFAULT_EXPLORER_COMMANDS: WorkspaceFileExplorerCommands = {
  clearDirectoryListingScope,
  invalidateDirectoryListing,
  isStaleDirectoryListingError,
  listDirectory,
  onWorkspaceFileChanged,
  showContextMenu,
  unwatchWorkspaceDirectory,
  watchWorkspaceDirectory,
};

const FALLBACK_REFRESH_INTERVAL_MS = 5_000;
const WATCH_REVALIDATION_INTERVAL_MS = 30_000;
const FILE_EXPLORER_CONTROL_SELECTOR = "[data-file-explorer-control='true']";
/** Two clicks on the same folder within this window open the native folder instead of toggling twice. */
const FOLDER_DOUBLE_CLICK_MS = 320;

type DirectorySnapshot = {
  entries: ExplorerEntry[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  fingerprint: string;
};

/** In-memory listing cache per workspace root so revisiting a workspace is instant (no blank tree). */
const explorerDirectorySessionByScope = new Map<string, Record<string, DirectorySnapshot>>();

function explorerScopeKey(workspaceId: string, rootPath: string): string {
  return `${workspaceId}:${normalizeExplorerPath(rootPath)}`;
}

function prepareDirectorySessionSnapshot(
  data: Record<string, DirectorySnapshot>,
): Record<string, DirectorySnapshot> {
  let changed = false;
  const next = { ...data };
  for (const [path, snapshot] of Object.entries(data)) {
    if (!snapshot.loading) continue;
    changed = true;
    next[path] = { ...snapshot, loading: false };
  }
  return changed ? next : data;
}

type DirectorySnapshotSummary = Pick<DirectorySnapshot, "error" | "fingerprint">;

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
      status: "error" | "empty";
      message: string;
    };

export function explorerRowDomKey(row: ExplorerTreeRow): string {
  return row.kind === "entry" ? row.entry.path : `${row.path}:${row.status}`;
}

export function isTreeRowControlTarget(target: EventTarget | null): boolean {
  return Boolean(
    target &&
      typeof target === "object" &&
      "closest" in target &&
      typeof (target as { closest?: unknown }).closest === "function" &&
      (target as { closest: (selector: string) => Element | null }).closest(
        FILE_EXPLORER_CONTROL_SELECTOR,
      ),
  );
}

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

export function shouldReuseBackgroundDirectorySnapshot(
  current: DirectorySnapshotSummary | undefined,
  fingerprint: string,
  error: string | null,
): boolean {
  return !!current && current.error === error && current.fingerprint === fingerprint;
}

export function shouldAutoRefreshExplorer(
  visibilityState: string,
  hasFocus: boolean,
  sectionExpanded = true,
): boolean {
  return sectionExpanded && visibilityState === "visible" && hasFocus;
}

function isExplorerPathWithin(candidatePath: string, ancestorPath: string): boolean {
  if (candidatePath === ancestorPath) {
    return true;
  }
  const prefix = ancestorPath.endsWith("/") ? ancestorPath : `${ancestorPath}/`;
  return candidatePath.startsWith(prefix);
}

function shouldSuppressExplorerEntry(entry: ExplorerEntry, showHiddenFiles: boolean): boolean {
  if (showHiddenFiles) return false;
  return entry.isHidden || entry.name.startsWith(".") || entry.name.startsWith("~$");
}

export function buildExplorerRows(
  rootPath: string,
  expandedPaths: Set<string>,
  directoryByPath: Record<string, DirectorySnapshot>,
  showHiddenFiles: boolean,
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
      if (shouldSuppressExplorerEntry(entry, showHiddenFiles)) continue;
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

      if (!childDirectory) {
        continue;
      }
      /** Keep showing cached listing while refresh runs (`loading`) so open/expand still animates. */
      if (childDirectory.loading && childDirectory.entries.length === 0) {
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

type ExplorerTreeRowViewProps = {
  row: ExplorerTreeRow;
  selected: boolean;
  tabIndex: 0 | -1;
  onContextMenu(event: React.MouseEvent, entry: ExplorerEntry): void;
  onEntryClick(entry: ExplorerEntry): void;
  onEntryFocus(entry: ExplorerEntry): void;
  onEntryKeyDown(
    event: React.KeyboardEvent,
    row: Extract<ExplorerTreeRow, { kind: "entry" }>,
  ): void;
  onOpenEntry(entry: ExplorerEntry): void;
  onOpenEntryMenu(entry: ExplorerEntry): void;
  onRowRef(path: string, element: HTMLDivElement | null): void;
  onToggleDirectory(path: string): void;
};

const ExplorerTreeRowView = memo(
  function ExplorerTreeRowView({
    row,
    selected,
    tabIndex,
    onContextMenu,
    onEntryClick,
    onEntryFocus,
    onEntryKeyDown,
    onOpenEntry,
    onOpenEntryMenu,
    onRowRef,
    onToggleDirectory,
  }: ExplorerTreeRowViewProps) {
    recordDesktopRenderMetric("file-explorer-row", explorerRowDomKey(row));
    if (row.kind === "status") {
      return (
        <div
          data-file-row-key={explorerRowDomKey(row)}
          role="none"
          className={cn(
            "flex items-center gap-1 rounded py-1 text-[10px] transition-opacity duration-150 ease-out motion-reduce:transition-none",
            row.status === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          style={{ paddingLeft: `${row.depth * 0.85 + 1.15}rem` }}
        >
          <span className="truncate" role={row.status === "error" ? "alert" : "status"}>
            {row.message}
          </span>
        </div>
      );
    }

    const { entry, depth } = row;
    const isDirectory = entry.isDirectory;
    const entryMeta = isDirectory
      ? `${entry.isHidden ? "Hidden folder" : "Folder"}`
      : `${formatEntrySize(entry.sizeBytes)} • ${formatModifiedAt(entry.modifiedAtMs)}${entry.isHidden ? " • hidden" : ""}`;

    return (
      <div
        ref={(element) => onRowRef(entry.path, element)}
        data-file-row-key={explorerRowDomKey(row)}
        role="treeitem"
        tabIndex={tabIndex}
        aria-level={depth + 1}
        aria-selected={isDirectory ? false : selected}
        aria-expanded={isDirectory ? row.expanded : undefined}
        className={cn(
          "group flex min-h-8 cursor-pointer items-center gap-1 rounded-[9px] py-0.5 pr-1 text-[11.5px] transition-[color,background-color,transform] duration-150 ease-out motion-reduce:transition-none active:scale-[0.99]",
          selected
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          entry.isHidden && "opacity-70",
        )}
        style={{ paddingLeft: `${depth * 0.85 + 0.35}rem` }}
        onDoubleClick={(event) => {
          if (isTreeRowControlTarget(event.target) || isDirectory) {
            return;
          }
          onOpenEntry(entry);
        }}
        onContextMenu={(event) => {
          onContextMenu(event, entry);
        }}
        onMouseDown={(event) => {
          if (isTreeRowControlTarget(event.target)) {
            event.stopPropagation();
          }
        }}
        onClick={(event) => {
          if (!isTreeRowControlTarget(event.target)) {
            onEntryClick(entry);
          }
        }}
        onFocus={() => onEntryFocus(entry)}
        onKeyDown={(event) => onEntryKeyDown(event, row)}
        title={entry.path}
      >
        {isDirectory ? (
          <AccessibleIconButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            label={row.expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
            className={cn(
              "size-7 min-w-7 rounded p-0 transition-colors duration-150 ease-out select-none shadow-none motion-reduce:transition-none",
              selected ? "hover:bg-accent-foreground/15" : "hover:bg-muted",
            )}
            data-file-explorer-control="true"
            onClick={() => onToggleDirectory(entry.path)}
          >
            <ChevronRightIcon
              strokeWidth={1.5}
              className={cn(
                "h-3.25 w-3.25 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                selected ? "text-link/80" : "text-inherit",
                row.expanded && "rotate-90",
              )}
            />
          </AccessibleIconButton>
        ) : (
          <span className="inline-block size-7" aria-hidden />
        )}

        {isDirectory ? (
          row.expanded ? (
            <FolderOpenIcon
              strokeWidth={1.5}
              className={cn(
                "h-3.25 w-3.25 shrink-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
                selected ? "text-link/80" : "text-link/85",
              )}
            />
          ) : (
            <FolderIcon
              strokeWidth={1.5}
              className={cn(
                "h-3.25 w-3.25 shrink-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
                selected ? "text-link/80" : "text-link/85",
              )}
            />
          )
        ) : (
          <FileIcon
            strokeWidth={1.5}
            className={cn(
              "h-3.25 w-3.25 shrink-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
              selected ? "text-link/80" : "text-inherit",
            )}
          />
        )}

        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{entry.name}</div>
          <div
            className={cn(
              "truncate text-[9px] leading-3.5",
              selected ? "text-accent-foreground/85" : "text-muted-foreground",
            )}
          >
            {entryMeta}
          </div>
        </div>

        <AccessibleIconButton
          type="button"
          variant="ghost"
          size="icon-sm"
          tabIndex={-1}
          label={`More options for ${entry.name}`}
          className={cn(
            "size-7 min-w-7 rounded p-0 opacity-0 transition-opacity select-none shadow-none",
            selected
              ? "opacity-100 hover:bg-accent-foreground/15"
              : "group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:bg-muted",
          )}
          data-file-explorer-control="true"
          onClick={() => onOpenEntryMenu(entry)}
        >
          <MoreVerticalIcon
            strokeWidth={1.5}
            className={cn("h-3.25 w-3.25", selected ? "text-link/80" : "text-inherit")}
          />
        </AccessibleIconButton>
      </div>
    );
  },
  (previous, next) => {
    if (
      previous.selected !== next.selected ||
      previous.tabIndex !== next.tabIndex ||
      previous.onContextMenu !== next.onContextMenu ||
      previous.onEntryClick !== next.onEntryClick ||
      previous.onEntryFocus !== next.onEntryFocus ||
      previous.onEntryKeyDown !== next.onEntryKeyDown ||
      previous.onOpenEntry !== next.onOpenEntry ||
      previous.onOpenEntryMenu !== next.onOpenEntryMenu ||
      previous.onRowRef !== next.onRowRef ||
      previous.onToggleDirectory !== next.onToggleDirectory ||
      previous.row.kind !== next.row.kind
    ) {
      return false;
    }
    if (previous.row.kind === "status" && next.row.kind === "status") {
      return (
        previous.row.depth === next.row.depth &&
        previous.row.path === next.row.path &&
        previous.row.status === next.row.status &&
        previous.row.message === next.row.message
      );
    }
    if (previous.row.kind === "entry" && next.row.kind === "entry") {
      return (
        previous.row.depth === next.row.depth &&
        previous.row.expanded === next.row.expanded &&
        previous.row.entry === next.row.entry
      );
    }
    return false;
  },
);

export const WorkspaceFileExplorer = memo(function WorkspaceFileExplorer({
  active,
  workspaceId,
  className,
  commands = DEFAULT_EXPLORER_COMMANDS,
}: WorkspaceFileExplorerProps) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null);
  const workspacePath = workspace?.path ?? null;
  const isOneOffChat = isOneOffChatWorkspace(workspace);
  const explorer = useAppStore((s) => s.workspaceExplorerById[workspaceId]);
  const refreshSignal = useAppStore((s) => s.workspaceExplorerRefreshById[workspaceId] ?? 0);
  const showHiddenFiles = useAppStore((s) => s.showHiddenFiles);
  const contextSidebarCollapsed = useAppStore((s) => s.contextSidebarCollapsed);
  const explorerActive = active ?? !contextSidebarCollapsed;
  const refresh = useAppStore((s) => s.refreshWorkspaceFiles);
  const selectFile = useAppStore((s) => s.selectWorkspaceFile);
  const openFile = useAppStore((s) => s.openWorkspaceFile);
  const openFilePreview = useAppStore((s) => s.openFilePreview);
  const revealFile = useAppStore((s) => s.revealWorkspaceFile);
  const copyPath = useAppStore((s) => s.copyWorkspaceFilePath);
  const trashPath = useAppStore((s) => s.trashWorkspacePath);

  const [directoryByPath, setDirectoryByPath] = useState<Record<string, DirectorySnapshot>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [watchSupported, setWatchSupported] = useState<boolean | null>(null);
  const [activeRowPath, setActiveRowPath] = useState<string | null>(null);

  const syncInFlightRef = useRef(false);
  const syncQueuedRef = useRef(false);
  const syncInvalidateQueuedRef = useRef(false);
  const scopeRef = useRef<string | null>(null);
  const rootPathRef = useRef<string>("");
  const expandedPathsRef = useRef<Set<string>>(new Set());
  const explorerActiveRef = useRef(explorerActive);
  const mountedRef = useRef(true);
  /** Latest directory snapshots (for expand: avoid toggling `loading` when cached data exists). */
  const directoryByPathRef = useRef<Record<string, DirectorySnapshot>>({});
  /** Tracks last folder row click for double-click → open in native explorer (no debounce delay). */
  const folderLastClickRef = useRef<{ path: string; t: number } | null>(null);
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>());
  explorerActiveRef.current = explorerActive;

  const rootPath = useMemo(() => {
    const candidate = explorer?.rootPath ?? workspacePath ?? "";
    return normalizeExplorerPath(candidate);
  }, [explorer?.rootPath, workspacePath]);

  const selectedPath = useMemo(() => {
    const current = explorer?.selectedPath;
    return current ? normalizeExplorerPath(current) : null;
  }, [explorer?.selectedPath]);

  const treeRows = useMemo(
    () => buildExplorerRows(rootPath, expandedPaths, directoryByPath, showHiddenFiles),
    [rootPath, expandedPaths, directoryByPath, showHiddenFiles],
  );
  const entryRows = useMemo(
    () =>
      treeRows.filter(
        (row): row is Extract<ExplorerTreeRow, { kind: "entry" }> => row.kind === "entry",
      ),
    [treeRows],
  );
  const entryRowsRef = useRef(entryRows);
  entryRowsRef.current = entryRows;
  const rovingRowPath = useMemo(() => {
    if (
      activeRowPath &&
      entryRows.some((row) => normalizeExplorerPath(row.entry.path) === activeRowPath)
    ) {
      return activeRowPath;
    }
    if (
      selectedPath &&
      entryRows.some((row) => normalizeExplorerPath(row.entry.path) === selectedPath)
    ) {
      return selectedPath;
    }
    const firstRow = entryRows[0];
    return firstRow ? normalizeExplorerPath(firstRow.entry.path) : null;
  }, [activeRowPath, entryRows, selectedPath]);

  const rootSnapshot = directoryByPath[rootPath];
  const rootLabel = formatPathLabel(rootPath);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    rootPathRef.current = rootPath;
  }, [rootPath]);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  useEffect(() => {
    directoryByPathRef.current = directoryByPath;
  }, [directoryByPath]);

  useEffect(() => {
    if (explorerActive && !explorer && workspacePath) {
      void refresh(workspaceId).catch(() => {});
    }
  }, [explorer, explorerActive, refresh, workspaceId, workspacePath]);

  const loadDirectory = useCallback(
    async (path: string, opts?: { background?: boolean; silent?: boolean }): Promise<void> => {
      const targetPath = normalizeExplorerPath(path);
      const requestScope = scopeRef.current;
      if (!targetPath || !requestScope) return;

      setDirectoryByPath((previous) => {
        const current = previous[targetPath];
        /** Silent: fetch without flipping `loading` (used for prefetch; keeps UI off spinners). */
        if (opts?.silent) {
          return previous;
        }
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
        const listed = await commands.listDirectory({
          workspaceId,
          path: targetPath,
          includeHidden: showHiddenFiles,
        });
        if (!mountedRef.current || scopeRef.current !== requestScope) {
          return;
        }
        const entries = sortExplorerEntries(listed);
        const fingerprint = buildDirectoryFingerprint(entries);
        setDirectoryByPath((previous) => {
          const current = previous[targetPath];
          if (shouldReuseBackgroundDirectorySnapshot(current, fingerprint, null)) {
            if (!current?.loading) {
              return previous;
            }
            return {
              ...previous,
              [targetPath]: {
                ...current,
                loading: false,
              },
            };
          }

          return {
            ...previous,
            [targetPath]: {
              entries,
              loading: false,
              error: null,
              updatedAt: Date.now(),
              fingerprint,
            },
          };
        });
      } catch (error) {
        if (
          !mountedRef.current ||
          scopeRef.current !== requestScope ||
          commands.isStaleDirectoryListingError(error)
        ) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setDirectoryByPath((previous) => {
          const current = previous[targetPath];
          if (
            opts?.background &&
            shouldReuseBackgroundDirectorySnapshot(current, current?.fingerprint ?? "", message)
          ) {
            return previous;
          }

          return {
            ...previous,
            [targetPath]: {
              ...(current ?? defaultDirectorySnapshot()),
              loading: false,
              error: message,
            },
          };
        });
      }
    },
    [commands, showHiddenFiles, workspaceId],
  );

  const refreshExpandedDirectories = useCallback(
    async (options?: { invalidate?: boolean }) => {
      const currentRootPath = rootPathRef.current;
      if (!currentRootPath || !explorerActiveRef.current) return;
      if (syncInFlightRef.current) {
        syncQueuedRef.current = true;
        syncInvalidateQueuedRef.current ||= options?.invalidate === true;
        return;
      }
      syncInFlightRef.current = true;
      let invalidate = options?.invalidate === true;

      try {
        do {
          syncQueuedRef.current = false;
          invalidate ||= syncInvalidateQueuedRef.current;
          syncInvalidateQueuedRef.current = false;
          const cycleRootPath = rootPathRef.current;
          if (!cycleRootPath) break;
          const paths = new Set<string>([cycleRootPath, ...expandedPathsRef.current]);
          if (invalidate) {
            for (const path of paths) {
              commands.invalidateDirectoryListing({ workspaceId, path });
            }
          }
          invalidate = false;
          await Promise.all(
            Array.from(paths).map((path) => loadDirectory(path, { background: true })),
          );
        } while (syncQueuedRef.current);
      } finally {
        syncInFlightRef.current = false;
      }
    },
    [commands, loadDirectory, workspaceId],
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
            for (const expandedPath of next) {
              if (isExplorerPathWithin(expandedPath, targetPath)) {
                next.delete(expandedPath);
              }
            }
          }
        } else {
          next.add(targetPath);
        }
        expandedPathsRef.current = next;
        return next;
      });

      if (!isExpanded) {
        const normalizedTarget = normalizeExplorerPath(targetPath);
        const snap = directoryByPathRef.current[normalizedTarget];
        const useBackgroundRefresh =
          !!snap && !snap.loading && !snap.error && snap.updatedAt != null;
        void loadDirectory(
          targetPath,
          useBackgroundRefresh ? { background: true } : undefined,
        ).catch(() => {});
      }
    },
    [loadDirectory],
  );

  useEffect(() => {
    if (!rootPath) return;
    const scope = explorerScopeKey(workspaceId, rootPath);
    if (scopeRef.current === scope) return;

    const prevScope = scopeRef.current;
    if (prevScope) {
      explorerDirectorySessionByScope.set(
        prevScope,
        prepareDirectorySessionSnapshot(directoryByPathRef.current),
      );
    }

    folderLastClickRef.current = null;
    rowElementsRef.current.clear();
    setActiveRowPath(null);
    scopeRef.current = scope;

    const normalizedRoot = normalizeExplorerPath(rootPath);
    commands.clearDirectoryListingScope({
      workspaceId,
      path: normalizedRoot,
      recursive: true,
    });
    const cached = explorerDirectorySessionByScope.get(scope);
    const nextMap = cached ?? {};
    setDirectoryByPath(nextMap);
    const nextExpanded = new Set<string>([normalizedRoot]);
    expandedPathsRef.current = nextExpanded;
    setExpandedPaths(nextExpanded);
    selectFile(workspaceId, null);

    if (explorerActive) {
      const hasCachedListings = cached && Object.keys(cached).length > 0;
      if (hasCachedListings) {
        void loadDirectory(rootPath, { background: true }).catch(() => {});
      } else {
        void loadDirectory(rootPath).catch(() => {});
      }
    }
  }, [commands, explorerActive, loadDirectory, rootPath, selectFile, workspaceId]);

  useEffect(() => {
    return () => {
      const scope = scopeRef.current;
      if (scope) {
        explorerDirectorySessionByScope.set(
          scope,
          prepareDirectorySessionSnapshot(directoryByPathRef.current),
        );
      }
    };
  }, []);

  useEffect(() => {
    if (!rootPath || !explorerActive) {
      setWatchSupported(null);
      return;
    }
    let subscribed = true;
    setWatchSupported(null);
    const stopListening = commands.onWorkspaceFileChanged((event) => {
      if (
        event.workspaceId !== workspaceId ||
        normalizeExplorerPath(event.rootPath) !== rootPathRef.current
      ) {
        return;
      }

      if (event.invalidatedSubtreePaths.length > 0) {
        setDirectoryByPath((previous) => {
          let next = previous;
          for (const cachedPath of Object.keys(previous)) {
            if (
              event.invalidatedSubtreePaths.some((subtreePath) =>
                isExplorerPathWithin(cachedPath, normalizeExplorerPath(subtreePath)),
              )
            ) {
              if (next === previous) {
                next = { ...previous };
              }
              delete next[cachedPath];
            }
          }
          return next;
        });
        setExpandedPaths((previous) => {
          const next = new Set(previous);
          for (const expandedPath of previous) {
            if (
              event.invalidatedSubtreePaths.some((subtreePath) =>
                isExplorerPathWithin(expandedPath, normalizeExplorerPath(subtreePath)),
              )
            ) {
              next.delete(expandedPath);
            }
          }
          if (next.size === previous.size) {
            return previous;
          }
          expandedPathsRef.current = next;
          return next;
        });
      }

      if (!explorerActiveRef.current) {
        return;
      }
      const visibleAffectedPaths = event.affectedDirectoryPaths
        .map(normalizeExplorerPath)
        .filter(
          (directoryPath) =>
            directoryPath === rootPathRef.current || expandedPathsRef.current.has(directoryPath),
        );
      void Promise.all(
        visibleAffectedPaths.map((directoryPath) =>
          loadDirectory(directoryPath, { background: true }),
        ),
      );
    });
    void commands
      .watchWorkspaceDirectory({ workspaceId, rootPath })
      .then((supported) => {
        if (subscribed) {
          setWatchSupported(supported);
        }
      })
      .catch(() => {
        if (subscribed) {
          setWatchSupported(false);
        }
      });

    return () => {
      subscribed = false;
      stopListening();
      commands.clearDirectoryListingScope({ workspaceId, path: rootPath, recursive: true });
      void commands.unwatchWorkspaceDirectory({ workspaceId, rootPath }).catch(() => {});
    };
  }, [commands, explorerActive, loadDirectory, rootPath, workspaceId]);

  useEffect(() => {
    if (!rootPath || !explorerActive) return;
    void refreshExpandedDirectories({ invalidate: true });
  }, [explorerActive, rootPath, refreshExpandedDirectories, showHiddenFiles]);

  useEffect(() => {
    if (!rootPath || !explorerActive || refreshSignal === 0) return;
    void refreshExpandedDirectories({ invalidate: true });
  }, [explorerActive, refreshExpandedDirectories, refreshSignal, rootPath]);

  useEffect(() => {
    if (!rootPath || !explorerActive) return;
    const intervalMs =
      watchSupported === true ? WATCH_REVALIDATION_INTERVAL_MS : FALLBACK_REFRESH_INTERVAL_MS;
    const interval = window.setInterval(() => {
      if (
        !shouldAutoRefreshExplorer(document.visibilityState, document.hasFocus(), explorerActive)
      ) {
        return;
      }
      void refreshExpandedDirectories({ invalidate: true });
    }, intervalMs);

    return () => window.clearInterval(interval);
  }, [explorerActive, refreshExpandedDirectories, rootPath, watchSupported]);

  useEffect(() => {
    if (!rootPath || !explorerActive) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshExpandedDirectories({ invalidate: true });
      }
    };
    const onFocus = () => {
      void refreshExpandedDirectories({ invalidate: true });
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [explorerActive, refreshExpandedDirectories, rootPath]);

  const openEntryMenu = useCallback(
    async (entry: ExplorerEntry) => {
      const targetPath = entry.path;
      const normalizedPath = normalizeExplorerPath(targetPath);
      if (!entry.isDirectory) {
        selectFile(workspaceId, targetPath);
      }

      const folderExpanded = entry.isDirectory && expandedPathsRef.current.has(normalizedPath);
      const openLabel = entry.isDirectory ? "Open Folder" : "Open File";

      const items = [
        ...(entry.isDirectory
          ? [
              {
                id: folderExpanded ? "collapse" : "expand",
                label: folderExpanded ? "Collapse Folder" : "Expand Folder",
              },
            ]
          : []),
        { id: "open", label: openLabel },
        { id: "reveal", label: "Reveal in Finder/Explorer" },
        { id: "copy", label: "Copy Full Path" },
        { id: "trash", label: "Move to Trash" },
      ];

      const action = await commands.showContextMenu(items);
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
            publishForegroundNotification({
              kind: "error",
              title: "Move to Trash failed",
              detail: detail || "Unable to move the selected item to Trash.",
            });
          }
        }
      }
    },
    [
      workspaceId,
      selectFile,
      openFile,
      toggleDirectory,
      revealFile,
      copyPath,
      trashPath,
      refreshExpandedDirectories,
      commands,
    ],
  );

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent, entry: ExplorerEntry) => {
      e.preventDefault();
      e.stopPropagation();
      await openEntryMenu(entry);
    },
    [openEntryMenu],
  );

  const handleOpenEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (entry.isDirectory) {
        toggleDirectory(entry.path);
        return;
      }
      void openFile(workspaceId, entry.path, false).catch(() => {});
    },
    [openFile, toggleDirectory, workspaceId],
  );

  const handleSelectEntry = useCallback(
    (entry: ExplorerEntry) => {
      selectFile(workspaceId, entry.path);
      if (!entry.isDirectory) {
        openFilePreview({ path: entry.path });
      }
    },
    [openFilePreview, selectFile, workspaceId],
  );

  const handleEntryClick = useCallback(
    (entry: ExplorerEntry) => {
      if (!entry.isDirectory) {
        handleSelectEntry(entry);
        return;
      }
      const normalizedPath = normalizeExplorerPath(entry.path);
      const now = Date.now();
      const previous = folderLastClickRef.current;
      if (
        previous &&
        previous.path === normalizedPath &&
        now - previous.t < FOLDER_DOUBLE_CLICK_MS
      ) {
        folderLastClickRef.current = null;
        void openFile(workspaceId, entry.path, false).catch(() => {});
        return;
      }
      folderLastClickRef.current = { path: normalizedPath, t: now };
      toggleDirectory(entry.path);
    },
    [handleSelectEntry, openFile, toggleDirectory, workspaceId],
  );

  const registerRowElement = useCallback((path: string, element: HTMLDivElement | null) => {
    const normalizedPath = normalizeExplorerPath(path);
    if (element) {
      rowElementsRef.current.set(normalizedPath, element);
    } else {
      rowElementsRef.current.delete(normalizedPath);
    }
  }, []);

  const focusEntryRow = useCallback((index: number) => {
    const target = entryRowsRef.current[index];
    if (!target) return;
    const targetPath = normalizeExplorerPath(target.entry.path);
    setActiveRowPath(targetPath);
    requestAnimationFrame(() => rowElementsRef.current.get(targetPath)?.focus());
  }, []);

  const handleEntryFocus = useCallback((entry: ExplorerEntry) => {
    setActiveRowPath(normalizeExplorerPath(entry.path));
  }, []);

  const handleEntryKeyDown = useCallback(
    (event: React.KeyboardEvent, row: Extract<ExplorerTreeRow, { kind: "entry" }>) => {
      if (isTreeRowControlTarget(event.target)) return;
      const currentEntryRows = entryRowsRef.current;
      const currentPath = normalizeExplorerPath(row.entry.path);
      const currentIndex = currentEntryRows.findIndex(
        (candidate) => normalizeExplorerPath(candidate.entry.path) === currentPath,
      );
      if (currentIndex < 0) return;

      const focusParent = () => {
        for (let index = currentIndex - 1; index >= 0; index -= 1) {
          const candidate = currentEntryRows[index];
          if (candidate && candidate.depth < row.depth) {
            focusEntryRow(index);
            return;
          }
        }
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusEntryRow(Math.min(currentIndex + 1, currentEntryRows.length - 1));
          return;
        case "ArrowUp":
          event.preventDefault();
          focusEntryRow(Math.max(currentIndex - 1, 0));
          return;
        case "Home":
          event.preventDefault();
          focusEntryRow(0);
          return;
        case "End":
          event.preventDefault();
          focusEntryRow(currentEntryRows.length - 1);
          return;
        case "ArrowRight":
          if (!row.entry.isDirectory) return;
          event.preventDefault();
          if (!row.expanded) {
            toggleDirectory(row.entry.path);
            return;
          }
          if (currentEntryRows[currentIndex + 1]?.depth === row.depth + 1) {
            focusEntryRow(currentIndex + 1);
          }
          return;
        case "ArrowLeft":
          event.preventDefault();
          if (row.entry.isDirectory && row.expanded) {
            toggleDirectory(row.entry.path);
          } else {
            focusParent();
          }
          return;
        case "Enter":
          event.preventDefault();
          handleOpenEntry(row.entry);
          return;
        case " ":
        case "Spacebar":
          event.preventDefault();
          if (row.entry.isDirectory) {
            toggleDirectory(row.entry.path);
          } else {
            handleSelectEntry(row.entry);
          }
          return;
        case "ContextMenu":
          event.preventDefault();
          void openEntryMenu(row.entry);
          return;
        case "F10":
          if (!event.shiftKey) return;
          event.preventDefault();
          void openEntryMenu(row.entry);
          return;
        default:
          break;
      }

      if (
        event.key.length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !isImeComposing(event.nativeEvent)
      ) {
        const query = event.key.toLocaleLowerCase();
        for (let offset = 1; offset <= currentEntryRows.length; offset += 1) {
          const index = (currentIndex + offset) % currentEntryRows.length;
          const candidate = currentEntryRows[index];
          if (candidate?.entry.name.toLocaleLowerCase().startsWith(query)) {
            event.preventDefault();
            focusEntryRow(index);
            return;
          }
        }
      }
    },
    [focusEntryRow, handleOpenEntry, handleSelectEntry, openEntryMenu, toggleDirectory],
  );

  if (!workspacePath || !rootPath) {
    return (
      <div className={cn("flex items-center justify-center p-4 text-muted-foreground", className)}>
        <span className="text-xs">No workspace selected</span>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between px-2.5 pb-1 pt-2">
        <div className="flex items-center gap-2 min-w-0">
          {isOneOffChat ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto min-w-0 justify-start p-0 text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground/80 no-underline hover:text-foreground hover:underline"
              data-file-explorer-control="true"
              onClick={() => void openFile(workspaceId, rootPath, false).catch(() => {})}
              title="Open in native explorer"
            >
              Files
            </Button>
          ) : (
            <>
              <div className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/80 shrink-0 uppercase">
                Files
              </div>
              <div className="text-muted-foreground/35 text-[11px] shrink-0 font-light">/</div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto min-w-0 justify-start p-0 text-[11.5px] font-semibold text-foreground/88 no-underline hover:text-foreground hover:underline"
                data-file-explorer-control="true"
                onClick={() => void openFile(workspaceId, rootPath, false).catch(() => {})}
                title="Open in native explorer"
              >
                {rootLabel}
              </Button>
            </>
          )}
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1"
        data-file-explorer-scroll-region="true"
      >
        {rootSnapshot?.error ? (
          <div className="rounded bg-destructive/10 p-3 text-center text-xs text-destructive">
            {rootSnapshot.error}
          </div>
        ) : treeRows.length === 0 &&
          (!rootSnapshot || rootSnapshot.loading) ? null : treeRows.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">This folder is empty</div>
        ) : (
          <div
            role="tree"
            aria-label={`Workspace files for ${rootLabel}`}
            className="flex flex-col gap-0.5"
          >
            {treeRows.map((row) => (
              <ExplorerTreeRowView
                key={explorerRowDomKey(row)}
                row={row}
                tabIndex={
                  row.kind === "entry" && normalizeExplorerPath(row.entry.path) === rovingRowPath
                    ? 0
                    : -1
                }
                selected={
                  row.kind === "entry" &&
                  !row.entry.isDirectory &&
                  selectedPath === normalizeExplorerPath(row.entry.path)
                }
                onContextMenu={handleContextMenu}
                onEntryClick={handleEntryClick}
                onEntryFocus={handleEntryFocus}
                onEntryKeyDown={handleEntryKeyDown}
                onOpenEntry={handleOpenEntry}
                onOpenEntryMenu={openEntryMenu}
                onRowRef={registerRowElement}
                onToggleDirectory={toggleDirectory}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
