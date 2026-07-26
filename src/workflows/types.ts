import type { AgentReasoningEffort } from "../shared/agents";

/**
 * A JSON Schema literal. Deliberately data-only rather than a zod object: the
 * script runs in a separate realm behind a structured-clone boundary, and an
 * object containing functions cannot cross it. The host rehydrates via
 * `z.fromJSONSchema`, which also keeps the schema serializable into the journal.
 */
export type WorkflowJsonSchema = Record<string, unknown>;

export type WorkflowAgentOptions = {
  /** Short human label. Becomes the child's `nickname` and the progress row title. */
  label?: string;
  /** Must be one of `meta.phases`. Validated host-side; an unknown phase is an error. */
  phase?: string;
  /** JSON Schema. When present, `agent()` resolves to a validated object, not a string. */
  schema?: WorkflowJsonSchema;
  /** Model id or `provider:modelId`. Goes through `routeAgentConfig`; may fall back. */
  model?: string;
  effort?: AgentReasoningEffort;
  /** Maps to `contextMode`. `"full"` is deliberately unavailable — see docs/workflows.md. */
  isolation?: "none" | "brief";
  /** Required when `isolation === "brief"`. */
  briefing?: string;
  /** A role id (`default`/`explorer`/`research`/`worker`/`reviewer`) or a profile ref. */
  agentType?: string;
  /** Restricts the child's writes. Validated by `isUsableTargetPath`. Disables bash for that child. */
  targetPaths?: readonly string[];
  /** Per-call failure policy. Default `"fail"` — the promise rejects. */
  onError?: "fail" | "null";
  /** Wall-clock ceiling for this one agent. */
  timeoutMs?: number;
};

export type WorkflowJournalEntry = {
  /** Monotonic call index within the run. Part of the resume key. */
  index: number;
  /** Digest of (sourceHash, index, prompt, normalized opts). */
  digest: string;
  phase: string | null;
  label: string | null;
  /** The value `agent()` resolved to. `null` when the call failed under `onError:"null"`. */
  result: unknown;
  agentId: string | null;
  usdCost: number | null;
};

export type WorkflowRunSummary = {
  runId: string;
  /**
   * SHA-256 of the script source. Not part of the resume key (see
   * `digestAgentCall`) — this is for traceability: which script version produced
   * this journal.
   */
  scriptHash: string;
  name: string;
  description: string;
  phases: readonly string[];
  agentCount: number;
  cachedCount: number;
  erroredCount: number;
  spentUsd: number;
  durationMs: number;
  result: unknown;
  logs: string[];
  /** Set when the run was resumed from a prior journal. */
  resumedFromRunId?: string;
};

/** Structured compile failure, returned to the model instead of thrown. */
export type WorkflowCompileFailure = {
  ok: false;
  issues: Array<{ path: string; message: string }>;
};

type WorkflowCompileSuccess = {
  ok: true;
  js: string;
  sourceHash: string;
};

export type WorkflowCompileResult = WorkflowCompileSuccess | WorkflowCompileFailure;
