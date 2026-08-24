import { describe, expect, test } from "bun:test";

import { runWorkflowAgent } from "../../src/workflows/hostAgent";
import { makeFakeControl, makeWorkflowCtx, workflowTmpDir } from "./harness";

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
});
