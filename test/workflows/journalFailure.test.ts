import { describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import path from "node:path";

import { runWorkflow } from "../../src/workflows/WorkflowRunner";
import {
  type FakeControl,
  makeFakeControl,
  makeWorkflowCtx,
  metaHeader,
  workflowTmpDir,
} from "./harness";

async function runWithUnavailableJournal(opts: {
  directory: string;
  control: FakeControl;
  script: string;
  resumeFromRunId?: string;
  breakWhen: (agents: Array<{ state: string; agentId: string | null }>) => boolean;
}) {
  const logs: string[] = [];
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  let moved = false;

  try {
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(opts.directory, { log: (line) => logs.push(line) }),
      control: opts.control,
      script: opts.script,
      runTimeoutMs: 150,
      ...(opts.resumeFromRunId ? { resumeFromRunId: opts.resumeFromRunId } : {}),
      onProgress: ({ runId, agents }) => {
        if (moved || !opts.breakWhen(agents)) return;
        moved = true;
        const runDirectory = path.join(opts.directory, "workflows", "runs", runId);
        renameSync(runDirectory, `${runDirectory}-unavailable`);
      },
    });
    await Bun.sleep(0);
    return { outcome, logs, unhandled, moved };
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("workflow journal checkpoint failures", () => {
  test("continues a cached replay and reports a persistence warning", async () => {
    const directory = await workflowTmpDir();
    const script =
      `${metaHeader("cached-journal-error", ["main"])}` +
      `export default async function run({ agent }) { return await agent("cached"); }`;
    const initial = await runWorkflow({
      ctx: makeWorkflowCtx(directory),
      control: makeFakeControl({ reply: () => "cached-value" }),
      script,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    const { outcome, logs, unhandled, moved } = await runWithUnavailableJournal({
      directory,
      control: makeFakeControl(),
      script,
      resumeFromRunId: initial.summary.runId,
      breakWhen: (agents) => agents.some((agent) => agent.state === "cached"),
    });

    expect(moved).toBe(true);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toBe("cached-value");
    expect(logs.some((line) => line.includes("journal checkpoint failed"))).toBe(true);
    expect(unhandled).toEqual([]);
  });

  test("preserves a completed live child when its checkpoint cannot be written", async () => {
    const directory = await workflowTmpDir();
    const control = makeFakeControl({ reply: () => "live-value" });
    const { outcome, logs, unhandled, moved } = await runWithUnavailableJournal({
      directory,
      control,
      script:
        `${metaHeader("live-journal-error", ["main"])}` +
        `export default async function run({ agent }) { return await agent("live"); }`,
      breakWhen: (agents) => agents.some((agent) => agent.state === "completed"),
    });

    expect(moved).toBe(true);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toBe("live-value");
    expect(outcome.summary.erroredCount).toBe(0);
    expect(control.closed()).toEqual(["agent-1"]);
    expect(logs.some((line) => line.includes("journal checkpoint failed"))).toBe(true);
    expect(unhandled).toEqual([]);
  });

  test("preserves a nullable failed child when its checkpoint cannot be written", async () => {
    const directory = await workflowTmpDir();
    const control = makeFakeControl({ state: () => "errored" });
    const { outcome, logs, unhandled, moved } = await runWithUnavailableJournal({
      directory,
      control,
      script:
        `${metaHeader("null-journal-error", ["main"])}` +
        `export default async function run({ agent }) {\n` +
        `  return await agent("nullable", { onError: "null" });\n}`,
      breakWhen: (agents) =>
        agents.some((agent) => agent.state === "errored" && agent.agentId !== null),
    });

    expect(moved).toBe(true);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.result).toBeNull();
    expect(outcome.summary.erroredCount).toBe(1);
    expect(control.closed()).toEqual(["agent-1"]);
    expect(logs.some((line) => line.includes("journal checkpoint failed"))).toBe(true);
    expect(unhandled).toEqual([]);
  });
});
