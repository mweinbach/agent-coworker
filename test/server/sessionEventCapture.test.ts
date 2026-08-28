import { describe, expect, test } from "bun:test";
import { createSessionEventCapture } from "../../src/server/jsonrpc/sessionEventCapture";
import type { SessionEvent } from "../../src/server/protocol";
import type { SessionBinding } from "../../src/server/startServer/types";

type UsageEvent = Extract<SessionEvent, { type: "session_usage" }>;

function isUsageEvent(event: SessionEvent): event is UsageEvent {
  return event.type === "session_usage";
}

function createHarness() {
  const sinks = new Map<string, (event: SessionEvent) => void>();
  const binding: SessionBinding = {
    session: null,
    runtime: null,
    socket: null,
    sinks: new Map(),
  };
  let nextId = 0;
  const events = createSessionEventCapture({
    addBindingSink(_binding, sinkId, sink) {
      sinks.set(sinkId, sink);
    },
    removeBindingSink(_binding, sinkId) {
      sinks.delete(sinkId);
    },
    createSinkId: () => `sink-${++nextId}`,
  });
  return { events, sinks, binding };
}

function usageEvent(sessionId = "session-1"): UsageEvent {
  return { type: "session_usage", sessionId, usage: null };
}

describe("createSessionEventCapture", () => {
  test("capture resolves the first matching event and removes the sink", async () => {
    const { events, sinks, binding } = createHarness();

    const result = events.capture(
      binding,
      () => {
        expect(sinks.size).toBe(1);
        sinks.get("sink-1")?.(usageEvent());
      },
      isUsageEvent,
      50,
    );

    await expect(result).resolves.toEqual(usageEvent());
    expect(sinks.size).toBe(0);
  });

  test("capture times out and removes the sink when nothing matches", async () => {
    const { events, sinks, binding } = createHarness();

    const result = events.capture(binding, () => {}, isUsageEvent, 20);
    await expect(result).rejects.toThrow("Timed out waiting for control event");
    expect(sinks.size).toBe(0);
  });

  test("capture rejects when the action throws and still removes the sink", async () => {
    const { events, sinks, binding } = createHarness();

    const result = events.capture(
      binding,
      async () => {
        throw new Error("mutation failed");
      },
      isUsageEvent,
      50,
    );

    await expect(result).rejects.toThrow("mutation failed");
    expect(sinks.size).toBe(0);
  });

  test("captureMutationOutcome settles null after the idle window when no event arrives", async () => {
    const { events, sinks, binding } = createHarness();

    const result = await events.captureMutationOutcome(binding, () => {}, isUsageEvent, 80, 15);
    expect(result).toBeNull();
    expect(sinks.size).toBe(0);
  });

  test("captureMutationOutcome resolves a matching event and ignores a later action error", async () => {
    const { events, sinks, binding } = createHarness();

    const result = events.captureMutationOutcome(
      binding,
      async () => {
        sinks.get("sink-1")?.(usageEvent("live"));
        throw new Error("late action failure");
      },
      isUsageEvent,
      80,
      15,
    );

    await expect(result).resolves.toEqual(usageEvent("live"));
    expect(sinks.size).toBe(0);
  });

  test("captureMutationEvents collects matches then settles after idle", async () => {
    const { events, sinks, binding } = createHarness();

    const result = await events.captureMutationEvents(
      binding,
      () => {
        sinks.get("sink-1")?.(usageEvent("one"));
        sinks.get("sink-1")?.({ type: "log", sessionId: "one", line: "ignore" });
        sinks.get("sink-1")?.(usageEvent("two"));
      },
      isUsageEvent,
      80,
      15,
    );

    expect(result).toEqual([usageEvent("one"), usageEvent("two")]);
    expect(sinks.size).toBe(0);
  });

  test("concurrent captures use separate sinks and do not cross-talk", async () => {
    const { events, sinks, binding } = createHarness();

    const first = events.capture(binding, () => {}, isUsageEvent, 80);
    const second = events.capture(binding, () => {}, isUsageEvent, 80);
    expect([...sinks.keys()]).toEqual(["sink-1", "sink-2"]);

    sinks.get("sink-2")?.(usageEvent("second"));
    sinks.get("sink-1")?.(usageEvent("first"));

    await expect(second).resolves.toEqual(usageEvent("second"));
    await expect(first).resolves.toEqual(usageEvent("first"));
    expect(sinks.size).toBe(0);
  });
});
