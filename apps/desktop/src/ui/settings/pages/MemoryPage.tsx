import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";

import { useAppStore } from "../../../app/store";
import type { MemoryListEntry } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/utils";
import { confirmAction } from "../../../lib/desktopCommands";

type DraftMemory = {
  scope: "workspace" | "user";
  id: string;
  content: string;
};

export const HOT_MEMORY_ID = "hot";
export const MEMORY_LOADING_STALL_MS = 1_500;

export function resolveDraftMemoryId(rawId: string): string {
  return rawId.trim() || HOT_MEMORY_ID;
}

export function isMemoryLoadStalled(
  memoriesLoading: boolean,
  requestedAt: number | null,
  nowMs: number,
  stallMs = MEMORY_LOADING_STALL_MS,
): boolean {
  if (!memoriesLoading || requestedAt === null) return false;
  return nowMs - requestedAt >= stallMs;
}

function emptyDraft(): DraftMemory {
  return { scope: "workspace", id: "", content: "" };
}

function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 60_000) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(diffMs / 86_400_000);
  if (days === 1) return "yesterday";

  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function MemoryPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const requestWorkspaceMemories = useAppStore((s) => s.requestWorkspaceMemories);
  const upsertWorkspaceMemory = useAppStore((s) => s.upsertWorkspaceMemory);
  const deleteWorkspaceMemory = useAppStore((s) => s.deleteWorkspaceMemory);

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, selectedWorkspaceId],
  );
  const runtime = workspace ? workspaceRuntimeById[workspace.id] : null;
  const memories = runtime?.memories ?? [];
  const memoriesLoading = runtime?.memoriesLoading ?? false;

  const [draft, setDraft] = useState<DraftMemory>(emptyDraft);
  const [editingEntry, setEditingEntry] = useState<MemoryListEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [filterScope, setFilterScope] = useState<"all" | "workspace" | "user">("all");
  const [memoryLoadRequestedAt, setMemoryLoadRequestedAt] = useState<number | null>(null);
  const [memoryLoadStalled, setMemoryLoadStalled] = useState(false);

  const [parent] = useAutoAnimate();

  const requestMemories = (workspaceId: string) => {
    setMemoryLoadRequestedAt(Date.now());
    setMemoryLoadStalled(false);
    void requestWorkspaceMemories(workspaceId);
  };

  useEffect(() => {
    if (!workspace) return;
    setEditingEntry(null);
    setDraft(emptyDraft());
    setDialogOpen(false);
    requestMemories(workspace.id);
  }, [workspace?.id]);

  useEffect(() => {
    if (!memoriesLoading) {
      setMemoryLoadRequestedAt(null);
      setMemoryLoadStalled(false);
      return;
    }

    const requestedAt = memoryLoadRequestedAt ?? Date.now();
    if (memoryLoadRequestedAt === null) {
      setMemoryLoadRequestedAt(requestedAt);
    }

    if (isMemoryLoadStalled(true, requestedAt, Date.now())) {
      setMemoryLoadStalled(true);
      return;
    }

    const timer = window.setTimeout(() => {
      setMemoryLoadStalled(true);
    }, Math.max(0, MEMORY_LOADING_STALL_MS - (Date.now() - requestedAt)));
    return () => window.clearTimeout(timer);
  }, [memoriesLoading, memoryLoadRequestedAt, workspace?.id]);

  const filtered = filterScope === "all" ? memories : memories.filter((m) => m.scope === filterScope);
  const showMemoryLoading = memoriesLoading && !memoryLoadStalled;

  const toggleExpand = (key: string) => {
    setExpandedIds((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const entryKey = (entry: MemoryListEntry) => `${entry.scope}:${entry.id}`;

  const openCreateDialog = () => {
    setEditingEntry(null);
    setDraft(emptyDraft());
    setDialogOpen(true);
  };

  const openEditDialog = (entry: MemoryListEntry) => {
    setEditingEntry(entry);
    setDraft({ scope: entry.scope, id: entry.id, content: entry.content });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingEntry(null);
    setDraft(emptyDraft());
  };

  const handleSave = () => {
    if (!workspace || !draft.content.trim()) return;
    const id = resolveDraftMemoryId(draft.id);
    void upsertWorkspaceMemory(workspace.id, draft.scope, id, draft.content.trim());
    closeDialog();
  };

  const handleDelete = async (entry: MemoryListEntry) => {
    if (!workspace) return;
    const confirmed = await confirmAction({
      title: "Delete memory",
      message: `Delete "${entry.id}"?`,
      detail: "This memory will be permanently removed.",
      kind: "warning",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    void deleteWorkspaceMemory(workspace.id, entry.scope, entry.id);
  };

  const scopeLabel = (scope: "workspace" | "user") => (scope === "workspace" ? "Workspace" : "Global");

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Memory</h1>
        <p className="text-sm text-muted-foreground">
          Things Cowork remembers about you and this workspace.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {workspaces.length > 1 && workspace ? (
            <Select value={workspace.id} onValueChange={(value) => void selectWorkspace(value)}>
              <SelectTrigger className="max-w-48" aria-label="Active workspace">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <div className="flex rounded-md border border-border/70 overflow-hidden">
            {(["all", "workspace", "user"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  filterScope === scope
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
                onClick={() => setFilterScope(scope)}
              >
                {scope === "all" ? "All" : scopeLabel(scope)}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={showMemoryLoading}
            onClick={() => workspace && requestMemories(workspace.id)}
          >
            {showMemoryLoading ? "Loading..." : "Refresh"}
          </Button>
        </div>

        {workspace ? (
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={openCreateDialog}>
            <PlusIcon className="w-4 h-4 mr-1.5" />
            Add memory
          </Button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-background/50 py-12 flex flex-col items-center justify-center gap-3">
          <BrainIcon className="w-10 h-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {showMemoryLoading ? "Loading..." : "No memories yet"}
          </p>
          {!showMemoryLoading && workspace ? (
            <Button variant="outline" size="sm" onClick={openCreateDialog}>
              Add your first memory
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="rounded-xl border border-border/70 overflow-hidden bg-background/50" ref={parent}>
          {filtered.map((entry) => {
            const key = entryKey(entry);
            const isExpanded = expandedIds[key] ?? false;

            return (
              <div key={key} className={cn("border-b border-border/70 last:border-b-0", isExpanded && "bg-card/40")}>
                <div
                  className="flex items-center justify-between p-4 cursor-pointer hover:bg-card/60 transition-colors"
                  onClick={() => toggleExpand(key)}
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? (
                      <ChevronDownIcon className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
                    )}
                    <span className="font-medium text-foreground text-sm">{entry.id}</span>
                    <Badge variant={entry.scope === "workspace" ? "default" : "secondary"} className="text-[10px] uppercase h-5">
                      {scopeLabel(entry.scope)}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground/60">
                    Updated {relativeTime(entry.updatedAt)}
                  </span>
                </div>

                {isExpanded && (
                  <div className="px-10 pb-4 text-xs space-y-3">
                    <pre className="whitespace-pre-wrap text-muted-foreground font-sans text-[13px] leading-relaxed">
                      {entry.content}
                    </pre>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => openEditDialog(entry)}
                      >
                        <PencilIcon className="w-3.5 h-3.5 mr-1" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                        onClick={() => void handleDelete(entry)}
                      >
                        <Trash2Icon className="w-3.5 h-3.5 mr-1" />
                        Delete
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingEntry ? `Edit memory` : "Add memory"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Title</label>
              <Input
                placeholder="Optional — leave blank for general memory"
                value={draft.id}
                disabled={!!editingEntry}
                onChange={(event) => setDraft((prev) => ({ ...prev, id: event.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Scope</label>
              <Select
                value={draft.scope}
                disabled={!!editingEntry}
                onValueChange={(value) => setDraft((prev) => ({ ...prev, scope: value as "workspace" | "user" }))}
              >
                <SelectTrigger aria-label="Memory scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="workspace">Workspace</SelectItem>
                  <SelectItem value="user">Global</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Content</label>
              <Textarea
                placeholder="What should Cowork remember?"
                className="min-h-[100px]"
                value={draft.content}
                onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSave} disabled={!draft.content.trim()}>
                {editingEntry ? "Save changes" : "Add memory"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
