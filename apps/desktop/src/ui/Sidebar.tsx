import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";

import {
  ChevronRightIcon,
  CirclePlusIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";

import { useAppStore } from "../app/store";
import { confirmAction, showContextMenu } from "../lib/desktopCommands";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { formatSidebarRelativeAge, getVisibleSidebarThreads, shouldEmphasizeWorkspaceRow } from "./sidebarHelpers";
const MAX_VISIBLE_THREADS = 10;

export const Sidebar = memo(function Sidebar() {
  const view = useAppStore((s) => s.view);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const reorderWorkspaces = useAppStore((s) => s.reorderWorkspaces);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
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
    if (!selectedWorkspaceId) {
      return;
    }
    setExpandedWorkspaceSections((current) =>
      current[selectedWorkspaceId] !== undefined
        ? current
        : { ...current, [selectedWorkspaceId]: true },
    );
  }, [selectedWorkspaceId]);

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

  const toggleWorkspaceSection = useCallback((workspaceId: string) => {
    setExpandedWorkspaceSections((current) => ({
      ...current,
      [workspaceId]: !(current[workspaceId] ?? false),
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
      { id: "remove", label: "Remove workspace" },
    ]);

    if (result === "select") {
      void selectWorkspace(wsId);
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

  return (
    <aside className="app-sidebar sidebar-rail-enter flex h-full w-full flex-col gap-2 px-2.5 pt-1.5 pb-3.5">
      <nav className="grid gap-1">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "sidebar-lift h-9 justify-start rounded-xl px-3 text-[14px] font-medium tracking-[-0.015em] text-foreground/80",
            "hover:bg-foreground/[0.045] hover:text-foreground",
            view === "chat" && "bg-foreground/[0.055] text-foreground",
          )}
          onClick={() => void newThread()}
        >
          <CirclePlusIcon className="h-4 w-4 text-muted-foreground" />
          New thread
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "sidebar-lift h-9 justify-start rounded-xl px-3 text-[14px] font-medium tracking-[-0.015em] text-foreground/80",
            "hover:bg-foreground/[0.045] hover:text-foreground",
            view === "skills" && "bg-foreground/[0.055] text-foreground",
          )}
          onClick={() => void openSkills()}
        >
          <SparklesIcon className="h-4 w-4 text-muted-foreground" />
          Skills
        </Button>
      </nav>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <div className="text-[13px] font-medium tracking-[-0.015em] text-muted-foreground">Workspaces</div>
          <Button
            size="icon-sm"
            variant="ghost"
            className="sidebar-lift size-7 rounded-lg text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground"
            onClick={() => void addWorkspace()}
            aria-label="Add workspace"
          >
            <FolderPlusIcon className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
          {workspaces.length === 0 ? (
            <div className="rounded-2xl bg-foreground/[0.04] px-4 py-5 text-center text-sm text-muted-foreground">
              <FolderPlusIcon strokeWidth={1.5} className="mx-auto mb-2 h-7 w-7 text-muted-foreground/70" />
              <div>No workspaces yet</div>
              <Button className="mt-3 h-8 rounded-xl px-3" size="sm" variant="outline" type="button" onClick={() => void addWorkspace()}>
                Add workspace
              </Button>
            </div>
          ) : (
            workspaces.map((workspace) => {
              const active = workspace.id === selectedWorkspaceId;
              const expanded = expandedWorkspaceSections[workspace.id] ?? false;
              const workspaceThreads = threadsByWorkspaceId.get(workspace.id) ?? [];
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

              return (
                <div key={workspace.id} className="space-y-1.5">
                  <div
                    className={cn(
                      "sidebar-workspace-card flex items-center gap-1 rounded-xl px-1.5 py-1",
                      emphasizeWorkspace
                        ? "bg-foreground/[0.05] text-foreground"
                        : active
                          ? "text-foreground hover:bg-foreground/[0.03]"
                        : "text-foreground/78 hover:bg-foreground/[0.03] hover:text-foreground",
                      dropTargetWorkspaceId === workspace.id &&
                        draggedWorkspaceId !== workspace.id &&
                        "bg-foreground/[0.08] ring-1 ring-foreground/10",
                    )}
                    draggable={workspaces.length > 1}
                    data-dragging={draggedWorkspaceId === workspace.id ? "true" : "false"}
                    data-drop-target={
                      dropTargetWorkspaceId === workspace.id && draggedWorkspaceId !== workspace.id ? "true" : "false"
                    }
                    onDragStart={(event) => handleWorkspaceDragStart(event, workspace.id)}
                    onDragOver={(event) => handleWorkspaceDragOver(event, workspace.id)}
                    onDragEnd={clearWorkspaceDragState}
                    onDrop={(event) => void handleWorkspaceDrop(event, workspace.id)}
                    onContextMenu={(e) => handleWorkspaceContextMenu(e, workspace.id, workspace.name)}
                    title={workspace.path}
                  >
                    <button
                      type="button"
                      className="sidebar-symbol-slot group flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-transparent text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground active:bg-transparent"
                      aria-label={expanded ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
                      aria-expanded={expanded}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleWorkspaceSection(workspace.id);
                      }}
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
                    </button>
                    <button
                      type="button"
                      className="sidebar-lift flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left"
                      onClick={() => void selectWorkspace(workspace.id)}
                    >
                      <span className="truncate text-[14px] font-medium tracking-[-0.015em]">{workspace.name}</span>
                    </button>
                  </div>

                  <div
                    aria-hidden={!expanded}
                    className={cn(
                      "sidebar-thread-region grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                      expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-60",
                    )}
                  >
                    <div className="overflow-hidden">
                      <div className="space-y-1 pl-2 pt-1">
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
                              <button
                                key={thread.id}
                                className={cn(
                                  "sidebar-thread-item sidebar-lift flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left",
                                  isActive
                                    ? "bg-foreground/[0.06] text-foreground"
                                    : "text-foreground/82 hover:bg-foreground/[0.04] hover:text-foreground",
                                  expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
                                )}
                                style={{ transitionDelay: expanded ? `${Math.min(index, 6) * 26}ms` : "0ms" }}
                                onClick={() => {
                                  if (!isEditing) {
                                    void selectThread(thread.id);
                                  }
                                }}
                                onDoubleClick={() => startEditing(thread.id, displayTitle)}
                                onContextMenu={(e) => handleThreadContextMenu(e, thread.id, displayTitle)}
                                type="button"
                              >
                                <span className="min-w-0 flex-1">
                                  {isEditing ? (
                                    <input
                                      ref={editInputRef}
                                      className="min-w-0 w-full rounded-lg border border-border/80 bg-background px-2 py-1 text-[13px] text-foreground outline-none focus:ring-1 focus:ring-ring"
                                      value={editingTitle}
                                      onChange={(e) => setEditingTitle(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          e.preventDefault();
                                          commitRename(thread.id, editingTitle);
                                        } else if (e.key === "Escape") {
                                          e.preventDefault();
                                          cancelRename();
                                        }
                                      }}
                                      onBlur={() => commitRename(thread.id, editingTitle)}
                                      onClick={(e) => e.stopPropagation()}
                                      onDoubleClick={(e) => e.stopPropagation()}
                                    />
                                  ) : (
                                    <span className="block truncate text-[13px] font-medium tracking-[-0.018em]">
                                      {displayTitle}
                                    </span>
                                  )}
                                </span>

                                {!isEditing ? (
                                  <span className="flex shrink-0 items-center gap-2 pl-2">
                                    {busy ? (
                                      <span className="h-2 w-2 rounded-full bg-primary animate-pulse" aria-hidden="true" />
                                    ) : null}
                                    {ageLabel ? (
                                      <span className="text-[11px] font-medium text-muted-foreground">{ageLabel}</span>
                                    ) : null}
                                  </span>
                                ) : null}
                              </button>
                            );
                          })}

                          {workspaceThreads.length > MAX_VISIBLE_THREADS ? (
                            <button
                              className={cn(
                                "sidebar-lift px-3 py-1 text-left text-[12px] font-medium text-muted-foreground transition-[opacity,transform,color] duration-200 hover:text-foreground",
                                expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
                              )}
                              style={{ transitionDelay: expanded ? `${Math.min(visibleThreads.length, 6) * 26}ms` : "0ms" }}
                              onClick={() => toggleThreadList(workspace.id)}
                              type="button"
                            >
                              {showAllThreads ? "Show less" : `Show ${hiddenThreadCount} more`}
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                    </div>
                  </div>
                </div>
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
            "sidebar-lift h-9 w-full justify-start rounded-xl px-3 text-[14px] font-medium tracking-[-0.015em] text-foreground/78",
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
