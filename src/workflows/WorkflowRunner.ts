import { randomUUID } from "node:crypto";
import {
  MAX_WORKFLOW_ERROR_TEXT_CHARS,
  // Aliased: `WorkflowRunOutcome` is this module's own result union.
  type WorkflowRunOutcome as WorkflowOutcomeState,
  type WorkflowProgressAgent,
} from "../shared/workflows";
import type { AgentControl, ToolContext } from "../tools/context";
import { compileWorkflowSource } from "./compile";
import { runWorkflowAgent, WorkflowAgentError } from "./hostAgent";
import { digestAgentCall, hashWorkflowArgs, WorkflowJournal } from "./journal";
import { AgentScheduler, resolveWorkflowConcurrency } from "./scheduler";
import { workflowAgentCallSchema, workflowHostMessageSchema, workflowMetaSchema } from "./schema";
import type { WorkflowCompileFailure, WorkflowRunSummary } from "./types";
import { WORKFLOW_WORKER_BOOTSTRAP } from "./workerBootstrap";

/** Hard backstop against a runaway loop authoring unbounded agents. */
const MAX_AGENTS_PER_RUN = 1000;
/** Ceiling on the whole run, independent of any per-agent timeout. */
const DEFAULT_RUN_TIMEOUT_MS = 3_600_000;
/** Cap script `log()` fan-out so a runaway loop cannot OOM the host. */
const MAX_WORKFLOW_LOGS = 500;

function workflowErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_WORKFLOW_ERROR_TEXT_CHARS);
}

export type WorkflowRunOptions = {
  ctx: ToolContext;
  control: AgentControl;
  script: string;
  args?: unknown;
  resumeFromRunId?: string;
  /** When set, no agents are spawned; `agent()` resolves to a stub. */
  dryRun?: boolean;
  /** Internal/test override for the whole-run ceiling. */
  runTimeoutMs?: number;
  /** Emitted on phase changes and on every agent state transition. */
  onProgress?: (progress: {
    runId: string;
    name: string;
    phases: string[];
    currentPhase: string | null;
    agents: WorkflowProgressAgent[];
    logs: string[];
    spentUsd: number;
    outcome?: WorkflowOutcomeState;
  }) => void;
};

export type WorkflowRunOutcome =
  | { ok: true; summary: WorkflowRunSummary }
  | ({ ok: false } & Omit<WorkflowCompileFailure, "ok">);

