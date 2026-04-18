import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";

import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  Settings2Icon,
  SquarePenIcon,
  SparklesIcon,
} from "lucide-react";

import { resolvePluginCatalogWorkspaceSelection } from "../app/pluginManagement";
import { useAppStore } from "../app/store";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { confirmAction, showContextMenu } from "../lib/desktopCommands";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { formatSidebarRelativeAge, getVisibleSidebarThreads, shouldEmphasizeWorkspaceRow } from "./sidebarHelpers";
import { useWindowDragHandle } from "./layout/useWindowDragHandle";

const MAX_VISIBLE_THREADS = 10;

function formatWorkspaceMeta(opts: {
  threadCount: number;
  isActive: boolean;
  view: "chat" | "skills" | "settings";
  isCurrentThreadWorkspace: boolean;
  isStarting: boolean;
  hasError: boolean;
}): string {
  if (opts.hasError) return "Connection issue";
  if (opts.isStarting) return "Starting workspace";

  const sessionLabel = opts.threadCount === 1 ? "1 session" : `${opts.threadCount} sessions`;

  if (opts.isActive && opts.view === "skills") {
    return `${sessionLabel} · viewing plugins`;
  }
  if (opts.isCurrentThreadWorkspace) {
    return `${sessionLabel} · current chat`;
  }
  if (opts.threadCount === 0) {
    return "No sessions yet";
  }
  return sessionLabel;
}

