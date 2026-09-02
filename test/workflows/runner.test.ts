import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { SessionCostTracker } from "../../src/session/costTracker";
import type { WorkflowProgressPayload } from "../../src/shared/workflows";
import {
  WORKFLOW_INLINE_PROMPT_CHARS,
  WORKFLOW_MAX_PROMPT_CHARS,
} from "../../src/workflows/inputSpill";
import { runWorkflow } from "../../src/workflows/WorkflowRunner";
import { makeFakeControl, makeWorkflowCtx, metaHeader, workflowTmpDir } from "./harness";

const N_SCHEMA = `{ type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }`;

describe("runWorkflow: control flow", () => {
  test("pipeline runs every item through every stage without a barrier", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ reply: (nth) => `r${nth}` });
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader("pipe", ["one", "two"])}` +
        `export default async function run({ agent, pipeline, phase }) {\n` +
        `  phase("one");\n` +
        `  return await pipeline(["a", "b", "c"],\n` +
        `    (item) => agent("s1 " + item, { phase: "one" }),\n` +
        `    (prev, item, i) => agent("s2 " + prev + " " + item + " " + i, { phase: "two" }));\n}`,
      args: {},
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.agentCount).toBe(6);
    expect(outcome.summary.erroredCount).toBe(0);
    // Stage 2 receives (previousResult, originalItem, index).
    expect(control.messages().some((m) => m.startsWith("s2 ") && m.endsWith(" a 0"))).toBe(true);
    expect(control.messages().some((m) => m.startsWith("s2 ") && m.endsWith(" c 2"))).toBe(true);
  });

  test("parallel is a barrier and yields null for a failed thunk", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({
      state: (nth) => (nth === 2 ? "errored" : "completed"),
    });
    let finalAgentErrors: Array<string | undefined> = [];
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      onProgress: (progress) => {
        if (progress.outcome) finalAgentErrors = progress.agents.map((agent) => agent.error);
      },
      script:
        `${metaHeader()}` +
        `export default async function run({ agent, parallel, compact }) {\n` +
        `  const out = await parallel([\n` +
        `    () => agent("one", { onError: "null" }),\n` +
        `    () => agent("two", { onError: "null" }),\n` +
        `    () => agent("three", { onError: "null" }),\n` +
        `  ]);\n` +
        `  return { raw: out.length, kept: compact(out).length };\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toEqual({ raw: 3, kept: 2 });
    expect(outcome.summary.erroredCount).toBe(1);
    expect(finalAgentErrors.some((error) => error?.includes("errored"))).toBe(true);
  });

  test("args reach the script and every spawned agent is closed", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader()}` +
        `export default async function run({ agent, args }) {\n` +
        `  const out = [];\n` +
        `  for (const item of args.items) out.push(await agent("do " + item));\n` +
        `  return out.length;\n}`,
      args: { items: ["x", "y"] },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toBe(2);
    expect(control.closed()).toEqual(["agent-1", "agent-2"]);
  });
});

describe("runWorkflow: schema-validated returns", () => {
  test("overrides role-level final-response instructions only for structured children", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({
      reply: (nth) => (nth === 1 ? `<workflow_result>{"n": 7}</workflow_result>` : "plain"),
    });
    const originalSpawn = control.spawn.bind(control);
    const systemPromptSuffixes: Array<string | undefined> = [];
    control.spawn = async (options) => {
      systemPromptSuffixes.push(options.systemPromptSuffix);
      return await originalSpawn(options);
    };

    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader()}` +
        `export default async function run({ agent }) {\n` +
        `  const structured = await agent("count", { agentType: "research", schema: ${N_SCHEMA} });\n` +
        `  const plain = await agent("plain", { agentType: "research" });\n` +
        `  return { n: structured.n, plain };\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toEqual({ n: 7, plain: "plain" });
    expect(systemPromptSuffixes[0]).toContain("Workflow structured-output mode");
    expect(systemPromptSuffixes[0]).toContain(
      "replaces role-level final-response and report-footer instructions",
    );
    expect(systemPromptSuffixes[1]).toBeUndefined();
  });

  test("a valid envelope is parsed into an object", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({
      reply: (nth) => `here you go\n<workflow_result>{"n": ${nth}}</workflow_result>`,
    });
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader()}` +
        `export default async function run({ agent }) {\n` +
        `  const r = await agent("count", { schema: ${N_SCHEMA} });\n` +
        `  return r.n + 100;\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toBe(101);
  });

  test("a malformed envelope triggers exactly one repair turn", async () => {
    const dir = await workflowTmpDir();
    let attempts = 0;
    const control = makeFakeControl({
      reply: () => {
        attempts += 1;
        return attempts === 1
          ? "no envelope at all"
          : `<workflow_result>{"n": 7}</workflow_result>`;
      },
    });
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader()}` +
        `export default async function run({ agent }) {\n` +
        `  return await agent("count", { schema: ${N_SCHEMA} });\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toEqual({ n: 7 });
    expect(attempts).toBe(2);
    expect(control.messages().some((m) => m.includes("did not validate"))).toBe(true);
  });

  test("a persistently invalid result fails the call", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ reply: () => "still no envelope" });
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader()}` +
        `export default async function run({ agent }) {\n` +
        `  return await agent("count", { schema: ${N_SCHEMA}, onError: "null" });\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toBeNull();
  });
});

describe("runWorkflow: failure semantics", () => {
  test("an errored child rejects rather than resolving to its last text", async () => {
    // StatusBus treats `errored` as terminal, so wait() returns timedOut:false for
    // a crashed child. Surfacing its text as a result would look like success.
    const dir = await workflowTmpDir();
    const control = makeFakeControl({
      state: () => "errored",
      reply: () => "a plausible-looking partial answer",
    });
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader()}` +
        `export default async function run({ agent }) {\n` +
        `  try { return { got: await agent("go") }; }\n` +
        `  catch (error) { return { caught: String(error.message) }; }\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toMatchObject({ caught: expect.stringContaining("errored") });
  });

  test('onError defaults to "fail" so a failure propagates to the script', async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ state: () => "errored" });
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader()}` +
        `export default async function run({ agent }) { return await agent("go"); }`,
    }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(outcome).toContain("errored");
  });

  test("an unknown phase is rejected against meta.phases", async () => {
    const dir = await workflowTmpDir();
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script:
        `${metaHeader("m", ["declared"])}` +
        `export default async function run({ agent }) {\n` +
        `  try { return await agent("go", { phase: "undeclared" }); }\n` +
        `  catch (error) { return String(error.message); }\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(String(outcome.summary.result)).toContain("undeclared");
  });

  test("phase() rejects titles outside meta.phases", async () => {
    const dir = await workflowTmpDir();
    await expect(
      runWorkflow({
        ctx: makeWorkflowCtx(dir),
        control: makeFakeControl(),
        script:
          `${metaHeader("phase-check", ["declared"])}` +
          `export default async function run({ phase }) { phase("undeclared"); return "no"; }`,
      }),
    ).rejects.toThrow(/unknown phase "undeclared"/);
  });

  test("cancelling the turn aborts the run", async () => {
    const dir = await workflowTmpDir();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 250);
    const message = await runWorkflow({
      ctx: makeWorkflowCtx(dir, { abortSignal: abort.signal }),
      control: makeFakeControl(),
      script: `${metaHeader()}export default async function run() { while (true) {} }`,
    }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toContain("cancelled");
  });
});

describe("runWorkflow: compile failures are values, not throws", () => {
  test("a missing default export reports a structured issue", async () => {
    const dir = await workflowTmpDir();
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script: metaHeader(),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.path)).toContain("exports.default");
  });

  test("a missing meta export reports a structured issue", async () => {
    const dir = await workflowTmpDir();
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script: `export default async function run() { return 1; }`,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.path)).toContain("exports.meta");
  });

  test("an invalid meta literal is rejected before any agent runs", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    const message = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `export const meta = { name: "x" };\n` +
        `export default async function run({ agent }) { return await agent("go"); }`,
    }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toContain("meta is invalid");
    expect(control.spawnCount()).toBe(0);
  });

  test("expected workflow name is validated during the worker metadata handshake", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    const message = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      expectedName: "expected-name",
      script:
        `${metaHeader("different-name")}` +
        `export default async function run({ agent }) { return await agent("go"); }`,
    }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toContain(
      'workflow filename/name mismatch: expected meta.name "expected-name", found "different-name"',
    );
    expect(control.spawnCount()).toBe(0);
  });
});

describe("runWorkflow: live progress", () => {
  test("streams phases and agent state transitions, ending with an outcome", async () => {
    const dir = await workflowTmpDir();
    const updates: Array<{
      currentPhase: string | null;
      states: string[];
      outcome?: string;
    }> = [];

    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      onProgress: (progress) =>
        updates.push({
          currentPhase: progress.currentPhase,
          states: progress.agents.map((agent) => agent.state),
          ...(progress.outcome ? { outcome: progress.outcome } : {}),
        }),
      script:
        `${metaHeader("streamed", ["one", "two"])}` +
        `export default async function run({ agent, phase, log }) {\n` +
        `  phase("one");\n` +
        `  await agent("a", { label: "first" });\n` +
        `  phase("two");\n` +
        `  await agent("b", { label: "second" });\n` +
        `  log("finished");\n` +
        `  return "ok";\n}`,
    });

    expect(outcome.ok).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((u) => u.currentPhase === "one")).toBe(true);
    expect(updates.some((u) => u.currentPhase === "two")).toBe(true);
    // Every agent passes through queued -> running -> completed.
    expect(updates.some((u) => u.states.includes("queued"))).toBe(true);
    expect(updates.some((u) => u.states.includes("running"))).toBe(true);
    // Exactly one terminal emission, and it is last.
    const terminal = updates.filter((u) => u.outcome !== undefined);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.outcome).toBe("completed");
    expect(updates.at(-1)?.outcome).toBe("completed");
    expect(updates.at(-1)?.states).toEqual(["completed", "completed"]);
  });

  test("marks replayed calls as cached and reports zero spend", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("cachehit", ["one"])}` +
      `export default async function run({ agent }) { return await agent("only", { label: "L" }); }`;

    const first = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let final: { states: string[]; spentUsd: number } | null = null;
    await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script,
      resumeFromRunId: first.summary.runId,
      onProgress: (progress) => {
        if (progress.outcome) {
          final = { states: progress.agents.map((a) => a.state), spentUsd: progress.spentUsd };
        }
      },
    });

    expect(final).not.toBeNull();
    expect(final?.states).toEqual(["cached"]);
    expect(final?.spentUsd).toBe(0);
  });

  test("reports a cancelled run as cancelled, not errored", async () => {
    const dir = await workflowTmpDir();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 250);
    let outcome: string | undefined;

    await runWorkflow({
      ctx: makeWorkflowCtx(dir, { abortSignal: abort.signal }),
      control: makeFakeControl(),
      script: `${metaHeader()}export default async function run() { while (true) {} }`,
      onProgress: (progress) => {
        if (progress.outcome) outcome = progress.outcome;
      },
    }).catch(() => {});

    expect(outcome).toBe("cancelled");
  });
});

