import { Reorder, useDragControls } from "framer-motion";
import {
  ChevronRightIcon,
  ClipboardListIcon,
  ClipboardPlusIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
} from "lucide-react";
import {
  type MouseEvent,
  memo,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAppStore } from "../../app/store";
import type { TaskSummary, ThreadRecord, ThreadRuntime, WorkspaceRecord } from "../../app/types";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Input } from "../../components/ui/input";
import { usePrefersReducedMotion } from "../../lib/usePrefersReducedMotion";
import { cn } from "../../lib/utils";
import { formatSidebarRelativeAge } from "../sidebarHelpers";
import { ThreadOverflowMenu } from "./ThreadOverflowMenu";

export const MAX_VISIBLE_THREADS = 5;
const WORKSPACE_ITEM_CLASSNAME = "sidebar-workspace-item min-w-0 [&:not(:last-child)]:mb-3";
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

export type WorkspaceMoveDirection = "up" | "down";

export type SidebarWorkspaceItemProps = {
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
  onNewWorkspaceChat: (workspaceId: string) => void;
  onNewWorkspaceTask: (workspaceId: string) => void;
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
  selectedTaskId: string | null;
  selectThread: (threadId: string) => void;
  selectTask: (taskId: string) => void;
  showAllThreads: boolean;
  threadRuntimeById: Record<string, ThreadRuntime | undefined>;
  visibleThreads: ThreadRecord[];
  workspace: WorkspaceRecord;
  workspaceThreads: ThreadRecord[];
  tasks: TaskSummary[];
  canGenerateMemoryForThread: (threadId: string) => boolean;
  onGenerateMemoryForThread: (threadId: string) => void;
  onDeleteHistoryForThread: (threadId: string, title: string) => void;
};

