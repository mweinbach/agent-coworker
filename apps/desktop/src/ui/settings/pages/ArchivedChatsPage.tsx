import { ArchiveIcon, ClockIcon, RotateCcwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { countOutstandingInteractions } from "../../../app/interactionQueue";
import { useAppStore } from "../../../app/store";
import { isStandardChatThread } from "../../../app/threadFilters";
import { workspaceLabelForThread } from "../../../app/workspaceDisplayTargets";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { confirmAction } from "../../../lib/desktopCommands";
import { ConversationImportDialog } from "../import/ConversationImportDialog";
import { SettingsEmptyState, SettingsRow, SettingsSection } from "../SettingsPrimitives";

function formatArchivedDate(isoString?: string): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ArchivedChatsPage() {
  const threads = useAppStore((s) => s.threads);
  const workspaces = useAppStore((s) => s.workspaces);
  const desktopSettings = useAppStore((s) => s.desktopSettings);
  const interactionsByThread = useAppStore((s) => s.interactionsByThread);
  const restoreThread = useAppStore((s) => s.restoreThread);
  const deleteThreadHistory = useAppStore((s) => s.deleteThreadHistory);
  const setArchivedChatsAutoDeleteDays = useAppStore((s) => s.setArchivedChatsAutoDeleteDays);
  const [searchQuery, setSearchQuery] = useState("");

  const archivedThreads = threads.filter(
    (thread) => thread.archived && isStandardChatThread(thread, { includeArchived: true }),
  );
  const filteredArchivedThreads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return archivedThreads;
    return archivedThreads.filter((thread) => {
      const title = (thread.title || "New chat").toLowerCase();
      const workspaceName = workspaceLabelForThread(
        workspaces,
        thread.workspaceId,
        "Unknown workspace",
      ).toLowerCase();
      return title.includes(query) || workspaceName.includes(query);
    });
  }, [archivedThreads, searchQuery, workspaces]);
  const currentAutoDelete = desktopSettings.archivedChatsAutoDeleteDays;

  const handleDelete = async (threadId: string, title: string) => {
    const confirmed = await confirmAction({
      title: "Delete archived chat",
      message: `Permanently delete "${title || "New chat"}"?`,
      detail: "This removes the chat history permanently. This action cannot be undone.",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      kind: "error",
      defaultAction: "cancel",
    });
    if (confirmed) {
      void deleteThreadHistory(threadId);
    }
  };

  return (
    <>
      <SettingsSection
        title="Conversation import"
        description="Import Codex, Claude Code, or Cowork backup chats as normal Cowork threads."
        action={<ConversationImportDialog />}
      >
        <SettingsRow
          title="Safe imports"
          description="Imported chats keep their visible replay history, while future turns use sanitized context without external provider continuation state."
        />
      </SettingsSection>

      <SettingsSection
        title="Auto-delete Settings"
        description="Configure how long archived conversation history remains before being permanently deleted from your computer."
      >
        <SettingsRow
          title="Delete archived chats"
          description="Applies to every archived chat on this device."
          control={
            <Select
              value={String(currentAutoDelete)}
              onValueChange={(val) => setArchivedChatsAutoDeleteDays(Number(val))}
            >
              <SelectTrigger className="w-48 text-[13px] h-9" aria-label="Auto-delete retention">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Never</SelectItem>
                <SelectItem value="7">After 7 days</SelectItem>
                <SelectItem value="30">After 30 days</SelectItem>
                <SelectItem value="90">After 90 days</SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsSection>

      {archivedThreads.length === 0 ? (
        <SettingsEmptyState
          icon={<ArchiveIcon />}
          title="No archived chats"
          description="Archived chats will be stored here. Use a chat's More actions menu in the sidebar to archive it."
        />
      ) : (
        <SettingsSection
          title={`Archived Chats (${filteredArchivedThreads.length}${
            searchQuery.trim() ? ` of ${archivedThreads.length}` : ""
          })`}
        >
          <div className="relative mb-3">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search archived chats"
              aria-label="Search archived chats"
              className="h-9 pl-8 text-[13px]"
            />
          </div>
          {filteredArchivedThreads.length === 0 ? (
            <div className="px-1 py-4 text-sm text-muted-foreground">
              No archived chats match “{searchQuery.trim()}”.
            </div>
          ) : (
            filteredArchivedThreads.map((thread) => {
              const interactionCount = countOutstandingInteractions(
                interactionsByThread[thread.id],
              );
              const wsName = workspaceLabelForThread(
                workspaces,
                thread.workspaceId,
                "Unknown workspace",
              );
              return (
                <SettingsRow
                  key={thread.id}
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{thread.title || "New chat"}</span>
                      {interactionCount > 0 ? (
                        <Badge variant="secondary">Needs input · {interactionCount}</Badge>
                      ) : null}
                    </span>
                  }
                  description={
                    <span className="flex items-center gap-2.5">
                      <span>{wsName}</span>
                      <span className="text-[10px] opacity-45">•</span>
                      <span className="flex items-center gap-1">
                        <ClockIcon className="h-3 w-3" />
                        <span>Archived {formatArchivedDate(thread.archivedAt)}</span>
                      </span>
                    </span>
                  }
                  control={
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] px-2.5"
                        onClick={() => void restoreThread(thread.id)}
                      >
                        <RotateCcwIcon className="h-3.5 w-3.5" />
                        Restore
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/[0.06] px-2.5"
                        onClick={() => handleDelete(thread.id, thread.title)}
                      >
                        <Trash2Icon className="h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  }
                />
              );
            })
          )}
        </SettingsSection>
      )}
    </>
  );
}
