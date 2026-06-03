import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import type { AdvancedMemoryListEntry, MemoryListEntry } from "../../../app/types";
import {
  CHATS_WORKSPACE_TARGET_ID,
  resolveWorkspaceDisplayTargets,
  type WorkspaceDisplayTarget,
} from "../../../app/workspaceDisplayTargets";
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
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { confirmAction } from "../../../lib/desktopCommands";
import {
  decodeProviderModelSelection,
  encodeProviderModelSelection,
  modelChoicesFromCatalog,
  modelDisplayNamesFromCatalog,
  resolveModelDisplayLabel,
} from "../../../lib/modelChoices";
import { cn } from "../../../lib/utils";

type DraftMemory = {
  scope: "workspace" | "user";
  id: string;
  content: string;
};

const HOT_MEMORY_ID = "hot";
const DEFAULT_ADVANCED_MEMORY_MODEL_REF = "google:gemini-3.1-flash-lite";
export const CHATS_MEMORY_TARGET_ID = CHATS_WORKSPACE_TARGET_ID;
export const MEMORY_LOADING_STALL_MS = 1_500;
export { parentDirectoryPath } from "../../../app/workspaceDisplayTargets";

export type MemoryTarget = WorkspaceDisplayTarget;

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

export const resolveMemoryTargets = resolveWorkspaceDisplayTargets;

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
  const desktopFeatures = useAppStore((s) => s.desktopFeatureFlags);
  const workspacePickerEnabled = desktopFeatures.workspacePicker !== false;
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const requestWorkspaceMemories = useAppStore((s) => s.requestWorkspaceMemories);
  const upsertWorkspaceMemory = useAppStore((s) => s.upsertWorkspaceMemory);
  const deleteWorkspaceMemory = useAppStore((s) => s.deleteWorkspaceMemory);
  const requestWorkspaceAdvancedMemories = useAppStore((s) => s.requestWorkspaceAdvancedMemories);
  const upsertWorkspaceAdvancedMemory = useAppStore((s) => s.upsertWorkspaceAdvancedMemory);
  const deleteWorkspaceAdvancedMemory = useAppStore((s) => s.deleteWorkspaceAdvancedMemory);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);

  const { targets: memoryTargets, activeTarget } = useMemo(
    () => resolveMemoryTargets(workspaces, selectedWorkspaceId),
    [workspaces, selectedWorkspaceId],
  );
  const runtime = activeTarget ? workspaceRuntimeById[activeTarget.workspaceId] : null;
  const activeWorkspace = activeTarget
    ? (workspaces.find((workspace) => workspace.id === activeTarget.workspaceId) ?? null)
    : null;
  const advancedMemoryEnabled =
    runtime?.controlSessionConfig?.advancedMemory === true ||
    activeWorkspace?.defaultAdvancedMemory === true;
  const memories = runtime?.memories ?? [];
  const advancedMemories = runtime?.advancedMemories ?? [];
  const memoriesLoading = runtime?.memoriesLoading ?? false;
  const providerCatalog = runtime?.providerCatalog ?? [];
  const modelChoices = useMemo(() => modelChoicesFromCatalog(providerCatalog), [providerCatalog]);
  const modelDisplayNames = useMemo(
    () => modelDisplayNamesFromCatalog(providerCatalog),
    [providerCatalog],
  );
  const selectedGeneratorRef =
    (typeof runtime?.controlSessionConfig?.advancedMemoryModelRef === "string" &&
      runtime.controlSessionConfig.advancedMemoryModelRef) ||
    activeWorkspace?.defaultAdvancedMemoryModelRef ||
    DEFAULT_ADVANCED_MEMORY_MODEL_REF;

  const [draft, setDraft] = useState<DraftMemory>(emptyDraft);
  const [editingEntry, setEditingEntry] = useState<MemoryListEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [filterScope, setFilterScope] = useState<"all" | "workspace" | "user">("all");
  const [memoryLoadRequestedAt, setMemoryLoadRequestedAt] = useState<number | null>(null);
  const [memoryLoadStalled, setMemoryLoadStalled] = useState(false);

  const [parent] = useAutoAnimate();

  const requestMemories = useCallback(
    (target: MemoryTarget) => {
      setMemoryLoadRequestedAt(Date.now());
      setMemoryLoadStalled(false);
      if (advancedMemoryEnabled) {
        void requestWorkspaceAdvancedMemories(target.workspaceId, { cwd: target.targetPath });
        return;
      }
      void requestWorkspaceMemories(target.workspaceId, { cwd: target.targetPath });
    },
    [advancedMemoryEnabled, requestWorkspaceAdvancedMemories, requestWorkspaceMemories],
  );

  useEffect(() => {
    if (!activeTarget) return;
    setEditingEntry(null);
    setDraft(emptyDraft());
    setDialogOpen(false);
    requestMemories(activeTarget);
  }, [activeTarget, requestMemories]);

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

    const timer = window.setTimeout(
      () => {
        setMemoryLoadStalled(true);
      },
      Math.max(0, MEMORY_LOADING_STALL_MS - (Date.now() - requestedAt)),
    );
    return () => window.clearTimeout(timer);
  }, [memoriesLoading, memoryLoadRequestedAt]);

  const filtered =
    filterScope === "all" ? memories : memories.filter((m) => m.scope === filterScope);
  const showMemoryLoading = memoriesLoading && !memoryLoadStalled;

  const toggleExpand = (key: string) => {
    setExpandedIds((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const entryKey = (entry: MemoryListEntry) => `${entry.scope}:${entry.id}`;
  const advancedEntryKey = (entry: AdvancedMemoryListEntry) => entry.fileName;

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

  const openAdvancedEditDialog = (entry: AdvancedMemoryListEntry) => {
    setEditingEntry(null);
    setDraft({ scope: "workspace", id: entry.fileName, content: entry.content });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingEntry(null);
    setDraft(emptyDraft());
  };

  const handleSave = () => {
    if (!activeTarget || !draft.content.trim()) return;
    if (advancedMemoryEnabled) {
      const name = draft.id.trim() || "memory.md";
      void upsertWorkspaceAdvancedMemory(activeTarget.workspaceId, name, draft.content.trim(), {
        cwd: activeTarget.targetPath,
      });
      closeDialog();
      return;
    }
    const id = resolveDraftMemoryId(draft.id);
    void upsertWorkspaceMemory(activeTarget.workspaceId, draft.scope, id, draft.content.trim(), {
      cwd: activeTarget.targetPath,
    });
    closeDialog();
  };

  const handleDelete = async (entry: MemoryListEntry) => {
    if (!activeTarget) return;
    const confirmed = await confirmAction({
      title: "Delete memory",
      message: `Delete "${entry.id}"?`,
      detail: "This memory will be permanently removed.",
      kind: "warning",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    void deleteWorkspaceMemory(activeTarget.workspaceId, entry.scope, entry.id, {
      cwd: activeTarget.targetPath,
    });
  };

  const handleAdvancedDelete = async (entry: AdvancedMemoryListEntry) => {
    if (!activeTarget) return;
    const confirmed = await confirmAction({
      title: "Delete memory",
      message: `Delete "${entry.fileName}"?`,
      detail: "This advanced memory file will be permanently removed.",
      kind: "warning",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    void deleteWorkspaceAdvancedMemory(activeTarget.workspaceId, entry.fileName, {
      cwd: activeTarget.targetPath,
    });
  };

  const scopeLabel = (scope: "workspace" | "user") =>
    scope === "workspace"
      ? activeTarget?.kind === "chats"
        ? "Chats"
        : "This workspace"
      : "Everywhere";
  const memoryTitle = (entry: MemoryListEntry) =>
    entry.id === HOT_MEMORY_ID ? "Always include" : entry.id;
  const advancedMemoryTitle = (entry: AdvancedMemoryListEntry) => entry.fileName;
  const handleTargetChange = (targetId: string) => {
    const target = memoryTargets.find((entry) => entry.id === targetId);
    if (!target) return;
    void selectWorkspace(target.workspaceId);
  };

  const handleAdvancedMemoryToggle = (enabled: boolean) => {
    if (!activeTarget) return;
    void updateWorkspaceDefaults(activeTarget.workspaceId, { defaultAdvancedMemory: enabled });
  };

  const handleGeneratorModelChange = (value: string) => {
    const decoded = decodeProviderModelSelection(value);
    if (!activeTarget || !decoded) return;
    void updateWorkspaceDefaults(activeTarget.workspaceId, {
      defaultAdvancedMemoryModelRef: encodeProviderModelSelection(
        decoded.provider,
        decoded.modelId,
      ),
    });
  };

  const selectedGenerator = decodeProviderModelSelection(selectedGeneratorRef);

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-lg border border-border/70 bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="font-medium text-sm">Advanced Memory</h3>
              <p className="text-muted-foreground text-xs">
                Store agent-generated Markdown memories in the central user memory hub.
              </p>
            </div>
            <Switch
              checked={advancedMemoryEnabled}
              disabled={!activeTarget}
              onCheckedChange={handleAdvancedMemoryToggle}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-sm">Generator model</p>
              <p className="text-muted-foreground text-xs">
                Used by the headless memory agent after each response.
              </p>
            </div>
            <Select
              disabled={!activeTarget || !advancedMemoryEnabled}
              value={selectedGeneratorRef}
              onValueChange={handleGeneratorModelChange}
            >
              <SelectTrigger className="max-w-64" aria-label="Advanced memory generator model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(modelChoices).flatMap(([provider, models]) =>
                  models.map((modelId) => {
                    const typedProvider = provider as Parameters<
                      typeof encodeProviderModelSelection
                    >[0];
                    return (
                      <SelectItem
                        key={`${provider}:${modelId}`}
                        value={encodeProviderModelSelection(typedProvider, modelId)}
                      >
                        {provider} /{" "}
                        {resolveModelDisplayLabel(typedProvider, modelId, modelDisplayNames)}
                      </SelectItem>
                    );
                  }),
                )}
                {selectedGenerator ? null : (
                  <SelectItem value={DEFAULT_ADVANCED_MEMORY_MODEL_REF}>
                    google / gemini-3.1-flash-lite
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {workspacePickerEnabled && memoryTargets.length > 1 && activeTarget ? (
            <Select value={activeTarget.id} onValueChange={handleTargetChange}>
              <SelectTrigger className="max-w-48" aria-label="Memory target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {memoryTargets.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {!advancedMemoryEnabled ? (
            <div className="flex rounded-md border border-border/70 overflow-hidden">
              {(["all", "workspace", "user"] as const).map((scope) => (
                <Button
                  key={scope}
                  className={cn(
                    "h-auto rounded-none border-0 px-3 py-1.5 text-xs font-medium shadow-none transition-colors first:rounded-l-none last:rounded-r-none",
                    filterScope === scope
                      ? "bg-primary text-primary-foreground"
                      : "bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                  onClick={() => setFilterScope(scope)}
                  type="button"
                  variant="ghost"
                >
                  {scope === "all" ? "All" : scopeLabel(scope)}
                </Button>
              ))}
            </div>
          ) : null}

          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={showMemoryLoading}
            onClick={() => activeTarget && requestMemories(activeTarget)}
          >
            {showMemoryLoading ? "Loading..." : "Refresh"}
          </Button>
        </div>

        {activeTarget ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={openCreateDialog}
          >
            <PlusIcon className="w-4 h-4 mr-1.5" />
            {advancedMemoryEnabled ? "Add file" : "Add memory"}
          </Button>
        ) : null}
      </div>

      {advancedMemoryEnabled ? (
        advancedMemories.length === 0 ? (
          <div className="rounded-xl border border-border/70 bg-background/50 py-12 flex flex-col items-center justify-center gap-3">
            <BrainIcon className="w-10 h-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {showMemoryLoading ? "Loading..." : "No advanced memory files yet"}
            </p>
            {!showMemoryLoading && activeTarget ? (
              <Button variant="outline" size="sm" onClick={openCreateDialog}>
                Add your first memory file
              </Button>
            ) : null}
          </div>
        ) : (
          <div
            className="rounded-xl border border-border/70 overflow-hidden bg-background/50"
            ref={parent}
          >
            {advancedMemories.map((entry) => {
              const key = advancedEntryKey(entry);
              const isExpanded = expandedIds[key] ?? false;
              return (
                <div
                  key={key}
                  className={cn(
                    "border-b border-border/70 last:border-b-0",
                    isExpanded && "bg-card/40",
                  )}
                >
                  <button
                    type="button"
                    className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-card/60"
                    onClick={() => toggleExpand(key)}
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded ? (
                        <ChevronDownIcon className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
                      )}
                      <span className="font-medium text-foreground text-sm">
                        {advancedMemoryTitle(entry)}
                      </span>
                      <Badge variant="secondary" className="text-[10px] uppercase h-5">
                        Markdown
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground/60">
                      Updated {relativeTime(entry.updatedAt)}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="px-10 pb-4 text-xs space-y-3">
                      <pre className="whitespace-pre-wrap text-muted-foreground font-sans text-[13px] leading-relaxed">
                        {entry.content}
                      </pre>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            openAdvancedEditDialog(entry);
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
                            void handleAdvancedDelete(entry);
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
        )
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-background/50 py-12 flex flex-col items-center justify-center gap-3">
          <BrainIcon className="w-10 h-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {showMemoryLoading ? "Loading..." : "No remembered facts yet"}
          </p>
          {!showMemoryLoading && activeTarget ? (
            <Button variant="outline" size="sm" onClick={openCreateDialog}>
              Add your first memory
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          className="rounded-xl border border-border/70 overflow-hidden bg-background/50"
          ref={parent}
        >
          {filtered.map((entry) => {
            const key = entryKey(entry);
            const isExpanded = expandedIds[key] ?? false;

            return (
              <div
                key={key}
                className={cn(
                  "border-b border-border/70 last:border-b-0",
                  isExpanded && "bg-card/40",
                )}
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-card/60"
                  onClick={() => toggleExpand(key)}
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? (
                      <ChevronDownIcon className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
                    )}
                    <span className="font-medium text-foreground text-sm">
                      {memoryTitle(entry)}
                    </span>
                    <Badge
                      variant={entry.scope === "workspace" ? "default" : "secondary"}
                      className="text-[10px] uppercase h-5"
                    >
                      {scopeLabel(entry.scope)}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground/60">
                    Updated {relativeTime(entry.updatedAt)}
                  </span>
                </button>

                {isExpanded && (
                  <div className="px-10 pb-4 text-xs space-y-3">
                    <pre className="whitespace-pre-wrap text-muted-foreground font-sans text-[13px] leading-relaxed">
                      {entry.content}
                    </pre>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditDialog(entry);
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
            <DialogTitle>
              {advancedMemoryEnabled
                ? draft.id
                  ? "Edit memory file"
                  : "Add memory file"
                : editingEntry
                  ? `Edit remembered fact`
                  : "Add remembered fact"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label htmlFor="memory-title" className="text-xs font-medium text-foreground">
                {advancedMemoryEnabled ? "File name" : "Title"}
              </label>
              <Input
                id="memory-title"
                placeholder={
                  advancedMemoryEnabled
                    ? "project-preferences.md"
                    : "Optional. Leave blank to always include it."
                }
                value={draft.id}
                disabled={!advancedMemoryEnabled && !!editingEntry}
                onChange={(event) => setDraft((prev) => ({ ...prev, id: event.target.value }))}
              />
            </div>

            {!advancedMemoryEnabled ? (
              <div className="space-y-1.5">
                <label htmlFor="memory-scope" className="text-xs font-medium text-foreground">
                  Scope
                </label>
                <Select
                  value={draft.scope}
                  disabled={!!editingEntry}
                  onValueChange={(value) =>
                    setDraft((prev) => ({ ...prev, scope: value as "workspace" | "user" }))
                  }
                >
                  <SelectTrigger id="memory-scope" aria-label="Memory scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="workspace">{scopeLabel("workspace")}</SelectItem>
                    <SelectItem value="user">Everywhere</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="memory-content" className="text-xs font-medium text-foreground">
                Content
              </label>
              <Textarea
                id="memory-content"
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
                {advancedMemoryEnabled
                  ? draft.id
                    ? "Save file"
                    : "Add memory file"
                  : editingEntry
                    ? "Save changes"
                    : "Add remembered fact"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
