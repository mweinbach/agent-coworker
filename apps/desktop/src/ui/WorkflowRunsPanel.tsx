import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  DatabaseZapIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
  WorkflowIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { formatCost } from "../../../../src/session/pricing";
import { useAppStore } from "../app/store";
import type { ThreadWorkflowRun } from "../app/types";
import { ScrollShadow } from "../components/ui/scroll-shadow";
import { cn } from "../lib/utils";
import { WorkflowRunDetailDialog } from "./WorkflowRunDetailDialog";

type WorkflowAgentRow = ThreadWorkflowRun["agents"][number];

function isTerminalAgentState(state: WorkflowAgentRow["state"]): boolean {
  return state === "completed" || state === "errored" || state === "cached";
}

function agentStateLabel(state: WorkflowAgentRow["state"], runCancelled: boolean): string {
  return runCancelled && !isTerminalAgentState(state) ? "cancelled" : state;
}

function agentStateIcon(state: WorkflowAgentRow["state"], runCancelled: boolean) {
  if (runCancelled && !isTerminalAgentState(state)) {
    return <MinusCircleIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />;
  }
  switch (state) {
    case "running":
      return (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3 shrink-0 animate-spin text-foreground"
        />
      );
    case "completed":
      return <CheckCircle2Icon aria-hidden="true" className="size-3 shrink-0 text-success" />;
    case "errored":
      return <AlertCircleIcon aria-hidden="true" className="size-3 shrink-0 text-warning" />;
    case "cached":
      return (
        <DatabaseZapIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      );
    default:
      return (
        <CircleDashedIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      );
  }
}

function runHasFailedAgents(run: ThreadWorkflowRun): boolean {
  return run.agents.some((agent) => agent.state === "errored");
}

function isLegacyDryRun(run: ThreadWorkflowRun): boolean {
  return (
    run.outcome === "completed" &&
    run.agents.length > 0 &&
    run.agents.every(
      (agent) => agent.state === "completed" && agent.agentId === null && agent.usdCost === 0,
    )
  );
}

function runOutcomeIcon(run: ThreadWorkflowRun) {
  switch (run.outcome) {
    case "completed":
      return runHasFailedAgents(run) ? (
        <AlertCircleIcon className="size-3.5 shrink-0 text-warning" />
      ) : (
        <CheckCircle2Icon className="size-3.5 shrink-0 text-success" />
      );
    case "errored":
      return <AlertCircleIcon className="size-3.5 shrink-0 text-warning" />;
    case "cancelled":
      return <MinusCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    default:
      return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-foreground" />;
  }
}

function runStatusLabel(run: ThreadWorkflowRun): string {
  const succeeded = run.agents.filter(
    (agent) => agent.state === "completed" || agent.state === "cached",
  ).length;
  const failed = run.agents.filter((agent) => agent.state === "errored").length;
  if (run.outcome === "cancelled") return "cancelled";
  if (run.outcome === "errored") return "failed";
  if (run.outcome === "completed") {
    if (failed > 0) return `completed with ${failed} failed`;
    return `${succeeded} agents`;
  }
  const running = run.agents.filter((agent) => agent.state === "running").length;
  return running > 0
    ? `${succeeded}/${run.agents.length} · ${running} running`
    : `${succeeded} agents`;
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
  return [...groups.entries()].filter(
    ([phase, agents]) => agents.length > 0 || phase === run.currentPhase,
  );
}

