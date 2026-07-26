import { describe, expect, test } from "bun:test";

import { StatusBus } from "../../src/server/agents/StatusBus";
import type { PersistentAgentSummary } from "../../src/shared/agents";

function summary(
  agentId: string,
  executionState: PersistentAgentSummary["executionState"],
): PersistentAgentSummary {
  return {
    agentId,
    parentSessionId: "root",
    role: "default",
    mode: "collaborative",
    depth: 1,
    effectiveModel: "test-model",
    provider: "openai",
    title: agentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lifecycleState: "active",
    executionState,
    busy: false,
  } as PersistentAgentSummary;
}

describe("StatusBus.wait reports failures separately from readiness", () => {
  test("a crashed child is ready AND errored", async () => {
    // Regression for an observed production failure: a fan-out of four children
    // each blew the model's context window, and `waitForAgent` reported
    // timedOut:false with all four "ready". The parent then read their partial
    // transcripts as if they were answers.
    const bus = new StatusBus();
    bus.publish(summary("a", "errored"));

    const result = await bus.wait(["a"], 0, "all");

    expect(result.timedOut).toBe(false);
    expect(result.readyAgentIds).toEqual(["a"]);
    expect(result.erroredAgentIds).toEqual(["a"]);
  });

  test("separates the survivors from the casualties in a mixed fan-out", async () => {
    const bus = new StatusBus();
    bus.publish(summary("ok-1", "completed"));
    bus.publish(summary("dead-1", "errored"));
    bus.publish(summary("ok-2", "completed"));
    bus.publish(summary("dead-2", "errored"));

    const result = await bus.wait(["ok-1", "dead-1", "ok-2", "dead-2"], 0, "all");

    expect(result.readyAgentIds).toHaveLength(4);
    expect(result.erroredAgentIds.sort()).toEqual(["dead-1", "dead-2"]);
    const survivors = result.readyAgentIds.filter((id) => !result.erroredAgentIds.includes(id));
    expect(survivors.sort()).toEqual(["ok-1", "ok-2"]);
  });

  test("a clean run reports no errors", async () => {
    const bus = new StatusBus();
    bus.publish(summary("a", "completed"));
    bus.publish(summary("b", "completed"));

    const result = await bus.wait(["a", "b"], 0, "all");

    expect(result.readyAgentIds).toHaveLength(2);
    expect(result.erroredAgentIds).toEqual([]);
  });

  test("a closed child counts as ready but not as errored", async () => {
    // `closed` is a lifecycle outcome, not a failure — the parent chose to end it.
    const bus = new StatusBus();
    bus.publish(summary("a", "closed"));

    const result = await bus.wait(["a"], 0, "all");

    expect(result.readyAgentIds).toEqual(["a"]);
    expect(result.erroredAgentIds).toEqual([]);
  });

  test("an empty request reports both lists empty", async () => {
    const result = await new StatusBus().wait([], 0, "all");
    expect(result.readyAgentIds).toEqual([]);
    expect(result.erroredAgentIds).toEqual([]);
  });
});
