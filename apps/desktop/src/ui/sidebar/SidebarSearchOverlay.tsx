import { ClipboardListIcon, FolderIcon, MessageSquareIcon, SearchIcon, XIcon } from "lucide-react";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  SidebarSectionKey,
  TaskSummary,
  ThreadRecord,
  WorkspaceRecord,
} from "../../app/types";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";
import { isImeComposing } from "../../lib/keyboard";
import { cn } from "../../lib/utils";
import { formatSidebarRelativeAge } from "../sidebarHelpers";

const IS_APPLE =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/i.test(navigator.platform) ||
    /mac/i.test(
      (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "",
    ));

const MOD_SYMBOL = IS_APPLE ? "⌘" : "Ctrl+";

const PROJECT_BADGE_SLOTS = ["0", "1", "2", "3", "4", "5", "6"] as const;
type SearchBadgeSlot = (typeof PROJECT_BADGE_SLOTS)[number] | "chats";

function compactDisplayPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/");
  const withoutHome = normalized
    .replace(
      /^\/Users\/[^/]+\/Library\/Mobile Documents\/iCloud~md~obsidian\/Documents\//,
      "iCloud/Obsidian/",
    )
    .replace(/^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs\//, "iCloud/")
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~");
  if (withoutHome.length <= 44) return withoutHome;
  const parts = withoutHome.split("/").filter(Boolean);
  if (parts.length <= 2) return withoutHome;
  const prefix = withoutHome.startsWith("~") ? "~/" : "…/";
  return `${prefix}…/${parts.slice(-2).join("/")}`;
}

function getProjectBadgeSlot(id: string, index: number): SearchBadgeSlot {
  let hash = index;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return PROJECT_BADGE_SLOTS[hash % PROJECT_BADGE_SLOTS.length] ?? "0";
}

type SearchOverlayEntry =
  | {
      key: string;
      kind: "thread";
      thread: ThreadRecord;
      title: string;
      subtitle: string;
    }
  | {
      key: string;
      kind: "task";
      task: TaskSummary;
      title: string;
      subtitle: string;
    }
  | {
      key: string;
      kind: "workspace";
      workspace: WorkspaceRecord;
      title: string;
      subtitle: string;
    };

type SearchOverlayGroup = {
  id: string;
  kind: "project" | "chats";
  title: string;
  badgeSlot: SearchBadgeSlot;
  workspace?: WorkspaceRecord;
  entries: SearchOverlayEntry[];
};

export type SidebarSearchOverlayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderedSectionKeys?: SidebarSectionKey[];
  projectWorkspaces: WorkspaceRecord[];
  threadsByWorkspaceId: Map<string, ThreadRecord[]>;
  oneOffChatThreads: ThreadRecord[];
  taskSummariesByWorkspaceId: Record<string, TaskSummary[] | undefined>;
  tasksEnabled: boolean;
  selectedThreadId: string | null;
  selectedTaskId: string | null;
  selectedWorkspaceId: string | null;
  onSelectThread: (threadId: string) => void;
  onSelectTask: (taskId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
};

