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

  test("restores tracker state from a persisted snapshot", () => {
    const original = new SessionCostTracker("session-1");
    original.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        promptTokens: 1000,
        completionTokens: 250,
        totalTokens: 1250,
      },
    });
    original.updateBudget({ warnAtUsd: 3, stopAtUsd: 5 });

    const restored = SessionCostTracker.fromSnapshot(original.getSnapshot());

    expect(restored.getSnapshot()).toEqual(original.getSnapshot());
  });

  test("uses cached prompt token pricing discounts when available", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        promptTokens: 1_000_000,
        cachedPromptTokens: 400_000,
        completionTokens: 500_000,
        totalTokens: 1_500_000,
      },
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeCloseTo(9.1, 6);
  });

  test("prefers runtime-provided estimated cost when present", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        promptTokens: 1000,
        completionTokens: 100,
        totalTokens: 1100,
        estimatedCostUsd: 1.23,
      },
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBe(1.23);
    expect(tracker.getSnapshot().turns[0]?.estimatedCostUsd).toBe(1.23);
  });

  test("updateBudget preserves unspecified thresholds and clears explicit nulls", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.updateBudget({ warnAtUsd: 2, stopAtUsd: 5 });
    tracker.updateBudget({ warnAtUsd: 3 });
    expect(tracker.getBudgetStatus()).toMatchObject({
      warnAtUsd: 3,
      stopAtUsd: 5,
    });

    tracker.updateBudget({ stopAtUsd: null });
    expect(tracker.getBudgetStatus()).toMatchObject({
      warnAtUsd: 3,
      stopAtUsd: null,
    });
  });
});