describe("runWorkflow: dry run", () => {
  test("reports the call graph without spawning anything", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    let progressUpdates = 0;
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      dryRun: true,
      onProgress: () => {
        progressUpdates += 1;
      },
      script:
        `${metaHeader()}` +
        `export default async function run({ agent, parallel }) {\n` +
        `  await parallel([1, 2, 3, 4].map((n) => () => agent("task " + n)));\n` +
        `  return "done";\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.agentCount).toBe(4);
    expect(outcome.summary.spentUsd).toBe(0);
    expect(control.spawnCount()).toBe(0);
    expect(progressUpdates).toBe(0);
  });
});

describe("runWorkflow: settlement", () => {
  test.each([
    { signals: ["done", "error", "cancel"], outcome: "errored", error: "worker failed" },
    { signals: ["done", "cancel", "error"], outcome: "cancelled", error: "workflow cancelled" },
    { signals: ["error", "cancel", "done"], outcome: "errored", error: "worker failed" },
    { signals: ["cancel", "error", "done"], outcome: "cancelled", error: "workflow cancelled" },
    { signals: ["crash", "cancel"], outcome: "errored", error: "worker crashed" },
    { signals: ["invalid", "cancel"], outcome: "errored", error: "invalid message" },
    { signals: ["phase", "cancel"], outcome: "errored", error: "unknown phase" },
  ])("keeps the terminal winner for $signals", async ({ signals, outcome, error }) => {
    const dir = await workflowTmpDir();
    const abort = new AbortController();
    const terminal: WorkflowProgressPayload[] = [];
    const originalWorker = globalThis.Worker;
    let terminations = 0;
    class ControlledWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      postMessage(message: { t: string }) {
        if (message.t !== "start") return;
        for (const signal of signals) {
          if (signal === "cancel") abort.abort();
          else if (signal === "crash") this.onerror?.({ message: "worker crashed" } as ErrorEvent);
          else {
            this.onmessage?.({
              data:
                signal === "error"
                  ? { t: "error", message: "worker failed" }
                  : signal === "phase"
                    ? { t: "phase", title: "unknown" }
                    : { t: signal, result: "done" },
            } as MessageEvent);
          }
        }
      }

      terminate() {
        terminations += 1;
      }
    }
    globalThis.Worker = ControlledWorker as unknown as typeof Worker;
    try {
      await expect(
        runWorkflow({
          ctx: makeWorkflowCtx(dir, { abortSignal: abort.signal }),
          control: makeFakeControl(),
          script: `${metaHeader()}export default async function run() { return "done"; }`,
          onProgress: (progress) => {
            if (progress.outcome) terminal.push(progress);
          },
        }),
      ).rejects.toThrow(error);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ outcome, error: expect.stringContaining(error) });
      expect(terminations).toBe(1);
    } finally {
      globalThis.Worker = originalWorker;
    }
  });

  test("completion remains the winner when its final snapshot triggers cancellation", async () => {
    const dir = await workflowTmpDir();
    const abort = new AbortController();
    const terminal: WorkflowProgressPayload[] = [];
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir, { abortSignal: abort.signal }),
      control: makeFakeControl(),
      script: `${metaHeader()}export default async function run() { return "done"; }`,
      onProgress: (progress) => {
        if (!progress.outcome) return;
        terminal.push(progress);
        abort.abort();
      },
    });
    expect(outcome.ok).toBe(true);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.outcome).toBe("completed");
  });

  test("a fatal child drains active siblings and final spend without awaiting itself", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ costUsd: 0.25 });
    const originalWait = control.wait.bind(control);
    const originalClose = control.close.bind(control);
    const closeStarted: string[] = [];
    const terminal: WorkflowProgressPayload[] = [];
    const costs: number[] = [];
    const closing = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    control.wait = async (options) => {
      if (options.agentIds[0] === "agent-2") return await new Promise<never>(() => {});
      if (options.agentIds[0] === "agent-3") {
        await closing.promise;
        throw Object.assign(new Error("source task is locked"), {
          code: "task_locked",
          source: "session",
        });
      }
      return await originalWait(options);
    };
    control.close = async (options) => {
      closeStarted.push(options.agentId);
      if (options.agentId === "agent-1") {
        closing.resolve();
        await releaseClose.promise;
      }
      const result = await originalClose(options);
      if (options.agentId === "agent-1") closed.resolve();
      return result;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = runWorkflow({
        ctx: makeWorkflowCtx(dir, {
          costTracker: { recordUnattributedCost: (cost: number) => costs.push(cost) } as never,
        }),
        control,
        runTimeoutMs: 1_000,
        script: `${metaHeader()}export default async function run({ agent, parallel }) {
          return await parallel([
            () => agent("completed with spend"),
            () => agent("still running"),
            () => agent("fatal", { onError: "null" }),
          ]);
        }`,
        onProgress: (progress) => {
          if (progress.outcome) terminal.push(progress);
        },
      });
      await expect(
        Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("fatal finalization stalled")), 2_000);
          }),
        ]),
      ).rejects.toThrow("source task is locked");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ outcome: "errored", spentUsd: 0.25 });
      expect(terminal[0]?.agents.map((agent) => agent.state)).toEqual([
        "errored",
        "errored",
        "errored",
      ]);
      expect(terminal[0]?.agents[0]?.usdCost).toBe(0.25);
      expect(costs).toEqual([0.25]);
      expect(closeStarted.toSorted()).toEqual(["agent-1", "agent-2", "agent-3"]);
      expect(control.closed()).not.toContain("agent-1");
      releaseClose.resolve();
      await closed.promise;
      expect(control.closed().toSorted()).toEqual(["agent-1", "agent-2", "agent-3"]);
    } finally {
      clearTimeout(timer);
      releaseClose.resolve();
    }
  });

  test("awaits fire-and-forget agent() calls before completing", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({
      reply: () => "ok",
    });
    // Slow wait: each child takes ~50ms so a premature done would finish before
    // all spawns are recorded.
    const originalWait = control.wait.bind(control);
    control.wait = async (args) => {
      await Bun.sleep(40);
      return originalWait(args);
    };

    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader("fanout", ["main"])}` +
        `export default async function run({ agent }) {\n` +
        `  for (let i = 0; i < 12; i++) void agent("task " + i);\n` +
        `  return "early";\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toBe("early");
    expect(outcome.summary.agentCount).toBe(12);
    expect(control.spawnCount()).toBe(12);
    expect(control.closed()).toHaveLength(12);
  });

  test("drains chained fire-and-forget agent() calls before completing", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ reply: () => "ok" });
    const originalWait = control.wait.bind(control);
    control.wait = async (args) => {
      await Bun.sleep(20);
      return originalWait(args);
    };

    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader("chain", ["main"])}` +
        `export default async function run({ agent }) {\n` +
        `  void agent("first").then(() => agent("second"));\n` +
        `  return "early";\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.agentCount).toBe(2);
    expect(control.spawnCount()).toBe(2);
    expect(control.closed()).toHaveLength(2);
  });

  test("cancellation interrupts an outstanding AgentControl wait promptly", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    control.wait = async () => await new Promise<never>(() => {});
    const abort = new AbortController();
    const terminal: WorkflowProgressPayload[] = [];
    const pending = runWorkflow({
      ctx: makeWorkflowCtx(dir, { abortSignal: abort.signal }),
      control,
      script:
        `${metaHeader("cancel", ["main"])}` +
        `export default async function run({ agent }) { return await agent("slow"); }`,
      onProgress: (progress) => {
        if (progress.outcome) terminal.push(progress);
      },
    });
    await Promise.race([
      (async () => {
        while (control.spawnCount() === 0) await Bun.sleep(1);
      })(),
      Bun.sleep(1_000).then(() => {
        throw new Error("workflow agent did not spawn");
      }),
    ]);
    const startedAt = performance.now();
    abort.abort();

    await expect(pending).rejects.toThrow(/cancelled/);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(control.closed()).toHaveLength(1);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ outcome: "cancelled", error: "workflow cancelled" });
    expect(terminal[0]?.agents[0]).toMatchObject({ state: "running", agentId: "agent-1" });
    expect(terminal[0]?.agents[0]?.error).toBeUndefined();
  });

  test("cancellation interrupts an outstanding AgentControl spawn promptly", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    let markSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      markSpawnStarted = resolve;
    });
    control.spawn = async () => {
      markSpawnStarted();
      return await new Promise<never>(() => {});
    };
    const abort = new AbortController();
    const pending = runWorkflow({
      ctx: makeWorkflowCtx(dir, { abortSignal: abort.signal }),
      control,
      script:
        `${metaHeader("cancel-spawn", ["main"])}` +
        `export default async function run({ agent }) { return await agent("slow spawn"); }`,
    });

    await spawnStarted;
    const startedAt = performance.now();
    abort.abort();

    await expect(pending).rejects.toThrow(/cancelled/);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test("observes cancellation that occurs while the run is registering its listener", async () => {
    const dir = await workflowTmpDir();
    let abortedReads = 0;
    const abortSignal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads > 1;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal;

    await expect(
      runWorkflow({
        ctx: makeWorkflowCtx(dir, { abortSignal }),
        control: makeFakeControl(),
        script: `${metaHeader()}export default async function run() { return "too late"; }`,
      }),
    ).rejects.toThrow(/cancelled/);
  });

  test("treats a spawn-time parent task lock as fatal despite onError null", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    control.spawn = async () => {
      throw Object.assign(new Error("source task is locked"), {
        code: "task_locked" as const,
        source: "session" as const,
      });
    };

    await expect(
      runWorkflow({
        ctx: makeWorkflowCtx(dir),
        control,
        script:
          `${metaHeader()}` +
          `export default async function run({ agent }) { return await agent("blocked", { onError: "null" }); }`,
      }),
    ).rejects.toThrow(/source task is locked/);
  });

  test("feeds oversized prompts to agents through format-preserving files", async () => {
    const dir = await workflowTmpDir();
    let finalProgress:
      | {
          outcome?: string;
          agents: Array<{ label: string; state: string }>;
        }
      | undefined;
    const control = makeFakeControl();
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader()}` +
        `export default async function run({ agent }) { return await agent(JSON.stringify({ payload: "x".repeat(${WORKFLOW_INLINE_PROMPT_CHARS + 1}) }), { label: "synthesis", phase: "main", inputFormat: "json" }); }`,
      onProgress: (progress) => {
        if (progress.outcome) finalProgress = progress;
      },
    });

    expect(outcome.ok).toBe(true);
    const transportMessage = control.messages()[0] ?? "";
    expect(transportMessage.length).toBeLessThanOrEqual(WORKFLOW_INLINE_PROMPT_CHARS);
    const targetPath = /^Input file: (.+)$/m.exec(transportMessage)?.[1]?.trim();
    expect(targetPath).toEndWith(".json");
    const savedPrompt = await fs.readFile(path.resolve(dir, targetPath as string), "utf8");
    expect(JSON.parse(savedPrompt)).toEqual({
      payload: "x".repeat(WORKFLOW_INLINE_PROMPT_CHARS + 1),
    });
    expect(finalProgress?.outcome).toBe("completed");
    expect(finalProgress?.agents).toEqual([
      expect.objectContaining({ label: "synthesis", state: "completed" }),
    ]);
  });

  test("persists an over-limit agent call as an errored row with a run diagnostic", async () => {
    const dir = await workflowTmpDir();
    let finalProgress:
      | {
          outcome?: string;
          error?: string;
          agents: Array<{ label: string; state: string; error?: string }>;
        }
      | undefined;

    await expect(
      runWorkflow({
        ctx: makeWorkflowCtx(dir),
        control: makeFakeControl(),
        script:
          `${metaHeader()}` +
          `export default async function run({ agent }) { return await agent("x".repeat(${WORKFLOW_MAX_PROMPT_CHARS + 1}), { label: "synthesis", phase: "main" }); }`,
        onProgress: (progress) => {
          if (progress.outcome) finalProgress = progress;
        },
      }),
    ).rejects.toThrow(
      new RegExp(`expected string to have <=${WORKFLOW_MAX_PROMPT_CHARS} characters`),
    );

    expect(finalProgress?.outcome).toBe("errored");
    expect(finalProgress?.error).toContain(
      `expected string to have <=${WORKFLOW_MAX_PROMPT_CHARS} characters`,
    );
    expect(finalProgress?.agents).toEqual([
      expect.objectContaining({
        label: "synthesis",
        state: "errored",
        error: expect.stringContaining(
          `expected string to have <=${WORKFLOW_MAX_PROMPT_CHARS} characters`,
        ),
      }),
    ]);
  });

  test("the whole-run timeout interrupts outstanding agents before their per-agent timeout", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    control.wait = async () => await new Promise<never>(() => {});
    const startedAt = performance.now();
    let finalOutcome: string | undefined;

    await expect(
      runWorkflow({
        ctx: makeWorkflowCtx(dir),
        control,
        runTimeoutMs: 250,
        script:
          `${metaHeader("timeout", ["main"])}` +
          `export default async function run({ agent }) { return await agent("slow", { timeoutMs: 60000 }); }`,
        onProgress: (progress) => {
          if (progress.outcome) finalOutcome = progress.outcome;
        },
      }),
    ).rejects.toThrow(/exceeded 250ms/);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(control.spawnCount()).toBe(1);
    expect(control.closed()).toHaveLength(1);
    expect(finalOutcome).toBe("errored");
  });

  test("surfaces oversized script errors instead of waiting for the run timeout", async () => {
    const dir = await workflowTmpDir();
    const startedAt = performance.now();
    const message = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      runTimeoutMs: 500,
      script:
        `${metaHeader("large-error", ["main"])}` +
        `export default async function run() { throw new Error("x".repeat(5001)); }`,
    }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toHaveLength(4_000);
    expect(message).not.toContain("exceeded");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("rejects non-JSON-serializable args before spawning a worker", async () => {
    const dir = await workflowTmpDir();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script: `${metaHeader()}export default async function run() { return 1; }`,
      args: circular,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.path).toBe("args");
  });

  test("throws immediately when the abort signal is already aborted", async () => {
    const dir = await workflowTmpDir();
    const abort = new AbortController();
    abort.abort();
    await expect(
      runWorkflow({
        ctx: makeWorkflowCtx(dir, { abortSignal: abort.signal }),
        control: makeFakeControl(),
        script: `${metaHeader()}export default async function run() { return 1; }`,
      }),
    ).rejects.toThrow(/cancelled/);
  });
});

