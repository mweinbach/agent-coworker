import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAppStore } from "../../../app/store";
import { operationKey } from "../../../app/store.helpers";
import type { AdvancedMemoryEntry, OperationState } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
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
import { OperationFeedback } from "../../OperationFeedback";
import { SettingsEmptyState } from "../SettingsPrimitives";

export type DraftAdvancedMemory = {
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

export function AdvancedMemoryEditorDialog({
  open,
  editingSlug,
  draft,
  saving,
  operation,
  isDirty,
  setDraft,
  onCancel,
  onSave,
}: {
  open: boolean;
  editingSlug: string | null;
  draft: DraftAdvancedMemory;
  saving: boolean;
  operation: OperationState | undefined;
  isDirty: boolean;
  setDraft: Dispatch<SetStateAction<DraftAdvancedMemory>>;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={async (nextOpen) => {
        if (!nextOpen && saving) return;
        if (!nextOpen && isDirty) {
          const confirmed = await confirmAction({
            title: "Discard changes?",
            message: "You have unsaved changes to this memory.",
            confirmLabel: "Discard",
            cancelLabel: "Keep editing",
            kind: "warning",
            defaultAction: "cancel",
          });
          if (!confirmed) return;
        }
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent className="flex max-h-[min(92vh,48rem)] w-[min(92vw,42rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12">
          <DialogTitle>{editingSlug ? "Edit memory" : "Add memory"}</DialogTitle>
          <DialogDescription className="sr-only">
            Edit the memory name, description, type, and content.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="adv-memory-name" className="text-xs font-medium text-foreground">
                Name
              </label>
              <Input
                id="adv-memory-name"
                placeholder="Short topic title"
                value={draft.name}
                disabled={saving}
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
                disabled={saving}
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
                disabled={saving}
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
                className="h-[min(42vh,24rem)] min-h-[12rem] resize-y overflow-auto [field-sizing:fixed]"
                value={draft.body}
                disabled={saving}
                onChange={(event) => setDraft((prev) => ({ ...prev, body: event.target.value }))}
              />
            </div>
          </div>
        </div>
        <OperationFeedback operation={operation} className="mx-5 mb-4" />
        <DialogFooter className="shrink-0 border-t border-border/60 px-5 py-4">
          <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={!draft.name.trim() || !draft.body.trim() || saving}
          >
            {saving ? "Saving..." : editingSlug ? "Save changes" : "Add memory"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdvancedMemoryPanel({ workspaceId, cwd }: { workspaceId: string; cwd: string }) {
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const requestAdvancedMemories = useAppStore((s) => s.requestAdvancedMemories);
  const upsertAdvancedMemory = useAppStore((s) => s.upsertAdvancedMemory);
  const deleteAdvancedMemory = useAppStore((s) => s.deleteAdvancedMemory);
  const operationsByKey = useAppStore((s) => s.operationsByKey);

  const runtime = workspaceRuntimeById[workspaceId];
  const memories = useMemo(() => runtime?.advancedMemories ?? [], [runtime?.advancedMemories]);
  const folder = runtime?.advancedMemoryActiveFolder ?? null;
  const loading = runtime?.advancedMemoriesLoading ?? false;
  const controlSessionId = runtime?.controlSessionId ?? null;
  const saveOperation = operationsByKey[operationKey("memory", "advanced-save", workspaceId)];
  const saving = saveOperation?.status === "pending";

  const [draft, setDraft] = useState<DraftAdvancedMemory>(emptyDraft);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedSlugs, setExpandedSlugs] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    void requestAdvancedMemories(workspaceId, { cwd });
  }, [requestAdvancedMemories, workspaceId, cwd]);

  // Re-fetch on mount/cwd change and again once the control session connects:
  // the initial request returns early while the session is still handshaking.
  // biome-ignore lint/correctness/useExhaustiveDependencies: controlSessionId is an intentional re-trigger
  useEffect(() => {
    refresh();
  }, [refresh, controlSessionId]);

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

  const isDraftDirty = useCallback((): boolean => {
    if (editingSlug) {
      const original = memories.find((entry) => entry.slug === editingSlug);
      if (!original) return true;
      return (
        draft.name !== original.name ||
        draft.description !== original.description ||
        draft.type !== (original.type || "note") ||
        draft.body !== original.body
      );
    }
    const fresh = emptyDraft();
    return (
      draft.name !== fresh.name ||
      draft.description !== fresh.description ||
      draft.type !== fresh.type ||
      draft.body !== fresh.body
    );
  }, [draft, editingSlug, memories]);

  const handleSave = async () => {
    if (!draft.name.trim() || !draft.body.trim() || saving) return;
    const result = await upsertAdvancedMemory(
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
    if (result.ok) closeDialog();
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
        <SettingsEmptyState
          icon={<BrainIcon />}
          title={
            loading ? "Loading..." : "No memories yet. They are written automatically as you work."
          }
        />
      ) : (
        <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/50 bg-card">
          {memories.map((entry) => {
            const isExpanded = expandedSlugs[entry.slug] ?? false;
            const deleteOperation =
              operationsByKey[
                operationKey(
                  "memory",
                  "advanced-delete",
                  workspaceId,
                  folder ?? undefined,
                  entry.slug,
                )
              ];
            return (
              <div key={entry.slug} className={cn(isExpanded && "bg-card/40")}>
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
                        disabled={deleteOperation?.status === "pending"}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDelete(entry);
                        }}
                      >
                        <Trash2Icon className="w-3.5 h-3.5 mr-1" />
                        Delete
                      </Button>
                    </div>
                    <OperationFeedback operation={deleteOperation} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AdvancedMemoryEditorDialog
        open={dialogOpen}
        editingSlug={editingSlug}
        draft={draft}
        saving={saving}
        operation={saveOperation}
        isDirty={isDraftDirty()}
        setDraft={setDraft}
        onCancel={closeDialog}
        onSave={() => void handleSave()}
      />
    </div>
  );
}
