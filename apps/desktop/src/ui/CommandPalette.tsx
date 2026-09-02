import { defaultFilter } from "cmdk";
import {
  ClipboardListIcon,
  ClipboardPlusIcon,
  FolderIcon,
  HistoryIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  Settings2Icon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../app/store";
import { isStandardChatThread } from "../app/threadFilters";
import {
  isOneOffChatWorkspace,
  type TaskSummary,
  type ThreadRecord,
  type WorkspaceRecord,
} from "../app/types";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandKbd,
  CommandList,
  CommandSeparator,
} from "../components/ui/command";
import { requestDesktopRailCommand } from "../lib/desktopRailCommands";
import { getSettingsGroups } from "./settings/SettingsShell";

export type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const IS_APPLE =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/i.test(navigator.platform) ||
    // navigator.platform is deprecated; userAgentData may be present in Chromium.
    (typeof (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ===
      "string" &&
      /mac/i.test(
        (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "",
      )));

const MOD = IS_APPLE ? "⌘" : "Ctrl";
const SHIFT = IS_APPLE ? "⇧" : "Shift";

function searchPaletteEntries<T>(
  entries: T[],
  query: string,
  keywords: (entry: T) => string[],
  recentLimit = 8,
): T[] {
  if (!query.trim()) return entries.slice(0, recentLimit);
  return entries.filter((entry) => defaultFilter("", query, keywords(entry)) > 0);
}

/**
 * Cmd/Ctrl+K command palette. Surfaces recent chats, workspaces, settings
 * pages, and skills so power users can navigate without the mouse. All data
 * comes from the existing zustand store and selection reuses existing store
 * actions (selectThread / selectWorkspace / openSettings / openSkills).
 */
export const CommandPalette = memo(function CommandPalette({
  open,
  onOpenChange,
}: CommandPaletteProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const threads = useAppStore((s) => s.threads);
  const workspaces = useAppStore((s) => s.workspaces);
  const taskSummariesByWorkspaceId = useAppStore((s) => s.taskSummariesByWorkspaceId);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const selectedThreadBusy = useAppStore((s) =>
    s.selectedThreadId ? s.threadRuntimeById[s.selectedThreadId]?.busy === true : false,
  );
  const developerMode = useAppStore((s) => s.developerMode);
  const remoteAccessAvailable = useAppStore((s) => s.desktopFeatureFlags.remoteAccess === true);
  const tasksEnabled = useAppStore((s) => s.desktopFeatureFlags.tasks === true);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);

  const selectThread = useAppStore((s) => s.selectThread);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const selectTask = useAppStore((s) => s.selectTask);
  const openSettings = useAppStore((s) => s.openSettings);
  const openSkills = useAppStore((s) => s.openSkills);
  const openNewTask = useAppStore((s) => s.openNewTask);
  const cancelThread = useAppStore((s) => s.cancelThread);

  useEffect(() => {
    if (!open) setSearchQuery("");
  }, [open]);

  const workspaceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of workspaces) map.set(ws.id, ws.name);
    return map;
  }, [workspaces]);

  const recentThreads = useMemo(() => {
    const eligible = threads
      .filter((thread) => isStandardChatThread(thread))
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    return searchPaletteEntries(eligible, searchQuery, (thread) => [
      "chat",
      thread.title || "New chat",
      workspaceNameById.get(thread.workspaceId) ?? "",
    ]);
  }, [searchQuery, threads, workspaceNameById]);

  // Project workspaces (exclude one-off chats) — these are the navigable ones.
  const projectWorkspaces = useMemo(
    () =>
      searchPaletteEntries(
        workspaces.filter((ws) => !isOneOffChatWorkspace(ws)),
        searchQuery,
        (workspace) => ["project", "workspace", workspace.name],
      ),
    [searchQuery, workspaces],
  );

  const tasks = useMemo(() => {
    if (!tasksEnabled) return [];
    const entries = workspaces
      .flatMap((workspace) =>
        (taskSummariesByWorkspaceId[workspace.id] ?? []).map((task) => ({
          task,
          workspaceName: workspace.name,
        })),
      )
      .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
    return searchPaletteEntries(entries, searchQuery, ({ task, workspaceName }) => [
      "task",
      task.title,
      workspaceName,
    ]);
  }, [searchQuery, tasksEnabled, taskSummariesByWorkspaceId, workspaces]);

  // Installed skills across the known workspace catalogs.
  const skills = useMemo(() => {
    const entries: { name: string; description: string; installationId: string }[] = [];
    const seen = new Set<string>();
    for (const ws of workspaces) {
      const catalog = workspaceRuntimeById[ws.id]?.skillsCatalog;
      if (!catalog) continue;
      for (const inst of catalog.installations) {
        if (!inst.enabled || seen.has(inst.name)) continue;
        seen.add(inst.name);
        entries.push({
          name: inst.interface?.displayName ?? inst.name,
          description: inst.description,
          installationId: inst.installationId,
        });
      }
    }
    return searchPaletteEntries(
      entries,
      searchQuery,
      (skill) => ["skill", skill.name, skill.description],
      12,
    );
  }, [searchQuery, workspaces, workspaceRuntimeById]);

  const settingsPages = useMemo(
    () =>
      getSettingsGroups(remoteAccessAvailable, { includeDevelopmentPages: developerMode }).flatMap(
        (group) => group.pages.map((page) => ({ id: page.id, label: page.label })),
      ),
    [remoteAccessAvailable, developerMode],
  );

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      void selectThread(threadId);
      close();
    },
    [selectThread, close],
  );

  const handleSelectWorkspace = useCallback(
    (workspaceId: string) => {
      void selectWorkspace(workspaceId);
      close();
    },
    [selectWorkspace, close],
  );

  const handleSelectTask = useCallback(
    (taskId: string) => {
      void selectTask(taskId);
      close();
    },
    [selectTask, close],
  );

  const handleOpenSettings = useCallback(
    (page: Parameters<typeof openSettings>[0]) => {
      openSettings(page);
      close();
    },
    [openSettings, close],
  );

  const handleOpenSkills = useCallback(() => {
    void openSkills();
    close();
  }, [openSkills, close]);

  const handleNewChat = useAppStore((s) => s.openNewChatLanding);
  const handleNewChatClick = useCallback(() => {
    void handleNewChat({ defaultTargetKind: "oneOff" });
    close();
  }, [handleNewChat, close]);

  const handleNewTaskClick = useCallback(() => {
    void openNewTask();
    close();
  }, [openNewTask, close]);

  const handleStopTurnClick = useCallback(() => {
    if (selectedThreadId && selectedThreadBusy) {
      cancelThread(selectedThreadId);
    }
    close();
  }, [cancelThread, close, selectedThreadBusy, selectedThreadId]);

  const handleToggleSidebarClick = useCallback(() => {
    requestDesktopRailCommand("toggle-sidebar");
    close();
  }, [close]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        value={searchQuery}
        onValueChange={setSearchQuery}
        placeholder="Search chats, projects, tasks, settings, skills…"
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem onSelect={handleNewChatClick} value="new chat">
            <MessageSquareIcon />
            <span>New chat</span>
            <CommandKbd keys={[MOD, "N"]} />
          </CommandItem>
          {tasksEnabled ? (
            <CommandItem onSelect={handleNewTaskClick} value="new task">
              <ClipboardPlusIcon />
              <span>New task</span>
            </CommandItem>
          ) : null}
          {selectedThreadBusy ? (
            <CommandItem onSelect={handleStopTurnClick} value="stop current turn">
              <SquareIcon />
              <span>Stop current turn</span>
              <CommandKbd keys={[MOD, "."]} />
            </CommandItem>
          ) : null}
          <CommandItem onSelect={handleToggleSidebarClick} value="toggle sidebar">
            <PanelLeftIcon />
            <span>Toggle sidebar</span>
            <CommandKbd keys={[MOD, "B"]} />
          </CommandItem>
          <CommandItem onSelect={handleOpenSkills} value="browse skills">
            <SparklesIcon />
            <span>Browse skills</span>
            <CommandKbd keys={[MOD, SHIFT, "K"]} />
          </CommandItem>
        </CommandGroup>

        {recentThreads.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={searchQuery.trim() ? "Chats" : "Recent chats"}>
              {recentThreads.map((thread) => (
                <ThreadCommandItem
                  key={thread.id}
                  thread={thread}
                  workspaceName={workspaceNameById.get(thread.workspaceId)}
                  isSelected={thread.id === selectedThreadId}
                  onSelect={handleSelectThread}
                />
              ))}
            </CommandGroup>
          </>
        ) : null}

        {tasks.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={searchQuery.trim() ? "Tasks" : "Recent tasks"}>
              {tasks.map(({ task, workspaceName }) => (
                <TaskCommandItem
                  key={task.id}
                  task={task}
                  workspaceName={workspaceName}
                  isSelected={task.id === selectedTaskId}
                  onSelect={handleSelectTask}
                />
              ))}
            </CommandGroup>
          </>
        ) : null}

        {projectWorkspaces.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Workspaces">
              {projectWorkspaces.map((ws) => (
                <WorkspaceCommandItem key={ws.id} workspace={ws} onSelect={handleSelectWorkspace} />
              ))}
            </CommandGroup>
          </>
        ) : null}

        {settingsPages.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Settings">
              {settingsPages.map((page, index) => (
                <CommandItem
                  key={page.id}
                  value={`settings ${page.label}`}
                  onSelect={() => handleOpenSettings(page.id)}
                >
                  <Settings2Icon />
                  <span>{page.label}</span>
                  {index === 0 ? <CommandKbd keys={[MOD, ","]} /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {skills.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Skills">
              {skills.map((skill) => (
                <CommandItem
                  key={skill.installationId}
                  value={`skill ${skill.installationId}`}
                  keywords={[skill.name, skill.description]}
                  onSelect={handleOpenSkills}
                >
                  <SparklesIcon />
                  <span>{skill.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
});

const ThreadCommandItem = memo(function ThreadCommandItem({
  thread,
  workspaceName,
  isSelected,
  onSelect,
}: {
  thread: ThreadRecord;
  workspaceName?: string;
  isSelected: boolean;
  onSelect: (threadId: string) => void;
}) {
  const title = thread.title || "New chat";
  return (
    <CommandItem
      value={`thread ${thread.id}`}
      keywords={["chat", title, workspaceName ?? ""]}
      onSelect={() => onSelect(thread.id)}
    >
      <HistoryIcon />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {workspaceName ? (
        <span className="ml-auto text-xs text-muted-foreground truncate max-w-[40%]">
          {workspaceName}
        </span>
      ) : null}
      {isSelected ? <span className="sr-only">(current)</span> : null}
    </CommandItem>
  );
});

const TaskCommandItem = memo(function TaskCommandItem({
  task,
  workspaceName,
  isSelected,
  onSelect,
}: {
  task: TaskSummary;
  workspaceName: string;
  isSelected: boolean;
  onSelect: (taskId: string) => void;
}) {
  return (
    <CommandItem
      value={`task ${task.id}`}
      keywords={[task.title, workspaceName]}
      onSelect={() => onSelect(task.id)}
    >
      <ClipboardListIcon />
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <span className="ml-auto max-w-[40%] truncate text-xs text-muted-foreground">
        {workspaceName}
      </span>
      {isSelected ? <span className="sr-only">(current)</span> : null}
    </CommandItem>
  );
});

const WorkspaceCommandItem = memo(function WorkspaceCommandItem({
  workspace,
  onSelect,
}: {
  workspace: WorkspaceRecord;
  onSelect: (workspaceId: string) => void;
}) {
  return (
    <CommandItem
      value={`workspace ${workspace.id}`}
      keywords={["project", workspace.name]}
      onSelect={() => onSelect(workspace.id)}
    >
      <FolderIcon />
      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
    </CommandItem>
  );
});
