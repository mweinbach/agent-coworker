import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleIcon,
  FolderOpenIcon,
  MinusCircleIcon,
  SparklesIcon,
} from "lucide-react";
import { memo } from "react";
import { useShallow } from "zustand/react/shallow";

import { formatCost, formatTokenCount } from "../../../../src/session/pricing";
import { useAppStore } from "../app/store";
import type { FeedItem, ThreadAgentSummary, ThreadRuntime } from "../app/types";
import { cn } from "../lib/utils";
import { InlineErrorBoundary } from "./CrashReportingErrorBoundary";
import { buildMarkdownPreviewText } from "./chat/markdownPreview";
import { WorkspaceFileExplorer } from "./file-explorer/WorkspaceFileExplorer";
import { DesktopMarkdown } from "./markdown";
import { WorkflowRunsPanel } from "./WorkflowRunsPanel";

const EMPTY_AGENTS: ThreadRuntime["agents"] = [];
const EMPTY_WORKFLOW_RUNS: ThreadRuntime["workflowRuns"] = [];
const planStalenessByFeed = new WeakMap<FeedItem[], boolean>();

/** True when a newer user turn exists after the last todo snapshot. */
function isPlanSnapshotStale(feed: FeedItem[] | undefined): boolean {
  if (!feed || feed.length === 0) return false;
  const cached = planStalenessByFeed.get(feed);
  if (cached !== undefined) return cached;
  const stale = computePlanSnapshotStaleness(feed);
  planStalenessByFeed.set(feed, stale);
  return stale;
}

function computePlanSnapshotStaleness(feed: FeedItem[]): boolean {
  let lastTodosTsMs: number | null = null;
  let lastUserTsMs: number | null = null;
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const item = feed[index];
    if (!item) continue;
    if (lastTodosTsMs === null && item.kind === "todos") {
      const ms = Date.parse(item.ts);
      if (Number.isFinite(ms)) lastTodosTsMs = ms;
    }
    if (lastUserTsMs === null && item.kind === "message" && item.role === "user") {
      const ms = Date.parse(item.ts);
      if (Number.isFinite(ms)) lastUserTsMs = ms;
    }
    if (lastTodosTsMs !== null && lastUserTsMs !== null) return lastUserTsMs > lastTodosTsMs;
  }
  return false;
}

const taskStatusIconClassName = "mt-0.5 size-3.5 shrink-0";

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

function agentUsageLabel(agent: ThreadAgentSummary): string | null {
  const usage = agent.sessionUsage;
  if (!usage) return null;
  const tokenLabel = `${formatTokenCount(usage.totalTokens)} tokens`;
  const costLabel =
    usage.costTrackingAvailable && typeof usage.estimatedTotalCostUsd === "number"
      ? formatCost(usage.estimatedTotalCostUsd)
      : "cost unavailable";
  return `${tokenLabel} · ${costLabel}`;
}

