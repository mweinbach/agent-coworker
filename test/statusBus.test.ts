import { describe, expect, test } from "bun:test";
import { StatusBus } from "../src/server/agents/StatusBus";
import type { PersistentAgentSummary } from "../src/shared/agents";

function makeSummary(
  agentId: string,
  overrides: Partial<PersistentAgentSummary> = {},
): PersistentAgentSummary {
  return {
    agentId,
    parentSessionId: "root-1",
    role: "worker",
    mode: "collaborative",
    depth: 1,
    effectiveModel: "gpt-5.4-mini",
    provider: "openai",
    title: agentId,
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    lifecycleState: "active",
    executionState: "running",
    busy: true,
    ...overrides,
  };
}

describe("StatusBus.wait", () => {
  test("any mode resolves on the first terminal child and returns the latest status for every requested id", async () => {
    const bus = new StatusBus();
    const runningChild = makeSummary("child-1");
    const completedChild = makeSummary("child-2", {
      updatedAt: "2026-04-13T00:00:05.000Z",
      executionState: "completed",
      busy: false,
      lastMessagePreview: "done",
    });

    bus.publish(runningChild);
    bus.publish(makeSummary("child-2"));

    const waitPromise = bus.wait(["child-1", "child-2"], 250, "any");
    setTimeout(() => {
      bus.publish(completedChild);
    }, 10);

    await expect(waitPromise).resolves.toEqual({
      timedOut: false,
      mode: "any",
      agents: [runningChild, completedChild],
      readyAgentIds: ["child-2"],
    });
  });

  test("all mode waits for every requested child to become terminal", async () => {
    const bus = new StatusBus();
    const completedChild1 = makeSummary("child-1", {
      updatedAt: "2026-04-13T00:00:03.000Z",
      executionState: "completed",
      busy: false,
    });
    const erroredChild2 = makeSummary("child-2", {
      updatedAt: "2026-04-13T00:00:04.000Z",
      executionState: "errored",
      busy: false,
      lastMessagePreview: "failed",
    });

    bus.publish(makeSummary("child-1"));
    bus.publish(makeSummary("child-2"));

    const waitPromise = bus.wait(["child-1", "child-2"], 250, "all");
    setTimeout(() => {
      bus.publish(completedChild1);
    }, 10);
    setTimeout(() => {
      bus.publish(erroredChild2);
    }, 20);

    await expect(waitPromise).resolves.toEqual({
      timedOut: false,
      mode: "all",
      agents: [completedChild1, erroredChild2],
      readyAgentIds: ["child-1", "child-2"],
    });
  });

  test("timeouts still return the latest status snapshot and terminal subset", async () => {
    const bus = new StatusBus();
    const completedChild = makeSummary("child-1", {
      updatedAt: "2026-04-13T00:00:03.000Z",
      executionState: "completed",
      busy: false,
    });
    const runningChild = makeSummary("child-2", {
      updatedAt: "2026-04-13T00:00:04.000Z",
    });

    bus.publish(completedChild);
    bus.publish(runningChild);

    const startedAt = performance.now();
    const result = await bus.wait(["child-1", "child-2"], 25, "all");
    const elapsedMs = performance.now() - startedAt;

    expect(result).toEqual({
      timedOut: true,
      mode: "all",
      agents: [completedChild, runningChild],
      readyAgentIds: ["child-1"],
    });
    expect(elapsedMs).toBeLessThan(500);
  });

  test("zero-timeout polls respect the requested mode", async () => {
    const bus = new StatusBus();
    const completedChild = makeSummary("child-1", {
      executionState: "completed",
      busy: false,
    });
    const runningChild = makeSummary("child-2");

    bus.publish(completedChild);
    bus.publish(runningChild);

    await expect(bus.wait(["child-1", "child-2"], 0, "any")).resolves.toEqual({
      timedOut: false,
      mode: "any",
      agents: [completedChild, runningChild],
      readyAgentIds: ["child-1"],
    });

    await expect(bus.wait(["child-1", "child-2"], 0, "all")).resolves.toEqual({
      timedOut: true,
      mode: "all",
      agents: [completedChild, runningChild],
      readyAgentIds: ["child-1"],
    });
  });
});
