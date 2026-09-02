import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  assertSafeWorkflowRunId,
  digestAgentCall,
  hashWorkflowArgs,
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

function makeRoutedWorkflowCtx(
  projectCoworkDir: string,
  config: Partial<ReturnType<typeof makeWorkflowCtx>["config"]>,
) {
  const context = makeWorkflowCtx(projectCoworkDir);
  return { ...context, config: { ...context.config, ...config } };
}

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

  test.each([
    { name: "provider", config: { provider: "anthropic" as const } },
    { name: "model", config: { model: "different-model" } },
    { name: "routing mode", config: { childModelRoutingMode: "same-provider" as const } },
    { name: "routing allowlist", config: { allowedChildModelRefs: ["google:gemini"] } },
  ])("re-executes inherited calls when the parent $name changes", async ({ config }) => {
    const dir = await workflowTmpDir();
    const initialConfig = {
      provider: "openai" as const,
      model: "shared-model",
      childModelRoutingMode: "cross-provider-allowlist" as const,
      allowedChildModelRefs: ["anthropic:claude"],
    };
    const script =
      `${metaHeader("inherited-identity", ["main"])}` +
      `export default async function run({ agent }) { return await agent("same prompt"); }`;
    const first = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, initialConfig),
      control: makeFakeControl({ reply: () => "original-model" }),
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const resumedControl = makeFakeControl({ reply: () => "changed-model" });
    const resumed = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, { ...initialConfig, ...config }),
      control: resumedControl,
      script,
      resumeFromRunId: first.summary.runId,
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.result).toBe("changed-model");
    expect(resumed.summary.cachedCount).toBe(0);
    expect(resumedControl.spawnCount()).toBe(1);
    expect(resumedControl.models()).toEqual([undefined]);
  });

  test("replays inherited calls when their effective routing identity is unchanged", async () => {
    const dir = await workflowTmpDir();
    const initialConfig = {
      provider: "openai" as const,
      model: "shared-model",
      childModelRoutingMode: "cross-provider-allowlist" as const,
      allowedChildModelRefs: ["anthropic:claude", "google:gemini"],
      preferredChildModel: "first-suggestion",
      preferredChildModelRef: "anthropic:claude",
    };
    const script =
      `${metaHeader("stable-identity", ["main"])}` +
      `export default async function run({ agent }) { return await agent("same prompt"); }`;
    const first = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, initialConfig),
      control: makeFakeControl({ reply: () => "cached-result" }),
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const resumedControl = makeFakeControl({ reply: () => "should-not-run" });
    const resumed = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, {
        ...initialConfig,
        allowedChildModelRefs: ["google:gemini", "anthropic:claude", "google:gemini"],
        preferredChildModel: "second-suggestion",
        preferredChildModelRef: "google:gemini",
        workflowMaxConcurrentAgents: 3,
      }),
      control: resumedControl,
      script,
      resumeFromRunId: first.summary.runId,
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.result).toBe("cached-result");
    expect(resumed.summary.cachedCount).toBe(1);
    expect(resumed.summary.spentUsd).toBe(0);
    expect(resumedControl.spawnCount()).toBe(0);
  });

  test("re-executes provider-unqualified explicit models when the parent provider changes", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("unqualified-explicit-identity", ["main"])}` +
      `export default async function run({ agent }) { return await agent("same prompt", { model: "fixed-model" }); }`;
    const first = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, { provider: "openai", model: "parent-model" }),
      control: makeFakeControl({ reply: () => "openai-result" }),
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const resumedControl = makeFakeControl({ reply: () => "anthropic-result" });
    const resumed = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, { provider: "anthropic", model: "parent-model" }),
      control: resumedControl,
      script,
      resumeFromRunId: first.summary.runId,
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.result).toBe("anthropic-result");
    expect(resumed.summary.cachedCount).toBe(0);
    expect(resumedControl.spawnCount()).toBe(1);
    expect(resumedControl.models()).toEqual(["fixed-model"]);
  });

  test("preserves provider-unqualified explicit-model cache hits when inherited routing changes", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("explicit-identity", ["main"])}` +
      `export default async function run({ agent }) { return await agent("same prompt", { model: "fixed-model" }); }`;
    const firstControl = makeFakeControl({ reply: () => "explicit-result" });
    const first = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, {
        provider: "openai",
        model: "first-parent-model",
        childModelRoutingMode: "same-provider",
      }),
      control: firstControl,
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(firstControl.models()).toEqual(["fixed-model"]);

    const resumedControl = makeFakeControl({ reply: () => "should-not-run" });
    const resumed = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, {
        provider: "openai",
        model: "second-parent-model",
        childModelRoutingMode: "cross-provider-allowlist",
        allowedChildModelRefs: ["anthropic:claude"],
      }),
      control: resumedControl,
      script,
      resumeFromRunId: first.summary.runId,
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.result).toBe("explicit-result");
    expect(resumed.summary.cachedCount).toBe(1);
    expect(resumedControl.spawnCount()).toBe(0);
  });

  test.each([
    {
      name: "same-provider routing",
      config: {
        childModelRoutingMode: "same-provider" as const,
        allowedChildModelRefs: ["openai:gpt-5.4"],
      },
      error: "cross-provider routing is disabled for this workspace",
    },
    {
      name: "allowlist removal",
      config: {
        childModelRoutingMode: "cross-provider-allowlist" as const,
        allowedChildModelRefs: ["openai:gpt-5.2"],
      },
      error: "the requested child target is not in this workspace allowlist",
    },
  ])(
    "does not replay provider-qualified cache hits denied by current $name",
    async ({ config, error }) => {
      const dir = await workflowTmpDir();
      const script =
        `${metaHeader("qualified-routing-denied", ["main"])}` +
        `export default async function run({ agent }) { return await agent("same prompt", { model: "openai:gpt-5.4" }); }`;
      const first = await runWorkflow({
        ctx: makeRoutedWorkflowCtx(dir, {
          provider: "google",
          model: "gemini-3-flash-preview",
          childModelRoutingMode: "cross-provider-allowlist",
          allowedChildModelRefs: ["openai:gpt-5.4"],
        }),
        control: makeFakeControl({ reply: () => "protected-openai-result" }),
        script,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const resumedControl = makeFakeControl();
      let attemptedModel: string | undefined;
      resumedControl.spawn = async (options) => {
        attemptedModel = options.model;
        throw new Error(
          `Requested child target openai:gpt-5.4 could not be used because ${error}.`,
        );
      };

      await expect(
        runWorkflow({
          ctx: makeRoutedWorkflowCtx(dir, {
            provider: "google",
            model: "gemini-3-flash-preview",
            ...config,
          }),
          control: resumedControl,
          script,
          resumeFromRunId: first.summary.runId,
        }),
      ).rejects.toThrow(error);
      expect(attemptedModel).toBe("openai:gpt-5.4");
      expect(resumedControl.spawnCount()).toBe(0);
    },
  );

  test("does not replay allowlisted cross-provider results after the provider disconnects", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("qualified-provider-disconnected", ["main"])}` +
      `export default async function run({ agent }) { return await agent("same prompt", { model: "openai:gpt-5.4" }); }`;
    const context = makeRoutedWorkflowCtx(dir, {
      provider: "google",
      model: "gemini-3-flash-preview",
      childModelRoutingMode: "cross-provider-allowlist",
      allowedChildModelRefs: ["openai:gpt-5.4"],
    });
    const first = await runWorkflow({
      ctx: context,
      control: makeFakeControl({ reply: () => "private-openai-result" }),
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const resumedControl = makeFakeControl();
    let attemptedModel: string | undefined;
    resumedControl.spawn = async (options) => {
      attemptedModel = options.model;
      throw new Error(
        "Requested child target openai:gpt-5.4 could not be used because the requested provider is not connected.",
      );
    };

    await expect(
      runWorkflow({
        ctx: context,
        control: resumedControl,
        script,
        resumeFromRunId: first.summary.runId,
      }),
    ).rejects.toThrow("the requested provider is not connected");
    expect(attemptedModel).toBe("openai:gpt-5.4");
    expect(resumedControl.spawnCount()).toBe(0);
  });

  test("preserves provider-qualified explicit-model cache hits for the same parent provider", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("qualified-same-provider", ["main"])}` +
      `export default async function run({ agent }) { return await agent("same prompt", { model: "openai:gpt-5.4" }); }`;
    const first = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, {
        provider: "openai",
        model: "gpt-5.4",
        childModelRoutingMode: "cross-provider-allowlist",
        allowedChildModelRefs: ["anthropic:claude"],
      }),
      control: makeFakeControl({ reply: () => "same-provider-result" }),
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const resumedControl = makeFakeControl({ reply: () => "should-not-run" });
    const resumed = await runWorkflow({
      ctx: makeRoutedWorkflowCtx(dir, {
        provider: "openai",
        model: "gpt-5.2",
        childModelRoutingMode: "same-provider",
      }),
      control: resumedControl,
      script,
      resumeFromRunId: first.summary.runId,
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.result).toBe("same-provider-result");
    expect(resumed.summary.cachedCount).toBe(1);
    expect(resumedControl.spawnCount()).toBe(0);
  });

  test.each([
    { name: "canonical target", model: "openai:gpt-5.4", allowedModel: "openai:gpt-5.4" },
    { name: "aliased target", model: "openai:gpt-5.1", allowedModel: "openai:gpt-5.4" },
    { name: "aliased allowlist entry", model: "openai:gpt-5.4", allowedModel: "openai:gpt-5.1" },
  ])(
    "re-executes explicitly allowed cross-provider targets for $name",
    async ({ model, allowedModel }) => {
      const dir = await workflowTmpDir();
      const script =
        `${metaHeader("qualified-explicit-identity", ["main"])}` +
        `export default async function run({ agent }) { return await agent("same prompt", { model: ${JSON.stringify(model)} }); }`;
      const firstControl = makeFakeControl({ reply: () => "qualified-result" });
      const first = await runWorkflow({
        ctx: makeRoutedWorkflowCtx(dir, {
          provider: "openai",
          model: "gpt-5.4",
          childModelRoutingMode: "same-provider",
        }),
        control: firstControl,
        script,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(firstControl.models()).toEqual([model]);

      const resumedControl = makeFakeControl({ reply: () => "fresh-authorized-result" });
      const resumed = await runWorkflow({
        ctx: makeRoutedWorkflowCtx(dir, {
          provider: "anthropic",
          model: "second-parent-model",
          childModelRoutingMode: "cross-provider-allowlist",
          allowedChildModelRefs: [allowedModel],
        }),
        control: resumedControl,
        script,
        resumeFromRunId: first.summary.runId,
      });

      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.summary.result).toBe("fresh-authorized-result");
      expect(resumed.summary.cachedCount).toBe(0);
      expect(resumedControl.spawnCount()).toBe(1);
      expect(resumedControl.models()).toEqual([model]);
    },
  );

  test("does not replay a malformed provider-qualified model reference", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("malformed-qualified-identity", ["main"])}` +
      `export default async function run({ agent }) { return await agent("same prompt", { model: "openai:" }); }`;
    const context = makeRoutedWorkflowCtx(dir, { provider: "openai", model: "gpt-5.4" });
    const first = await runWorkflow({
      ctx: context,
      control: makeFakeControl({ reply: () => "invalid-cached-result" }),
      script,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const resumedControl = makeFakeControl();
    let spawnAttempted = false;
    resumedControl.spawn = async () => {
      spawnAttempted = true;
      throw new Error('Unsupported child model "openai:". Expected provider:modelId.');
    };

    await expect(
      runWorkflow({
        ctx: context,
        control: resumedControl,
        script,
        resumeFromRunId: first.summary.runId,
      }),
    ).rejects.toThrow('Unsupported child model "openai:"');
    expect(spawnAttempted).toBe(true);
  });

  test.each([
    {
      name: "inherited",
      options: { onError: "fail" as const, timeoutMs: 600_000 },
      scriptOptions: "",
      expectedResult: "fresh-result",
      expectedCachedCount: 0,
      expectedSpawnCount: 1,
    },
    {
      name: "unqualified_explicit",
      options: { onError: "fail" as const, timeoutMs: 600_000, model: "fixed-model" },
      scriptOptions: ', { model: "fixed-model" }',
      expectedResult: "fresh-result",
      expectedCachedCount: 0,
      expectedSpawnCount: 1,
    },
    {
      name: "qualified_explicit",
      options: { onError: "fail" as const, timeoutMs: 600_000, model: "openai:fixed-model" },
      scriptOptions: ', { model: "openai:fixed-model" }',
      expectedResult: "legacy-result",
      expectedCachedCount: 1,
      expectedSpawnCount: 0,
    },
  ])(
    "handles durable legacy $name-model journal entries safely",
    async ({
      name,
      options,
      scriptOptions,
      expectedResult,
      expectedCachedCount,
      expectedSpawnCount,
    }) => {
      const dir = await workflowTmpDir();
      const runId = `wf_legacy_${name}`;
      const runDir = workflowRunDir(dir, runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, "journal.jsonl"),
        `${JSON.stringify({
          index: 0,
          digest: digestAgentCall({
            argsHash: hashWorkflowArgs(undefined),
            prompt: "same prompt",
            opts: options,
          }),
          phase: null,
          label: "agent-1",
          result: "legacy-result",
          agentId: "legacy-agent",
          usdCost: 0.01,
        })}\n`,
      );

      const control = makeFakeControl({ reply: () => "fresh-result" });
      const resumed = await runWorkflow({
        ctx: makeRoutedWorkflowCtx(dir, { provider: "openai", model: "parent-model" }),
        control,
        script:
          `${metaHeader("legacy-identity", ["main"])}` +
          `export default async function run({ agent }) { return await agent("same prompt"${scriptOptions}); }`,
        resumeFromRunId: runId,
      });

      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.summary.result).toBe(expectedResult);
      expect(resumed.summary.cachedCount).toBe(expectedCachedCount);
      expect(control.spawnCount()).toBe(expectedSpawnCount);
    },
  );

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

  test("parallel identical calls replay in their original call order", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("parallel-dupes", ["main"])}` +
      `export default async function run({ agent, parallel }) {\n` +
      `  return await parallel([() => agent("same"), () => agent("same")]);\n}`;
    let releaseFirst!: () => void;
    const firstIsBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = makeFakeControl({
      reply: async (nth) => {
        if (nth === 1) await firstIsBlocked;
        return `run1-${nth}`;
      },
    });

    const one = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: first,
      script,
      onProgress: ({ agents }) => {
        if (agents.some((agent) => agent.index === 1 && agent.state === "completed")) {
          releaseFirst();
        }
      },
    });
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
    expect(two.summary.result).toEqual(["run1-1", "run1-2"]);
    expect(second.spawnCount()).toBe(0);
  });

  test("persists completed agent checkpoints while the workflow is still running", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    const originalWait = control.wait.bind(control);
    let resolveSecondWait!: () => void;
    const secondWaitGate = new Promise<void>((resolve) => {
      resolveSecondWait = resolve;
    });
    let notifySecondWait!: () => void;
    const secondWaitStarted = new Promise<void>((resolve) => {
      notifySecondWait = resolve;
    });
    control.wait = async (options) => {
      if (options.agentIds[0] === "agent-2") {
        notifySecondWait();
        await secondWaitGate;
      }
      return await originalWait(options);
    };
    let runId = "";
    const pending = runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script:
        `${metaHeader("durable-checkpoints", ["main"])}` +
        `export default async function run({ agent }) {\n` +
        `  await agent("first");\n` +
        `  return await agent("second");\n}`,
      onProgress: (progress) => {
        runId = progress.runId;
      },
    });

    try {
      await secondWaitStarted;
      const journalPath = path.join(dir, "workflows", "runs", runId, "journal.jsonl");
      const entries = (await fs.readFile(journalPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { index: number; result: unknown });

      expect(entries).toEqual([expect.objectContaining({ index: 0, result: "reply 1" })]);
    } finally {
      resolveSecondWait();
      await pending.catch(() => {});
    }
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

    const runDirectory = path.join(dir, "workflows", "runs", dry.summary.runId);
    await expect(fs.access(runDirectory)).rejects.toThrow();

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

  test("ignores legacy dry-run journal entries during live resume", async () => {
    const dir = await workflowTmpDir();
    const script =
      `${metaHeader("legacy-dry", ["a"])}` +
      `export default async function run({ agent }) { return await agent("only"); }`;
    const argsHash = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const digest = digestAgentCall({ argsHash, prompt: "only", opts: {} });
    const legacyRunId = "wf_legacy_dry";
    const runDir = workflowRunDir(dir, legacyRunId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "journal.jsonl"),
      `${JSON.stringify({
        index: 0,
        digest,
        phase: null,
        label: "agent-1",
        result: "[dry-run] agent-1",
        agentId: "dry-0",
        usdCost: 0,
      })}\n`,
    );

    const control = makeFakeControl({ reply: () => "live" });
    const resumed = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control,
      script,
      resumeFromRunId: legacyRunId,
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.result).toBe("live");
    expect(resumed.summary.cachedCount).toBe(0);
    expect(control.spawnCount()).toBe(1);
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
