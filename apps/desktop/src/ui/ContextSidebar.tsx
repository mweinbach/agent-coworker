import { useEffect } from "react";

import { CheckCircle2Icon, CircleDashedIcon, CircleIcon, FileIcon, FolderIcon } from "lucide-react";

import { useAppStore } from "../app/store";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { cn } from "../lib/utils";

export function ContextSidebar() {
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const todos = useAppStore((s) => selectedThreadId ? s.latestTodosByThreadId[selectedThreadId] : null);
  const files = useAppStore((s) => selectedWorkspaceId ? s.workspaceFilesById[selectedWorkspaceId] : null);
  const refresh = useAppStore((s) => s.refreshWorkspaceFiles);

  useEffect(() => {
    if (selectedWorkspaceId) {
      void refresh(selectedWorkspaceId).catch(() => {});
    }
  }, [refresh, selectedWorkspaceId]);

  return (
    <aside className="app-context-sidebar flex h-full w-[300px] shrink-0 flex-col gap-3 border-l border-border/80 bg-background p-3">
      <Card className="border-border/80 bg-card/80">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Tasks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {!todos || todos.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted-foreground">No active tasks</div>
          ) : (
            todos.map((todo, index) => (
              <div key={`${todo.content}:${index}`} className="flex items-start gap-2 text-xs">
                {todo.status === "completed" ? (
                  <CheckCircle2Icon className="mt-0.5 h-3.5 w-3.5 text-emerald-500" />
                ) : todo.status === "in_progress" ? (
                  <CircleDashedIcon className="mt-0.5 h-3.5 w-3.5 text-primary" />
                ) : (
                  <CircleIcon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span className={cn("leading-5 text-foreground", todo.status === "completed" && "line-through text-muted-foreground")}>{todo.content}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="min-h-0 flex-1 border-border/80 bg-card/80">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Files</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 overflow-auto pt-0">
          {!files || files.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted-foreground">No files found</div>
          ) : (
            <div className="space-y-1">
              {files.map((file, index) => (
                <div key={`${file.name}:${index}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/35 hover:text-foreground" title={file.name}>
                  {file.isDirectory ? <FolderIcon className="h-3.5 w-3.5 shrink-0" /> : <FileIcon className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate">{file.name}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </aside>
  );
}