describe("runWorkflow: budget admission", () => {
  function budgetTracker(stopAtUsd: number, currentCostUsd: number) {
    return {
      getBudgetStatus: () => ({
        configured: true,
        warnAtUsd: null,
        stopAtUsd,
        warningTriggered: false,
        stopTriggered: currentCostUsd >= stopAtUsd,
        currentCostUsd,
      }),
    };
  }

  test("serializes capped fan-out and stops admitting agents after crossing the threshold", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ costUsd: 0.75 });
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir, { costTracker: budgetTracker(1, 0) as never }),
      control,
      script:
        `${metaHeader("budget", ["main"])}` +
        `export default async function run({ parallel, agent }) {\n` +
        `  return await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(control.spawnCount()).toBe(2);
    expect(outcome.summary.spentUsd).toBe(1.5);
    expect(outcome.summary.erroredCount).toBe(1);
  });

  test("subtracts existing session spend from the workflow budget", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ costUsd: 0.2 });
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir, { costTracker: budgetTracker(1, 0.9) as never }),
      control,
      script:
        `${metaHeader("baseline", ["main"])}` +
        `export default async function run({ agent }) {\n` +
        `  const first = await agent("a", { onError: "null" });\n` +
        `  const second = await agent("b", { onError: "null" });\n` +
        `  return [first, second];\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(control.spawnCount()).toBe(1);
    expect(outcome.summary.result).toEqual(["reply 1", null]);
    expect(outcome.summary.spentUsd).toBe(0.2);
  });

  test("records workflow spend on the session tracker for later runs", async () => {
    const dir = await workflowTmpDir();
    const tracker = new SessionCostTracker("session-1", { stopAtUsd: 1 });
    const first = await runWorkflow({
      ctx: makeWorkflowCtx(dir, { costTracker: tracker }),
      control: makeFakeControl({ costUsd: 1.1 }),
      script:
        `${metaHeader("first-budget", ["main"])}` +
        `export default async function run({ agent }) { return await agent("first"); }`,
    });
    expect(first.ok).toBe(true);
    expect(tracker.getBudgetStatus()).toMatchObject({
      currentCostUsd: 1.1,
      stopTriggered: true,
    });

    const secondControl = makeFakeControl();
    const second = await runWorkflow({
      ctx: makeWorkflowCtx(dir, { costTracker: tracker }),
      control: secondControl,
      script:
        `${metaHeader("second-budget", ["main"])}` +
        `export default async function run({ agent }) { return await agent("second", { onError: "null" }); }`,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.summary.result).toBeNull();
    expect(secondControl.spawnCount()).toBe(0);
  });

  test("honors concurrent session spend before admitting the next child", async () => {
    const dir = await workflowTmpDir();
    const tracker = new SessionCostTracker("shared-budget-session", { stopAtUsd: 1 });
    const control = makeFakeControl({
      costUsd: 0.2,
      reply: (nth) => {
        if (nth === 1) tracker.recordUnattributedCost(0.9);
        return `reply ${nth}`;
      },
    });
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir, { costTracker: tracker }),
      control,
      script:
        `${metaHeader("live-session-budget", ["main"])}` +
        `export default async function run({ agent }) {\n` +
        `  const first = await agent("first");\n` +
        `  const second = await agent("second", { onError: "null" });\n` +
        `  return [first, second];\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(control.spawnCount()).toBe(1);
    expect(outcome.summary.result).toEqual(["reply 1", null]);
    expect(tracker.getBudgetStatus().currentCostUsd).toBe(1.1);
  });

  test("does not cache a budget-blocked nullable call across resume", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("budget-resume", ["main"])}` +
      `export default async function run({ agent }) {\n` +
      `  const first = await agent("first");\n` +
      `  const second = await agent("second", { onError: "null" });\n` +
      `  return [first, second];\n}`;
    const first = await runWorkflow({
      ctx: makeWorkflowCtx(dir, { costTracker: budgetTracker(1, 0.9) as never }),
      control: makeFakeControl({ costUsd: 0.2 }),
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.summary.result).toEqual(["reply 1", null]);

    const resumedControl = makeFakeControl({ reply: () => "fresh" });
    const resumed = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: resumedControl,
      script,
      resumeFromRunId: first.summary.runId,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.result).toEqual(["reply 1", "fresh"]);
    expect(resumed.summary.cachedCount).toBe(1);
    expect(resumedControl.spawnCount()).toBe(1);
  });
});

