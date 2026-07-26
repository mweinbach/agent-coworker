import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  DatabaseZapIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
  WorkflowIcon,
} from "lucide-react";
import { memo } from "react";

import { formatCost } from "../../../../src/session/pricing";
import type { ThreadWorkflowRun } from "../app/types";
import { ScrollShadow } from "../components/ui/scroll-shadow";
import { cn } from "../lib/utils";

type WorkflowAgentRow = ThreadWorkflowRun["agents"][number];

function agentStateIcon(state: WorkflowAgentRow["state"]) {
  switch (state) {
    case "running":
      return <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-foreground" />;
    case "completed":
      return <CheckCircle2Icon className="size-3 shrink-0 text-success" />;
    case "errored":
      return <AlertCircleIcon className="size-3 shrink-0 text-warning" />;
    case "cached":
      return <DatabaseZapIcon className="size-3 shrink-0 text-muted-foreground" />;
    default:
      return <CircleDashedIcon className="size-3 shrink-0 text-muted-foreground" />;
  }
}

function runOutcomeIcon(run: ThreadWorkflowRun) {
  switch (run.outcome) {
    case "completed":
      return <CheckCircle2Icon className="size-3.5 shrink-0 text-success" />;
    case "errored":
      return <AlertCircleIcon className="size-3.5 shrink-0 text-warning" />;
    case "cancelled":
      return <MinusCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    default:
      return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-foreground" />;
  }
}

function runStatusLabel(run: ThreadWorkflowRun): string {
  const done = run.agents.filter(
    (agent) => agent.state === "completed" || agent.state === "cached",
  ).length;
  if (run.outcome === "cancelled") return "cancelled";
  if (run.outcome === "errored") return "failed";
  if (run.outcome === "completed") return `${done} agents`;
  const running = run.agents.filter((agent) => agent.state === "running").length;
  return running > 0 ? `${done}/${run.agents.length} · ${running} running` : `${done} agents`;
}

/** Groups the run's agents under their declared phases, in `meta.phases` order. */
function groupByPhase(run: ThreadWorkflowRun): Array<[string, WorkflowAgentRow[]]> {
  const groups = new Map<string, WorkflowAgentRow[]>();
  // Seed in declaration order so phases render in the order the script declares
  // them, not the order their first agent happened to start.
  for (const phase of run.phases) groups.set(phase, []);
  for (const agent of run.agents) {
    const key = agent.phase ?? "—";
    const bucket = groups.get(key);
    if (bucket) bucket.push(agent);
    else groups.set(key, [agent]);
  }
  return [...groups.entries()].filter(([, agents]) => agents.length > 0);
}

const WorkflowRunCard = memo(function WorkflowRunCard({ run }: { run: ThreadWorkflowRun }) {
  const phases = groupByPhase(run);
  const settled = run.outcome !== undefined;
  // Carry each line's absolute position before slicing: `logs` is append-only, so
  // that position is a stable key, whereas the index within the last-3 window
  // shifts every time a new line arrives.
  const recentLogs = run.logs.map((line, position) => ({ line, position })).slice(-3);

  return (
    <div className="app-context-sidebar__nested-panel rounded-[10px] border px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-foreground">{run.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {runOutcomeIcon(run)}
          <span className="tabular-nums">{runStatusLabel(run)}</span>
        </div>
      </div>

      {run.spentUsd > 0 ? (
        <div className="mt-0.5 text-xs tabular-nums app-text-muted">{formatCost(run.spentUsd)}</div>
      ) : null}

      {phases.length > 0 ? (
        <div className="mt-1.5 space-y-1.5">
          {phases.map(([phase, agents]) => (
            <div key={phase}>
              <div
                className={cn(
                  "app-type-label truncate text-[10px] uppercase tracking-[0.14em]",
                  phase === run.currentPhase && !settled ? "text-foreground" : "app-text-muted",
                )}
              >
                {phase}
              </div>
              <div className="mt-0.5 space-y-0.5">
                {agents.map((agent) => (
                  <div
                    key={agent.index}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    title={agent.agentId ?? undefined}
                  >
                    {agentStateIcon(agent.state)}
                    <span className="truncate">{agent.label}</span>
                    {agent.state === "cached" ? (
                      <span className="shrink-0 text-[10px] app-text-muted">cached</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {recentLogs.length > 0 ? (
        <div className="mt-1.5 space-y-0.5 border-t pt-1.5">
          {recentLogs.map(({ line, position }) => (
            <div
              key={`${run.runId}-log-${position}`}
              className="truncate text-[11px] leading-4 app-text-muted"
              title={line}
            >
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

export const WorkflowRunsPanel = memo(function WorkflowRunsPanel({
  runs,
  sectionClassName,
  headerClassName,
  labelClassName,
  scrollerClassName,
}: {
  runs: ThreadWorkflowRun[];
  sectionClassName: string;
  headerClassName: string;
  labelClassName: string;
  scrollerClassName: string;
}) {
  if (runs.length === 0) return null;

  return (
    <section className={sectionClassName} data-sidebar-panel="workflows">
      <div className={headerClassName}>
        <span className={labelClassName}>Workflows</span>
      </div>
      <ScrollShadow className={scrollerClassName} data-sidebar-section="workflows">
        <div className="space-y-1.5">
          {runs.map((run) => (
            <WorkflowRunCard key={run.runId} run={run} />
          ))}
        </div>
      </ScrollShadow>
    </section>
  );
});