export const ContextSidebar = memo(function ContextSidebar({
  active = true,
}: {
  active?: boolean;
}) {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const openAgentThread = useAppStore((s) => s.openAgentThread);
  const { todos, agents, workflowRuns, sessionKind, role, depth, effectiveModel, planIsStale } =
    useAppStore(
      useShallow((state) => {
        const threadId = state.selectedThreadId;
        const runtime = threadId ? state.threadRuntimeById[threadId] : undefined;
        const todos = threadId ? state.latestTodosByThreadId[threadId] : undefined;
        return {
          todos,
          agents: runtime?.agents ?? EMPTY_AGENTS,
          workflowRuns: runtime?.workflowRuns ?? EMPTY_WORKFLOW_RUNS,
          sessionKind: runtime?.sessionKind,
          role: runtime?.role,
          depth: runtime?.depth,
          effectiveModel: runtime?.effectiveModel,
          planIsStale: Boolean(todos?.length) && isPlanSnapshotStale(runtime?.feed),
        };
      }),
    );
  const panelShellClassName = "app-context-sidebar__panel rounded-2xl border";
  const sectionLabelClassName = "app-type-label tracking-[0.16em] app-text-muted uppercase";
  const compactSectionClassName = cn("flex-none", panelShellClassName);
  const compactSectionHeaderClassName = "px-3 pb-1 pt-2.5";
  const compactSectionBodyClassName = "px-3 pb-2.5 pt-0.5";
  const compactSectionScrollerClassName =
    "max-h-[10.5rem] overflow-y-auto overscroll-contain px-3 pb-2.5 pt-0.5";
  const compactMutedCopyClassName = "app-type-caption leading-5 app-text-muted";

  const hasActivity =
    (todos?.length ?? 0) > 0 ||
    agents.length > 0 ||
    workflowRuns.length > 0 ||
    sessionKind === "agent" ||
    Boolean(selectedWorkspaceId);

  const showTodos = (todos?.length ?? 0) > 0;
  const showAgents = agents.length > 0;

  if (!hasActivity) {
    return (
      <aside className="app-context-sidebar flex h-full w-full flex-col gap-1 overflow-hidden p-1.5">
        <section className={compactSectionClassName} data-sidebar-panel="idle">
          <div
            className={cn(
              compactSectionBodyClassName,
              compactMutedCopyClassName,
              "flex flex-col items-center gap-2 pt-4 text-center opacity-75",
            )}
          >
            <SparklesIcon className="size-5 app-text-muted" />
            <span>Tasks, subagents, and files show here once the thread has activity.</span>
          </div>
        </section>
      </aside>
    );
  }

  return (
    <aside className="app-context-sidebar flex h-full w-full flex-col gap-1 overflow-hidden p-1.5">
      {showTodos ? (
        <section className={compactSectionClassName} data-sidebar-panel="tasks">
          <div className={compactSectionHeaderClassName}>
            <span className={sectionLabelClassName}>{planIsStale ? "Previous plan" : "Plan"}</span>
          </div>
          <div className={compactSectionScrollerClassName} data-sidebar-section="tasks">
            <div className={cn("flex flex-col gap-1.5", planIsStale && "opacity-75")}>
              {todos?.map((todo) => (
                <div
                  key={`${todo.status}:${todo.content}`}
                  className="flex items-start gap-2 text-xs"
                >
                  {todo.status === "completed" ? (
                    <CheckCircle2Icon className={cn(taskStatusIconClassName, "text-success")} />
                  ) : todo.status === "in_progress" ? (
                    <CircleDashedIcon
                      className={cn(
                        taskStatusIconClassName,
                        planIsStale ? "text-muted-foreground" : "text-primary",
                      )}
                    />
                  ) : (
                    <CircleIcon className={cn(taskStatusIconClassName, "text-muted-foreground")} />
                  )}
                  <span
                    className={cn(
                      "leading-5 text-foreground",
                      (todo.status === "completed" || planIsStale) && "text-muted-foreground",
                      todo.status === "completed" && "line-through",
                    )}
                  >
                    {todo.content}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <WorkflowRunsPanel
        runs={workflowRuns}
        sectionClassName={compactSectionClassName}
        headerClassName={compactSectionHeaderClassName}
        labelClassName={sectionLabelClassName}
        scrollerClassName={compactSectionScrollerClassName}
      />

      {showAgents || sessionKind === "agent" ? (
        <section className={compactSectionClassName} data-sidebar-panel="subagents">
          <div className={compactSectionHeaderClassName}>
            <span className={sectionLabelClassName}>Subagents</span>
          </div>
          {sessionKind === "agent" ? (
            <div className={compactSectionBodyClassName}>
              <div className="app-context-sidebar__nested-panel rounded-lg border px-2.5 py-2 app-type-caption app-text-muted">
                <div className="flex items-center gap-2 text-foreground">
                  <BotIcon className="h-3.5 w-3.5" />
                  <span className="font-medium">This thread is a subagent</span>
                </div>
                <div className="mt-1">
                  {role ?? "default"} · depth {depth}
                </div>
                {effectiveModel ? <div className="mt-1 truncate">{effectiveModel}</div> : null}
              </div>
            </div>
          ) : (
            <div className={compactSectionScrollerClassName} data-sidebar-section="subagents">
              <div className="flex flex-col gap-1.5">
                {agents.map((agent) => {
                  const usageLabel = agentUsageLabel(agent);
                  return (
                    <button
                      type="button"
                      key={agent.agentId}
                      onClick={() =>
                        void openAgentThread(agent.agentId, agent.nickname || agent.title)
                      }
                      className="app-context-sidebar__nested-panel w-full rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-foreground">
                            {agent.nickname || agent.title}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {agent.role} · depth {agent.depth} · {agent.effectiveModel}
                          </div>
                          {usageLabel ? (
                            <div className="mt-0.5 truncate text-xs tabular-nums app-text-muted">
                              {usageLabel}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          {agentStatusIcon(agent)}
                          <span>{agentStatusLabel(agent)}</span>
                        </div>
                      </div>
                      {agent.lastMessagePreview ? (
                        <DesktopMarkdown className="mt-1.5 line-clamp-2 text-xs leading-4 text-muted-foreground [&_p]:my-0 [&_p]:leading-4 [&_ul]:my-0 [&_ol]:my-0 [&_li]:leading-4 [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:p-0 [&_code]:bg-transparent [&_code]:px-0 [&_code]:py-0 [&_a]:text-inherit">
                          {buildMarkdownPreviewText(agent.lastMessagePreview, 2)}
                        </DesktopMarkdown>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      ) : null}

      <section
        className={cn("min-h-0 flex-1 overflow-hidden", panelShellClassName)}
        data-sidebar-panel="files"
      >
        {selectedWorkspaceId ? (
          <InlineErrorBoundary label="This workspace's files couldn't be loaded.">
            <WorkspaceFileExplorer
              active={active}
              workspaceId={selectedWorkspaceId}
              className="h-full"
            />
          </InlineErrorBoundary>
        ) : (
          <>
            <div className={compactSectionHeaderClassName}>
              <span className={sectionLabelClassName}>Workspace files</span>
            </div>
            <div
              className={cn(
                compactSectionBodyClassName,
                compactMutedCopyClassName,
                "flex flex-col items-center gap-1.5 py-3 text-center",
              )}
            >
              <FolderOpenIcon className="size-4 app-text-muted" />
              <span>No workspace selected</span>
            </div>
          </>
        )}
      </section>
    </aside>
  );
});
