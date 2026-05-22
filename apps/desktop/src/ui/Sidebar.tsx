import { Reorder } from "framer-motion";
import {
  BookOpenIcon,
  ChevronDownIcon,
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
  useCallback,
  useEffect,
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
  type WorkspaceRecord,
} from "../app/types";
import { Button } from "../components/ui/button";
import { confirmAction, showContextMenu } from "../lib/desktopCommands";
import { resolveNewChatLandingProjectWorkspaceId } from "../lib/newChatLanding";
import { useDesktopPlatform } from "../lib/useDesktopPlatform";
import { cn } from "../lib/utils";
import { SidebarOneOffChatItem } from "./sidebar/SidebarOneOffChatItem";
import { SidebarSectionFrame } from "./sidebar/SidebarSectionFrame";
import {
  MAX_VISIBLE_THREADS,
  SidebarWorkspaceItem,
  type WorkspaceMoveDirection,
} from "./sidebar/SidebarWorkspaceItem";
import { useSidebarPersistence } from "./sidebar/useSidebarPersistence";
import {
  getVisibleSidebarThreads,
  shouldEmphasizeWorkspaceRow,
  swapSidebarItemsById,
} from "./sidebarHelpers";

export const Sidebar = memo(function Sidebar() {
  const platformInfo = useDesktopPlatform();
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
  const {
    expandedWorkspaceSections,
    setExpandedWorkspaceSections,
    expandedThreadLists,
    setExpandedThreadLists,
    projectsOpen,
    setProjectsOpen,
    chatsOpen,
    setChatsOpen,
    showAllChats,
    setShowAllChats,
  } = useSidebarPersistence();

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
  }, [activeProjectWorkspaceId, setExpandedWorkspaceSections]);

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

  const toggleThreadList = useCallback(
    (workspaceId: string) => {
      setExpandedThreadLists((current) => ({
        ...current,
        [workspaceId]: !current[workspaceId],
      }));
    },
    [setExpandedThreadLists],
  );

  const reorderEnabled = workspaceLifecycleEnabled && visibleProjectWorkspaces.length > 1;

  const handleWorkspaceOpenChange = useCallback(
    (workspaceId: string, nextOpen: boolean) => {
      setExpandedWorkspaceSections((current) => ({
        ...current,
        [workspaceId]: nextOpen,
      }));
    },
    [setExpandedWorkspaceSections],
  );

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
