import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  DatabaseZapIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
} from "lucide-react";
import { memo, useMemo } from "react";

import { formatCost } from "../../../../src/session/pricing";
import type { ThreadWorkflowRun } from "../app/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { ScrollShadow } from "../components/ui/scroll-shadow";
import { cn } from "../lib/utils";

type WorkflowAgentRow = ThreadWorkflowRun["agents"][number];

const STATE_ICON = {
  running: LoaderCircleIcon,
  completed: CheckCircle2Icon,
  errored: AlertCircleIcon,
  cached: DatabaseZapIcon,
  queued: CircleDashedIcon,
} as const;

const STATE_TONE: Record<WorkflowAgentRow["state"], string> = {
  running: "text-foreground",
  completed: "text-success",
  errored: "text-warning",
  cached: "text-muted-foreground",
  queued: "text-muted-foreground",
};

function AgentStateIcon({ state }: { state: WorkflowAgentRow["state"] }) {
  const Icon = STATE_ICON[state];
  return (
    <Icon
      className={cn("size-3.5 shrink-0", STATE_TONE[state], state === "running" && "animate-spin")}
    />
  );
}

/** Counts by state, used for the summary strip and the per-phase rollups. */
function tally(agents: WorkflowAgentRow[]) {
  const counts: Record<WorkflowAgentRow["state"], number> = {
    queued: 0,
    running: 0,
    completed: 0,
    errored: 0,
    cached: 0,
  };
  for (const agent of agents) counts[agent.state] += 1;
  return counts;
}

function StatChip({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="app-context-sidebar__nested-panel rounded-[10px] border px-2.5 py-1.5">
      <div className="app-type-label text-[10px] uppercase tracking-[0.14em] app-text-muted">
        {label}
      </div>
      <div className={cn("mt-0.5 text-sm font-medium tabular-nums", tone ?? "text-foreground")}>
        {value}
      </div>
    </div>
  );
}

export const WorkflowRunDetailDialog = memo(function WorkflowRunDetailDialog({
  run,
  open,
  onOpenChange,
}: {
  run: ThreadWorkflowRun | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const counts = useMemo(() => tally(run?.agents ?? []), [run]);

  // Group by phase in meta.phases declaration order, with anything unphased last.
  const phases = useMemo(() => {
    if (!run) return [] as Array<[string, WorkflowAgentRow[]]>;
    const groups = new Map<string, WorkflowAgentRow[]>();
    for (const phase of run.phases) groups.set(phase, []);
    for (const agent of run.agents) {
      const key = agent.phase ?? "unphased";
      const bucket = groups.get(key);
      if (bucket) bucket.push(agent);
      else groups.set(key, [agent]);
    }
    return [...groups.entries()].filter(([, agents]) => agents.length > 0);
  }, [run]);

  // `logs` is append-only, so a line's absolute position is a stable key. Carry it
  // on the item rather than using the map index, which the lint rightly rejects.
  const logLines = useMemo(
    () => (run?.logs ?? []).map((line, position) => ({ line, position })),
    [run],
  );

  if (!run) return null;

  const total = run.agents.length;
  const settled = run.outcome !== undefined;
  const statusLabel = settled ? (run.outcome ?? "") : (run.currentPhase ?? "running");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {settled ? (
              run.outcome === "completed" ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-success" />
              ) : run.outcome === "errored" ? (
                <AlertCircleIcon className="size-4 shrink-0 text-warning" />
              ) : (
                <MinusCircleIcon className="size-4 shrink-0 text-muted-foreground" />
              )
            ) : (
              <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-foreground" />
            )}
            <span className="truncate">{run.name}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {run.runId} · {statusLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-4 gap-2">
          <StatChip label="Agents" value={String(total)} />
          <StatChip
            label="Done"
            value={String(counts.completed + counts.cached)}
            tone="text-success"
          />
          <StatChip
            label="Failed"
            value={String(counts.errored)}
            tone={counts.errored > 0 ? "text-warning" : undefined}
          />
          <StatChip label="Cost" value={run.spentUsd > 0 ? formatCost(run.spentUsd) : "—"} />
        </div>

        {counts.cached > 0 ? (
          <p className="app-type-caption app-text-muted">
            {counts.cached} of {total} replayed from a previous run's journal at no cost.
          </p>
        ) : null}

        <ScrollShadow className="max-h-[22rem] overflow-y-auto overscroll-contain pr-1">
          <div className="space-y-3">
            {phases.map(([phase, agents]) => {
              const phaseCounts = tally(agents);
              const active = phase === run.currentPhase && !settled;
              return (
                <section key={phase}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "app-type-label text-[10px] uppercase tracking-[0.16em]",
                        active ? "text-foreground" : "app-text-muted",
                      )}
                    >
                      {phase}
                      {active ? " · running" : ""}
                    </span>
                    <span className="text-[10px] tabular-nums app-text-muted">
                      {phaseCounts.completed + phaseCounts.cached}/{agents.length}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {agents.map((agent) => (
                      <div
                        key={agent.index}
                        className="flex items-center gap-2 rounded-[8px] px-1.5 py-1 text-xs hover:bg-muted/40"
                      >
                        <AgentStateIcon state={agent.state} />
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {agent.label}
                        </span>
                        {agent.state === "cached" ? (
                          <span className="shrink-0 text-[10px] app-text-muted">cached</span>
                        ) : agent.usdCost !== null && agent.usdCost > 0 ? (
                          <span className="shrink-0 text-[10px] tabular-nums app-text-muted">
                            {formatCost(agent.usdCost)}
                          </span>
                        ) : null}
                        {agent.agentId ? (
                          <span
                            className="w-16 shrink-0 truncate font-mono text-[10px] app-text-muted"
                            title={agent.agentId}
                          >
                            {agent.agentId.slice(0, 8)}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </ScrollShadow>

        {run.logs.length > 0 ? (
          <div className="border-t pt-2">
            <div className="app-type-label text-[10px] uppercase tracking-[0.16em] app-text-muted">
              Log
            </div>
            <ScrollShadow className="mt-1 max-h-24 overflow-y-auto overscroll-contain">
              <div className="space-y-0.5">
                {logLines.map(({ line, position }) => (
                  <div
                    key={`${run.runId}-log-${position}`}
                    className="text-[11px] leading-4 app-text-muted"
                  >
                    {line}
                  </div>
                ))}
              </div>
            </ScrollShadow>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
});
