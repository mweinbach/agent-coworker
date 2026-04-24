import { Reorder, useDragControls } from "framer-motion";
import {
  BookOpenIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PanelLeftIcon,
  Settings2Icon,
  SparklesIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  type MouseEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { resolvePluginCatalogWorkspaceSelection } from "../app/pluginManagement";
import { useAppStore } from "../app/store";
import type { ThreadRecord, ThreadRuntime, WorkspaceRecord } from "../app/types";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { confirmAction, showContextMenu } from "../lib/desktopCommands";
import { usePrefersReducedMotion } from "../lib/usePrefersReducedMotion";
import { cn } from "../lib/utils";
import { useWindowDragHandle } from "./layout/useWindowDragHandle";
import {
  formatSidebarRelativeAge,
  getVisibleSidebarThreads,
  shouldEmphasizeWorkspaceRow,
  swapSidebarItemsById,
} from "./sidebarHelpers";

const MAX_VISIBLE_THREADS = 10;
const WORKSPACE_ITEM_CLASSNAME = "sidebar-workspace-item [&:not(:last-child)]:mb-3";
/** Matches `.sidebar-thread-region` transition duration in styles.css (fallback when transitionend does not fire). */
const SIDEBAR_THREAD_REGION_DURATION_MS = 240;

/** Tight spring so sibling cards track drag swaps; `layout="position"` avoids height cross-fade when rows differ (expanded threads). */
const WORKSPACE_REORDER_LAYOUT_TRANSITION = {
  layout: {
    type: "spring" as const,
    stiffness: 520,
    damping: 38,
    mass: 0.85,
  },
};

type WorkspaceMoveDirection = "up" | "down";

type SidebarWorkspaceItemProps = {
  active: boolean;
  editInputRef: RefObject<HTMLInputElement | null>;
  editingThreadId: string | null;
  editingTitle: string;
  emphasizeWorkspace: boolean;
  expanded: boolean;
  hiddenThreadCount: number;
  moveWorkspace: (workspaceId: string, direction: WorkspaceMoveDirection) => void;
  onCancelRename: () => void;
  onCommitRename: (threadId: string, title: string) => void;
  onEditingTitleChange: (title: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onStartEditing: (threadId: string, currentTitle: string) => void;
  onThreadContextMenu: (event: MouseEvent<HTMLElement>, threadId: string, title: string) => void;
  onToggleThreadList: (workspaceId: string) => void;
  onWorkspaceContextMenu: (
    event: MouseEvent<HTMLElement>,
    workspaceId: string,
    workspaceName: string,
  ) => void;
  onWorkspaceOpenChange: (workspaceId: string, nextOpen: boolean) => void;
  reorderEnabled: boolean;
  selectedThreadId: string | null;
  selectThread: (threadId: string) => void;
  showAllThreads: boolean;
  threadRuntimeById: Record<string, ThreadRuntime | undefined>;
  visibleThreads: ThreadRecord[];
  workspace: WorkspaceRecord;
  workspaceThreads: ThreadRecord[];
};

const SidebarWorkspaceItem = memo(function SidebarWorkspaceItem({
  active,
  editInputRef,
  editingThreadId,
  editingTitle,
  emphasizeWorkspace,
  expanded,
  hiddenThreadCount,
  moveWorkspace,
  onCancelRename,
  onCommitRename,
  onEditingTitleChange,
  onSelectWorkspace,
  onStartEditing,
  onThreadContextMenu,
  onToggleThreadList,
  onWorkspaceContextMenu,
  onWorkspaceOpenChange,
  reorderEnabled,
  selectedThreadId,
  selectThread,
  showAllThreads,
  threadRuntimeById,
  visibleThreads,
  workspace,
  workspaceThreads,
}: SidebarWorkspaceItemProps) {
  const controls = useDragControls();
  const prefersReducedMotion = usePrefersReducedMotion();
  const threadRegionRef = useRef<HTMLDivElement | null>(null);
  const prevExpandedRef = useRef(expanded);
  const [renderThreadRegion, setRenderThreadRegion] = useState(expanded);
  const [threadRegionOpen, setThreadRegionOpen] = useState(expanded);

  useLayoutEffect(() => {
    const wasExpanded = prevExpandedRef.current;
    prevExpandedRef.current = expanded;

    if (expanded) {
      if (prefersReducedMotion) {
        setRenderThreadRegion(true);
        setThreadRegionOpen(true);
        return;
      }
      if (wasExpanded) {
        setRenderThreadRegion(true);
        return;
      }
      setRenderThreadRegion(true);
      setThreadRegionOpen(false);
      return;
    }

    setThreadRegionOpen(false);
    if (prefersReducedMotion) {
      setRenderThreadRegion(false);
    }
  }, [expanded, prefersReducedMotion]);

  useLayoutEffect(() => {
    if (!expanded || prefersReducedMotion) return;
    if (!renderThreadRegion || threadRegionOpen) return;

    void threadRegionRef.current?.offsetHeight;

    let raf2: number | undefined;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setThreadRegionOpen(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== undefined) cancelAnimationFrame(raf2);
    };
  }, [expanded, prefersReducedMotion, renderThreadRegion, threadRegionOpen]);

  useEffect(() => {
    if (expanded) return;
    if (prefersReducedMotion) return;

    const node = threadRegionRef.current;
    const fallbackMs = SIDEBAR_THREAD_REGION_DURATION_MS + 48;
    let finished = false;
    const finishUnmount = () => {
      if (finished) return;
      finished = true;
      setRenderThreadRegion(false);
    };

    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== node) return;
      if (event.propertyName !== "grid-template-rows") return;
      finishUnmount();
    };

    node?.addEventListener("transitionend", onTransitionEnd);
    const timeoutId = window.setTimeout(finishUnmount, fallbackMs);

    return () => {
      node?.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(timeoutId);
    };
  }, [expanded, prefersReducedMotion]);

  const content = (
    <Collapsible
      className="flex flex-col"
      onContextMenu={(event) => onWorkspaceContextMenu(event, workspace.id, workspace.name)}
      onOpenChange={(nextOpen) => onWorkspaceOpenChange(workspace.id, nextOpen)}
      open={expanded}
      title={workspace.path}
    >
      <div
        className={cn(
          "sidebar-workspace-card flex items-center gap-1 rounded-lg px-1 py-0.5",
          reorderEnabled && "sidebar-workspace-card--reorderable",
          emphasizeWorkspace
            ? "border-border/45 bg-foreground/[0.05] text-foreground"
            : active
              ? "text-foreground hover:bg-foreground/[0.03]"
              : "text-foreground/78 hover:bg-foreground/[0.03] hover:text-foreground",
        )}
        onPointerDownCapture={
          reorderEnabled
            ? (event) => {
                if (event.button !== 0) {
                  return;
                }
                const target = event.target as HTMLElement;
                if (target.closest("button, input, a, textarea")) {
                  return;
                }
                controls.start(event);
              }
            : undefined
        }
      >
        <CollapsibleTrigger asChild>
          <Button
            aria-label={expanded ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
            className="sidebar-symbol-slot group h-6 w-6 shrink-0 rounded-md bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent"
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {expanded ? (
              <FolderOpenIcon className="sidebar-symbol-default h-4 w-4" />
            ) : (
              <FolderIcon className="sidebar-symbol-default h-4 w-4" />
            )}
            <ChevronRightIcon
              className={cn(
                "sidebar-symbol-hover sidebar-chevron absolute h-4 w-4",
                expanded ? "rotate-90 text-foreground" : "rotate-0",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <Button
          aria-keyshortcuts={
            reorderEnabled ? "Alt+ArrowUp Alt+ArrowDown Meta+ArrowUp Meta+ArrowDown" : undefined
          }
          className="sidebar-lift flex h-auto min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left"
          onKeyDown={
            reorderEnabled
              ? (event) => {
                  if (!(event.altKey || event.metaKey)) {
                    return;
                  }
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
                    return;
                  }
                  event.preventDefault();
                  moveWorkspace(workspace.id, event.key === "ArrowUp" ? "up" : "down");
                }
              : undefined
          }
          onClick={() => onSelectWorkspace(workspace.id)}
          title={workspace.path}
          type="button"
          variant="ghost"
        >
          <span className="block min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.015em]">
            {workspace.name}
          </span>
        </Button>
      </div>

      {renderThreadRegion ? (
        <div
          ref={threadRegionRef}
          className="sidebar-thread-region"
          data-state={threadRegionOpen ? "open" : "closed"}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="ml-3 space-y-1 border-l border-border/45 pl-3 pt-1">
              {workspaceThreads.length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-muted-foreground">No sessions yet</div>
              ) : (
                <>
                  {visibleThreads.map((thread) => {
                    const runtime = threadRuntimeById[thread.id];
                    const busy = runtime?.busy === true;
                    const isActive = thread.id === selectedThreadId;
                    const isEditing = editingThreadId === thread.id;
                    const displayTitle = thread.title || "New thread";
                    const ageLabel = formatSidebarRelativeAge(thread.lastMessageAt);

                    return isEditing ? (
                      <div
                        key={thread.id}
                        className="sidebar-thread-item flex w-full items-center gap-2.5 rounded-lg border border-border/40 bg-foreground/[0.04] px-2.5 py-1.5 text-left text-foreground"
                      >
                        <Input
                          ref={editInputRef}
                          className="min-w-0 w-full h-7 rounded-md border-border/70 text-[13px] shadow-none [&_[data-slot=input]]:h-7 [&_[data-slot=input]]:px-2 [&_[data-slot=input]]:text-[13px]"
                          value={editingTitle}
                          onBlur={() => onCommitRename(thread.id, editingTitle)}
                          onChange={(event) => onEditingTitleChange(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              onCommitRename(thread.id, editingTitle);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              onCancelRename();
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <Button
                        key={thread.id}
                        className={cn(
                          "sidebar-thread-item sidebar-lift flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left",
                          isActive
                            ? "border-border/45 bg-foreground/[0.05] text-foreground"
                            : "text-foreground/82 hover:border-border/35 hover:bg-foreground/[0.035] hover:text-foreground",
                        )}
                        onClick={() => selectThread(thread.id)}
                        onContextMenu={(event) =>
                          onThreadContextMenu(event, thread.id, displayTitle)
                        }
                        onDoubleClick={() => onStartEditing(thread.id, displayTitle)}
                        type="button"
                        variant="ghost"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium tracking-[-0.018em]">
                            {displayTitle}
                          </span>
                        </span>

                        <span className="flex shrink-0 items-center gap-2 pl-2">
                          {busy ? (
                            <span
                              className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse"
                              aria-hidden="true"
                            />
                          ) : null}
                          {ageLabel ? (
                            <span className="text-[11px] font-medium text-muted-foreground">
                              {ageLabel}
                            </span>
                          ) : null}
                        </span>
                      </Button>
                    );
                  })}

                  {workspaceThreads.length > MAX_VISIBLE_THREADS ? (
                    <Button
                      className="sidebar-lift px-2.5 py-1 text-left text-[12px] font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
                      onClick={() => onToggleThreadList(workspace.id)}
                      type="button"
                      variant="ghost"
                    >
                      {showAllThreads ? "Show less" : `Show ${hiddenThreadCount} more`}
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </Collapsible>
  );

  if (!reorderEnabled) {
    return <div className={WORKSPACE_ITEM_CLASSNAME}>{content}</div>;
  }

  return (
    <Reorder.Item
      as="div"
      className={WORKSPACE_ITEM_CLASSNAME}
      dragControls={controls}
      dragListener={false}
      layout="position"
      transition={WORKSPACE_REORDER_LAYOUT_TRANSITION}
      value={workspace}
    >
      {content}
    </Reorder.Item>
  );
});

export const Sidebar = memo(function Sidebar() {
  const platform =
    typeof document !== "undefined" ? document.documentElement.dataset.platform : undefined;
  const isWin32 = platform === "win32";
  const view = useAppStore((s) => s.view);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const pluginManagementWorkspaceId = useAppStore((s) => s.pluginManagementWorkspaceId);
  const pluginManagementMode = useAppStore((s) => s.pluginManagementMode);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);
  const desktopFeatures = useAppStore((s) => s.desktopFeatureFlags);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const setWorkspacesOrder = useAppStore((s) => s.setWorkspacesOrder);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const setPluginManagementWorkspace = useAppStore((s) => s.setPluginManagementWorkspace);
  const newThread = useAppStore((s) => s.newThread);
  const removeThread = useAppStore((s) => s.removeThread);
  const deleteThreadHistory = useAppStore((s) => s.deleteThreadHistory);
  const selectThread = useAppStore((s) => s.selectThread);
  const renameThread = useAppStore((s) => s.renameThread);
  const openSkills = useAppStore((s) => s.openSkills);
  const openResearch = useAppStore((s) => s.openResearch);
  const openSettings = useAppStore((s) => s.openSettings);

  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [expandedWorkspaceSections, setExpandedWorkspaceSections] = useState<
    Record<string, boolean>
  >({});
  const [expandedThreadLists, setExpandedThreadLists] = useState<Record<string, boolean>>({});
  const editInputRef = useRef<HTMLInputElement>(null);

  const pluginSelection = useMemo(
    () =>
      resolvePluginCatalogWorkspaceSelection({
        workspaces,
        selectedWorkspaceId,
        pluginManagementWorkspaceId,
        pluginManagementMode,
      }),
    [pluginManagementMode, pluginManagementWorkspaceId, selectedWorkspaceId, workspaces],
  );
  const workspacePickerEnabled = desktopFeatures.workspacePicker !== false;
  const workspaceLifecycleEnabled = desktopFeatures.workspaceLifecycle !== false;
  const activeWorkspaceId =
    view === "skills"
      ? pluginSelection.displayWorkspaceId
      : view === "research"
        ? null
        : selectedWorkspaceId;
  const sidebarSelectedThreadId = view === "research" ? null : selectedThreadId;
  const visibleWorkspaces = useMemo(() => {
    if (workspacePickerEnabled || workspaces.length <= 1) {
      return workspaces;
    }
    if (activeWorkspaceId) {
      const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
      if (activeWorkspace) {
        return [activeWorkspace];
      }
    }
    return workspaces[0] ? [workspaces[0]] : [];
  }, [activeWorkspaceId, workspacePickerEnabled, workspaces]);

  useEffect(() => {
    if (editingThreadId) {
      const input = editInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }
  }, [editingThreadId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    setExpandedWorkspaceSections((current) =>
      current[activeWorkspaceId] !== undefined
        ? current
        : { ...current, [activeWorkspaceId]: true },
    );
  }, [activeWorkspaceId]);

  const commitRename = useCallback(
    (threadId: string, title: string) => {
      const trimmed = title.trim();
      if (trimmed) {
        renameThread(threadId, trimmed);
      }
      setEditingThreadId(null);
      setEditingTitle("");
    },
    [renameThread],
  );

  const cancelRename = useCallback(() => {
    setEditingThreadId(null);
    setEditingTitle("");
  }, []);

  const startEditing = useCallback((threadId: string, currentTitle: string) => {
    setEditingThreadId(threadId);
    setEditingTitle(currentTitle);
  }, []);

  const threadsByWorkspaceId = useMemo(() => {
    const grouped = new Map<string, typeof threads>();
    for (const thread of threads) {
      const bucket = grouped.get(thread.workspaceId);
      if (bucket) {
        bucket.push(thread);
      } else {
        grouped.set(thread.workspaceId, [thread]);
      }
    }

    for (const [workspaceId, workspaceThreads] of grouped.entries()) {
      grouped.set(
        workspaceId,
        [...workspaceThreads].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
      );
    }

    return grouped;
  }, [threads]);

  const toggleThreadList = useCallback((workspaceId: string) => {
    setExpandedThreadLists((current) => ({
      ...current,
      [workspaceId]: !current[workspaceId],
    }));
  }, []);

  const reorderEnabled = workspaceLifecycleEnabled && visibleWorkspaces.length > 1;

  const handleWorkspaceOpenChange = useCallback((workspaceId: string, nextOpen: boolean) => {
    setExpandedWorkspaceSections((current) => ({
      ...current,
      [workspaceId]: nextOpen,
    }));
  }, []);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      void selectThread(threadId);
    },
    [selectThread],
  );

  const handleReorder = useCallback(
    (nextWorkspaces: WorkspaceRecord[]) => {
      void setWorkspacesOrder(nextWorkspaces.map((workspace) => workspace.id));
    },
    [setWorkspacesOrder],
  );

  const moveWorkspace = useCallback(
    (workspaceId: string, direction: WorkspaceMoveDirection) => {
      const nextWorkspaces = swapSidebarItemsById(workspaces, workspaceId, direction);
      if (nextWorkspaces === workspaces) {
        return;
      }
      void setWorkspacesOrder(nextWorkspaces.map((workspace) => workspace.id));
    },
    [setWorkspacesOrder, workspaces],
  );

  const handleSelectWorkspace = useCallback(
    (workspaceId: string) => {
      void (view === "skills"
        ? setPluginManagementWorkspace(workspaceId)
        : selectWorkspace(workspaceId));
    },
    [selectWorkspace, setPluginManagementWorkspace, view],
  );

  const handleWorkspaceContextMenu = async (
    e: MouseEvent<HTMLElement>,
    wsId: string,
    wsName: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const result = await showContextMenu([
      { id: "select", label: "Select workspace" },
      ...(workspaceLifecycleEnabled ? [{ id: "remove", label: "Remove workspace" }] : []),
    ]);

    if (result === "select") {
      void (view === "skills" ? setPluginManagementWorkspace(wsId) : selectWorkspace(wsId));
    } else if (result === "remove") {
      const confirmed = await confirmAction({
        title: "Remove workspace",
        message: `Remove workspace "${wsName}"?`,
        detail: "This only removes it from Cowork. Files on disk are unchanged.",
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        kind: "warning",
        defaultAction: "cancel",
      });
      if (confirmed) {
        void removeWorkspace(wsId);
      }
    }
  };

  const handleThreadContextMenu = async (
    e: MouseEvent<HTMLElement>,
    tId: string,
    tTitle: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const result = await showContextMenu([
      { id: "select", label: "Open thread" },
      { id: "rename", label: "Rename thread" },
      { id: "remove", label: "Remove thread" },
      { id: "delete_history", label: "Delete session history" },
    ]);

    if (result === "select") {
      void selectThread(tId);
    } else if (result === "rename") {
      startEditing(tId, tTitle);
    } else if (result === "remove") {
      const confirmed = await confirmAction({
        title: "Remove session",
        message: `Remove session "${tTitle}"?`,
        detail: "The chat transcript will be removed from this desktop app.",
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        kind: "warning",
        defaultAction: "cancel",
      });
      if (confirmed) {
        void removeThread(tId);
      }
    } else if (result === "delete_history") {
      const confirmed = await confirmAction({
        title: "Delete session history",
        message: `Delete session history for "${tTitle}"?`,
        detail: "This removes local transcript and server-side history for this session.",
        confirmLabel: "Delete history",
        cancelLabel: "Cancel",
        kind: "error",
        defaultAction: "cancel",
      });
      if (confirmed) {
        void deleteThreadHistory(tId);
      }
    }
  };

  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const win32TitlebandButtonDragHandle = useWindowDragHandle<HTMLButtonElement>(isWin32);
  const workspaceItems = visibleWorkspaces.map((workspace) => {
    const active = workspace.id === activeWorkspaceId;
    const expanded = expandedWorkspaceSections[workspace.id] ?? false;
    const workspaceThreads = threadsByWorkspaceId.get(workspace.id) ?? [];
    const emphasizeWorkspace = shouldEmphasizeWorkspaceRow(
      active,
      sidebarSelectedThreadId,
      workspaceThreads.map((thread) => thread.id),
    );
    const showAllThreads = expandedThreadLists[workspace.id] === true;
    const { visibleThreads, hiddenThreadCount } = getVisibleSidebarThreads(
      workspaceThreads,
      showAllThreads,
      MAX_VISIBLE_THREADS,
    );

    return (
      <SidebarWorkspaceItem
        key={workspace.id}
        active={active}
        editInputRef={editInputRef}
        editingThreadId={editingThreadId}
        editingTitle={editingTitle}
        emphasizeWorkspace={emphasizeWorkspace}
        expanded={expanded}
        hiddenThreadCount={hiddenThreadCount}
        moveWorkspace={moveWorkspace}
        onCancelRename={cancelRename}
        onCommitRename={commitRename}
        onEditingTitleChange={setEditingTitle}
        onSelectWorkspace={handleSelectWorkspace}
        onStartEditing={startEditing}
        onThreadContextMenu={handleThreadContextMenu}
        onToggleThreadList={toggleThreadList}
        onWorkspaceContextMenu={handleWorkspaceContextMenu}
        onWorkspaceOpenChange={handleWorkspaceOpenChange}
        reorderEnabled={reorderEnabled}
        selectedThreadId={sidebarSelectedThreadId}
        selectThread={handleSelectThread}
        showAllThreads={showAllThreads}
        threadRuntimeById={threadRuntimeById}
        visibleThreads={visibleThreads}
        workspace={workspace}
        workspaceThreads={workspaceThreads}
      />
    );
  });

  return (
    <aside className="app-sidebar sidebar-rail-enter relative flex h-full w-full flex-col gap-1.5 px-2 pt-1.5 pb-3">
      <div className="app-sidebar__titleband">
        <div className="app-sidebar__titleband-drag-zone" aria-hidden="true" />
        <div className="app-sidebar__titleband-row flex w-full items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "sidebar-lift h-8 min-w-0 flex-1 justify-start rounded-lg px-2.5 text-[13px] font-medium tracking-[-0.015em] text-foreground/80",
              "hover:bg-foreground/[0.045] hover:text-foreground",
            )}
            onClick={() => void newThread()}
            {...win32TitlebandButtonDragHandle}
          >
            <SquarePenIcon className="h-4 w-4 text-muted-foreground" />
            New Chat
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={toggleSidebar}
            title="Hide sidebar"
            aria-label="Hide sidebar"
            className="app-sidebar__collapse-toggle sidebar-lift ml-auto shrink-0 text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground"
            {...win32TitlebandButtonDragHandle}
          >
            <PanelLeftIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <nav className="grid w-full gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "sidebar-lift h-8 w-full min-w-0 justify-start rounded-lg px-2.5 text-[13px] font-medium tracking-[-0.015em] text-foreground/80",
            "hover:bg-foreground/[0.045] hover:text-foreground",
            view === "research" && "bg-foreground/[0.055] text-foreground",
          )}
          onClick={() => void openResearch()}
        >
          <BookOpenIcon className="h-4 w-4 text-muted-foreground" />
          Research
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "sidebar-lift h-8 w-full min-w-0 justify-start rounded-lg px-2.5 text-[13px] font-medium tracking-[-0.015em] text-foreground/80",
            "hover:bg-foreground/[0.045] hover:text-foreground",
            view === "skills" && "bg-foreground/[0.055] text-foreground",
          )}
          onClick={() => void openSkills()}
        >
          <SparklesIcon className="h-4 w-4 text-muted-foreground" />
          Plugins
        </Button>
      </nav>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <div className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            Workspaces
          </div>
          {workspaceLifecycleEnabled ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="sidebar-lift size-6 rounded-md text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground"
              onClick={() => void addWorkspace()}
              aria-label="Add workspace"
            >
              <FolderPlusIcon className="h-4 w-4" />
            </Button>
          ) : null}
        </div>

        {workspaces.length === 0 ? (
          <div className="min-h-0 flex-1 overflow-auto pr-1">
            <div className="rounded-xl border border-border/55 bg-foreground/[0.03] px-4 py-4 text-center text-xs text-muted-foreground">
              <FolderPlusIcon
                strokeWidth={1.5}
                className="mx-auto mb-2 h-6 w-6 text-muted-foreground/70"
              />
              <div>No workspaces yet</div>
              {workspaceLifecycleEnabled ? (
                <Button
                  className="mt-3 h-7 rounded-lg px-3"
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void addWorkspace()}
                >
                  Add workspace
                </Button>
              ) : null}
            </div>
          </div>
        ) : reorderEnabled ? (
          <Reorder.Group
            as="div"
            axis="y"
            className="min-h-0 flex-1 overflow-auto pr-1"
            layoutScroll
            onReorder={handleReorder}
            values={visibleWorkspaces}
          >
            {workspaceItems}
          </Reorder.Group>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto pr-1">{workspaceItems}</div>
        )}
      </section>

      <div className="border-t border-border/60 pt-2">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "sidebar-lift h-8 w-full justify-start rounded-lg px-2.5 text-[13px] font-medium tracking-[-0.015em] text-foreground/78",
            "hover:bg-foreground/[0.045] hover:text-foreground",
            view === "settings" && "bg-foreground/[0.055] text-foreground",
          )}
          type="button"
          onClick={() => void openSettings()}
        >
          <Settings2Icon className="h-4 w-4 text-muted-foreground" />
          Settings
        </Button>
      </div>
    </aside>
  );
});