const WorkflowRunCard = memo(function WorkflowRunCard({
  run,
  onOpen,
}: {
  run: ThreadWorkflowRun;
  onOpen: (run: ThreadWorkflowRun) => void;
}) {
  const phases = groupByPhase(run);
  const settled = run.outcome !== undefined;
  const runCancelled = run.outcome === "cancelled";
  // Carry each line's absolute position before slicing: `logs` is append-only, so
  // that position is a stable key, whereas the index within the last-3 window
  // shifts every time a new line arrives.
  const recentLogs = run.logs.map((line, position) => ({ line, position })).slice(-3);
  const status = runStatusLabel(run);
  const costLabel = run.spentUsd > 0 ? `, ${formatCost(run.spentUsd)}` : "";

  return (
    <button
      type="button"
      onClick={() => onOpen(run)}
      aria-label={`Open workflow ${run.name} (${status}${costLabel}; ${run.runId})`}
      className="app-context-sidebar__nested-panel w-full rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-foreground">{run.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {runOutcomeIcon(run)}
          <span className="tabular-nums">{status}</span>
        </div>
      </div>

      {run.spentUsd > 0 ? (
        <div className="mt-0.5 text-xs tabular-nums app-text-muted">{formatCost(run.spentUsd)}</div>
      ) : null}

      {phases.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {phases.map(([phase, agents]) => (
            <div key={phase}>
              <div
                className={cn(
                  "app-type-label truncate uppercase tracking-[0.14em]",
                  phase === run.currentPhase && !settled ? "text-foreground" : "app-text-muted",
                )}
              >
                {phase}
              </div>
              <div className="mt-0.5 flex flex-col gap-0.5">
                {agents.length === 0 ? (
                  <div className="app-type-caption text-warning">No agent started</div>
                ) : (
                  agents.map((agent) => (
                    <div key={agent.index} className="text-xs text-muted-foreground">
                      <div
                        className="flex items-center gap-1.5"
                        title={agent.error ?? agent.agentId ?? undefined}
                      >
                        {agentStateIcon(agent.state, runCancelled)}
                        <span className="sr-only">
                          {agent.label}: {agentStateLabel(agent.state, runCancelled)}
                        </span>
                        <span className="truncate">{agent.label}</span>
                        {agent.state === "cached" ? (
                          <span
                            aria-hidden="true"
                            className="app-type-caption shrink-0 app-text-muted"
                          >
                            cached
                          </span>
                        ) : null}
                      </div>
                      {agent.error ? (
                        <div
                          className="ml-[1.125rem] line-clamp-2 text-warning"
                          title={agent.error}
                        >
                          {agent.error}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {run.error ? (
        <div className="mt-1.5 line-clamp-2 border-t pt-1.5 text-xs text-warning" title={run.error}>
          {run.error}
        </div>
      ) : null}

      {recentLogs.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-0.5 border-t pt-1.5">
          {recentLogs.map(({ line, position }) => (
            <div
              key={`${run.runId}-log-${position}`}
              className="app-type-caption truncate app-text-muted"
              title={line}
            >
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </button>
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
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const openAgentThread = useAppStore((s) => s.openAgentThread);
  const visibleRuns = runs.filter((run) => !isLegacyDryRun(run));
  // Read the run back out of `runs` rather than holding the object: progress
  // events replace it wholesale, and a captured copy would freeze mid-run.
  const openRun = visibleRuns.find((run) => run.runId === openRunId) ?? null;
  // Runtime stores newest-last; render newest-first so current activity is on top
  // of the short sidebar scroll area.
  const orderedRuns = visibleRuns.toReversed();

  if (visibleRuns.length === 0) return null;

  return (
    <section className={sectionClassName} data-sidebar-panel="workflows">
      <div className={headerClassName}>
        <span className={labelClassName}>Workflows</span>
      </div>
      <ScrollShadow className={scrollerClassName} data-sidebar-section="workflows">
        <div className="flex flex-col gap-1.5">
          {orderedRuns.map((run) => (
            <WorkflowRunCard
              key={run.runId}
              run={run}
              onOpen={(selected) => setOpenRunId(selected.runId)}
            />
          ))}
        </div>
      </ScrollShadow>
      <WorkflowRunDetailDialog
        run={openRun}
        open={openRun !== null}
        onOpenAgent={(agentId, title) => {
          setOpenRunId(null);
          void openAgentThread(agentId, title);
        }}
        onOpenChange={(next) => {
          if (!next) setOpenRunId(null);
        }}
      />
    </section>
  );
});
