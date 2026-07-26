import { randomUUID } from "node:crypto";
import type {
  // Aliased: `WorkflowRunOutcome` is this module's own result union.
  WorkflowRunOutcome as WorkflowOutcomeState,
  WorkflowProgressAgent,
} from "../shared/workflows";
import type { AgentControl, ToolContext } from "../tools/context";
import { compileWorkflowSource } from "./compile";
import { runWorkflowAgent, WorkflowAgentError } from "./hostAgent";
import { digestAgentCall, hashWorkflowArgs, WorkflowJournal } from "./journal";
import { AgentScheduler, WORKFLOW_MAX_INFLIGHT_AGENTS } from "./scheduler";
import { workflowAgentCallSchema, workflowHostMessageSchema, workflowMetaSchema } from "./schema";
import type { WorkflowCompileFailure, WorkflowRunSummary } from "./types";
import { WORKFLOW_WORKER_BOOTSTRAP } from "./workerBootstrap";

/** Hard backstop against a runaway loop authoring unbounded agents. */
const MAX_AGENTS_PER_RUN = 1000;
/** Ceiling on the whole run, independent of any per-agent timeout. */
const DEFAULT_RUN_TIMEOUT_MS = 3_600_000;

export type WorkflowRunOptions = {
  ctx: ToolContext;
  control: AgentControl;
  script: string;
  args?: unknown;
  resumeFromRunId?: string;
  /** When set, no agents are spawned; `agent()` resolves to a stub. */
  dryRun?: boolean;
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

  const runId = `wf_${randomUUID().slice(0, 12)}`;
  const startedAt = Date.now();
  const journal = await WorkflowJournal.open({
    projectCoworkDir: opts.ctx.config.projectCoworkDir,
    runId,
    ...(opts.resumeFromRunId ? { resumeFromRunId: opts.resumeFromRunId } : {}),
  });

  const scheduler = new AgentScheduler(WORKFLOW_MAX_INFLIGHT_AGENTS);
  const progress: WorkflowProgressAgent[] = [];
  const logs: string[] = [];
  const liveAgentIds = new Set<string>();
  let currentPhase: string | null = null;
  let spentUsd = 0;
  let callIndex = 0;
  let meta: { name: string; description: string; phases: string[] } | null = null;

  const budgetTotal = opts.ctx.costTracker?.getBudgetStatus?.()?.stopAtUsd ?? null;
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

  let finished = false;
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
    await Promise.allSettled([...liveAgentIds].map((agentId) => opts.control.close({ agentId })));
    if (reason) opts.ctx.log(`tool! workflow ${runId} ${reason}`);
    await journal.flush().catch(() => {});
  };

  const onAbort = () => {
    void teardown("cancelled").then(() => {
      emitProgress("cancelled");
      fail(new Error("workflow cancelled"));
    });
  };
  opts.ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

  const runTimer = setTimeout(() => {
    void teardown("exceeded the run timeout").then(() =>
      fail(new Error(`workflow ${runId} exceeded ${DEFAULT_RUN_TIMEOUT_MS}ms`)),
    );
  }, DEFAULT_RUN_TIMEOUT_MS);

  const emitProgress = (outcome?: WorkflowOutcomeState) =>
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
      ...(outcome ? { outcome } : {}),
    });

  const handleAgentCall = async (callId: number, payload: unknown) => {
    const index = callIndex++;
    if (index >= MAX_AGENTS_PER_RUN) {
      worker.postMessage({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({
          ok: false,
          message: `workflow exceeded the ${MAX_AGENTS_PER_RUN}-agent ceiling`,
        }),
      });
      return;
    }

    let prompt: string;
    let options: ReturnType<typeof workflowAgentCallSchema.parse>["opts"];
    try {
      const raw = JSON.parse(String(payload));
      const parsed = workflowAgentCallSchema.parse(raw);
      prompt = parsed.prompt;
      options = parsed.opts;
      if (options.phase && meta && !meta.phases.includes(options.phase)) {
        throw new Error(
          `unknown phase "${options.phase}"; meta.phases declares: ${meta.phases.join(", ")}`,
        );
      }
    } catch (error) {
      worker.postMessage({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({
          ok: false,
          message: `invalid agent() call: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
      journal.append({ ...cached, index, digest });
      worker.postMessage({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({ ok: true, value: cached.result }),
      });
      return;
    }

    try {
      const outcome = await scheduler.run(async () => {
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

      if (outcome.agentId) liveAgentIds.delete(outcome.agentId);
      row.state = "completed";
      row.usdCost = outcome.usdCost;
      spentUsd += outcome.usdCost ?? 0;
      emitProgress();
      worker.postMessage({ t: "budgetUpdate", spentUsd });

      journal.append({
        index,
        digest,
        phase,
        label,
        result: outcome.value,
        agentId: outcome.agentId,
        usdCost: outcome.usdCost,
      });

      worker.postMessage({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({ ok: true, value: outcome.value }),
      });
    } catch (error) {
      if (error instanceof WorkflowAgentError && error.agentId) {
        liveAgentIds.delete(error.agentId);
      }
      row.state = "errored";
      emitProgress();

      // A fatal error (task lock, cancellation) aborts the run rather than being
      // handed back to the script, which could otherwise swallow it via onError.
      if (error instanceof WorkflowAgentError && error.fatal) {
        await teardown(error.message);
        emitProgress("errored");
        fail(error);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (options.onError === "null") {
        worker.postMessage({
          t: "agentResult",
          callId,
          ok: true,
          payload: JSON.stringify({ ok: true, value: null }),
        });
        return;
      }
      worker.postMessage({
        t: "agentResult",
        callId,
        ok: true,
        payload: JSON.stringify({ ok: false, message }),
      });
    }
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
          worker.postMessage({
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
        worker.postMessage({ t: "metaAck", callId, ok: true, payload: { ok: true } });
        return;
      }
      case "agent": {
        void handleAgentCall(message.callId, message.payload);
        return;
      }
      // Progress goes to the workflow_progress event only — deliberately NOT to
      // ctx.log. A log line prefixed `tool>` is reverse-parsed into a tool card by
      // the desktop (legacyToolLogs.ts), so emitting one per phase and per log()
      // would spray the parent transcript with dozens of fake tool cards for work
      // that belongs in the run panel. Only genuine failures below reach ctx.log.
      case "phase": {
        currentPhase = message.title;
        emitProgress();
        return;
      }
      case "log": {
        logs.push(message.message);
        emitProgress();
        return;
      }
      case "done": {
        void (async () => {
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
        void (async () => {
          clearTimeout(runTimer);
          await teardown("");
          emitProgress("errored");
          fail(new Error(message.message));
        })();
        return;
      }
      default:
        return;
    }
  };

  worker.onerror = (event: ErrorEvent) => {
    void (async () => {
      clearTimeout(runTimer);
      await teardown("");
      emitProgress("errored");
      fail(new Error(event.message || "workflow worker crashed"));
    })();
  };

  worker.postMessage({
    t: "start",
    js: compiled.js,
    argsJson: JSON.stringify(opts.args ?? {}),
    budgetTotal,
  });

  try {
    return await settled;
  } finally {
    clearTimeout(runTimer);
    opts.ctx.abortSignal?.removeEventListener("abort", onAbort);
    await teardown("");
  }
}
