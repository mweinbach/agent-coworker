import { memo } from "react";

import { AlertCircleIcon, BotIcon, CheckCircle2Icon, CircleDashedIcon, CircleIcon, MinusCircleIcon } from "lucide-react";

import { useAppStore } from "../app/store";
import type { ThreadAgentSummary } from "../app/types";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { ScrollShadow } from "../components/ui/scroll-shadow";
import { cn } from "../lib/utils";
import { WorkspaceFileExplorer } from "./file-explorer/WorkspaceFileExplorer";

function agentStatusIcon(agent: ThreadAgentSummary) {
  if (agent.lifecycleState === "closed") {
    return <MinusCircleIcon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />;
  }
  if (agent.executionState === "errored") {
    return <AlertCircleIcon className="mt-0.5 h-3.5 w-3.5 text-amber-500" />;
  }
  if (agent.busy || agent.executionState === "running" || agent.executionState === "pending_init") {
    return <CircleDashedIcon className="mt-0.5 h-3.5 w-3.5 text-primary" />;
  }
  if (agent.executionState === "completed") {
    return <CheckCircle2Icon className="mt-0.5 h-3.5 w-3.5 text-emerald-500" />;
  }
  return <CircleIcon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />;
}

function agentStatusLabel(agent: ThreadAgentSummary): string {
  if (agent.lifecycleState === "closed") return "closed";
  if (agent.busy) return "busy";
  return agent.executionState.replace(/_/g, " ");
}

export const ContextSidebar = memo(function ContextSidebar() {
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const threadRuntime = useAppStore((s) => selectedThreadId ? s.threadRuntimeById[selectedThreadId] : null);
  const todos = useAppStore((s) => selectedThreadId ? s.latestTodosByThreadId[selectedThreadId] : null);
  const agents = threadRuntime?.agents ?? [];
  const scrollSectionCardClassName = "flex min-h-0 max-h-[30%] flex-col overflow-hidden rounded-lg border-border/70 bg-background/32 shadow-none";
  const scrollSectionContentClassName = "min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-1.5 px-2.5 pt-2 pb-2.5";

  return (
    <aside className="app-context-sidebar flex h-full w-full flex-col gap-2 p-2.5 overflow-hidden">
      <Card className={scrollSectionCardClassName}>
        <CardHeader className="flex-none px-2.5 pt-2.5 pb-0">
          <CardTitle className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/80 uppercase">Tasks</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollShadow className={scrollSectionContentClassName} data-sidebar-section="tasks">
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
          </ScrollShadow>
        </CardContent>
      </Card>

      <Card className={scrollSectionCardClassName}>
        <CardHeader className="flex-none px-2.5 pt-2.5 pb-0">
          <CardTitle className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/80 uppercase">Agents</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollShadow className={scrollSectionContentClassName} data-sidebar-section="agents">
          {!selectedThreadId ? (
            <div className="py-3 text-center text-xs text-muted-foreground">Select a thread to inspect agents</div>
          ) : threadRuntime?.sessionKind === "agent" ? (
            <div className="rounded-lg border border-border/60 bg-background/38 p-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <BotIcon className="h-3.5 w-3.5" />
                <span className="font-medium">This thread is a child agent</span>
              </div>
              <div className="mt-1">{threadRuntime.role ?? "default"} · depth {threadRuntime.depth}</div>
              {threadRuntime.effectiveModel ? <div className="mt-1 truncate">{threadRuntime.effectiveModel}</div> : null}
            </div>
          ) : agents.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted-foreground">No child agents</div>
          ) : (
            agents.map((agent) => (
              <div key={agent.agentId} className="rounded-lg border border-border/60 bg-background/38 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-foreground">
                      {agent.nickname || agent.title}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {agent.role} · depth {agent.depth} · {agent.effectiveModel}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    {agentStatusIcon(agent)}
                    <span>{agentStatusLabel(agent)}</span>
                  </div>
                </div>
                {agent.lastMessagePreview ? (
                  <div className="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {agent.lastMessagePreview}
                  </div>
                ) : null}
              </div>
            ))
          )}
          </ScrollShadow>
        </CardContent>
      </Card>

      <Card className="min-h-0 flex-1 rounded-lg border-border/70 bg-background/32 flex flex-col shadow-none">
        <CardContent className="min-h-0 flex-1 p-0">
          {selectedWorkspaceId ? (
            <WorkspaceFileExplorer workspaceId={selectedWorkspaceId} />
          ) : (
            <>
              <div className="px-2.5 pt-2.5 pb-0">
                <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/80 uppercase">Files</span>
              </div>
              <div className="py-3 text-center text-xs text-muted-foreground">No workspace selected</div>
            </>
          )}
        </CardContent>
      </Card>
    </aside>
  );
});
