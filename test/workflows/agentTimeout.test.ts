import { describe, expect, test } from "bun:test";

import { runWorkflowAgent } from "../../src/workflows/hostAgent";
import { runWorkflow } from "../../src/workflows/WorkflowRunner";
import { makeFakeControl, makeWorkflowCtx, metaHeader, workflowTmpDir } from "./harness";

const RESULT_SCHEMA = {
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
  additionalProperties: false,
};

describe("workflow agent end-to-end timeouts", () => {
  test("shares one deadline across the initial turn and its schema repair", async () => {
    const dir = await workflowTmpDir();
    let attempts = 0;
    const control = makeFakeControl({
      reply: () =>
        ++attempts === 1 ? "no structured result" : '<workflow_result>{"n":1}</workflow_result>',
    });
    const originalWait = control.wait.bind(control);
    control.wait = async (options) => {
      await Bun.sleep(40);
      return await originalWait(options);
    };

    await expect(
      runWorkflowAgent({
        ctx: makeWorkflowCtx(dir),
        control,
        prompt: "produce a structured result",
        options: { schema: RESULT_SCHEMA, timeoutMs: 60 },
        label: "slow-repair",
        onAgentId: () => {},
      }),
    ).rejects.toThrow(/timed out/);

    expect(control.closed()).toEqual(["agent-1"]);
  });

  test("times out a stalled spawn and closes a child that appears later", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl();
    const originalSpawn = control.spawn.bind(control);
    const originalClose = control.close.bind(control);
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let notifyClosed!: () => void;
    const childClosed = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });
    control.spawn = async (options) => {
      await spawnGate;
      return await originalSpawn(options);
    };
    control.close = async (options) => {
      const result = await originalClose(options);
      notifyClosed();
      return result;
    };
    const safeguard = new AbortController();
    const fallback = setTimeout(() => safeguard.abort(), 200);

    try {
      await expect(
        runWorkflowAgent({
          ctx: makeWorkflowCtx(dir),
          control,
          abortSignal: safeguard.signal,
          prompt: "spawn slowly",
          options: { timeoutMs: 30 },
          label: "slow-spawn",
          onAgentId: () => {},
        }),
      ).rejects.toThrow(/timed out/);
    } finally {
      clearTimeout(fallback);
      releaseSpawn();
    }

    await childClosed;
    expect(control.closed()).toEqual(["agent-1"]);
  });

  test("applies the same deadline while sending a schema-repair turn", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ reply: () => "no structured result" });
    control.sendInput = async () => await new Promise<never>(() => {});
    const safeguard = new AbortController();
    const fallback = setTimeout(() => safeguard.abort(), 200);

    try {
      await expect(
        runWorkflowAgent({
          ctx: makeWorkflowCtx(dir),
          control,
          abortSignal: safeguard.signal,
          prompt: "repair slowly",
          options: { schema: RESULT_SCHEMA, timeoutMs: 30 },
          label: "slow-repair-input",
          onAgentId: () => {},
        }),
      ).rejects.toThrow(/timed out/);
    } finally {
      clearTimeout(fallback);
    }

    expect(control.closed()).toEqual(["agent-1"]);
  });

  test("bounds a stalled advisory cost inspection without discarding the child result", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ reply: () => "completed-value" });
    control.inspect = async () => await new Promise<never>(() => {});
    const safeguard = new AbortController();
    const fallback = setTimeout(() => safeguard.abort(), 200);
    const startedAt = performance.now();

    try {
      const outcome = await runWorkflowAgent({
        ctx: makeWorkflowCtx(dir),
        control,
        abortSignal: safeguard.signal,
        prompt: "finish before accounting stalls",
        options: { timeoutMs: 30 },
        label: "slow-inspection",
        onAgentId: () => {},
      });

      expect(performance.now() - startedAt).toBeLessThan(120);
      expect(outcome.value).toBe("completed-value");
      expect(outcome.usdCost).toBeNull();
      expect(control.closed()).toEqual(["agent-1"]);
    } finally {
      clearTimeout(fallback);
    }
  });

  test("bounds a stalled cleanup callback while allowing its close to finish later", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ reply: () => "completed-value" });
    const originalClose = control.close.bind(control);
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let notifyClosed!: () => void;
    const childClosed = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });
    control.close = async (options) => {
      await closeGate;
      const closed = await originalClose(options);
      notifyClosed();
      return closed;
    };
    const fallback = setTimeout(releaseClose, 200);
    const startedAt = performance.now();

    try {
      const outcome = await runWorkflowAgent({
        ctx: makeWorkflowCtx(dir),
        control,
        closeAgent: async (agentId) => {
          await control.close({ agentId });
        },
        prompt: "finish before cleanup stalls",
        options: { timeoutMs: 30 },
        label: "slow-cleanup",
        onAgentId: () => {},
      });

      expect(performance.now() - startedAt).toBeLessThan(120);
      expect(outcome.value).toBe("completed-value");
      expect(control.closed()).toEqual([]);
      releaseClose();
      await childClosed;
      expect(control.closed()).toEqual(["agent-1"]);
    } finally {
      clearTimeout(fallback);
      releaseClose();
    }
  });

  test("completes a workflow while a timed-out child close continues in the background", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ reply: () => "completed-value" });
    const originalClose = control.close.bind(control);
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let notifyClosed!: () => void;
    const childClosed = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });
    control.close = async (options) => {
      await closeGate;
      const closed = await originalClose(options);
      notifyClosed();
      return closed;
    };
    const fallback = setTimeout(releaseClose, 1_400);
    const startedAt = performance.now();

    try {
      const outcome = await runWorkflow({
        ctx: makeWorkflowCtx(dir),
        control,
        runTimeoutMs: 1_800,
        script:
          `${metaHeader("bounded-run-cleanup", ["main"])}` +
          `export default async function run({ agent }) {\n` +
          `  return await agent("finished", { timeoutMs: 1000 });\n}`,
      });

      expect(performance.now() - startedAt).toBeLessThan(1_200);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.summary.result).toBe("completed-value");
      expect(control.closed()).toEqual([]);
      releaseClose();
      await childClosed;
      expect(control.closed()).toEqual(["agent-1"]);
    } finally {
      clearTimeout(fallback);
      releaseClose();
    }
  });

  test("observes cleanup rejections after terminal teardown stops waiting", async () => {
    const dir = await workflowTmpDir();
    const control = makeFakeControl({ reply: () => "completed-value" });
    let closeAttempts = 0;
    control.close = async () => {
      closeAttempts += 1;
      await Promise.resolve();
      throw new Error("child close failed");
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const outcome = await runWorkflow({
        ctx: makeWorkflowCtx(dir),
        control,
        script:
          `${metaHeader("rejected-run-cleanup", ["main"])}` +
          `export default async function run({ agent }) { return await agent("finished"); }`,
      });
      await Bun.sleep(0);

      expect(outcome.ok).toBe(true);
      expect(closeAttempts).toBeGreaterThan(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
