import { BrainIcon, ChevronDownIcon, ChevronRightIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import type { AdvancedMemoryEntry } from "../../../app/types";
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
import { confirmAction } from "../../../lib/desktopCommands";
import { cn } from "../../../lib/utils";

type DraftAdvancedMemory = {
  slug: string;
  name: string;
  description: string;
  type: string;
  body: string;
};

const MEMORY_TYPES = ["feedback", "project", "note"] as const;

function emptyDraft(): DraftAdvancedMemory {
  return { slug: "", name: "", description: "", type: "note", body: "" };
}

export function AdvancedMemoryPanel({
  workspaceId,
  cwd,
}: {
  workspaceId: string;
  cwd: string;
}) {
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const requestAdvancedMemories = useAppStore((s) => s.requestAdvancedMemories);
  const upsertAdvancedMemory = useAppStore((s) => s.upsertAdvancedMemory);
  const deleteAdvancedMemory = useAppStore((s) => s.deleteAdvancedMemory);

  const runtime = workspaceRuntimeById[workspaceId];
  const memories = useMemo(() => runtime?.advancedMemories ?? [], [runtime?.advancedMemories]);
  const folder = runtime?.advancedMemoryActiveFolder ?? null;
  const loading = runtime?.advancedMemoriesLoading ?? false;

  const [draft, setDraft] = useState<DraftAdvancedMemory>(emptyDraft);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedSlugs, setExpandedSlugs] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    void requestAdvancedMemories(workspaceId, { cwd });
  }, [requestAdvancedMemories, workspaceId, cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openCreate = () => {
    setEditingSlug(null);
    setDraft(emptyDraft());
    setDialogOpen(true);
  };

  const openEdit = (entry: AdvancedMemoryEntry) => {
    setEditingSlug(entry.slug);
    setDraft({
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      type: entry.type || "note",
      body: entry.body,
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingSlug(null);
    setDraft(emptyDraft());
  };

  const handleSave = () => {
    if (!draft.name.trim() || !draft.body.trim()) return;
    void upsertAdvancedMemory(
      workspaceId,
      {
        ...(folder ? { folder } : {}),
        ...(editingSlug ? { slug: editingSlug } : {}),
        name: draft.name.trim(),
        description: draft.description.trim(),
        type: draft.type,
        body: draft.body.trim(),
      },
      { cwd },
    );
    closeDialog();
  };

  const handleDelete = async (entry: AdvancedMemoryEntry) => {
    const confirmed = await confirmAction({
      title: "Delete memory",
      message: `Delete "${entry.name}"?`,
      detail: "This memory file will be permanently removed.",
      kind: "warning",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    void deleteAdvancedMemory(workspaceId, folder ?? undefined, entry.slug, { cwd });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {folder ? <Badge variant="secondary">{folder}</Badge> : null}
          <Button variant="outline" size="sm" type="button" disabled={loading} onClick={refresh}>
            {loading ? "Loading..." : "Refresh"}
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={openCreate}
        >
          <PlusIcon className="w-4 h-4 mr-1.5" />
          Add memory
        </Button>
      </div>

      {memories.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-background/50 py-12 flex flex-col items-center justify-center gap-3">
          <BrainIcon className="w-10 h-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {loading ? "Loading..." : "No memories yet. They are written automatically as you work."}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/70 overflow-hidden bg-background/50">
          {memories.map((entry) => {
            const isExpanded = expandedSlugs[entry.slug] ?? false;
            return (
              <div
                key={entry.slug}
                className={cn("border-b border-border/70 last:border-b-0", isExpanded && "bg-card/40")}
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-card/60"
                  onClick={() =>
                    setExpandedSlugs((prev) => ({ ...prev, [entry.slug]: !prev[entry.slug] }))
                  }
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? (
                      <ChevronDownIcon className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
                    )}
                    <span className="font-medium text-foreground text-sm">{entry.name}</span>
                    <Badge variant="secondary" className="text-[10px] uppercase h-5">
                      {entry.type}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground/60 truncate max-w-[40%]">
                    {entry.description}
                  </span>
                </button>
                {isExpanded && (
                  <div className="px-10 pb-4 text-xs space-y-3">
                    <pre className="whitespace-pre-wrap text-muted-foreground font-sans text-[13px] leading-relaxed">
                      {entry.body}
                    </pre>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          openEdit(entry);
                        }}
                      >
                        <PencilIcon className="w-3.5 h-3.5 mr-1" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDelete(entry);
                        }}
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

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSlug ? "Edit memory" : "Add memory"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label htmlFor="adv-memory-name" className="text-xs font-medium text-foreground">
                Name
              </label>
              <Input
                id="adv-memory-name"
                placeholder="Short topic title"
                value={draft.name}
                onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="adv-memory-desc" className="text-xs font-medium text-foreground">
                Description
              </label>
              <Input
                id="adv-memory-desc"
                placeholder="One-line summary for the index"
                value={draft.description}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, description: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="adv-memory-type" className="text-xs font-medium text-foreground">
                Type
              </label>
              <Select
                value={draft.type}
                onValueChange={(value) => setDraft((prev) => ({ ...prev, type: value }))}
              >
                <SelectTrigger id="adv-memory-type" aria-label="Memory type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="adv-memory-body" className="text-xs font-medium text-foreground">
                Content
              </label>
              <Textarea
                id="adv-memory-body"
                placeholder="What should Cowork remember?"
                className="min-h-[140px]"
                value={draft.body}
                onChange={(event) => setDraft((prev) => ({ ...prev, body: event.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleSave}
                disabled={!draft.name.trim() || !draft.body.trim()}
              >
                {editingSlug ? "Save changes" : "Add memory"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
