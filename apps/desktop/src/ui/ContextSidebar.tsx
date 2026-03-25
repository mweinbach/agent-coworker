import { memo } from "react";

import { AlertCircleIcon, BotIcon, CheckCircle2Icon, CircleDashedIcon, CircleIcon, MinusCircleIcon } from "lucide-react";

import { useAppStore } from "../app/store";
import type { ThreadAgentSummary } from "../app/types";
import { MessageResponse } from "../components/ai-elements/message";
import { ScrollShadow } from "../components/ui/scroll-shadow";
import { cn } from "../lib/utils";
import { buildMarkdownPreviewText } from "./chat/markdownPreview";
import { WorkspaceFileExplorer } from "./file-explorer/WorkspaceFileExplorer";

function agentStatusIcon(agent: ThreadAgentSummary) {
  if (agent.lifecycleState === "closed") {
    return <MinusCircleIcon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />;
  }
  if (agent.executionState === "errored") {
    return <AlertCircleIcon className="mt-0.5 h-3.5 w-3.5 text-warning" />;
  }
  if (agent.busy || agent.executionState === "running" || agent.executionState === "pending_init") {
    return <CircleDashedIcon className="mt-0.5 h-3.5 w-3.5 text-primary" />;
  }
  if (agent.executionState === "completed") {
    return <CheckCircle2Icon className="mt-0.5 h-3.5 w-3.5 text-success" />;
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
  const panelShellClassName = "app-context-sidebar__panel rounded-[14px] border";
  const sectionLabelClassName = "text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/78 uppercase";
  const compactSectionClassName = cn("flex-none", panelShellClassName);
  const compactSectionHeaderClassName = "px-3 pb-1 pt-2.5";
  const compactSectionBodyClassName = "px-3 pb-2.5 pt-0.5";
  const compactSectionScrollerClassName = "max-h-[10.5rem] overflow-y-auto overscroll-contain px-3 pb-2.5 pt-0.5";
  const compactMutedCopyClassName = "text-[11px] leading-5 text-muted-foreground/82";

  return (
    <aside className="app-context-sidebar flex h-full w-full flex-col gap-1 overflow-hidden p-1.5">
      <section className={compactSectionClassName} data-sidebar-panel="tasks">
        <div className={compactSectionHeaderClassName}>
          <span className={sectionLabelClassName}>Tasks</span>
        </div>
        {!todos || todos.length === 0 ? (
          <div className={cn(compactSectionBodyClassName, compactMutedCopyClassName)}>No active tasks</div>
        ) : (
          <ScrollShadow className={compactSectionScrollerClassName} data-sidebar-section="tasks">
            <div className="space-y-1.5">
              {todos.map((todo, index) => (
                <div key={`${todo.content}:${index}`} className="flex items-start gap-2 text-[11px]">
                  {todo.status === "completed" ? (
                    <CheckCircle2Icon className="mt-0.5 h-3.25 w-3.25 text-success" />
                  ) : todo.status === "in_progress" ? (
                    <CircleDashedIcon className="mt-0.5 h-3.25 w-3.25 text-primary" />
                  ) : (
                    <CircleIcon className="mt-0.5 h-3.25 w-3.25 text-muted-foreground" />
                  )}
                  <span className={cn("leading-5 text-foreground", todo.status === "completed" && "line-through text-muted-foreground")}>{todo.content}</span>
                </div>
              ))}
            </div>
          </ScrollShadow>
        )}
      </section>

      <section className={compactSectionClassName} data-sidebar-panel="subagents">
        <div className={compactSectionHeaderClassName}>
          <span className={sectionLabelClassName}>Subagents</span>
        </div>
        {!selectedThreadId ? (
          <div className={cn(compactSectionBodyClassName, compactMutedCopyClassName)}>Select a thread to inspect subagents</div>
        ) : threadRuntime?.sessionKind === "agent" ? (
          <div className={compactSectionBodyClassName}>
            <div className="app-context-sidebar__nested-panel rounded-[10px] border px-2.5 py-2 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <BotIcon className="h-3.5 w-3.5" />
                <span className="font-medium">This thread is a subagent</span>
              </div>
              <div className="mt-1">{threadRuntime.role ?? "default"} · depth {threadRuntime.depth}</div>
              {threadRuntime.effectiveModel ? <div className="mt-1 truncate">{threadRuntime.effectiveModel}</div> : null}
            </div>
          </div>
        ) : agents.length === 0 ? (
          <div className={cn(compactSectionBodyClassName, compactMutedCopyClassName)}>No subagents</div>
        ) : (
          <ScrollShadow className={compactSectionScrollerClassName} data-sidebar-section="subagents">
            <div className="space-y-1.5">
              {agents.map((agent) => (
                <div key={agent.agentId} className="app-context-sidebar__nested-panel rounded-[10px] border px-2.5 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[11px] font-medium text-foreground">
                        {agent.nickname || agent.title}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {agent.role} · depth {agent.depth} · {agent.effectiveModel}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      {agentStatusIcon(agent)}
                      <span>{agentStatusLabel(agent)}</span>
                    </div>
                  </div>
                  {agent.lastMessagePreview ? (
                    <MessageResponse className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground [&_p]:my-0 [&_p]:leading-4 [&_ul]:my-0 [&_ol]:my-0 [&_li]:leading-4 [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:p-0 [&_code]:bg-transparent [&_code]:px-0 [&_code]:py-0 [&_a]:text-inherit">
                      {buildMarkdownPreviewText(agent.lastMessagePreview, 2)}
                    </MessageResponse>
                  ) : null}
                </div>
              ))}
            </div>
          </ScrollShadow>
        )}
      </section>

      <section className={cn("min-h-0 flex-1 overflow-hidden", panelShellClassName)} data-sidebar-panel="files">
        {selectedWorkspaceId ? (
          <WorkspaceFileExplorer workspaceId={selectedWorkspaceId} className="h-full" />
        ) : (
          <>
            <div className={compactSectionHeaderClassName}>
              <span className={sectionLabelClassName}>Files</span>
            </div>
            <div className={cn(compactSectionBodyClassName, compactMutedCopyClassName)}>No workspace selected</div>
          </>
        )}
      </section>
    </aside>
  );
});
