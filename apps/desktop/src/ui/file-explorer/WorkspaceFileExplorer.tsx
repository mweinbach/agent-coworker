import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FileIcon,
  MoreVerticalIcon,
} from "lucide-react";
import type { AutoAnimationPlugin } from "@formkit/auto-animate";
import { getTransitionSizes } from "@formkit/auto-animate";
import { useAutoAnimate } from "@formkit/auto-animate/react";

import { useAppStore } from "../../app/store";
import type { ExplorerEntry } from "../../app/types";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { listDirectory, showContextMenu, confirmAction, showNotification, previewOSFile } from "../../lib/desktopCommands";

export type WorkspaceFileExplorerProps = {
  workspaceId: string;
  className?: string;
};

const AUTO_REFRESH_INTERVAL_MS = 5000;
const FILE_EXPLORER_CONTROL_SELECTOR = "[data-file-explorer-control='true']";
/** Two clicks on the same folder within this window open the native folder instead of toggling twice. */
const FOLDER_DOUBLE_CLICK_MS = 320;

/** Add/remove/move keyframes for file tree rows (AutoAnimate plugin). */
const fileExplorerTreeAnimate: AutoAnimationPlugin = (el, action, coordA, coordB) => {
  const moveMs = 300;

  /**
   * Enter motion is handled in CSS (`.file-explorer-row-enter`) keyed off row-key diffs.
   * AutoAnimate's `add` often does not run meaningfully here: sibling layouts mostly take the
   * `remain` path, and `isOffscreen` skips entries inside nested scroll regions.
   */
  if (action === "add") {
    return new KeyframeEffect(el, [{ opacity: 1 }, { opacity: 1 }], { duration: 0 });
  }

  if (action === "remove") {
    return new KeyframeEffect(
      el,
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(0.96)" },
      ],
      { duration: 240, easing: "ease-out", fill: "both" },
    );
  }

  if (action === "remain" && coordA && coordB) {
    const oldCoords = coordA;
    const newCoords = coordB;
    let deltaLeft = oldCoords.left - newCoords.left;
    let deltaTop = oldCoords.top - newCoords.top;
    const deltaRight = oldCoords.left + oldCoords.width - (newCoords.left + newCoords.width);
    const deltaBottom = oldCoords.top + oldCoords.height - (newCoords.top + newCoords.height);
    if (deltaBottom === 0) deltaTop = 0;
    if (deltaRight === 0) deltaLeft = 0;
    const [widthFrom, widthTo, heightFrom, heightTo] = getTransitionSizes(el, oldCoords, newCoords);
    const start: Record<string, string> = {
      transform: `translate(${deltaLeft}px, ${deltaTop}px)`,
    };
    const end: Record<string, string> = {
      transform: "translate(0, 0)",
    };
    if (widthFrom !== widthTo) {
      start.width = `${widthFrom}px`;
      end.width = `${widthTo}px`;
    }
    if (heightFrom !== heightTo) {
      start.height = `${heightFrom}px`;
      end.height = `${heightTo}px`;
    }
    return new KeyframeEffect(el, [start, end], {
      duration: moveMs,
      easing: "ease-out",
      fill: "both",
    });
  }

  return new KeyframeEffect(el, [{ opacity: 1 }, { opacity: 1 }], { duration: 0 });
};