describe("runWorkflow: total agent admission limit", () => {
  const maxAgentCalls = 1_000;

  test("allows a dry run to reach the cap without exceeding it", async () => {
    const dir = await workflowTmpDir();
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      dryRun: true,
      script:
        `${metaHeader("at-agent-limit", ["main"])}` +
        `export default async function run({ agent, parallel }) {\n` +
        `  return (await parallel(Array.from({ length: ${maxAgentCalls} }, () => () => agent("work")))).length;\n}`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.agentCount).toBe(maxAgentCalls);
    expect(outcome.summary.result).toBe(maxAgentCalls);
    expect(outcome.summary.erroredCount).toBe(0);
  });

  test("a parallel fan-out cannot swallow the fatal agent ceiling", async () => {
    const dir = await workflowTmpDir();
    await expect(
      runWorkflow({
        ctx: makeWorkflowCtx(dir),
        control: makeFakeControl(),
        dryRun: true,
        script:
          `${metaHeader("parallel-agent-limit", ["main"])}` +
          `export default async function run({ agent, parallel }) {\n` +
          `  await parallel(Array.from({ length: ${maxAgentCalls + 5} }, () => () => agent("work", { onError: "null" })));\n` +
          `  return "swallowed failure";\n}`,
      }),
    ).rejects.toThrow("1000-agent ceiling");
  });

  test("catch-and-retry cannot retain extra rows or logs after the agent ceiling", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    let maxRetainedAgents = 0;
    let terminalOutcome: string | undefined;
    const logs: string[] = [];

    await expect(
      runWorkflow({
        ctx: makeWorkflowCtx(dir),
        control,
        script:
          `${metaHeader("retry-agent-limit", ["main"])}` +
          `export default async function run({ agent, phase, log }) {\n` +
          `  for (let index = 0; index < ${maxAgentCalls + 5}; index += 1) {\n` +
          `    try { await agent(""); } catch {}\n` +
          `    if (index >= ${maxAgentCalls}) { phase("main"); log("after ceiling"); }\n` +
          `  }\n` +
          `  return "swallowed failure";\n}`,
        onProgress: (progress) => {
          maxRetainedAgents = Math.max(maxRetainedAgents, progress.agents.length);
          if (progress.outcome) {
            terminalOutcome = progress.outcome;
            logs.push(...progress.logs);
          }
        },
      }),
    ).rejects.toThrow("1000-agent ceiling");

    expect(control.spawnCount()).toBe(0);
    expect(maxRetainedAgents).toBeLessThanOrEqual(maxAgentCalls);
    expect(terminalOutcome).toBe("errored");
    expect(logs).toEqual([]);
  });
});
