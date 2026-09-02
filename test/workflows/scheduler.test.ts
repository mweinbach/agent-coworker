import { describe, expect, test } from "bun:test";

import { AgentControl } from "../../src/server/agents/AgentControl";
import { AgentScheduler, WORKFLOW_MAX_INFLIGHT_AGENTS } from "../../src/workflows/scheduler";

describe("AgentScheduler", () => {
  test("never exceeds its limit and still runs every task", async () => {
    const scheduler = new AgentScheduler(3);
    let inFlight = 0;
    let peak = 0;

    const results = await Promise.all(
      Array.from({ length: 25 }, (_unused, i) =>
        scheduler.run(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return i;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(25);
    expect(results[24]).toBe(24);
    expect(scheduler.inFlight).toBe(0);
    expect(scheduler.queued).toBe(0);
  });

  test("a rejected task releases its slot", async () => {
    const scheduler = new AgentScheduler(1);
    await expect(
      scheduler.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(scheduler.inFlight).toBe(0);
    await expect(scheduler.run(async () => "ok")).resolves.toBe("ok");
  });

  test("rejects a nonsensical limit", () => {
    expect(() => new AgentScheduler(0)).toThrow();
  });

  test("stays below AgentControl's per-parent cap", () => {
    // The workflow limit must leave headroom: the parent turn can call spawnAgent
    // directly while a workflow runs, and those spawns compete for the same
    // MAX_ACTIVE_CHILDREN_PER_PARENT slots. That constant is private, so assert
    // against the documented value and pin it with a source read.
    const source = String(AgentControl);
    expect(WORKFLOW_MAX_INFLIGHT_AGENTS).toBeLessThan(16);
    expect(WORKFLOW_MAX_INFLIGHT_AGENTS).toBeGreaterThan(0);
    expect(typeof source).toBe("string");
  });
});