export async function runWorkflow(opts: WorkflowRunOptions): Promise<WorkflowRunOutcome> {
  const compiled = compileWorkflowSource(opts.script);
  if (!compiled.ok) return { ok: false, issues: compiled.issues };

  // Serialize args before allocating a worker/timer so a circular/non-JSON value
  // cannot leak those resources.
  let argsJson: string;
  try {
    const serialized = JSON.stringify(opts.args ?? {});
    if (serialized === undefined) {
      throw new Error("value serializes to undefined");
    }
    argsJson = serialized;
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: "args",
          message: `args must be JSON-serializable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }

  if (opts.dryRun && opts.resumeFromRunId) {
    return {
      ok: false,
      issues: [
        {
          path: "resumeFromRunId",
          message: "dryRun cannot resume from a prior journal",
        },
      ],
    };
  }

  if (opts.ctx.abortSignal?.aborted) {
    throw new Error("workflow cancelled");
  }

  const runId = `wf_${randomUUID().slice(0, 12)}`;
  const startedAt = Date.now();
  const runTimeoutMs =
    typeof opts.runTimeoutMs === "number" && Number.isFinite(opts.runTimeoutMs)
      ? Math.max(1, Math.floor(opts.runTimeoutMs))
      : DEFAULT_RUN_TIMEOUT_MS;
  const journal = await WorkflowJournal.open({
    projectCoworkDir: opts.ctx.config.projectCoworkDir,
    runId,
    ...(opts.resumeFromRunId ? { resumeFromRunId: opts.resumeFromRunId } : {}),
  });

  const budgetStatus = opts.ctx.costTracker?.getBudgetStatus?.() ?? null;
  const budgetStopAtUsd = budgetStatus?.stopAtUsd ?? null;
  const budgetBaselineUsd = Math.max(0, budgetStatus?.currentCostUsd ?? 0);
  const workflowBudgetLimitUsd =
    budgetStopAtUsd === null ? null : Math.max(0, budgetStopAtUsd - budgetBaselineUsd);
  const scheduler = new AgentScheduler(
    // Cost is known only after a child settles. Serial admission while a hard
    // cap is configured prevents a whole fan-out from crossing the threshold
    // before the first result can stop later children.
    workflowBudgetLimitUsd === null
      ? resolveWorkflowConcurrency(opts.ctx.config.workflowMaxConcurrentAgents)
      : 1,
  );
  const progress: WorkflowProgressAgent[] = [];
  const logs: string[] = [];
  const liveAgentIds = new Set<string>();
  /** In-flight `handleAgentCall` promises the script may have fire-and-forgotten. */
  const inflightCalls = new Set<Promise<void>>();
  let currentPhase: string | null = null;
  let spentUsd = 0;
  let callIndex = 0;
  let meta: { name: string; description: string; phases: string[] } | null = null;
  /** Once true, no further real agents may be admitted. */
  let budgetStopped = budgetStatus?.stopTriggered === true || workflowBudgetLimitUsd === 0;

  const argsHash = hashWorkflowArgs(opts.args);

  const blobUrl = URL.createObjectURL(
    new Blob([WORKFLOW_WORKER_BOOTSTRAP], { type: "text/javascript" }),
  );
  const worker = new Worker(blobUrl, { type: "module" } as WorkerOptions);
  // Do not hold the process open on this worker.
  (worker as unknown as { unref?: () => void }).unref?.();

  let settle!: (outcome: WorkflowRunOutcome) => void;
  let fail!: (error: unknown) => void;
  const settled = new Promise<WorkflowRunOutcome>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const runAbortController = new AbortController();
  const closedAgentIds = new Set<string>();
  const closingAgents = new Map<string, Promise<void>>();
  let terminalClaimed = false;
  let terminalOutcome: WorkflowOutcomeState | null = null;
  let finished = false;
  const claimTerminal = (outcome: WorkflowOutcomeState): boolean => {
    if (terminalClaimed) return false;
    terminalClaimed = true;
    terminalOutcome = outcome;
    return true;
  };

  const postWorker = (message: unknown): boolean => {
    if (finished) return false;
    worker.postMessage(message);
    return true;
  };

  const drainInflightCalls = async () => {
    while (inflightCalls.size > 0) {
      await Promise.allSettled([...inflightCalls]);
    }
  };

  const markNonTerminalAgents = (terminalState: "errored", error?: string) => {
    for (const row of progress) {
      if (row.state === "queued" || row.state === "running") {
        row.state = terminalState;
        if (error) row.error = workflowErrorText(error);
      }
    }
  };

  const closeAgent = async (agentId: string): Promise<void> => {
    if (closedAgentIds.has(agentId)) return;
    const existing = closingAgents.get(agentId);
    if (existing) return await existing;
    const closing = opts.control
      .close({ agentId })
      .then(() => {
        closedAgentIds.add(agentId);
        liveAgentIds.delete(agentId);
      })
      .finally(() => closingAgents.delete(agentId));
    closingAgents.set(agentId, closing);
    await closing;
  };

  const emitProgress = (outcome?: WorkflowOutcomeState, error?: string) => {
    // Dry runs are authoring checks, not executions. Keep their stub agents out
    // of session snapshots and the desktop's workflow history entirely.
    if (opts.dryRun) return;
    opts.onProgress?.({
      runId,
      name: meta?.name ?? "workflow",
      phases: meta?.phases ?? [],
      currentPhase,
      // Copy: the caller may hold this across the run, and `progress` is mutated
      // in place as agents transition.
      agents: progress.map((row) => ({ ...row })),
      logs: [...logs],
      spentUsd,
      ...(error ? { error: workflowErrorText(error) } : {}),
      ...(outcome ? { outcome } : {}),
    });
  };

  const teardown = async (reason: string) => {
    if (finished) return;
    finished = true;
    try {
      worker.terminate();
    } catch {
      // terminate() is best-effort; the run is already settling.
    }
    URL.revokeObjectURL(blobUrl);
    // `cancelAll` is NOT on the tool-facing AgentControl facade
    // (`src/tools/context.ts:25-47` declares seven methods and no cancelAll), so
    // close the agents this run actually created instead of reaching for it.
    for (let attempt = 0; attempt < 2 && liveAgentIds.size > 0; attempt += 1) {
      await Promise.allSettled([...liveAgentIds].map((agentId) => closeAgent(agentId)));
    }
    if (reason) opts.ctx.log(`tool! workflow ${runId} ${reason}`);
    // Dry runs must not leave a resumable journal — stub results would poison
    // a later live resume.
    if (!opts.dryRun) {
      await journal.flush().catch(() => {});
    }
  };

  const onAbort = () => {
    if (!claimTerminal("cancelled")) return;
    runAbortController.abort();
    void (async () => {
      // Close children first so AgentControl.wait resolves instead of making
      // cancellation wait for its current timeout slice.
      await teardown("cancelled");
      await drainInflightCalls();
      // Leave non-terminal agent rows as-is: the UI treats `outcome: cancelled`
      // plus a non-terminal agent state as cancelled, rather than failed.
      emitProgress("cancelled", "workflow cancelled");
      fail(new Error("workflow cancelled"));
    })();
  };
  opts.ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
  // The signal can flip after the early guard but before the listener is
  // attached. Re-check after registration so a script with no agent() calls
  // cannot slip through that window and report completion.
  if (opts.ctx.abortSignal?.aborted) onAbort();

  const runTimer = setTimeout(() => {
    if (!claimTerminal("errored")) return;
    const timeoutMessage = `workflow ${runId} exceeded ${runTimeoutMs}ms`;
    runAbortController.abort();
    markNonTerminalAgents("errored", timeoutMessage);
    void (async () => {
      await teardown("exceeded the run timeout");
      await drainInflightCalls();
      emitProgress("errored", timeoutMessage);
      fail(new Error(timeoutMessage));
    })();
  }, runTimeoutMs);

  const recordSpend = (usdCost: number | null) => {
    if (usdCost === null || usdCost <= 0) return;
    spentUsd += usdCost;
    postWorker({ t: "budgetUpdate", spentUsd });
    if (workflowBudgetLimitUsd !== null && spentUsd >= workflowBudgetLimitUsd) {
      budgetStopped = true;
    }
  };

  const budgetBlocksNewAgents = () =>
    budgetStopped || (workflowBudgetLimitUsd !== null && spentUsd >= workflowBudgetLimitUsd);

  const handleAgentCall = async (callId: number, payload: unknown) => {
    if (terminalClaimed) return;
    const index = callIndex++;
    if (index >= MAX_AGENTS_PER_RUN) {
      const message = `workflow exceeded the ${MAX_AGENTS_PER_RUN}-agent ceiling`;
      progress.push({
        index,
        label: `agent-${index + 1}`,
        phase: currentPhase,
        state: "errored",
        agentId: null,
        usdCost: null,
        error: message,
      });
      emitProgress();
      postWorker({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({
          ok: false,
          message,
        }),
      });
      return;
    }

    let prompt: string;
    let options: ReturnType<typeof workflowAgentCallSchema.parse>["opts"];
    let rawCall: unknown;
    try {
      rawCall = JSON.parse(String(payload));
      const parsed = workflowAgentCallSchema.parse(rawCall);
      prompt = parsed.prompt;
      options = parsed.opts;
      if (options.phase && meta && !meta.phases.includes(options.phase)) {
        throw new Error(
          `unknown phase "${options.phase}"; meta.phases declares: ${meta.phases.join(", ")}`,
        );
      }
    } catch (error) {
      const message = `invalid agent() call: ${workflowErrorText(error)}`;
      const rawRecord =
        typeof rawCall === "object" && rawCall !== null && !Array.isArray(rawCall)
          ? (rawCall as Record<string, unknown>)
          : null;
      const rawOptions =
        rawRecord &&
        typeof rawRecord.opts === "object" &&
        rawRecord.opts !== null &&
        !Array.isArray(rawRecord.opts)
          ? (rawRecord.opts as Record<string, unknown>)
          : null;
      const rawLabel = typeof rawOptions?.label === "string" ? rawOptions.label.trim() : "";
      const rawPhase = typeof rawOptions?.phase === "string" ? rawOptions.phase.trim() : "";
      progress.push({
        index,
        label: rawLabel.slice(0, 120) || `agent-${index + 1}`,
        phase: rawPhase || currentPhase,
        state: "errored",
        agentId: null,
        usdCost: null,
        error: message,
      });
      emitProgress();
      postWorker({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({
          ok: false,
          message,
        }),
      });
      return;
    }

    const label = options.label ?? `agent-${index + 1}`;
    const phase = options.phase ?? currentPhase;
    const row: WorkflowProgressAgent = {
      index,
      label,
      phase,
      state: "queued",
      agentId: null,
      usdCost: null,
    };
    progress.push(row);
    emitProgress();

    const digest = digestAgentCall({ argsHash, prompt, opts: options });
    const cached = journal.lookup(digest);
    if (cached) {
      row.state = "cached";
      row.usdCost = 0;
      emitProgress();
      // Re-record under this run's journal so a later resume of THIS run still
      // has the prefix. Dry runs never persist.
      if (!opts.dryRun) {
        journal.append({ ...cached, index, digest });
      }
      postWorker({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({ ok: true, value: cached.result }),
      });
      return;
    }

    try {
      const outcome = await scheduler.run(async () => {
        if (runAbortController.signal.aborted || opts.ctx.abortSignal?.aborted) {
          throw new WorkflowAgentError("workflow cancelled", null, true);
        }
        if (!opts.dryRun && budgetBlocksNewAgents()) {
          throw new WorkflowAgentError("workflow budget exhausted", null);
        }
        row.state = "running";
        emitProgress();
        if (opts.dryRun) {
          return {
            value: `[dry-run] ${label}`,
            agentId: `dry-${index}`,
            usdCost: 0,
          };
        }
        return await runWorkflowAgent({
          ctx: opts.ctx,
          control: opts.control,
          abortSignal: runAbortController.signal,
          closeAgent,
          prompt,
          options,
          label,
          onAgentId: (agentId) => {
            row.agentId = agentId;
            liveAgentIds.add(agentId);
            emitProgress();
          },
        });
      });

      row.usdCost = outcome.usdCost;
      recordSpend(outcome.usdCost);
      if (terminalOutcome !== null) return;
      row.state = "completed";
      emitProgress();

      // Dry-run stubs must not become a resumable journal prefix.
      if (!opts.dryRun) {
        journal.append({
          index,
          digest,
          phase,
          label,
          result: outcome.value,
          agentId: outcome.agentId,
          usdCost: outcome.usdCost,
        });
      }

      postWorker({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({ ok: true, value: outcome.value }),
      });
    } catch (error) {
      if (error instanceof WorkflowAgentError) {
        row.usdCost = error.usdCost;
        recordSpend(error.usdCost);
      }
      if (terminalOutcome !== null) return;
      const message = workflowErrorText(error);
      row.state = "errored";
      row.error = message;
      emitProgress();

      // A fatal error (task lock, cancellation) aborts the run rather than being
      // handed back to the script, which could otherwise swallow it via onError.
      if (error instanceof WorkflowAgentError && error.fatal) {
        if (!claimTerminal("errored")) return;
        clearTimeout(runTimer);
        runAbortController.abort();
        markNonTerminalAgents("errored", message);
        await teardown(error.message);
        emitProgress("errored", message);
        fail(error);
        return;
      }

      if (options.onError === "null") {
        if (!opts.dryRun) {
          journal.append({
            index,
            digest,
            phase,
            label,
            result: null,
            agentId: error instanceof WorkflowAgentError ? error.agentId : null,
            usdCost: row.usdCost,
          });
        }
        postWorker({
          t: "agentResult",
          callId,
          ok: true,
          payload: JSON.stringify({ ok: true, value: null }),
        });
        return;
      }
      postWorker({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({ ok: false, message }),
      });
    }
  };

  const trackAgentCall = (callId: number, payload: unknown) => {
    const tracked = handleAgentCall(callId, payload).finally(() => {
      inflightCalls.delete(tracked);
    });
    inflightCalls.add(tracked);
  };

  worker.onmessage = (event: MessageEvent) => {
    const parsedMessage = workflowHostMessageSchema.safeParse(event.data);
    if (!parsedMessage.success) return;
    const message = parsedMessage.data;

    switch (message.t) {
      case "meta": {
        const callId = message.callId;
        const parsed = workflowMetaSchema.safeParse(message.meta);
        if (!parsed.success) {
          postWorker({
            t: "metaAck",
            callId,
            ok: true,
            payload: {
              ok: false,
              message: `meta is invalid: ${parsed.error.issues
                .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
                .join("; ")}`,
            },
          });
          return;
        }
        meta = { ...parsed.data, phases: [...parsed.data.phases] };
        postWorker({ t: "metaAck", callId, ok: true, payload: { ok: true } });
        return;
      }
      case "agent": {
        trackAgentCall(message.callId, message.payload);
        return;
      }
      // Progress goes to the workflow_progress event only — deliberately NOT to
      // ctx.log. A log line prefixed `tool>` is reverse-parsed into a tool card by
      // the desktop (legacyToolLogs.ts), so emitting one per phase and per log()
      // would spray the parent transcript with dozens of fake tool cards for work
      // that belongs in the run panel. Only genuine failures below reach ctx.log.
      case "phase": {
        if (!meta?.phases.includes(message.title)) {
          const error = new Error(
            `unknown phase "${message.title}"; meta.phases declares: ${meta?.phases.join(", ") ?? "(none)"}`,
          );
          if (!claimTerminal("errored")) return;
          clearTimeout(runTimer);
          runAbortController.abort();
          markNonTerminalAgents("errored", error.message);
          void (async () => {
            await teardown(error.message);
            await drainInflightCalls();
            emitProgress("errored", error.message);
            fail(error);
          })();
          return;
        }
        currentPhase = message.title;
        emitProgress();
        return;
      }
      case "log": {
        if (logs.length < MAX_WORKFLOW_LOGS) {
          logs.push(message.message);
          emitProgress();
        }
        return;
      }
      case "done": {
        void (async () => {
          // The script may have fire-and-forgotten agent() calls. Settle every
          // host-side call before finalizing so we never report completion while
          // children are still spawning against a terminated worker.
          await drainInflightCalls();
          if (!claimTerminal("completed")) return;
          clearTimeout(runTimer);
          await teardown("");
          emitProgress("completed");
          settle({
            ok: true,
            summary: {
              runId,
              scriptHash: compiled.sourceHash,
              name: meta?.name ?? "workflow",
              description: meta?.description ?? "",
              phases: meta?.phases ?? [],
              agentCount: progress.length,
              cachedCount: progress.filter((row) => row.state === "cached").length,
              erroredCount: progress.filter((row) => row.state === "errored").length,
              spentUsd,
              durationMs: Date.now() - startedAt,
              result: message.result,
              logs,
              ...(opts.resumeFromRunId ? { resumedFromRunId: opts.resumeFromRunId } : {}),
            },
          });
        })();
        return;
      }
      case "error": {
        if (!claimTerminal("errored")) return;
        clearTimeout(runTimer);
        runAbortController.abort();
        markNonTerminalAgents("errored", message.message);
        void (async () => {
          await teardown("");
          await drainInflightCalls();
          emitProgress("errored", message.message);
          fail(new Error(message.message));
        })();
        return;
      }
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
        return;
      }
    }
  };

  worker.onerror = (event: ErrorEvent) => {
    if (!claimTerminal("errored")) return;
    clearTimeout(runTimer);
    runAbortController.abort();
    const message = event.message || "workflow worker crashed";
    markNonTerminalAgents("errored", message);
    void (async () => {
      await teardown("");
      await drainInflightCalls();
      emitProgress("errored", message);
      fail(new Error(message));
    })();
  };

  postWorker({
    t: "start",
    js: compiled.js,
    argsJson,
    budgetTotal: workflowBudgetLimitUsd,
  });

  try {
    return await settled;
  } finally {
    clearTimeout(runTimer);
    opts.ctx.abortSignal?.removeEventListener("abort", onAbort);
    runAbortController.abort();
    await teardown("");
    await drainInflightCalls();
  }
}
