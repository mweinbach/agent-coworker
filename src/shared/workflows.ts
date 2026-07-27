/**
 * Wire types for live workflow progress.
 *
 * Lives in `shared/` rather than `src/workflows/` because it crosses the
 * JSON-RPC boundary: the harness emits it as a `workflow_progress` SessionEvent
 * and thin clients (desktop, mobile, CLI) render it.
 */

import { z } from "zod";

export const WORKFLOW_AGENT_STATES = [
  "queued",
  "running",
  "completed",
  "errored",
  /** Replayed from a prior run's journal; cost zero. */
  "cached",
] as const;

export type WorkflowAgentState = (typeof WORKFLOW_AGENT_STATES)[number];

export const WORKFLOW_RUN_OUTCOMES = ["completed", "errored", "cancelled"] as const;

export type WorkflowRunOutcome = (typeof WORKFLOW_RUN_OUTCOMES)[number];

export const MAX_WORKFLOW_ERROR_TEXT_CHARS = 4_000;

export type WorkflowProgressAgent = {
  /** Monotonic call index within the run. Stable identity for a progress row. */
  index: number;
  label: string;
  phase: string | null;
  state: WorkflowAgentState;
  /** The child session id, once spawned. Null while queued or on a dry run. */
  agentId: string | null;
  usdCost: number | null;
  /** Diagnostic text when this call failed, including pre-spawn validation failures. */
  error?: string;
};

export type WorkflowProgressPayload = {
  runId: string;
  /** From `meta.name`; falls back to "workflow" before meta is validated. */
  name: string;
  /** Declared phases, in `meta.phases` order. */
  phases: string[];
  currentPhase: string | null;
  agents: WorkflowProgressAgent[];
  /** Lines the script emitted via `log()`. */
  logs: string[];
  spentUsd: number;
  /** Terminal diagnostic text for errored or cancelled runs. */
  error?: string;
  /** Present only on the final emission for a run. */
  outcome?: WorkflowRunOutcome;
};

/** Keep all active runs plus this many most-recent terminal runs per session. */
export const MAX_RETAINED_TERMINAL_WORKFLOW_RUNS = 20;

export function upsertRetainedWorkflowRun(
  runs: readonly WorkflowProgressPayload[],
  progress: WorkflowProgressPayload,
): WorkflowProgressPayload[] {
  const existingIndex = runs.findIndex((run) => run.runId === progress.runId);
  const next =
    existingIndex >= 0
      ? runs.map((run, index) => (index === existingIndex ? progress : run))
      : [...runs, progress];
  let terminalToDrop = Math.max(
    0,
    next.filter((run) => run.outcome !== undefined).length - MAX_RETAINED_TERMINAL_WORKFLOW_RUNS,
  );
  if (terminalToDrop === 0) return next;
  return next.filter((run) => {
    if (run.outcome === undefined) return true;
    if (terminalToDrop <= 0) return true;
    terminalToDrop -= 1;
    return false;
  });
}

export const workflowProgressAgentSchema = z
  .object({
    index: z.number().int().min(0),
    label: z.string(),
    phase: z.string().nullable(),
    state: z.enum(WORKFLOW_AGENT_STATES),
    agentId: z.string().nullable(),
    usdCost: z.number().nullable(),
    error: z.string().max(MAX_WORKFLOW_ERROR_TEXT_CHARS).optional(),
  })
  .strict();

export const workflowProgressPayloadSchema: z.ZodType<WorkflowProgressPayload> = z
  .object({
    runId: z.string().trim().min(1),
    name: z.string(),
    phases: z.array(z.string()),
    currentPhase: z.string().nullable(),
    agents: z.array(workflowProgressAgentSchema),
    logs: z.array(z.string()),
    spentUsd: z.number(),
    error: z.string().max(MAX_WORKFLOW_ERROR_TEXT_CHARS).optional(),
    outcome: z.enum(WORKFLOW_RUN_OUTCOMES).optional(),
  })
  .strict();
