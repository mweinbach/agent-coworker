import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import type { MemoryListEntry } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";

type DraftMemory = {
  scope: "workspace" | "user";
  id: string;
  content: string;
};

function emptyDraft(): DraftMemory {
  return { scope: "workspace", id: "", content: "" };
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filterScope, setFilterScope] = useState<"all" | "workspace" | "user">("all");

  useEffect(() => {
    if (!workspace) return;
    setEditingId(null);
    setDraft(emptyDraft());
    void requestWorkspaceMemories(workspace.id);
  }, [workspace?.id]);

  const filtered = filterScope === "all" ? memories : memories.filter((m) => m.scope === filterScope);

  const startEdit = (entry: MemoryListEntry) => {
    setEditingId(entry.id);
    setDraft({ scope: entry.scope, id: entry.id, content: entry.content });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const handleSave = () => {
    if (!workspace || !draft.content.trim()) return;
    const id = draft.id.trim() || undefined;
    void upsertWorkspaceMemory(workspace.id, draft.scope, id, draft.content.trim());
    cancelEdit();
  };

  const handleDelete = (entry: MemoryListEntry) => {
    if (!workspace) return;
    void deleteWorkspaceMemory(workspace.id, entry.scope, entry.id);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Memory</h1>
        <p className="text-sm text-muted-foreground">
          Manage persistent agent memories for this workspace. Memories are injected into the system prompt.
        </p>
      </div>

      {workspace ? (
        <Card className="border-border/80 bg-card/85">
          <CardHeader>
            <CardTitle>{editingId ? `Edit: ${editingId}` : "Add memory"}</CardTitle>
            <CardDescription>
              {editingId
                ? "Update an existing memory entry. Delete and recreate it to move it to another scope."
                : "Create a new memory entry in the workspace or user scope."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Input
                placeholder="Memory ID (optional, auto-generated if blank)"
                value={draft.id}
                disabled={!!editingId}
                onChange={(event) => setDraft((prev) => ({ ...prev, id: event.target.value }))}
              />
              <Select
                value={draft.scope}
                disabled={!!editingId}
                onValueChange={(value) => setDraft((prev) => ({ ...prev, scope: value as "workspace" | "user" }))}
              >
                <SelectTrigger aria-label="Memory scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="workspace">workspace</SelectItem>
                  <SelectItem value="user">user</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Textarea
              placeholder="Memory content"
              className="min-h-[80px]"
              value={draft.content}
              onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
            />

            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={handleSave} disabled={!draft.content.trim()}>
                {editingId ? "Save changes" : "Add memory"}
              </Button>
              {editingId ? (
                <Button type="button" variant="outline" onClick={cancelEdit}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Saved memories</CardTitle>
          <CardDescription>All workspace and user memory entries for this workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
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

            <Select value={filterScope} onValueChange={(value) => setFilterScope(value as typeof filterScope)}>
              <SelectTrigger className="max-w-32" aria-label="Filter by scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="workspace">workspace</SelectItem>
                <SelectItem value="user">user</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              type="button"
              disabled={memoriesLoading}
              onClick={() => workspace && void requestWorkspaceMemories(workspace.id)}
            >
              {memoriesLoading ? "Loading..." : "Refresh"}
            </Button>
          </div>

          {filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              {memoriesLoading ? "Loading memories..." : "No memories found."}
            </div>
          ) : null}

          {filtered.map((entry) => (
            <div key={`${entry.scope}:${entry.id}`} className="rounded-md border border-border/70 bg-muted/20 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{entry.id}</span>
                <Badge variant={entry.scope === "workspace" ? "default" : "secondary"}>{entry.scope}</Badge>
              </div>
              <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{entry.content}</div>
              <div className="mt-1 text-muted-foreground/60">
                Updated: {new Date(entry.updatedAt).toLocaleString()}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => startEdit(entry)}>
                  Edit
                </Button>
                <Button type="button" variant="destructive" onClick={() => handleDelete(entry)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
