import { ArchiveIcon, ClockIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { confirmAction } from "../../../lib/desktopCommands";

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
  const restoreThread = useAppStore((s) => s.restoreThread);
  const deleteThreadHistory = useAppStore((s) => s.deleteThreadHistory);
  const setArchivedChatsAutoDeleteDays = useAppStore((s) => s.setArchivedChatsAutoDeleteDays);

  const archivedThreads = threads.filter((t) => t.archived);
  const currentAutoDelete = desktopSettings.archivedChatsAutoDeleteDays;

  const handleDelete = async (threadId: string, title: string) => {
    const confirmed = await confirmAction({
      title: "Delete archived chat",
      message: `Permanently delete "${title || "New thread"}"?`,
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
    <div className="space-y-6">
      <Card className="border border-border/45 bg-foreground/[0.015] shadow-none">
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-semibold tracking-[-0.01em]">Auto-delete Settings</h3>
            <p className="text-xs text-muted-foreground leading-normal max-w-xl">
              Configure how long archived conversation history remains before being permanently
              deleted from your computer.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Select
              value={String(currentAutoDelete)}
              onValueChange={(val) => setArchivedChatsAutoDeleteDays(Number(val))}
            >
              <SelectTrigger className="w-48 text-[13px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Never</SelectItem>
                <SelectItem value="7">After 7 days</SelectItem>
                <SelectItem value="30">After 30 days</SelectItem>
                <SelectItem value="90">After 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold tracking-[-0.01em]">
            Archived Chats ({archivedThreads.length})
          </h3>
        </div>

        {archivedThreads.length === 0 ? (
          <div className="flex flex-col items-center justify-center border border-dashed border-border/60 rounded-xl py-12 px-4 text-center">
            <ArchiveIcon className="h-8 w-8 mb-3 text-muted-foreground/30" />
            <p className="text-sm font-medium text-foreground">No archived chats</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Archived chats will be stored here. You can archive any chat from the sidebar by
              hovering over its date label.
            </p>
          </div>
        ) : (
          <div className="border border-border/45 rounded-xl divide-y divide-border/40 overflow-hidden bg-background">
            {archivedThreads.map((thread) => {
              const wsName =
                workspaces.find((w) => w.id === thread.workspaceId)?.name || "Unknown workspace";
              return (
                <div
                  key={thread.id}
                  className="flex items-center justify-between p-3.5 hover:bg-foreground/[0.01] transition-all"
                >
                  <div className="min-w-0 flex-1 space-y-1 pr-4">
                    <div className="font-medium text-[13px] truncate">
                      {thread.title || "New thread"}
                    </div>
                    <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                      <span>{wsName}</span>
                      <span className="text-[10px] opacity-45">•</span>
                      <div className="flex items-center gap-1">
                        <ClockIcon className="h-3 w-3" />
                        <span>Archived {formatArchivedDate(thread.archivedAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
