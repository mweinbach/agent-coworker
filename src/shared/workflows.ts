/**
 * Wire types for live workflow progress.
 *
 * Lives in `shared/` rather than `src/workflows/` because it crosses the
 * JSON-RPC boundary: the harness emits it as a `workflow_progress` SessionEvent
 * and thin clients (desktop, mobile, CLI) render it.
 */

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

export type WorkflowProgressAgent = {
  /** Monotonic call index within the run. Stable identity for a progress row. */
  index: number;
  label: string;
  phase: string | null;
  state: WorkflowAgentState;
  /** The child session id, once spawned. Null while queued or on a dry run. */
  agentId: string | null;
  usdCost: number | null;
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
  /** Present only on the final emission for a run. */
  outcome?: WorkflowRunOutcome;
};