export const SidebarWorkspaceItem = memo(function SidebarWorkspaceItem({
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
  onNewWorkspaceChat,
  onNewWorkspaceTask,
  onSelectWorkspace,
  onStartEditing,
  onThreadContextMenu,
  onToggleThreadList,
  onWorkspaceContextMenu,
  onWorkspaceOpenChange,
  reorderEnabled,
  selectedThreadId,
  selectedTaskId,
  selectThread,
  selectTask,
  showAllThreads,
  threadRuntimeById,
  visibleThreads,
  workspace,
  workspaceThreads,
  tasks,
  canGenerateMemoryForThread,
  onGenerateMemoryForThread,
  onDeleteHistoryForThread,
}: SidebarWorkspaceItemProps) {
  const controls = useDragControls();
  const prefersReducedMotion = usePrefersReducedMotion();
  const threadRegionRef = useRef<HTMLDivElement | null>(null);
  const prevExpandedRef = useRef(expanded);
  const [renderThreadRegion, setRenderThreadRegion] = useState(expanded);
  const [threadRegionOpen, setThreadRegionOpen] = useState(expanded);
  const archiveThread = useAppStore((s) => s.archiveThread);

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
      className="flex min-w-0 flex-col"
      onContextMenu={(event) => onWorkspaceContextMenu(event, workspace.id, workspace.name)}
      onOpenChange={(nextOpen) => onWorkspaceOpenChange(workspace.id, nextOpen)}
      open={expanded}
      title={workspace.path}
    >
      <div
        className={cn(
          "sidebar-workspace-card group/workspace-row flex items-center gap-1 rounded-lg px-1 py-0.5",
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
        <Button
          aria-label={`New chat in ${workspace.name}`}
          className="sidebar-lift size-6 shrink-0 rounded-md text-muted-foreground opacity-0 pointer-events-none transition-opacity duration-150 hover:bg-foreground/[0.045] hover:text-foreground focus-visible:opacity-100 focus-visible:pointer-events-auto group-hover/workspace-row:opacity-100 group-hover/workspace-row:pointer-events-auto group-focus-within/workspace-row:opacity-100 group-focus-within/workspace-row:pointer-events-auto"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onNewWorkspaceChat(workspace.id);
          }}
          size="icon-sm"
          title={`New chat in ${workspace.name}`}
          type="button"
          variant="ghost"
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
        <Button
          aria-label={`New task in ${workspace.name}`}
          className="sidebar-lift size-6 shrink-0 rounded-md text-muted-foreground opacity-0 pointer-events-none transition-opacity duration-150 hover:bg-foreground/[0.045] hover:text-foreground focus-visible:opacity-100 focus-visible:pointer-events-auto group-hover/workspace-row:opacity-100 group-hover/workspace-row:pointer-events-auto group-focus-within/workspace-row:opacity-100 group-focus-within/workspace-row:pointer-events-auto"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onNewWorkspaceTask(workspace.id);
          }}
          size="icon-sm"
          title={`New task in ${workspace.name}`}
          type="button"
          variant="ghost"
        >
          <ClipboardPlusIcon className="h-4 w-4" />
        </Button>
      </div>

      {renderThreadRegion ? (
        <div
          ref={threadRegionRef}
          className="sidebar-thread-region"
          data-state={threadRegionOpen ? "open" : "closed"}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="ml-3 min-w-0 space-y-1 border-l border-border/45 pl-3 pt-1">
              {workspaceThreads.length === 0 && tasks.length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-muted-foreground">
                  No chats or tasks yet
                </div>
              ) : (
                <>
                  {workspaceThreads.length > 0 && tasks.length > 0 ? (
                    <div className="px-2.5 pt-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/65">
                      Chats
                    </div>
                  ) : null}
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
                      <div key={thread.id} className="relative group min-w-0">
                        <Button
                          className={cn(
                            "sidebar-thread-item sidebar-lift flex min-w-0 w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left",
                            isActive
                              ? "border-border/45 bg-foreground/[0.05] text-foreground"
                              : "text-foreground/82 hover:border-border/35 hover:bg-foreground/[0.035] hover:text-foreground",
                          )}
                          onClick={() => selectThread(thread.id)}
                          onContextMenu={(event) =>
                            onThreadContextMenu(event, thread.id, displayTitle)
                          }
                          onDoubleClick={() => onStartEditing(thread.id, displayTitle)}
                          title={displayTitle}
                          type="button"
                          variant="ghost"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium tracking-[-0.018em]">
                              {displayTitle}
                            </span>
                          </span>

                          <span className="relative flex shrink-0 items-center gap-2 pl-2 min-w-8 justify-end">
                            {busy ? (
                              <span
                                className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse"
                                aria-hidden="true"
                              />
                            ) : ageLabel ? (
                              <span className="text-[11px] font-medium text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-hover:pointer-events-none group-focus-within:opacity-0 group-focus-within:pointer-events-none">
                                {ageLabel}
                              </span>
                            ) : null}
                          </span>
                        </Button>
                        {!busy ? (
                          <div className="absolute right-1.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 pointer-events-none">
                            <ThreadOverflowMenu
                              canGenerateMemory={canGenerateMemoryForThread(thread.id)}
                              ariaLabelSuffix={displayTitle}
                              triggerVisibilityClassName="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transform scale-75 group-hover:scale-100 group-focus-within:scale-100"
                              onRename={() => onStartEditing(thread.id, displayTitle)}
                              onArchive={() => void archiveThread(thread.id)}
                              onGenerateMemory={() => onGenerateMemoryForThread(thread.id)}
                              onDeleteHistory={() =>
                                onDeleteHistoryForThread(thread.id, displayTitle)
                              }
                            />
                          </div>
                        ) : null}
                      </div>
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
                  {tasks.length > 0 ? (
                    <div
                      className={cn("flex flex-col gap-1", workspaceThreads.length > 0 && "mt-2")}
                    >
                      <div className="px-2.5 pt-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/65">
                        Tasks
                      </div>
                      {tasks.slice(0, MAX_VISIBLE_THREADS).map((task) => (
                        <Button
                          key={task.id}
                          type="button"
                          variant="ghost"
                          className={cn(
                            "sidebar-lift flex h-auto min-w-0 w-full items-center gap-2 rounded-lg border border-transparent px-2.5 py-1.5 text-left",
                            task.id === selectedTaskId
                              ? "border-border/45 bg-foreground/[0.05] text-foreground"
                              : "text-foreground/82 hover:border-border/35 hover:bg-foreground/[0.035] hover:text-foreground",
                          )}
                          onClick={() => selectTask(task.id)}
                          title={task.title}
                        >
                          <ClipboardListIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium tracking-[-0.018em]">
                              {task.title}
                            </span>
                            <span className="block truncate text-[10px] text-muted-foreground">
                              {task.completedWorkItemCount}/{task.totalWorkItemCount} ·{" "}
                              {task.status.replaceAll("_", " ")}
                              {task.pendingQuestionCount > 0 ? " · needs input" : ""}
                            </span>
                          </span>
                        </Button>
                      ))}
                    </div>
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
