import { useMemo } from "react";
import { MessageSquareIcon, RefreshCwIcon, SearchIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { InstallSkillDialog } from "./InstallSkillDialog";
import { useAppStore } from "../../app/store";

export function HeaderAndFilters({
  workspaceId,
  managementScope = "workspace",
  searchQuery,
  setSearchQuery,
}: {
  workspaceId: string;
  managementScope?: "workspace" | "global";
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}) {
  const refreshSkillsCatalog = useAppStore((s) => s.refreshSkillsCatalog);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectThread = useAppStore((s) => s.selectThread);
  const newThread = useAppStore((s) => s.newThread);

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === workspaceId) ?? null,
    [workspaceId, workspaces],
  );

  const workspaceThreads = useMemo(
    () =>
      threads
        .filter((thread) => thread.workspaceId === workspaceId)
        .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt)),
    [threads, workspaceId],
  );

  const activeThread = useMemo(() => {
    if (!selectedThreadId) {
      return workspaceThreads[0] ?? null;
    }
    return workspaceThreads.find((thread) => thread.id === selectedThreadId) ?? workspaceThreads[0] ?? null;
  }, [selectedThreadId, workspaceThreads]);

  const sessionLabel = workspaceThreads.length === 1 ? "1 session" : `${workspaceThreads.length} sessions`;
  const chatButtonLabel = workspaceThreads.length > 0 ? "Open chat" : "New thread";
  const ownerLabel = managementScope === "global"
    ? "Global"
    : workspace?.name ?? "this workspace";

  const handleOpenChat = async () => {
    if (activeThread) {
      await selectThread(activeThread.id);
      return;
    }
    await newThread({ workspaceId });
  };

  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <h1 className="text-lg font-semibold tracking-tight shrink-0">Skills</h1>
        <p className="text-sm text-muted-foreground truncate">
          <span className="font-medium text-foreground/80">{ownerLabel}</span>
          <span className="mx-1.5 text-muted-foreground/65">•</span>
          {sessionLabel}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-muted-foreground hover:text-foreground"
          onClick={() => void handleOpenChat()}
        >
          <MessageSquareIcon className="mr-1.5 h-4 w-4" />
          {chatButtonLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-muted-foreground hover:text-foreground"
          onClick={() => void refreshSkillsCatalog()}
        >
          <RefreshCwIcon className="mr-1.5 h-4 w-4" />
          Refresh
        </Button>
        <div className="relative w-44">
          <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search skills"
            className="h-8 border-transparent bg-muted/30 pl-8 text-sm focus-visible:bg-background focus-visible:border-ring"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <InstallSkillDialog workspaceId={workspaceId} />
      </div>
    </div>
  );
}
