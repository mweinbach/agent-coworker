import { memo } from "react";

import { CheckCircle2Icon, CircleDashedIcon, CircleIcon } from "lucide-react";

import { useAppStore } from "../app/store";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { cn } from "../lib/utils";
import { WorkspaceFileExplorer } from "./file-explorer/WorkspaceFileExplorer";

export const ContextSidebar = memo(function ContextSidebar() {
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const todos = useAppStore((s) => selectedThreadId ? s.latestTodosByThreadId[selectedThreadId] : null);

  return (
    <aside className="app-context-sidebar flex h-full w-full flex-col gap-3 p-3 overflow-hidden">
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

      <Card className="min-h-0 flex-1 border-border/80 bg-card/80 flex flex-col">
        <CardHeader className="pb-2 flex-none">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Files</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 p-0">
          {selectedWorkspaceId ? (
            <WorkspaceFileExplorer workspaceId={selectedWorkspaceId} />
          ) : (
            <div className="py-3 text-center text-xs text-muted-foreground">No workspace selected</div>
          )}
        </CardContent>
      </Card>
    </aside>
  );
});
