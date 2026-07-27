import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  assertSafeWorkflowRunId,
  digestAgentCall,
  workflowRunDir,
} from "../../src/workflows/journal";
import { runWorkflow } from "../../src/workflows/WorkflowRunner";
import { makeFakeControl, makeWorkflowCtx, metaHeader, workflowTmpDir } from "./harness";

const SCRIPT = (tag: string) =>
  `${metaHeader("resume", ["a"])}` +
  `export default async function run({ agent }) {\n` +
  `  const one = await agent("first ${tag}");\n` +
  `  const two = await agent("second ${tag}");\n` +
  `  const three = await agent("third ${tag}");\n` +
  `  return [one, two, three];\n}`;

describe("digestAgentCall", () => {
  test("is stable across key order and absent options", () => {
    const a = digestAgentCall({
      argsHash: "h",
      prompt: "p",
      opts: { label: "x", onError: "fail" },
    });
    const b = digestAgentCall({
      argsHash: "h",
      prompt: "p",
      opts: { onError: "fail", label: "x" },
    });
    expect(a).toBe(b);
  });

  test("ignores undefined-valued keys rather than failing to hash", () => {
    // `digestToolInput`'s canonical hasher returns null for ANY nested undefined,
    // which would make resume silently never cache. Dropping them is the
    // behaviour resume needs.
    const withUndefined = digestAgentCall({
      argsHash: "h",
      prompt: "p",
      opts: { label: "x", model: undefined, phase: undefined },
    });
    const without = digestAgentCall({ argsHash: "h", prompt: "p", opts: { label: "x" } });
    expect(withUndefined).toBe(without);
  });

  test("changes with prompt, options and args", () => {
    const base = { argsHash: "h", prompt: "p", opts: {} };
    expect(digestAgentCall({ ...base, prompt: "q" })).not.toBe(digestAgentCall(base));
    expect(digestAgentCall({ ...base, argsHash: "other" })).not.toBe(digestAgentCall(base));
    expect(digestAgentCall({ ...base, opts: { effort: "high" } })).not.toBe(digestAgentCall(base));
  });

  test("does not depend on call order", () => {
    // pipeline() has no barrier between stages, so the order calls reach the host
    // shifts with agent timings. An order-sensitive key would match nothing on a
    // rerun whose timings differed.
    const first = digestAgentCall({ argsHash: "h", prompt: "same", opts: { label: "l" } });
    const second = digestAgentCall({ argsHash: "h", prompt: "same", opts: { label: "l" } });
    expect(first).toBe(second);
  });
});

describe("resume", () => {
  test("an unchanged script replays entirely from cache", async () => {
    const dir = await workflowTmpDir();
    const first = makeFakeControl({ reply: (nth) => `value-${nth}` });
    const one = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: first,
      script: SCRIPT("v1"),
    });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(first.spawnCount()).toBe(3);

    const second = makeFakeControl({ reply: (nth) => `DIFFERENT-${nth}` });
    const two = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: second,
      script: SCRIPT("v1"),
      resumeFromRunId: one.summary.runId,
    });

    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(second.spawnCount()).toBe(0);
    expect(two.summary.cachedCount).toBe(3);
    // Cached values win, proving the replay is real and not a re-run.
    expect(two.summary.result).toEqual(["value-1", "value-2", "value-3"]);
    expect(two.summary.resumedFromRunId).toBe(one.summary.runId);
  });

  test("an edited script re-runs only the calls that actually changed", async () => {
    const dir = await workflowTmpDir();
    const first = makeFakeControl({ reply: (nth) => `old-${nth}` });
    const one = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: first,
      script: SCRIPT("v1"),
    });
    expect(one.ok).toBe(true);
    if (!one.ok) return;

    // Change only the SECOND call's prompt. Calls 1 and 3 are byte-for-byte the
    // same requests, so they replay; only call 2 costs anything. If call 3 had
    // genuinely depended on call 2's output, its prompt would have changed too and
    // it would re-run — which is what makes content-addressing sound.
    const edited =
      `${metaHeader("resume", ["a"])}` +
      `export default async function run({ agent }) {\n` +
      `  const one = await agent("first v1");\n` +
      `  const two = await agent("second CHANGED");\n` +
      `  const three = await agent("third v1");\n` +
      `  return [one, two, three];\n}`;

    const second = makeFakeControl({ reply: () => "fresh" });
    const two = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: second,
      script: edited,
      resumeFromRunId: one.summary.runId,
    });

    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(two.summary.cachedCount).toBe(2);
    expect(second.spawnCount()).toBe(1);
    expect(two.summary.result).toEqual(["old-1", "fresh", "old-3"]);
  });

  test("a repeated identical call consumes one cached result each", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("dupes", ["a"])}` +
      `export default async function run({ agent }) {\n` +
      `  return [await agent("same"), await agent("same")];\n}`;

    const first = makeFakeControl({ reply: (nth) => `run1-${nth}` });
    const one = await runWorkflow({ ctx: makeWorkflowCtx(dir), control: first, script });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.summary.result).toEqual(["run1-1", "run1-2"]);

    const second = makeFakeControl({ reply: () => "should-not-appear" });
    const two = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: second,
      script,
      resumeFromRunId: one.summary.runId,
    });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    // Both replay, and the second call gets the SECOND recorded result — not a
    // duplicate of the first.
    expect(two.summary.result).toEqual(["run1-1", "run1-2"]);
    expect(second.spawnCount()).toBe(0);
  });

  test("resuming from an unknown run id runs everything live", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script: SCRIPT("v1"),
      resumeFromRunId: "wf_does_not_exist",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.cachedCount).toBe(0);
    expect(control.spawnCount()).toBe(3);
  });

  test("rejects path-traversal resume ids before touching the filesystem", () => {
    expect(() => assertSafeWorkflowRunId("../../../attacker")).toThrow(/invalid workflow run id/);
    expect(() => assertSafeWorkflowRunId("wf_../escape")).toThrow(/invalid workflow run id/);
    expect(() => workflowRunDir("/tmp/cowork", "../../../attacker")).toThrow();
  });

  test("dry-run results are not resumable", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("dry", ["a"])}` +
      `export default async function run({ agent }) {\n` +
      `  return await agent("only");\n}`;

    const dry = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script,
      dryRun: true,
    });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;

    // Even if a forged journal.jsonl appears under the dry-run id, the dry run
    // itself must not have written stub results. Resume from it must spawn live.
    const journalPath = path.join(dir, "workflows", "runs", dry.summary.runId, "journal.jsonl");
    await expect(fs.access(journalPath)).rejects.toThrow();

    const live = makeFakeControl({ reply: () => "live-value" });
    const resumed = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: live,
      script,
      resumeFromRunId: dry.summary.runId,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(live.spawnCount()).toBe(1);
    expect(resumed.summary.cachedCount).toBe(0);
    expect(resumed.summary.result).toBe("live-value");
  });

  test('onError:"null" results are journaled and replay without re-spawning', async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("nullable", ["main"])}` +
      `export default async function run({ agent }) {\n` +
      `  return await agent("may fail", { onError: "null" });\n}`;

    const first = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl({ state: () => "errored" }),
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.summary.result).toBeNull();

    const resumedControl = makeFakeControl({ reply: () => "should-not-run" });
    const resumed = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: resumedControl,
      script,
      resumeFromRunId: first.summary.runId,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.result).toBeNull();
    expect(resumed.summary.cachedCount).toBe(1);
    expect(resumedControl.spawnCount()).toBe(0);
  });
});
