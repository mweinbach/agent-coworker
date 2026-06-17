import {
  FolderIcon,
  HistoryIcon,
  MessageSquareIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { useAppStore } from "../app/store";
import { isOneOffChatWorkspace, type ThreadRecord, type WorkspaceRecord } from "../app/types";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../components/ui/command";
import { getSettingsGroups } from "./settings/SettingsShell";

export type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Cmd/Ctrl+K command palette. Surfaces recent threads, workspaces, settings
 * pages, and skills so power users can navigate without the mouse. All data
 * comes from the existing zustand store and selection reuses existing store
 * actions (selectThread / selectWorkspace / openSettings / openSkills).
 */
export const CommandPalette = memo(function CommandPalette({
  open,
  onOpenChange,
}: CommandPaletteProps) {
  const threads = useAppStore((s) => s.threads);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const developerMode = useAppStore((s) => s.developerMode);
  const remoteAccessAvailable = useAppStore(
    (s) => s.desktopFeatureFlags.remoteAccess === true,
  );
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);

  const selectThread = useAppStore((s) => s.selectThread);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const openSettings = useAppStore((s) => s.openSettings);
  const openSkills = useAppStore((s) => s.openSkills);

  // Recent, non-draft, non-archived threads, newest first.
  const recentThreads = useMemo(() => {
    const eligible = threads.filter((t) => !t.draft && !t.archived);
    return [...eligible]
      .sort((a, b) => (b.lastMessageAt > a.lastMessageAt ? 1 : -1))
      .slice(0, 8);
  }, [threads]);

  const workspaceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of workspaces) map.set(ws.id, ws.name);
    return map;
  }, [workspaces]);

  // Project workspaces (exclude one-off chats) — these are the navigable ones.
  const projectWorkspaces = useMemo(
    () => workspaces.filter((ws) => !isOneOffChatWorkspace(ws)),
    [workspaces],
  );

  // Installed skills across the active workspace's catalog.
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
      if (entries.length >= 12) break;
    }
    return entries;
  }, [workspaces, workspaceRuntimeById]);

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

  const handleOpenSettings = useCallback(
    (page: string) => {
      // Cast: SettingsPageId is a string union; the palette only ever lists
      // ids produced by getSettingsGroups, so the cast is sound.
      openSettings(page as Parameters<typeof openSettings>[0]);
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

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search threads, workspaces, settings, skills…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem onSelect={handleNewChatClick} value="new chat">
            <MessageSquareIcon />
            <span>New chat</span>
          </CommandItem>
          <CommandItem onSelect={handleOpenSkills} value="browse skills">
            <SparklesIcon />
            <span>Browse skills</span>
          </CommandItem>
        </CommandGroup>

        {recentThreads.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent threads">
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

        {projectWorkspaces.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Workspaces">
              {projectWorkspaces.slice(0, 8).map((ws) => (
                <WorkspaceCommandItem
                  key={ws.id}
                  workspace={ws}
                  onSelect={handleSelectWorkspace}
                />
              ))}
            </CommandGroup>
          </>
        ) : null}

        {settingsPages.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Settings">
              {settingsPages.map((page) => (
                <CommandItem
                  key={page.id}
                  value={`settings ${page.label}`}
                  onSelect={() => handleOpenSettings(page.id)}
                >
                  <Settings2Icon />
                  <span>{page.label}</span>
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
                  value={`skill ${skill.name}`}
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
      value={`thread ${title}`}
      onSelect={() => onSelect(thread.id)}
    >
      <HistoryIcon />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {workspaceName ? (
        <span className="ml-auto text-xs text-muted-foreground truncate max-w-[40%]">
          {workspaceName}
        </span>
      ) : null}
      {isSelected ? (
        <span className="sr-only">(current)</span>
      ) : null}
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
      value={`workspace ${workspace.name}`}
      onSelect={() => onSelect(workspace.id)}
    >
      <FolderIcon />
      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
    </CommandItem>
  );
});
