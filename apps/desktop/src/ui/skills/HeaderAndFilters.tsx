import { useMemo } from "react";
import { MessageSquareIcon, RefreshCwIcon, SearchIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { InstallSkillDialog } from "./InstallSkillDialog";
import { useAppStore } from "../../app/store";

export function HeaderAndFilters({
  workspaceId,
  searchQuery,
  setSearchQuery,
}: {
  workspaceId: string;
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

  const handleOpenChat = async () => {
    if (activeThread) {
      await selectThread(activeThread.id);
      return;
    }
    await newThread({ workspaceId });
  };

  return (
    <div className="mb-6 flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="mb-1 text-[2rem] font-semibold tracking-tight">Skills</h1>
          <p className="text-sm text-muted-foreground">
            Skills for <span className="font-medium text-foreground/80">{workspace?.name ?? "this workspace"}</span>
            <span className="mx-2 text-muted-foreground/65">•</span>
            {sessionLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void handleOpenChat()}
          >
            <MessageSquareIcon className="mr-2 h-4 w-4" />
            {chatButtonLabel}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void refreshSkillsCatalog()}
          >
            <RefreshCwIcon className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <div className="relative w-60">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search skills"
              className="h-8 border-transparent bg-muted/30 pl-9 focus-visible:bg-background focus-visible:border-ring"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <InstallSkillDialog workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}