type DirectorySnapshot = {
  entries: ExplorerEntry[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  fingerprint: string;
};

/** In-memory listing cache per workspace root so revisiting a workspace is instant (no blank tree). */
const explorerDirectorySessionByScope = new Map<string, Record<string, DirectorySnapshot>>();
/** Parallel directory listings while prefetching (wave 1 + wave 2 under root). */
const PREFETCH_CONCURRENCY = 8;

function explorerScopeKey(workspaceId: string, rootPath: string): string {
  return `${workspaceId}:${normalizeExplorerPath(rootPath)}`;
}

function cloneDirectoryByPath(data: Record<string, DirectorySnapshot>): Record<string, DirectorySnapshot> {
  return JSON.parse(JSON.stringify(data)) as Record<string, DirectorySnapshot>;
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const queue = items.slice();
  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  };
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
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

function escapeRowKeyForSelector(key: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(key);
  }
  return key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function isTreeRowControlTarget(target: EventTarget | null): boolean {
  return Boolean(
    target &&
      typeof target === "object" &&
      "closest" in target &&
      typeof (target as { closest?: unknown }).closest === "function" &&
      (target as { closest: (selector: string) => Element | null }).closest(FILE_EXPLORER_CONTROL_SELECTOR),
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
  error: string | null
): boolean {
  return !!current && current.error === error && current.fingerprint === fingerprint;
}

export function shouldAutoRefreshExplorer(visibilityState: string, hasFocus: boolean): boolean {
  return visibilityState === "visible" && hasFocus;
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
  /** Latest directory snapshots (for expand: avoid toggling `loading` when cached data exists). */
  const directoryByPathRef = useRef<Record<string, DirectorySnapshot>>({});
  /** Tracks last folder row click for double-click → open in native explorer (no debounce delay). */
  const folderLastClickRef = useRef<{ path: string; t: number } | null>(null);
  /** Cancels stale prefetch waves when `directoryByPath` / scope changes. */
  const prefetchGenRef = useRef(0);

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
  const treeListDomRef = useRef<HTMLDivElement | null>(null);
  const [autoAnimateRef] = useAutoAnimate(fileExplorerTreeAnimate);
  const setTreeListEl = useCallback(
    (node: HTMLDivElement | null) => {
      treeListDomRef.current = node;
      autoAnimateRef(node);
    },
    [autoAnimateRef]
  );
  const [rowEnterAnimationsReady, setRowEnterAnimationsReady] = useState(false);
  const explorerRowAnimPrevRef = useRef<{ scope: string; keys: Set<string> }>({ scope: "", keys: new Set() });

  useEffect(() => {
    rootPathRef.current = rootPath;
  }, [rootPath]);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  useEffect(() => {
    directoryByPathRef.current = directoryByPath;
  }, [directoryByPath]);

  useLayoutEffect(() => {
    setRowEnterAnimationsReady(false);
  }, [workspaceId, rootPath]);

  useEffect(() => {
    if (!rootSnapshot || rootSnapshot.loading || rootSnapshot.updatedAt == null) {
      return undefined;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setRowEnterAnimationsReady(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [rootSnapshot?.loading, rootSnapshot?.updatedAt, rootPath, workspaceId]);

  useLayoutEffect(() => {
    const scope = explorerScopeKey(workspaceId, rootPath);
    const container = treeListDomRef.current;
    const keys = treeRows.map(explorerRowDomKey);
    const nextKeySet = new Set(keys);
    const bundle = explorerRowAnimPrevRef.current;

    if (bundle.scope !== scope) {
      explorerRowAnimPrevRef.current = { scope, keys: new Set(nextKeySet) };
      return;
    }

    if (!rowEnterAnimationsReady || !container) {
      explorerRowAnimPrevRef.current = { scope, keys: new Set(nextKeySet) };
      return;
    }

    const prev = bundle.keys;
    const added = keys.filter((k) => !prev.has(k));
    explorerRowAnimPrevRef.current = { scope, keys: new Set(nextKeySet) };

    if (added.length === 0) return;

    const reducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;

    for (const key of added) {
      const el = container.querySelector(`[data-file-row-key="${escapeRowKeyForSelector(key)}"]`);
      if (!(el instanceof HTMLElement)) continue;
      el.classList.remove("file-explorer-row-enter");
      void el.offsetWidth;
      el.classList.add("file-explorer-row-enter");
      const onEnd = (e: AnimationEvent) => {
        if (e.target !== el) return;
        el.classList.remove("file-explorer-row-enter");
        el.removeEventListener("animationend", onEnd);
      };
      el.addEventListener("animationend", onEnd);
    }
  }, [workspaceId, rootPath, treeRows, rowEnterAnimationsReady]);

  useEffect(() => {
    if (!explorer && workspacePath) {
      void refresh(workspaceId).catch(() => {});
    }
  }, [explorer, refresh, workspaceId, workspacePath]);

  const loadDirectory = useCallback(
    async (path: string, opts?: { background?: boolean; silent?: boolean }): Promise<boolean> => {
      const targetPath = normalizeExplorerPath(path);
      if (!targetPath) return false;

      const requestId = ++requestCounterRef.current;
      latestRequestByPathRef.current[targetPath] = requestId;

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
        const listed = await listDirectory({ path: targetPath, includeHidden: showHiddenFiles });
        const entries = sortExplorerEntries(listed);
        if (latestRequestByPathRef.current[targetPath] !== requestId) return false;

        const fingerprint = buildDirectoryFingerprint(entries);
        let changed = false;
        setDirectoryByPath((previous) => {
          const current = previous[targetPath];
          if (opts?.background && shouldReuseBackgroundDirectorySnapshot(current, fingerprint, null)) {
            return previous;
          }

          changed = true;
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
        return changed;
      } catch (error) {
        if (latestRequestByPathRef.current[targetPath] !== requestId) return false;

        const message = error instanceof Error ? error.message : String(error);
        let changed = false;
        setDirectoryByPath((previous) => {
          const current = previous[targetPath];
          if (opts?.background && shouldReuseBackgroundDirectorySnapshot(current, current?.fingerprint ?? "", message)) {
            return previous;
          }

          changed = true;
          return {
            ...previous,
            [targetPath]: {
              ...(current ?? defaultDirectorySnapshot()),
              loading: false,
              error: message,
            },
          };
        });
        return changed;
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
        const updates = await Promise.all(Array.from(paths).map((path) => loadDirectory(path, { background: true })));
        if (updates.some(Boolean)) {
          void refresh(workspaceId).catch(() => {});
        }
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
        const normalizedTarget = normalizeExplorerPath(targetPath);
        const snap = directoryByPathRef.current[normalizedTarget];
        const useBackgroundRefresh =
          !!snap && !snap.loading && !snap.error && snap.updatedAt != null;
        void loadDirectory(targetPath, useBackgroundRefresh ? { background: true } : undefined).catch(() => {});
      }
    },
    [loadDirectory]
  );

  useEffect(() => {
    if (!rootPath) return;
    const scope = explorerScopeKey(workspaceId, rootPath);
    if (scopeRef.current === scope) return;

    const prevScope = scopeRef.current;
    if (prevScope) {
      explorerDirectorySessionByScope.set(prevScope, cloneDirectoryByPath(directoryByPathRef.current));
    }

    folderLastClickRef.current = null;
    scopeRef.current = scope;

    latestRequestByPathRef.current = {};
    const normalizedRoot = normalizeExplorerPath(rootPath);
    const cached = explorerDirectorySessionByScope.get(scope);
    const nextMap = cached ? cloneDirectoryByPath(cached) : {};
    setDirectoryByPath(nextMap);
    const nextExpanded = new Set<string>([normalizedRoot]);
    expandedPathsRef.current = nextExpanded;
    setExpandedPaths(nextExpanded);
    selectFile(workspaceId, null);

    const hasCachedListings = cached && Object.keys(cached).length > 0;
    if (hasCachedListings) {
      void loadDirectory(rootPath, { background: true }).catch(() => {});
    } else {
      void loadDirectory(rootPath).catch(() => {});
    }
  }, [loadDirectory, rootPath, selectFile, workspaceId]);

  useEffect(() => {
    return () => {
      const scope = scopeRef.current;
      if (scope) {
        explorerDirectorySessionByScope.set(scope, cloneDirectoryByPath(directoryByPathRef.current));
      }
    };
  }, []);

  useEffect(() => {
    if (!rootPath) return;
    const normalizedRoot = normalizeExplorerPath(rootPath);
    const rootSnap = directoryByPath[normalizedRoot];
    if (!rootSnap || rootSnap.loading || rootSnap.error) return;

    const gen = ++prefetchGenRef.current;
    let cancelled = false;

    void (async () => {
      const silentLoad = async (dirPath: string) => {
        if (cancelled || gen !== prefetchGenRef.current) return;
        const p = normalizeExplorerPath(dirPath);
        const snap = directoryByPathRef.current[p];
        if (snap?.updatedAt != null && !snap.error) return;
        await loadDirectory(p, { silent: true });
      };

      const childDirs = rootSnap.entries.filter((e) => e.isDirectory).map((e) => normalizeExplorerPath(e.path));
      await runPool(childDirs, PREFETCH_CONCURRENCY, silentLoad);

      if (cancelled || gen !== prefetchGenRef.current) return;
      await new Promise<void>((r) => setTimeout(r, 0));

      const grand: string[] = [];
      for (const d of childDirs) {
        const snap = directoryByPathRef.current[d];
        if (!snap?.entries) continue;
        for (const e of snap.entries) {
          if (e.isDirectory) grand.push(normalizeExplorerPath(e.path));
        }
      }
      await runPool(grand, PREFETCH_CONCURRENCY, silentLoad);
    })();

    return () => {
      cancelled = true;
    };
  }, [directoryByPath, rootPath, loadDirectory]);

  useEffect(() => {
    if (!rootPath) return;
    void refreshExpandedDirectories();
  }, [rootPath, refreshExpandedDirectories, showHiddenFiles]);

  useEffect(() => {
    if (!rootPath) return;
    const interval = window.setInterval(() => {
      if (!shouldAutoRefreshExplorer(document.visibilityState, document.hasFocus())) {
        return;
      }
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

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent, entry: ExplorerEntry) => {
      e.preventDefault();
      e.stopPropagation();
      await openEntryMenu(entry);
    },
    [openEntryMenu]
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

  const handleSelectEntry = useCallback(
    (entry: ExplorerEntry) => {
      selectFile(workspaceId, entry.path);
      if (!entry.isDirectory) {
        void previewOSFile({ path: entry.path }).catch(() => {});
      }
    },
    [selectFile, workspaceId]
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
          <div className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/80 shrink-0 uppercase">Files</div>
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
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1" data-file-explorer-scroll-region="true">
        {rootSnapshot?.error ? (
          <div className="rounded bg-destructive/10 p-3 text-center text-xs text-destructive">{rootSnapshot.error}</div>
        ) : treeRows.length === 0 && (!rootSnapshot || rootSnapshot.loading) ? null : treeRows.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">This folder is empty</div>
        ) : (
          <div
            ref={setTreeListEl}
            role="tree"
            aria-label={`Workspace files for ${rootLabel}`}
            className="space-y-0.5"
          >
            {treeRows.map((row) => {
              if (row.kind === "status") {
                return (
                  <div
                    key={`${row.path}:${row.status}`}
                    data-file-row-key={explorerRowDomKey(row)}
                    className={cn(
                      "flex items-center gap-1 rounded py-1 text-[10px] transition-opacity duration-150 ease-out motion-reduce:transition-none",
                      row.status === "error" ? "text-destructive" : "text-muted-foreground"
                    )}
                    style={{ paddingLeft: `${row.depth * 0.85 + 1.15}rem` }}
                  >
                    <span className="truncate">{row.message}</span>
                  </div>
                );
              }

              const { entry, depth } = row;
              const normalizedPath = normalizeExplorerPath(entry.path);
              const isSelected = !entry.isDirectory && selectedPath === normalizedPath;
              const isDirectory = entry.isDirectory;
              const entryMeta = isDirectory
                ? `${entry.isHidden ? "Hidden folder" : "Folder"}`
                : `${formatEntrySize(entry.sizeBytes)} • ${formatModifiedAt(entry.modifiedAtMs)}${entry.isHidden ? " • hidden" : ""}`;

              return (
                <div
                  key={entry.path}
                  data-file-row-key={explorerRowDomKey(row)}
                  role="treeitem"
                  tabIndex={0}
                  aria-level={depth + 1}
                  aria-selected={isDirectory ? false : isSelected}
                  aria-expanded={isDirectory ? row.expanded : undefined}
                  className={cn(
                    "group flex cursor-pointer items-center gap-1 rounded-[9px] py-1 pr-1 text-[11.5px] transition-[color,background-color,transform] duration-150 ease-out motion-reduce:transition-none active:scale-[0.99]",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    entry.isHidden && "opacity-70"
                  )}
                  style={{ paddingLeft: `${depth * 0.85 + 0.35}rem` }}
                  onDoubleClick={(event) => {
                    if (isTreeRowControlTarget(event.target)) {
                      return;
                    }
                    if (entry.isDirectory) {
                      return;
                    }
                    handleOpenEntry(entry);
                  }}
                  onContextMenu={(event) => {
                    void handleContextMenu(event, entry);
                  }}
                  onMouseDown={(event) => {
                    if (isTreeRowControlTarget(event.target)) {
                      event.stopPropagation();
                    }
                  }}
                  onClick={(event) => {
                    if (isTreeRowControlTarget(event.target)) {
                      return;
                    }
                    if (entry.isDirectory) {
                      const now = Date.now();
                      const prev = folderLastClickRef.current;
                      if (
                        prev &&
                        prev.path === normalizedPath &&
                        now - prev.t < FOLDER_DOUBLE_CLICK_MS
                      ) {
                        folderLastClickRef.current = null;
                        void openFile(workspaceId, entry.path, false).catch(() => {});
                        return;
                      }
                      folderLastClickRef.current = { path: normalizedPath, t: now };
                      toggleDirectory(entry.path);
                      return;
                    }
                    handleSelectEntry(entry);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleOpenEntry(entry);
                      return;
                    }
                    if (event.key === " " || event.key === "Spacebar") {
                      event.preventDefault();
                      if (isDirectory) {
                        toggleDirectory(entry.path);
                      } else {
                        handleSelectEntry(entry);
                      }
                      return;
                    }
                    if (isDirectory && event.key === "ArrowRight" && !row.expanded) {
                      event.preventDefault();
                      toggleDirectory(entry.path);
                      return;
                    }
                    if (isDirectory && event.key === "ArrowLeft" && row.expanded) {
                      event.preventDefault();
                      toggleDirectory(entry.path);
                    }
                  }}
                  title={entry.path}
                >
                  {isDirectory ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={row.expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
                      className={cn(
                        "h-[18px] w-[18px] min-w-[18px] rounded p-0 transition-colors duration-150 ease-out select-none shadow-none motion-reduce:transition-none",
                        isSelected ? "hover:bg-accent-foreground/15" : "hover:bg-muted"
                      )}
                      data-file-explorer-control="true"
                      onPress={() => toggleDirectory(entry.path)}
                    >
                      <ChevronRightIcon
                        className={cn(
                          "h-3.25 w-3.25 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                          row.expanded && "rotate-90",
                        )}
                      />
                    </Button>
                  ) : (
                    <span className="inline-block h-[18px] w-[18px]" aria-hidden />
                  )}

                  {isDirectory ? (
                    row.expanded ? (
                      <FolderOpenIcon
                        className={cn(
                          "h-3.25 w-3.25 shrink-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
                          isSelected ? "text-accent-foreground" : "text-link/85",
                        )}
                      />
                    ) : (
                      <FolderIcon
                        className={cn(
                          "h-3.25 w-3.25 shrink-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
                          isSelected ? "text-accent-foreground" : "text-link/85",
                        )}
                      />
                    )
                  ) : (
                    <FileIcon className="h-3.25 w-3.25 shrink-0 transition-opacity duration-150 ease-out motion-reduce:transition-none" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{entry.name}</div>
                    <div className={cn("truncate text-[9px] leading-3.5", isSelected ? "text-accent-foreground/85" : "text-muted-foreground")}>
                      {entryMeta}
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`More options for ${entry.name}`}
                    className={cn(
                      "h-5 w-5 min-w-5 rounded p-0 opacity-0 transition-opacity select-none shadow-none",
                      isSelected ? "opacity-100 hover:bg-accent-foreground/15" : "group-hover:opacity-100 hover:bg-muted"
                    )}
                    data-file-explorer-control="true"
                    onPress={() => void openEntryMenu(entry)}
                  >
                    <MoreVerticalIcon className="h-3.25 w-3.25" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