export const Sidebar = memo(function Sidebar() {
  const platform = typeof document !== "undefined" ? document.documentElement.dataset.platform : undefined;
  const isWin32 = platform === "win32";
  const view = useAppStore((s) => s.view);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const pluginManagementWorkspaceId = useAppStore((s) => s.pluginManagementWorkspaceId);
  const pluginManagementMode = useAppStore((s) => s.pluginManagementMode);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);
  const desktopFeatures = useAppStore((s) => s.desktopFeatureFlags);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const reorderWorkspaces = useAppStore((s) => s.reorderWorkspaces);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const setPluginManagementWorkspace = useAppStore((s) => s.setPluginManagementWorkspace);
  const newThread = useAppStore((s) => s.newThread);
  const removeThread = useAppStore((s) => s.removeThread);
  const deleteThreadHistory = useAppStore((s) => s.deleteThreadHistory);
  const selectThread = useAppStore((s) => s.selectThread);
  const renameThread = useAppStore((s) => s.renameThread);
  const openSkills = useAppStore((s) => s.openSkills);
  const openSettings = useAppStore((s) => s.openSettings);

  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [expandedWorkspaceSections, setExpandedWorkspaceSections] = useState<Record<string, boolean>>({});
  const [expandedThreadLists, setExpandedThreadLists] = useState<Record<string, boolean>>({});
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [dropTargetWorkspaceId, setDropTargetWorkspaceId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const pluginSelection = useMemo(() => resolvePluginCatalogWorkspaceSelection({
    workspaces,
    selectedWorkspaceId,
    pluginManagementWorkspaceId,
    pluginManagementMode,
  }), [pluginManagementMode, pluginManagementWorkspaceId, selectedWorkspaceId, workspaces]);
  const workspacePickerEnabled = desktopFeatures.workspacePicker !== false;
  const workspaceLifecycleEnabled = desktopFeatures.workspaceLifecycle !== false;
  const activeWorkspaceId = view === "skills"
    ? pluginSelection.displayWorkspaceId
    : selectedWorkspaceId;

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

  const handleWorkspaceDragStart = useCallback((event: DragEvent<HTMLElement>, workspaceId: string) => {
    setDraggedWorkspaceId(workspaceId);
    setDropTargetWorkspaceId(workspaceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", workspaceId);
  }, []);

  const handleWorkspaceDragOver = useCallback((event: DragEvent<HTMLElement>, workspaceId: string) => {
    if (!draggedWorkspaceId || draggedWorkspaceId === workspaceId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetWorkspaceId(workspaceId);
  }, [draggedWorkspaceId]);

  const clearWorkspaceDragState = useCallback(() => {
    setDraggedWorkspaceId(null);
    setDropTargetWorkspaceId(null);
  }, []);

  const handleWorkspaceDrop = useCallback(async (event: DragEvent<HTMLElement>, targetWorkspaceId: string) => {
    event.preventDefault();
    const sourceWorkspaceId = draggedWorkspaceId || event.dataTransfer.getData("text/plain");
    clearWorkspaceDragState();
    if (!sourceWorkspaceId || sourceWorkspaceId === targetWorkspaceId) {
      return;
    }
    await reorderWorkspaces(sourceWorkspaceId, targetWorkspaceId);
  }, [clearWorkspaceDragState, draggedWorkspaceId, reorderWorkspaces]);

  const handleWorkspaceContextMenu = async (e: MouseEvent, wsId: string, wsName: string) => {
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

  const handleThreadContextMenu = async (e: MouseEvent, tId: string, tTitle: string) => {
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
          <div className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">Workspaces</div>
          {workspacePickerEnabled ? (
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

        <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
          {workspaces.length === 0 ? (
            <div className="rounded-xl border border-border/55 bg-foreground/[0.03] px-4 py-4 text-center text-xs text-muted-foreground">
              <FolderPlusIcon strokeWidth={1.5} className="mx-auto mb-2 h-6 w-6 text-muted-foreground/70" />
              <div>No workspaces yet</div>
              {workspacePickerEnabled ? (
                <Button className="mt-3 h-7 rounded-lg px-3" size="sm" variant="outline" type="button" onClick={() => void addWorkspace()}>
                  Add workspace
                </Button>
              ) : null}
            </div>
          ) : (
            workspaces.map((workspace) => {
              const active = workspace.id === activeWorkspaceId;
              const expanded = expandedWorkspaceSections[workspace.id] ?? false;
              const workspaceRuntime = workspaceRuntimeById[workspace.id];
              const workspaceThreads = threadsByWorkspaceId.get(workspace.id) ?? [];
              const threadCount = workspaceThreads.length;
              const isCurrentThreadWorkspace = selectedThreadId !== null
                && workspaceThreads.some((thread) => thread.id === selectedThreadId);
              const emphasizeWorkspace = shouldEmphasizeWorkspaceRow(
                active,
                selectedThreadId,
                workspaceThreads.map((thread) => thread.id),
              );
              const showAllThreads = expandedThreadLists[workspace.id] === true;
              const { visibleThreads, hiddenThreadCount } = getVisibleSidebarThreads(
                workspaceThreads,
                showAllThreads,
                MAX_VISIBLE_THREADS,
              );
              const workspaceMeta = formatWorkspaceMeta({
                threadCount,
                isActive: active,
                view,
                isCurrentThreadWorkspace,
                isStarting: workspaceRuntime?.starting === true,
                hasError: workspaceRuntime?.error !== null && workspaceRuntime?.error !== undefined,
              });

              return (
                <Collapsible
                  key={workspace.id}
                  className="space-y-1.5"
                  data-dragging={draggedWorkspaceId === workspace.id ? "true" : "false"}
                  data-drop-target={
                    dropTargetWorkspaceId === workspace.id && draggedWorkspaceId !== workspace.id ? "true" : "false"
                  }
                  draggable={workspaces.length > 1}
                  onContextMenu={(e) => handleWorkspaceContextMenu(e, workspace.id, workspace.name)}
                  onDragEnd={clearWorkspaceDragState}
                  onDragOver={(event: DragEvent<HTMLDivElement>) => handleWorkspaceDragOver(event, workspace.id)}
                  onDragStart={(event: DragEvent<HTMLDivElement>) => handleWorkspaceDragStart(event, workspace.id)}
                  onDrop={(event: DragEvent<HTMLDivElement>) => void handleWorkspaceDrop(event, workspace.id)}
                  onOpenChange={(nextOpen) => {
                    setExpandedWorkspaceSections((current) => ({
                      ...current,
                      [workspace.id]: nextOpen,
                    }));
                  }}
                  open={expanded}
                  title={workspace.path}
                >
                  <div
                    className={cn(
                      "sidebar-workspace-card flex items-center gap-1 rounded-lg px-1 py-1",
                      emphasizeWorkspace
                        ? "border-border/45 bg-foreground/[0.05] text-foreground"
                        : active
                          ? "text-foreground hover:bg-foreground/[0.03]"
                          : "text-foreground/78 hover:bg-foreground/[0.03] hover:text-foreground",
                      dropTargetWorkspaceId === workspace.id &&
                        draggedWorkspaceId !== workspace.id &&
                        "bg-foreground/[0.08] ring-1 ring-foreground/10",
                    )}
                  >
                    <CollapsibleTrigger asChild>
                      <Button
                        aria-label={expanded ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
                        className="sidebar-symbol-slot group h-6 w-6 shrink-0 rounded-md bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent"
                        size="icon-sm"
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
                      className="sidebar-lift flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left"
                      onClick={() => void (view === "skills"
                        ? setPluginManagementWorkspace(workspace.id)
                        : selectWorkspace(workspace.id))}
                      title={workspace.path}
                      type="button"
                      variant="ghost"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium tracking-[-0.015em]">{workspace.name}</span>
                        <span className="mt-0.5 block truncate text-[11px] font-medium text-muted-foreground">
                          {workspaceMeta}
                        </span>
                      </span>
                    </Button>
                  </div>

                  <CollapsibleContent className="sidebar-thread-region overflow-hidden">
                    <div className="ml-3 space-y-1 border-l border-border/45 pl-3 pt-1">
                      {workspaceThreads.length === 0 ? (
                        <div
                          className={cn(
                            "px-3 py-2 text-[12px] text-muted-foreground transition-[opacity,transform] duration-200",
                            expanded ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
                          )}
                        >
                          No sessions yet
                        </div>
                      ) : (
                        <>
                          {visibleThreads.map((thread, index) => {
                            const runtime = threadRuntimeById[thread.id];
                            const busy = runtime?.busy === true;
                            const isActive = thread.id === selectedThreadId;
                            const isEditing = editingThreadId === thread.id;
                            const displayTitle = thread.title || "New thread";
                            const ageLabel = formatSidebarRelativeAge(thread.lastMessageAt);

                            return (
                              isEditing ? (
                                <div
                                  key={thread.id}
                                  className={cn(
                                    "sidebar-thread-item flex w-full items-center gap-2.5 rounded-lg border border-border/40 bg-foreground/[0.04] px-2.5 py-1.5 text-left text-foreground",
                                    expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
                                  )}
                                  style={{ transitionDelay: expanded ? `${Math.min(index, 6) * 26}ms` : "0ms" }}
                                >
                                  <Input
                                    ref={editInputRef}
                                    className="min-w-0 w-full h-7 rounded-md border-border/70 text-[13px] shadow-none [&_[data-slot=input]]:h-7 [&_[data-slot=input]]:px-2 [&_[data-slot=input]]:text-[13px]"
                                    value={editingTitle}
                                    onBlur={() => commitRename(thread.id, editingTitle)}
                                    onChange={(e) => setEditingTitle(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    onDoubleClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.preventDefault();
                                        commitRename(thread.id, editingTitle);
                                      } else if (e.key === "Escape") {
                                        e.preventDefault();
                                        cancelRename();
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
                                    expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
                                  )}
                                  onClick={() => void selectThread(thread.id)}
                                  onContextMenu={(e) => handleThreadContextMenu(e, thread.id, displayTitle)}
                                  onDoubleClick={() => startEditing(thread.id, displayTitle)}
                                  style={{ transitionDelay: expanded ? `${Math.min(index, 6) * 26}ms` : "0ms" }}
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
                                      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
                                    ) : null}
                                    {ageLabel ? (
                                      <span className="text-[11px] font-medium text-muted-foreground">{ageLabel}</span>
                                    ) : null}
                                  </span>
                                </Button>
                              )
                            );
                          })}

                          {workspaceThreads.length > MAX_VISIBLE_THREADS ? (
                            <Button
                              className={cn(
                                "sidebar-lift px-2.5 py-1 text-left text-[12px] font-medium text-muted-foreground transition-[opacity,transform,color] duration-200 hover:text-foreground",
                                expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
                              )}
                              onClick={() => toggleThreadList(workspace.id)}
                              style={{ transitionDelay: expanded ? `${Math.min(visibleThreads.length, 6) * 26}ms` : "0ms" }}
                              type="button"
                              variant="ghost"
                            >
                              {showAllThreads ? "Show less" : `Show ${hiddenThreadCount} more`}
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })
          )}
        </div>
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
          onClick={() => openSettings()}
        >
          <Settings2Icon className="h-4 w-4 text-muted-foreground" />
          Settings
        </Button>
      </div>
    </aside>
  );
});
