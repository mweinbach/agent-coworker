import { describe, expect, test } from "bun:test";

import { StatusBus } from "../src/server/agents/StatusBus";

describe("StatusBus.wait", () => {
  test("honors short requested timeouts", async () => {
    const bus = new StatusBus();
    const startedAt = performance.now();

    const result = await bus.wait(["child-1"], 25);
    const elapsedMs = performance.now() - startedAt;

    expect(result).toEqual({ timedOut: true, agents: [] });
    expect(elapsedMs).toBeLessThan(500);
  });

  test("returns immediately for a zero-timeout poll when no child has completed", async () => {
    const bus = new StatusBus();

    await expect(bus.wait(["child-1"], 0)).resolves.toEqual({
      timedOut: true,
      agents: [],
    });
  });
});
