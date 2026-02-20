import { memo, useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import {
  CirclePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PlusIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";

import { useAppStore } from "../app/store";
import { confirmAction, showContextMenu } from "../lib/desktopCommands";
import { designTokens } from "../lib/designTokens";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

export const Sidebar = memo(function Sidebar() {
  const view = useAppStore((s) => s.view);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const newThread = useAppStore((s) => s.newThread);
  const removeThread = useAppStore((s) => s.removeThread);
  const selectThread = useAppStore((s) => s.selectThread);
  const renameThread = useAppStore((s) => s.renameThread);
  const openSkills = useAppStore((s) => s.openSkills);
  const openSettings = useAppStore((s) => s.openSettings);

  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
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

  const activeWorkspaceThreads = (selectedWorkspaceId
    ? threads.filter((t) => t.workspaceId === selectedWorkspaceId)
    : []
  ).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));

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
        message: `Remove workspace \"${wsName}\"?`,
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
    ]);

    if (result === "select") {
      void selectThread(tId);
    } else if (result === "rename") {
      startEditing(tId, tTitle);
    } else if (result === "remove") {
      const confirmed = await confirmAction({
        title: "Remove session",
        message: `Remove session \"${tTitle}\"?`,
        detail: "The chat transcript will be removed from this desktop app.",
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        kind: "warning",
        defaultAction: "cancel",
      });
      if (confirmed) {
        void removeThread(tId);
      }
    }
  };

  return (
    <aside
      className={cn(
        "app-sidebar flex h-full w-full flex-col gap-3 px-3 py-3",
        designTokens.classes.subtleSurface,
      )}
    >


      <nav className="grid gap-1">
        <Button
          variant={view === "chat" ? "secondary" : "ghost"}
          className="justify-start"
          onClick={() => void newThread()}
        >
          <CirclePlusIcon className="h-4 w-4" />
          New thread
        </Button>

        <Button
          variant={view === "skills" ? "secondary" : "ghost"}
          className="justify-start"
          onClick={() => void openSkills()}
        >
          <SparklesIcon className="h-4 w-4" />
          Skills
        </Button>
      </nav>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between px-2">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">Workspaces</div>
          <Button size="icon-sm" variant="ghost" onClick={() => void addWorkspace()} aria-label="Add workspace">
            <PlusIcon className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-auto pr-1">
          {workspaces.length === 0 ? (
            <div className="rounded-lg border border-transparent bg-muted/10 p-3 text-center text-xs text-muted-foreground">
              <FolderPlusIcon strokeWidth={1} className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
              <div>No workspaces yet</div>
              <Button className="mt-2" size="sm" variant="outline" type="button" onClick={() => void addWorkspace()}>
                Add workspace
              </Button>
            </div>
          ) : (
            workspaces.map((ws) => {
              const active = ws.id === selectedWorkspaceId;
              const workspaceThreads = active ? activeWorkspaceThreads : [];

              return (
                <div key={ws.id} className="space-y-1.5">
                  <button
                    className={cn(
                      "w-full rounded-lg border px-2.5 py-2 text-left transition-all duration-200 ease-out",
                      active
                        ? "border-border/40 bg-muted/20 shadow-sm"
                        : "border-transparent bg-transparent hover:border-border/20 hover:bg-muted/10",
                    )}
                    aria-expanded={active}
                    onClick={() => void selectWorkspace(ws.id)}
                    onContextMenu={(e) => handleWorkspaceContextMenu(e, ws.id, ws.name)}
                    title={ws.path}
                    type="button"
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{ws.name}</span>
                    </div>
                    <div className="truncate pl-6 text-[10px] text-muted-foreground/70">{ws.path}</div>
                  </button>

                  {active ? (
                    <div className="ml-4 space-y-1 border-l border-border/70 pl-3">
                      {workspaceThreads.length === 0 ? (
                        <div className="py-1 text-xs text-muted-foreground">No sessions yet</div>
                      ) : (
                        workspaceThreads.map((thread) => {
                          const runtime = threadRuntimeById[thread.id];
                          const busy = runtime?.busy === true;
                          const isActive = thread.id === selectedThreadId;
                          const isEditing = editingThreadId === thread.id;
                          const displayTitle = thread.title || "New thread";

                          return (
                              <button
                                key={thread.id}
                                className={cn(
                                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-200 ease-out",
                                  isActive
                                    ? "bg-muted/60 text-foreground"
                                    : "text-muted-foreground hover:bg-muted/35 hover:text-foreground",
                                )}
                              onClick={() => { if (!isEditing) void selectThread(thread.id); }}
                              onDoubleClick={() => startEditing(thread.id, displayTitle)}
                              onContextMenu={(e) => handleThreadContextMenu(e, thread.id, displayTitle)}
                              type="button"
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <MessageSquareIcon className="h-3.5 w-3.5 shrink-0" />
                                {isEditing ? (
                                  <input
                                    ref={editInputRef}
                                    className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
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
                                  <span className="truncate">{displayTitle}</span>
                                )}
                              </span>
                              {busy ? <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" /> : null}
                            </button>
                          );
                        })
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>

      <Button
        variant={view === "settings" ? "secondary" : "ghost"}
        className="justify-start"
        type="button"
        onClick={() => openSettings()}
      >
        <Settings2Icon className="h-4 w-4" />
        Settings
      </Button>
    </aside>
  );
});
