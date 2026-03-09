import { describe, expect, test } from "bun:test";

import { SessionCostTracker } from "../src/session/costTracker";

describe("SessionCostTracker", () => {
  test("clears stop-triggered state when hard-stop threshold is removed", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        totalTokens: 2_000_000,
      },
    });

    tracker.setBudget({ stopAtUsd: 0.001 });
    expect(tracker.isBudgetExceeded()).toBe(true);

    tracker.setBudget({ warnAtUsd: 20 });

    expect(tracker.isBudgetExceeded()).toBe(false);
    expect(tracker.getBudgetStatus()).toMatchObject({
      configured: true,
      warnAtUsd: 20,
      stopAtUsd: null,
      warningTriggered: false,
      stopTriggered: false,
    });
  });

  test("formats recent turn times deterministically in UTC", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        totalTokens: 2_000_000,
      },
    });

    (tracker as any).turns[0].timestamp = "2026-03-09T01:02:03.000Z";

    expect(tracker.formatRecentTurns(1)).toContain("[01:02:03Z]");
  });
});