export const SidebarSearchOverlay = memo(function SidebarSearchOverlay({
  open,
  onOpenChange,
  projectWorkspaces,
  threadsByWorkspaceId,
  oneOffChatThreads,
  taskSummariesByWorkspaceId,
  tasksEnabled,
  selectedThreadId,
  selectedTaskId,
  selectedWorkspaceId,
  onSelectThread,
  onSelectTask,
  onSelectWorkspace,
}: SidebarSearchOverlayProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const lastPointerRef: { current: { x: number; y: number } | null } = useRef(null);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setQuery("");
        setActiveIndex(0);
        lastPointerRef.current = null;
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const searchActive = normalizedQuery.length > 0;

  const matchesSearch = useCallback(
    (value: string | undefined) => {
      if (!normalizedQuery) return true;
      return (value ?? "").toLowerCase().includes(normalizedQuery);
    },
    [normalizedQuery],
  );

  const groups = useMemo<SearchOverlayGroup[]>(() => {
    const projectGroups: SearchOverlayGroup[] = projectWorkspaces.flatMap((workspace, index) => {
      const workspaceMatches =
        searchActive && (matchesSearch(workspace.name) || matchesSearch(workspace.path));
      const matchingThreads = (threadsByWorkspaceId.get(workspace.id) ?? []).filter(
        (thread) => !searchActive || workspaceMatches || matchesSearch(thread.title || "New chat"),
      );
      const matchingTasks = tasksEnabled
        ? (taskSummariesByWorkspaceId[workspace.id] ?? []).filter(
            (task) => !searchActive || workspaceMatches || matchesSearch(task.title),
          )
        : [];

      if (
        searchActive &&
        !workspaceMatches &&
        matchingThreads.length === 0 &&
        matchingTasks.length === 0
      ) {
        return [];
      }

      const entries: SearchOverlayEntry[] = [
        ...matchingThreads.map((thread): SearchOverlayEntry => {
          const age = formatSidebarRelativeAge(thread.lastMessageAt);
          return {
            key: `thread:${thread.id}`,
            kind: "thread",
            thread,
            title: thread.title || "New chat",
            subtitle: age,
          };
        }),
        ...matchingTasks.map(
          (task): SearchOverlayEntry => ({
            key: `task:${task.id}`,
            kind: "task",
            task,
            title: task.title,
            subtitle: "Task",
          }),
        ),
      ];

      if (entries.length === 0) {
        entries.push({
          key: `workspace:${workspace.id}`,
          kind: "workspace",
          workspace,
          title: workspace.name,
          subtitle: compactDisplayPath(workspace.path),
        });
      }

      return [
        {
          id: `project:${workspace.id}`,
          kind: "project" as const,
          title: workspace.name,
          badgeSlot: getProjectBadgeSlot(workspace.id, index),
          workspace,
          entries,
        },
      ];
    });

    const matchingOneOffThreads = oneOffChatThreads.filter(
      (thread) => !searchActive || matchesSearch(thread.title || "New chat"),
    );
    const chatsGroup: SearchOverlayGroup[] =
      matchingOneOffThreads.length > 0
        ? [
            {
              id: "chats",
              kind: "chats" as const,
              title: "Chats",
              badgeSlot: "chats",
              entries: matchingOneOffThreads.map((thread): SearchOverlayEntry => {
                const age = formatSidebarRelativeAge(thread.lastMessageAt);
                return {
                  key: `thread:${thread.id}`,
                  kind: "thread",
                  thread,
                  title: thread.title || "New chat",
                  subtitle: age,
                };
              }),
            },
          ]
        : [];

    return [...projectGroups, ...chatsGroup];
  }, [
    matchesSearch,
    oneOffChatThreads,
    projectWorkspaces,
    searchActive,
    taskSummariesByWorkspaceId,
    tasksEnabled,
    threadsByWorkspaceId,
  ]);

  const flatEntries = useMemo(() => groups.flatMap((group) => group.entries), [groups]);

  // Reset or clamp active index when results change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query is an intentional re-trigger
  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedQuery]);

  const clampedActiveIndex =
    flatEntries.length === 0 ? -1 : Math.min(activeIndex, flatEntries.length - 1);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (clampedActiveIndex < 0) return;
    const el = itemRefs.current.get(clampedActiveIndex);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [clampedActiveIndex]);

  const activateEntry = useCallback(
    (entry: SearchOverlayEntry | undefined) => {
      if (!entry) return;
      if (entry.kind === "thread") {
        onSelectThread(entry.thread.id);
      } else if (entry.kind === "task") {
        onSelectTask(entry.task.id);
      } else {
        onSelectWorkspace(entry.workspace.id);
      }
      handleOpenChange(false);
    },
    [handleOpenChange, onSelectTask, onSelectThread, onSelectWorkspace],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (isImeComposing(event.nativeEvent)) return;

      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        const digit = Number.parseInt(event.key, 10);
        if (digit >= 1 && digit <= 9) {
          const target = flatEntries[digit - 1];
          if (target) {
            event.preventDefault();
            activateEntry(target);
          }
          return;
        }
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (flatEntries.length > 0) {
          setActiveIndex((current) => (current + 1) % flatEntries.length);
        }
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (flatEntries.length > 0) {
          setActiveIndex((current) => (current - 1 + flatEntries.length) % flatEntries.length);
        }
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        if (clampedActiveIndex >= 0) {
          activateEntry(flatEntries[clampedActiveIndex]);
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        handleOpenChange(false);
      }
    },
    [activateEntry, clampedActiveIndex, flatEntries, handleOpenChange],
  );

  let runningIndex = 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-sidebar-search-overlay="true"
        overlayClassName="app-spotlight-scrim duration-100 data-[state=closed]:duration-75"
        className="app-spotlight top-[18%] w-[min(600px,calc(100vw-2rem))] max-w-[600px] translate-y-0 gap-0 overflow-hidden p-0 duration-100 data-[state=closed]:duration-75 data-[state=closed]:zoom-out-100 sm:max-w-[600px]"
      >
        <DialogTitle className="sr-only">
          {tasksEnabled ? "Search chats, projects, and tasks" : "Search chats and projects"}
        </DialogTitle>

        <div className="relative flex h-14 items-center gap-3 border-b app-border-subtle px-[1.125rem]">
          <SearchIcon aria-hidden="true" className="size-5 shrink-0 opacity-50" />
          <input
            ref={inputRef}
            data-slot="command-input"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              tasksEnabled ? "Search chats, projects, and tasks…" : "Search chats and projects…"
            }
            aria-label={
              tasksEnabled ? "Search chats, projects, and tasks" : "Search chats and projects"
            }
            className="h-10 min-w-0 flex-1 border-none bg-transparent text-[1.125rem] leading-tight tracking-[-0.012em] text-foreground shadow-none outline-none placeholder:text-muted-foreground focus:shadow-none focus:outline-none focus-visible:shadow-none focus-visible:outline-none"
          />
          {searchActive ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              className="size-6 shrink-0 rounded-full app-text-muted hover:app-hover-wash hover:text-foreground"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <div
          role="listbox"
          aria-label={tasksEnabled ? "Chats, projects, and tasks" : "Chats and projects"}
          className="flex max-h-[min(24rem,56vh)] scroll-py-2 flex-col gap-2.5 overflow-x-hidden overflow-y-auto px-2.5 pt-2 pb-2.5"
        >
          {groups.length === 0 ? (
            <div role="status" className="px-3 py-8 text-center app-type-body app-text-muted">
              {searchActive ? `No matches for “${query.trim()}”` : "No chats or projects yet"}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.id} className="flex flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2 px-1.5 py-1">
                  <span
                    aria-hidden="true"
                    data-badge-slot={group.badgeSlot}
                    className="app-search-badge flex size-5 shrink-0 items-center justify-center rounded-[6px] shadow-2xs"
                  >
                    {group.kind === "project" ? (
                      <FolderIcon className="size-3 text-white" strokeWidth={2.1} />
                    ) : (
                      <MessageSquareIcon className="size-3 text-white" strokeWidth={2.1} />
                    )}
                  </span>
                  {group.workspace ? (
                    <button
                      type="button"
                      title={group.workspace.path}
                      className="flex min-w-0 items-baseline gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:opacity-80"
                      onClick={() => {
                        if (group.workspace) {
                          onSelectWorkspace(group.workspace.id);
                          handleOpenChange(false);
                        }
                      }}
                    >
                      <span className="shrink-0 app-type-body font-semibold tracking-[-0.015em] app-text-primary">
                        {group.title}
                      </span>
                      <span className="min-w-0 truncate app-type-caption app-text-muted">
                        {compactDisplayPath(group.workspace.path)}
                      </span>
                    </button>
                  ) : (
                    <span className="min-w-0 truncate px-1 app-type-body font-semibold tracking-[-0.015em] app-text-primary">
                      {group.title}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-0.5">
                  {group.entries.map((entry) => {
                    const entryIndex = runningIndex++;
                    const isActive = entryIndex === clampedActiveIndex;
                    const isCurrent =
                      (entry.kind === "thread" && entry.thread.id === selectedThreadId) ||
                      (entry.kind === "task" && entry.task.id === selectedTaskId) ||
                      (entry.kind === "workspace" &&
                        entry.workspace.id === selectedWorkspaceId &&
                        selectedThreadId === null);
                    const shortcutHint = entryIndex < 9 ? `${MOD_SYMBOL}${entryIndex + 1}` : null;

                    return (
                      <button
                        key={entry.key}
                        ref={(node) => {
                          if (node) {
                            itemRefs.current.set(entryIndex, node);
                          } else {
                            itemRefs.current.delete(entryIndex);
                          }
                        }}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        data-search-overlay-item="true"
                        data-active={isActive ? "true" : undefined}
                        className={cn(
                          "group flex w-full items-center justify-between gap-3 rounded-[0.625rem] py-2 pr-3 pl-8 text-left transition-colors focus:outline-none focus-visible:outline-none",
                          isActive ? "app-selected-row" : "hover:app-hover-wash",
                        )}
                        onMouseMove={(event) => {
                          const prev = lastPointerRef.current;
                          lastPointerRef.current = { x: event.clientX, y: event.clientY };
                          if (prev && prev.x === event.clientX && prev.y === event.clientY) {
                            return;
                          }
                          if (activeIndex !== entryIndex) {
                            setActiveIndex(entryIndex);
                          }
                        }}
                        onClick={() => activateEntry(entry)}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          {entry.kind === "task" ? (
                            <ClipboardListIcon
                              aria-hidden="true"
                              className="size-3.5 shrink-0 app-text-muted"
                            />
                          ) : null}
                          <span className="truncate app-type-body font-medium leading-snug tracking-[-0.01em] app-text-primary">
                            {entry.title}
                          </span>
                          {isCurrent ? <span className="sr-only">(current)</span> : null}
                        </span>
                        {entry.subtitle || shortcutHint ? (
                          <span className="flex shrink-0 items-center gap-2.5 text-xs tabular-nums app-text-muted">
                            {entry.subtitle ? (
                              <span className="max-w-[14rem] truncate">{entry.subtitle}</span>
                            ) : null}
                            {shortcutHint ? (
                              <span className="font-medium">{shortcutHint}</span>
                            ) : null}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 border-t app-border-subtle px-4 py-2 text-xs app-text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border app-border-subtle app-fill-subtle px-1 font-sans text-xs font-medium app-text-secondary">
                ↑
              </kbd>
              <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border app-border-subtle app-fill-subtle px-1 font-sans text-xs font-medium app-text-secondary">
                ↓
              </kbd>
            </span>
            <span>Navigate</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border app-border-subtle app-fill-subtle px-1 font-sans text-xs font-medium app-text-secondary">
              ↵
            </kbd>
            <span>Select</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border app-border-subtle app-fill-subtle px-1.5 font-sans text-xs font-medium app-text-secondary">
              esc
            </kbd>
            <span>Close</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
});
