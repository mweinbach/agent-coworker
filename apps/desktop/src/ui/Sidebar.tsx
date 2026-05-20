import { Reorder, useDragControls } from "framer-motion";
import {
  ArchiveIcon,
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Settings2Icon,
  SparklesIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  type MouseEvent,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { resolvePluginCatalogWorkspaceSelection } from "../app/pluginManagement";
import { hasGoogleApiKeyForResearch } from "../app/researchAvailability";
import { useAppStore } from "../app/store";
import {
  isOneOffChatWorkspace,
  normalizeSidebarSectionOrder,
  type SidebarSectionKey,
  type ThreadRecord,
  type ThreadRuntime,
  type WorkspaceRecord,
} from "../app/types";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { confirmAction, showContextMenu } from "../lib/desktopCommands";
import { resolveNewChatLandingProjectWorkspaceId } from "../lib/newChatLanding";
import { useDesktopPlatform } from "../lib/useDesktopPlatform";
import { usePrefersReducedMotion } from "../lib/usePrefersReducedMotion";
import { cn } from "../lib/utils";
import {
  formatSidebarRelativeAge,
  getVisibleSidebarThreads,
  shouldEmphasizeWorkspaceRow,
  swapSidebarItemsById,
} from "./sidebarHelpers";

const MAX_VISIBLE_THREADS = 5;
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

const SIDEBAR_SECTION_REORDER_LAYOUT_TRANSITION = {
  layout: {
    type: "spring" as const,
    stiffness: 420,
    damping: 36,
    mass: 0.9,
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
            <div className="ml-3 min-w-0 space-y-1 border-l border-border/45 pl-3 pt-1">
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
                              <span className="text-[11px] font-medium text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-hover:pointer-events-none">
                                {ageLabel}
                              </span>
                            ) : null}
                          </span>
                        </Button>
                        {!busy ? (
                          <button
                            type="button"
                            className="absolute right-2.5 top-1/2 z-10 h-5 w-5 -translate-y-1/2 flex items-center justify-center rounded-md opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto text-muted-foreground/60 hover:text-foreground/85 hover:bg-foreground/[0.06] transition-all duration-200 ease-out transform scale-75 group-hover:scale-100"
                            title="Archive thread"
                            aria-label="Archive thread"
                            onClick={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                              void archiveThread(thread.id);
                            }}
                          >
                            <ArchiveIcon className="h-3.5 w-3.5" />
                          </button>
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

type SidebarSectionFrameProps = {
  children: ReactNode;
  reorderEnabled: boolean;
  sectionKey: SidebarSectionKey;
};

const SidebarSectionFrame = memo(function SidebarSectionFrame({
  children,
  reorderEnabled,
  sectionKey,
}: SidebarSectionFrameProps) {
  const controls = useDragControls();
  const className = cn("flex min-w-0 flex-col");

  if (!reorderEnabled) {
    return (
      <div className={className} data-sidebar-section={sectionKey}>
        {children}
      </div>
    );
  }

  return (
    <Reorder.Item
      as="div"
      className={className}
      data-sidebar-section={sectionKey}
      dragControls={controls}
      dragListener={false}
      layout="position"
      onPointerDownCapture={(event) => {
        if (event.button !== 0) {
          return;
        }
        const target = event.target as HTMLElement;
        if (!target.closest('[data-sidebar-section-drag-handle="true"]')) {
          return;
        }
        if (target.closest('[data-sidebar-section-action="true"]')) {
          return;
        }
        controls.start(event);
      }}
      transition={SIDEBAR_SECTION_REORDER_LAYOUT_TRANSITION}
      value={sectionKey}
    >
      {children}
    </Reorder.Item>
  );
});

type SidebarOneOffChatItemProps = {
  editInputRef: RefObject<HTMLInputElement | null>;
  editingThreadId: string | null;
  editingTitle: string;
  onCancelRename: () => void;
  onCommitRename: (threadId: string, title: string) => void;
  onEditingTitleChange: (title: string) => void;
  onStartEditing: (threadId: string, currentTitle: string) => void;
  onThreadContextMenu: (event: MouseEvent<HTMLElement>, threadId: string, title: string) => void;
  selectedThreadId: string | null;
  selectThread: (threadId: string) => void;
  thread: ThreadRecord;
  threadRuntimeById: Record<string, ThreadRuntime | undefined>;
};

const SidebarOneOffChatItem = memo(function SidebarOneOffChatItem({
  editInputRef,
  editingThreadId,
  editingTitle,
  onCancelRename,
  onCommitRename,
  onEditingTitleChange,
  onStartEditing,
  onThreadContextMenu,
  selectedThreadId,
  selectThread,
  thread,
  threadRuntimeById,
}: SidebarOneOffChatItemProps) {
  const archiveThread = useAppStore((s) => s.archiveThread);
  const runtime = threadRuntimeById[thread.id];
  const busy = runtime?.busy === true;
  const isActive = thread.id === selectedThreadId;
  const isEditing = editingThreadId === thread.id;
  const displayTitle = thread.title || "New chat";
  const ageLabel = formatSidebarRelativeAge(thread.lastMessageAt);

  if (isEditing) {
    return (
      <div className="sidebar-thread-item flex w-full items-center gap-2.5 rounded-lg border border-border/40 bg-foreground/[0.04] px-2.5 py-1.5 text-left text-foreground">
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
    );
  }

  return (
    <div className="relative group min-w-0">
      <Button
        className={cn(
          "sidebar-thread-item sidebar-lift flex min-w-0 w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left",
          isActive
            ? "border-border/45 bg-foreground/[0.05] text-foreground"
            : "text-foreground/82 hover:border-border/35 hover:bg-foreground/[0.035] hover:text-foreground",
        )}
        onClick={() => selectThread(thread.id)}
        onContextMenu={(event) => onThreadContextMenu(event, thread.id, displayTitle)}
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
            <span className="text-[11px] font-medium text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-hover:pointer-events-none">
              {ageLabel}
            </span>
          ) : null}
        </span>
      </Button>
      {!busy ? (
        <button
          type="button"
          className="absolute right-2.5 top-1/2 z-10 h-5 w-5 -translate-y-1/2 flex items-center justify-center rounded-md opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto text-muted-foreground/60 hover:text-foreground/85 hover:bg-foreground/[0.06] transition-all duration-200 ease-out transform scale-75 group-hover:scale-100"
          title="Archive chat"
          aria-label="Archive chat"
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            void archiveThread(thread.id);
          }}
        >
          <ArchiveIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
});

export const Sidebar = memo(function Sidebar() {
  const platformInfo = useDesktopPlatform();
  // Windows owns the native titleband inside the sidebar for drag space, while
  // the topbar rail owns the persistent collapse control.
  const isWin32 = platformInfo.sidebarTitlebandMode === "native";
  const view = useAppStore((s) => s.view);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const pluginManagementWorkspaceId = useAppStore((s) => s.pluginManagementWorkspaceId);
  const pluginManagementMode = useAppStore((s) => s.pluginManagementMode);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const newChatLandingTarget = useAppStore((s) => s.newChatLandingTarget);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);
  const desktopFeatures = useAppStore((s) => s.desktopFeatureFlags);
  const sidebarSectionOrder = useAppStore((s) => s.desktopSettings.sidebarSectionOrder);
  const googleResearchAvailable = useAppStore((s) =>
    hasGoogleApiKeyForResearch(s.providerStatusByName.google),
  );

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const setWorkspacesOrder = useAppStore((s) => s.setWorkspacesOrder);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const setPluginManagementWorkspace = useAppStore((s) => s.setPluginManagementWorkspace);
  const newThread = useAppStore((s) => s.newThread);
  const openNewChatLanding = useAppStore((s) => s.openNewChatLanding);
  const deleteThreadHistory = useAppStore((s) => s.deleteThreadHistory);
  const selectThread = useAppStore((s) => s.selectThread);
  const renameThread = useAppStore((s) => s.renameThread);
  const openSkills = useAppStore((s) => s.openSkills);
  const openResearch = useAppStore((s) => s.openResearch);
  const openSettings = useAppStore((s) => s.openSettings);
  const setSidebarSectionOrder = useAppStore((s) => s.setSidebarSectionOrder);

  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [expandedWorkspaceSections, setExpandedWorkspaceSections] = useState<
    Record<string, boolean>
  >({});
  const [expandedThreadLists, setExpandedThreadLists] = useState<Record<string, boolean>>({});
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [showAllChats, setShowAllChats] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);

  const projectWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace)),
    [workspaces],
  );
  const chatWorkspaces = useMemo(
    () => workspaces.filter((workspace) => isOneOffChatWorkspace(workspace)),
    [workspaces],
  );
  const pluginSelection = useMemo(
    () =>
      resolvePluginCatalogWorkspaceSelection({
        workspaces: projectWorkspaces,
        selectedWorkspaceId,
        pluginManagementWorkspaceId,
        pluginManagementMode,
      }),
    [pluginManagementMode, pluginManagementWorkspaceId, projectWorkspaces, selectedWorkspaceId],
  );
  const workspacePickerEnabled = desktopFeatures.workspacePicker !== false;
  const workspaceLifecycleEnabled = desktopFeatures.workspaceLifecycle !== false;
  const effectiveView = view === "research" && !googleResearchAvailable ? "chat" : view;
  const isOnNewChatLanding = effectiveView === "chat" && selectedThreadId === null;
  const landingProjectWorkspaceId = useMemo(
    () =>
      isOnNewChatLanding
        ? resolveNewChatLandingProjectWorkspaceId(
            newChatLandingTarget,
            projectWorkspaces,
            selectedWorkspaceId,
          )
        : null,
    [isOnNewChatLanding, newChatLandingTarget, projectWorkspaces, selectedWorkspaceId],
  );
  const activeWorkspaceId =
    effectiveView === "skills"
      ? pluginSelection.displayWorkspaceId
      : effectiveView === "research"
        ? null
        : isOnNewChatLanding
          ? landingProjectWorkspaceId
          : selectedWorkspaceId;
  const activeProjectWorkspaceId = projectWorkspaces.some(
    (workspace) => workspace.id === activeWorkspaceId,
  )
    ? activeWorkspaceId
    : null;
  const sidebarSelectedThreadId = effectiveView === "research" ? null : selectedThreadId;
  const visibleProjectWorkspaces = useMemo(() => {
    if (workspacePickerEnabled || projectWorkspaces.length <= 1) {
      return projectWorkspaces;
    }
    if (activeProjectWorkspaceId) {
      const activeWorkspace = projectWorkspaces.find(
        (workspace) => workspace.id === activeProjectWorkspaceId,
      );
      if (activeWorkspace) {
        return [activeWorkspace];
      }
    }
    return projectWorkspaces[0] ? [projectWorkspaces[0]] : [];
  }, [activeProjectWorkspaceId, projectWorkspaces, workspacePickerEnabled]);

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
    if (!activeProjectWorkspaceId) {
      return;
    }
    setExpandedWorkspaceSections((current) =>
      current[activeProjectWorkspaceId] !== undefined
        ? current
        : { ...current, [activeProjectWorkspaceId]: true },
    );
  }, [activeProjectWorkspaceId]);

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
      if (thread.archived) {
        continue;
      }
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

  const oneOffChatThreads = useMemo(
    () =>
      chatWorkspaces
        .flatMap((workspace) => threadsByWorkspaceId.get(workspace.id) ?? [])
        .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt)),
    [chatWorkspaces, threadsByWorkspaceId],
  );
  const orderedSectionKeys = useMemo(
    () => normalizeSidebarSectionOrder(sidebarSectionOrder),
    [sidebarSectionOrder],
  );
  const sectionReorderEnabled = orderedSectionKeys.length > 1;

  const toggleThreadList = useCallback((workspaceId: string) => {
    setExpandedThreadLists((current) => ({
      ...current,
      [workspaceId]: !current[workspaceId],
    }));
  }, []);

  const reorderEnabled = workspaceLifecycleEnabled && visibleProjectWorkspaces.length > 1;

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
      const oneOffWorkspaceIds = workspaces
        .filter((workspace) => isOneOffChatWorkspace(workspace))
        .map((workspace) => workspace.id);
      void setWorkspacesOrder([
        ...nextWorkspaces.map((workspace) => workspace.id),
        ...oneOffWorkspaceIds,
      ]);
    },
    [setWorkspacesOrder, workspaces],
  );

  const moveWorkspace = useCallback(
    (workspaceId: string, direction: WorkspaceMoveDirection) => {
      const nextProjectWorkspaces = swapSidebarItemsById(projectWorkspaces, workspaceId, direction);
      if (nextProjectWorkspaces === projectWorkspaces) {
        return;
      }
      const oneOffWorkspaceIds = workspaces
        .filter((workspace) => isOneOffChatWorkspace(workspace))
        .map((workspace) => workspace.id);
      void setWorkspacesOrder([
        ...nextProjectWorkspaces.map((workspace) => workspace.id),
        ...oneOffWorkspaceIds,
      ]);
    },
    [projectWorkspaces, setWorkspacesOrder, workspaces],
  );

  const handleSectionReorder = useCallback(
    (nextSections: SidebarSectionKey[]) => {
      setSidebarSectionOrder(normalizeSidebarSectionOrder(nextSections));
    },
    [setSidebarSectionOrder],
  );

  const handleSelectWorkspace = useCallback(
    (workspaceId: string) => {
      void (effectiveView === "skills"
        ? setPluginManagementWorkspace(workspaceId)
        : selectWorkspace(workspaceId));
    },
    [effectiveView, selectWorkspace, setPluginManagementWorkspace],
  );

  const handleProjectSectionMenu = async (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const normalizedOrder = normalizeSidebarSectionOrder(sidebarSectionOrder);
    const chatsAboveProjects = normalizedOrder[0] === "chats";
    const result = await showContextMenu([
      ...(workspaceLifecycleEnabled ? [{ id: "add_project", label: "Add project" }] : []),
      {
        id: chatsAboveProjects ? "move_projects_above_chats" : "move_chats_above_projects",
        label: chatsAboveProjects ? "Move projects above chats" : "Move chats above projects",
        enabled: oneOffChatThreads.length > 0,
      },
    ]);

    if (result === "add_project") {
      void addWorkspace();
    } else if (result === "move_chats_above_projects") {
      setSidebarSectionOrder(["chats", "projects"]);
    } else if (result === "move_projects_above_chats") {
      setSidebarSectionOrder(["projects", "chats"]);
    }
  };

  const handleWorkspaceContextMenu = async (
    e: MouseEvent<HTMLElement>,
    wsId: string,
    wsName: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const result = await showContextMenu([
      { id: "new_project_chat", label: "New chat in project" },
      { id: "select", label: "Select project" },
      ...(workspaceLifecycleEnabled ? [{ id: "remove", label: "Remove project" }] : []),
    ]);

    if (result === "new_project_chat") {
      void newThread({ workspaceId: wsId, scope: "project" });
    } else if (result === "select") {
      void (effectiveView === "skills"
        ? setPluginManagementWorkspace(wsId)
        : selectWorkspace(wsId));
    } else if (result === "remove") {
      const confirmed = await confirmAction({
        title: "Remove project",
        message: `Remove project "${wsName}"?`,
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
      { id: "delete_history", label: "Delete session history" },
    ]);

    if (result === "delete_history") {
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

  const workspaceItems = visibleProjectWorkspaces.map((workspace) => {
    const active = workspace.id === activeProjectWorkspaceId;
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

  const chatSection = (
    <div className="flex flex-col gap-2">
      <div
        className="group flex items-center justify-between gap-2 px-1"
        data-sidebar-section-drag-handle="true"
      >
        <div className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 active:cursor-grabbing">
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/75">
            Chats
          </span>
          <Button
            aria-expanded={chatsOpen}
            aria-label={chatsOpen ? "Collapse chats" : "Expand chats"}
            className="size-6 shrink-0 rounded-md bg-transparent text-muted-foreground/75 hover:bg-foreground/[0.045] hover:text-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-150"
            data-sidebar-section-action="true"
            onClick={() => setChatsOpen((open) => !open)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon
              className={cn("h-4 w-4 transition-transform", chatsOpen ? "" : "-rotate-90")}
            />
          </Button>
        </div>
        <div className="flex items-center">
          <Button
            size="icon-sm"
            variant="ghost"
            className="sidebar-lift size-6 rounded-md text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-150"
            data-sidebar-section-action="true"
            onClick={() => void openNewChatLanding({ defaultTargetKind: "oneOff" })}
            aria-label="New chat"
          >
            <PlusIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {chatsOpen ? (
        oneOffChatThreads.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-muted-foreground/60 italic">No chats yet</div>
        ) : (
          <div className="flex flex-col gap-1">
            <div
              className={cn(
                "grid gap-1 min-h-0",
                showAllChats && "sidebar-chats-scroll-container pr-1",
              )}
            >
              {(showAllChats ? oneOffChatThreads : oneOffChatThreads.slice(0, 5)).map((thread) => (
                <SidebarOneOffChatItem
                  key={thread.id}
                  editInputRef={editInputRef}
                  editingThreadId={editingThreadId}
                  editingTitle={editingTitle}
                  onCancelRename={cancelRename}
                  onCommitRename={commitRename}
                  onEditingTitleChange={setEditingTitle}
                  onStartEditing={startEditing}
                  onThreadContextMenu={handleThreadContextMenu}
                  selectedThreadId={sidebarSelectedThreadId}
                  selectThread={handleSelectThread}
                  thread={thread}
                  threadRuntimeById={threadRuntimeById}
                />
              ))}
            </div>
            {oneOffChatThreads.length > 5 ? (
              <Button
                className="sidebar-lift px-2.5 py-1 text-left text-[12px] font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
                onClick={() => setShowAllChats((prev) => !prev)}
                type="button"
                variant="ghost"
              >
                {showAllChats ? "Show less" : `Show ${oneOffChatThreads.length - 5} more`}
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );

  const projectSection = (
    <div className="flex flex-col gap-2">
      <div
        className="group flex items-center justify-between gap-2 px-1"
        data-sidebar-section-drag-handle="true"
      >
        <div className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 active:cursor-grabbing">
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/75">
            Projects
          </span>
          <Button
            aria-expanded={projectsOpen}
            aria-label={projectsOpen ? "Collapse projects" : "Expand projects"}
            className="size-6 shrink-0 rounded-md bg-transparent text-muted-foreground/75 hover:bg-foreground/[0.045] hover:text-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-150"
            data-sidebar-section-action="true"
            onClick={() => setProjectsOpen((open) => !open)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon
              className={cn("h-4 w-4 transition-transform", projectsOpen ? "" : "-rotate-90")}
            />
          </Button>
        </div>
        <div className="flex items-center">
          <Button
            aria-label="Project section options"
            className="sidebar-lift size-6 rounded-md text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-150"
            data-sidebar-section-action="true"
            onClick={handleProjectSectionMenu}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <MoreHorizontalIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {projectsOpen ? (
        projectWorkspaces.length === 0 ? (
          <div className="flex flex-col">
            <div className="rounded-md border border-border/55 bg-foreground/[0.03] px-4 py-4 text-center text-xs text-muted-foreground">
              <FolderPlusIcon
                strokeWidth={1.5}
                className="mx-auto mb-2 h-6 w-6 text-muted-foreground/70"
              />
              <div>No projects yet</div>
              {workspaceLifecycleEnabled ? (
                <Button
                  className="mt-3 h-7 rounded-md px-3"
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void addWorkspace()}
                >
                  Add project
                </Button>
              ) : null}
            </div>
          </div>
        ) : reorderEnabled ? (
          <Reorder.Group
            as="div"
            axis="y"
            className="flex flex-col gap-1"
            onReorder={handleReorder}
            values={visibleProjectWorkspaces}
          >
            {workspaceItems}
          </Reorder.Group>
        ) : (
          <div className="flex flex-col gap-1">{workspaceItems}</div>
        )
      ) : null}
    </div>
  );

  const sidebarSections: Record<SidebarSectionKey, ReactNode> = {
    projects: projectSection,
    chats: chatSection,
  };

  return (
    <aside className="app-sidebar sidebar-rail-enter relative flex h-full w-full min-w-0 flex-col gap-1.5 overflow-hidden px-2 pt-1.5 pb-3">
      <div className="app-sidebar__titleband">
        <div className="app-sidebar__titleband-drag-zone" aria-hidden="true" />
        <div className="app-sidebar__titleband-row flex w-full items-center gap-1">
          {!isWin32 ? (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "sidebar-lift h-8 min-w-0 flex-1 justify-start rounded-lg px-2.5 text-[13px] font-medium tracking-[-0.015em] text-foreground/80",
                "hover:bg-foreground/[0.045] hover:text-foreground",
              )}
              onClick={() => void openNewChatLanding()}
            >
              <SquarePenIcon className="h-4 w-4 text-muted-foreground" />
              New Chat
            </Button>
          ) : null}
        </div>
      </div>
      {isWin32 ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "app-sidebar__new-chat-button sidebar-lift h-8 w-full min-w-0 justify-start rounded-lg px-2.5 text-[13px] font-medium tracking-[-0.015em] text-foreground/80",
            "hover:bg-foreground/[0.045] hover:text-foreground",
          )}
          onClick={() => void openNewChatLanding()}
        >
          <SquarePenIcon className="h-4 w-4 text-muted-foreground" />
          New Chat
        </Button>
      ) : null}
      <nav className="grid w-full min-w-0 gap-1.5">
        {googleResearchAvailable ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "sidebar-lift h-8 w-full min-w-0 justify-start rounded-lg px-2.5 text-[13px] font-medium tracking-[-0.015em] text-foreground/80",
              "hover:bg-foreground/[0.045] hover:text-foreground",
              effectiveView === "research" && "bg-foreground/[0.055] text-foreground",
            )}
            onClick={() => void openResearch()}
          >
            <BookOpenIcon className="h-4 w-4 text-muted-foreground" />
            Research
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "sidebar-lift h-8 w-full min-w-0 justify-start rounded-lg px-2.5 text-[13px] font-medium tracking-[-0.015em] text-foreground/80",
            "hover:bg-foreground/[0.045] hover:text-foreground",
            effectiveView === "skills" && "bg-foreground/[0.055] text-foreground",
          )}
          onClick={() => void openSkills()}
        >
          <SparklesIcon className="h-4 w-4 text-muted-foreground" />
          Plugins
        </Button>
      </nav>

      <Reorder.Group
        as="section"
        axis="y"
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto pr-1"
        onReorder={handleSectionReorder}
        values={orderedSectionKeys}
      >
        {orderedSectionKeys.map((sectionKey) => (
          <SidebarSectionFrame
            key={sectionKey}
            reorderEnabled={sectionReorderEnabled}
            sectionKey={sectionKey}
          >
            {sidebarSections[sectionKey]}
          </SidebarSectionFrame>
        ))}
      </Reorder.Group>

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
