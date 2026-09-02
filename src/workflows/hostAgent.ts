import { isAgentControlTaskLockError } from "../server/agents/AgentControl";
import { AGENT_ROLE_VALUES, type AgentRole } from "../shared/agents";
import type { AgentControl, ToolContext } from "../tools/context";
import {
  buildRepairInstruction,
  buildSchemaInstruction,
  buildSchemaSystemInstruction,
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
    readonly usdCost: number | null = null,
  ) {
    super(message);
    this.name = "WorkflowAgentError";
  }
}

type WorkflowAgentDeadline = {
  expiresAt: number;
  label: string;
};

class WorkflowAgentTimeoutError extends WorkflowAgentError {
  constructor(agentId: string | null, label: string) {
    super(`agent ${agentId ?? `"${label}"`} timed out`, agentId);
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
  abortSignal?: AbortSignal;
  closeAgent?: (agentId: string) => Promise<void>;
  prompt: string;
  inputFileTargetPath?: string;
  options: WorkflowAgentOptions;
  label: string;
  onAgentId: (agentId: string) => void;
}): Promise<HostAgentOutcome> {
  const { ctx, control, options } = opts;
  const deadline: WorkflowAgentDeadline = {
    expiresAt: Date.now() + (options.timeoutMs ?? 600_000),
    label: opts.label,
  };
  const schema = options.schema;
  const message = schema ? `${opts.prompt}\n${buildSchemaInstruction(schema)}` : opts.prompt;

  const agentType = options.agentType?.trim();
  const role = agentType && isKnownRole(agentType) ? agentType : undefined;
  const profileRef = agentType && !isKnownRole(agentType) ? agentType : undefined;
  const targetPaths = options.targetPaths?.length
    ? [
        ...new Set([
          ...options.targetPaths,
          ...(opts.inputFileTargetPath ? [opts.inputFileTargetPath] : []),
        ]),
      ]
    : undefined;

  let spawned: Awaited<ReturnType<AgentControl["spawn"]>>;
  const spawnPromise = control.spawn({
    message,
    ...(schema ? { systemPromptSuffix: buildSchemaSystemInstruction() } : {}),
    ...(role ? { role } : {}),
    ...(profileRef ? { profileRef } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { reasoningEffort: options.effort } : {}),
    nickname: opts.label.slice(0, 120),
    ...(targetPaths ? { targetPaths } : {}),
    contextMode: options.isolation ?? "none",
    ...(options.briefing ? { briefing: options.briefing } : {}),
  });
  try {
    spawned = await raceWithAbort(
      spawnPromise,
      opts.abortSignal ?? ctx.abortSignal,
      null,
      deadline,
    );
  } catch (error) {
    if (
      error instanceof WorkflowAgentTimeoutError ||
      (error instanceof WorkflowAgentError && error.fatal)
    ) {
      void spawnPromise
        .then(async (lateSpawn) => {
          try {
            if (opts.closeAgent) await opts.closeAgent(lateSpawn.agentId);
            else await control.close({ agentId: lateSpawn.agentId });
          } catch {}
        })
        .catch(() => {});
    }
    throw new WorkflowAgentError(
      error instanceof Error ? error.message : String(error),
      null,
      error instanceof WorkflowAgentError ? error.fatal : isAgentControlTaskLockError(error),
    );
  }
  opts.onAgentId(spawned.agentId);

  let usdCost: number | null = null;
  try {
    const finalText = await waitSliced({
      ctx,
      control,
      agentId: spawned.agentId,
      deadline,
      abortSignal: opts.abortSignal,
    });

    let value: unknown = finalText;

    if (schema) {
      let validation = validateAgainstJsonSchema(schema, extractResultEnvelope(finalText));

      // Exactly one repair turn. A second would usually re-fail the same way and
      // doubles the cost of a fan-out's worst case.
      if (!validation.ok) {
        await raceWithAbort(
          control.sendInput({
            agentId: spawned.agentId,
            message: buildRepairInstruction(validation.issues),
          }),
          opts.abortSignal ?? ctx.abortSignal,
          spawned.agentId,
          deadline,
        );
        const repaired = await waitSliced({
          ctx,
          control,
          agentId: spawned.agentId,
          deadline,
          abortSignal: opts.abortSignal,
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
    usdCost = await readAgentUsdCost(
      control,
      spawned.agentId,
      opts.abortSignal ?? ctx.abortSignal,
      deadline,
    );
    return { value, agentId: spawned.agentId, usdCost };
  } catch (error) {
    // Errored agents still spent tokens — capture cost so the host budget can
    // hard-stop instead of treating failures as free.
    if (usdCost === null && !(error instanceof WorkflowAgentError && error.fatal)) {
      usdCost = await readAgentUsdCost(
        control,
        spawned.agentId,
        opts.abortSignal ?? ctx.abortSignal,
        deadline,
      );
    }
    if (isAgentControlTaskLockError(error)) {
      throw new WorkflowAgentError(error.message, spawned.agentId, true, usdCost);
    }
    if (error instanceof WorkflowAgentError) {
      throw new WorkflowAgentError(error.message, error.agentId, error.fatal, usdCost);
    }
    throw new WorkflowAgentError(
      error instanceof Error ? error.message : String(error),
      spawned.agentId,
      false,
      usdCost,
    );
  } finally {
    try {
      const closing: Promise<unknown> = opts.closeAgent
        ? opts.closeAgent(spawned.agentId)
        : control.close({ agentId: spawned.agentId });
      // A timed-out close still owns the real child-cleanup operation. Observe
      // its eventual rejection even after this caller stops waiting for it.
      void closing.catch(() => {});
      await raceWithAbort(closing, opts.abortSignal ?? ctx.abortSignal, spawned.agentId, deadline);
    } catch (error) {
      ctx.log(
        `tool! workflow agent cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function readAgentUsdCost(
  control: AgentControl,
  agentId: string,
  abortSignal?: AbortSignal,
  deadline?: WorkflowAgentDeadline,
): Promise<number | null> {
  if (deadline && deadline.expiresAt <= Date.now()) return null;
  try {
    const inspected = await raceWithAbort(
      control.inspect({ agentId }),
      abortSignal,
      agentId,
      deadline,
    );
    return inspected.sessionUsage?.estimatedTotalCostUsd ?? null;
  } catch (error) {
    if (error instanceof WorkflowAgentError && error.fatal) throw error;
    // Usage is advisory; never fail a completed agent over accounting.
    return null;
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
  deadline: WorkflowAgentDeadline;
  abortSignal?: AbortSignal;
}): Promise<string> {
  for (;;) {
    if (opts.abortSignal?.aborted || opts.ctx.abortSignal?.aborted) {
      throw new WorkflowAgentError("workflow cancelled", opts.agentId, true);
    }
    const remaining = opts.deadline.expiresAt - Date.now();
    if (remaining <= 0) {
      throw new WorkflowAgentTimeoutError(opts.agentId, opts.deadline.label);
    }

    let waited: Awaited<ReturnType<AgentControl["wait"]>>;
    try {
      waited = await raceWithAbort(
        opts.control.wait({
          agentIds: [opts.agentId],
          timeoutMs: Math.min(WAIT_SLICE_MS, remaining),
          mode: "all",
          includeFinalMessage: true,
        }),
        opts.abortSignal ?? opts.ctx.abortSignal,
        opts.agentId,
        opts.deadline,
      );
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

async function raceWithAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  agentId: string | null,
  deadline?: WorkflowAgentDeadline,
): Promise<T> {
  if (!signal && !deadline) return await pending;
  if (signal?.aborted) {
    throw new WorkflowAgentError("workflow cancelled", agentId, true);
  }

  let onAbort: (() => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const racing: Array<Promise<T>> = [pending];
  if (signal) {
    racing.push(
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new WorkflowAgentError("workflow cancelled", agentId, true));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  if (deadline) {
    const remaining = deadline.expiresAt - Date.now();
    if (remaining <= 0) {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      throw new WorkflowAgentTimeoutError(agentId, deadline.label);
    }
    racing.push(
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new WorkflowAgentTimeoutError(agentId, deadline.label)),
          remaining,
        );
      }),
    );
  }
  try {
    return await Promise.race(racing);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (timeout) clearTimeout(timeout);
  }
}
