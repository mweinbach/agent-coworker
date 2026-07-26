import { isAgentControlTaskLockError } from "../server/agents/AgentControl";
import { AGENT_ROLE_VALUES, type AgentRole } from "../shared/agents";
import type { AgentControl, ToolContext } from "../tools/context";
import {
  buildRepairInstruction,
  buildSchemaInstruction,
  extractResultEnvelope,
  validateAgainstJsonSchema,
} from "./resultSchema";
import type { WorkflowAgentOptions } from "./types";

/** One slice of `AgentControl.wait`. Keeps `ctx.abortSignal` responsive on long runs. */
const WAIT_SLICE_MS = 120_000;

export type HostAgentOutcome = {
  value: unknown;
  agentId: string;
  usdCost: number | null;
};

export class WorkflowAgentError extends Error {
  constructor(
    message: string,
    readonly agentId: string | null,
    readonly fatal: boolean = false,
  ) {
    super(message);
    this.name = "WorkflowAgentError";
  }
}

function isKnownRole(value: string): value is AgentRole {
  return (AGENT_ROLE_VALUES as readonly string[]).includes(value);
}

/**
 * Run one `agent()` call to completion: spawn → wait → validate → repair → close.
 *
 * The sequence is a transcription of the production loop in
 * `src/tools/taskReview.ts:122-185`, with three corrections that loop does not
 * need but a fan-out does. They are called out inline.
 */
export async function runWorkflowAgent(opts: {
  ctx: ToolContext;
  control: AgentControl;
  prompt: string;
  options: WorkflowAgentOptions;
  label: string;
  onAgentId: (agentId: string) => void;
}): Promise<HostAgentOutcome> {
  const { ctx, control, options } = opts;
  const schema = options.schema;
  const message = schema ? `${opts.prompt}\n${buildSchemaInstruction(schema)}` : opts.prompt;

  const agentType = options.agentType?.trim();
  const role = agentType && isKnownRole(agentType) ? agentType : undefined;
  const profileRef = agentType && !isKnownRole(agentType) ? agentType : undefined;

  const spawned = await control.spawn({
    message,
    ...(role ? { role } : {}),
    ...(profileRef ? { profileRef } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { reasoningEffort: options.effort } : {}),
    nickname: opts.label.slice(0, 120),
    ...(options.targetPaths?.length ? { targetPaths: [...options.targetPaths] } : {}),
    contextMode: options.isolation ?? "none",
    ...(options.briefing ? { briefing: options.briefing } : {}),
  });
  opts.onAgentId(spawned.agentId);

  try {
    const finalText = await waitSliced({
      ctx,
      control,
      agentId: spawned.agentId,
      timeoutMs: options.timeoutMs ?? 600_000,
    });

    let value: unknown = finalText;

    if (schema) {
      let validation = validateAgainstJsonSchema(schema, extractResultEnvelope(finalText));

      // Exactly one repair turn. A second would usually re-fail the same way and
      // doubles the cost of a fan-out's worst case.
      if (!validation.ok) {
        await control.sendInput({
          agentId: spawned.agentId,
          message: buildRepairInstruction(validation.issues),
        });
        const repaired = await waitSliced({
          ctx,
          control,
          agentId: spawned.agentId,
          timeoutMs: options.timeoutMs ?? 600_000,
        });
        validation = validateAgainstJsonSchema(schema, extractResultEnvelope(repaired));
      }

      if (!validation.ok) {
        throw new WorkflowAgentError(
          `agent "${opts.label}" did not return a valid result: ${validation.issues.join("; ")}`,
          spawned.agentId,
        );
      }
      value = validation.value;
    }

    // CORRECTION 3: `AgentWaitInspection` carries no usage fields, so `wait()`
    // alone cannot fund `budget.spent()`. Inspect once, here, before close().
    let usdCost: number | null = null;
    try {
      const inspected = await control.inspect({ agentId: spawned.agentId });
      usdCost = inspected.sessionUsage?.estimatedTotalCostUsd ?? null;
    } catch {
      // Usage is advisory; never fail a completed agent over accounting.
    }

    return { value, agentId: spawned.agentId, usdCost };
  } finally {
    try {
      await control.close({ agentId: spawned.agentId });
    } catch (error) {
      ctx.log(
        `tool! workflow agent cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Wait for one child in bounded slices.
 *
 * CORRECTION 1: a single 600s `wait()` leaves cancellation latency up to ten
 * minutes on the last outstanding agent, because `AgentControl.wait` does not
 * observe the turn's abort signal. Slicing lets us re-check between windows.
 *
 * CORRECTION 2: `StatusBus.isTerminal` counts `errored` and `closed` as terminal
 * (`StatusBus.ts:6-12`), so `wait({mode:"all"})` returns `timedOut:false` for a
 * child that CRASHED. Reading `latestAssistantText` at that point would surface a
 * failure as a plausible-looking string result — and under a schema, as a wasted
 * repair turn followed by a misleading validation error. `AgentWaitResult.agents`
 * carries `executionState`, so check it before touching the text.
 */
async function waitSliced(opts: {
  ctx: ToolContext;
  control: AgentControl;
  agentId: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;

  for (;;) {
    if (opts.ctx.abortSignal?.aborted) {
      throw new WorkflowAgentError("workflow cancelled", opts.agentId, true);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new WorkflowAgentError(`agent ${opts.agentId} timed out`, opts.agentId);
    }

    let waited: Awaited<ReturnType<AgentControl["wait"]>>;
    try {
      waited = await opts.control.wait({
        agentIds: [opts.agentId],
        timeoutMs: Math.min(WAIT_SLICE_MS, remaining),
        mode: "all",
        includeFinalMessage: true,
      });
    } catch (error) {
      // A task lock means the parent became unwritable. That is systemic, so it
      // aborts the whole run regardless of the call's `onError` policy —
      // otherwise a 300-way fan-out degrades into 300 silent nulls.
      if (isAgentControlTaskLockError(error)) {
        throw new WorkflowAgentError(error.message, opts.agentId, true);
      }
      throw error;
    }

    if (waited.timedOut) continue;

    const summary = waited.agents.find((agent) => agent.agentId === opts.agentId);
    if (summary?.executionState === "errored") {
      throw new WorkflowAgentError(`agent ${opts.agentId} errored`, opts.agentId);
    }

    const text = waited.inspections
      ?.find((inspection) => inspection.agentId === opts.agentId)
      ?.latestAssistantText?.trim();

    if (!text) {
      if (summary?.executionState === "closed") {
        throw new WorkflowAgentError(
          `agent ${opts.agentId} closed without producing a result`,
          opts.agentId,
        );
      }
      throw new WorkflowAgentError(`agent ${opts.agentId} returned no output`, opts.agentId);
    }

    return text;
  }
}
