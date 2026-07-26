import { describe, expect, test } from "bun:test";

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
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
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
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      dryRun: true,
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
  });
});
