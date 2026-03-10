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

  test("invalidates aggregate cost availability after an uncatalogued turn", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        promptTokens: 1000,
        completionTokens: 100,
        totalTokens: 1100,
      },
    });
    tracker.recordTurn({
      turnId: "turn-2",
      provider: "openai",
      model: "uncatalogued-model",
      usage: {
        promptTokens: 500,
        completionTokens: 50,
        totalTokens: 550,
      },
    });

    expect(tracker.getSnapshot()).toMatchObject({
      estimatedTotalCostUsd: null,
      costTrackingAvailable: false,
      budgetStatus: {
        currentCostUsd: null,
      },
    });
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

  test("updateBudget rejects merged thresholds where warning would exceed the hard stop", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.updateBudget({ warnAtUsd: 2, stopAtUsd: 5 });

    expect(() => tracker.updateBudget({ warnAtUsd: 6 })).toThrow(
      "Warning threshold must be less than the hard-stop threshold.",
    );
    expect(tracker.getBudgetStatus()).toMatchObject({
      warnAtUsd: 2,
      stopAtUsd: 5,
    });
  });

  test("emits budget alert events when thresholds are crossed", () => {
    const tracker = new SessionCostTracker("session-1");
    const alerts: Array<{ type: string; currentCostUsd: number; thresholdUsd: number }> = [];

    tracker.addListener((event) => {
      if (event.type === "budget_warning" || event.type === "budget_exceeded") {
        alerts.push({
          type: event.type,
          currentCostUsd: event.currentCostUsd,
          thresholdUsd: event.thresholdUsd,
        });
      }
    });

    tracker.setBudget({ warnAtUsd: 1, stopAtUsd: 2 });
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

    expect(alerts).toEqual([
      { type: "budget_warning", currentCostUsd: 17.5, thresholdUsd: 1 },
      { type: "budget_exceeded", currentCostUsd: 17.5, thresholdUsd: 2 },
    ]);
  });

  test("getSnapshot returns decoupled copies of mutable state", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        promptTokens: 1000,
        completionTokens: 250,
        totalTokens: 1250,
      },
    });

    const snapshot = tracker.getSnapshot();
    snapshot.byModel[0]!.turns = 99;
    snapshot.turns[0]!.model = "mutated";
    snapshot.turns[0]!.usage.totalTokens = 999_999;

    const freshSnapshot = tracker.getSnapshot();
    expect(freshSnapshot.byModel[0]).toMatchObject({
      model: "gpt-5.4",
      turns: 1,
      totalTokens: 1250,
    });
    expect(freshSnapshot.turns[0]).toMatchObject({
      model: "gpt-5.4",
      usage: {
        promptTokens: 1000,
        completionTokens: 250,
        totalTokens: 1250,
      },
    });
  });

  test("getCompactSnapshot keeps totals while truncating turn history", () => {
    const tracker = new SessionCostTracker("session-1");

    for (let i = 0; i < 10; i += 1) {
      tracker.recordTurn({
        turnId: `turn-${i + 1}`,
        provider: "openai",
        model: "gpt-5.4",
        usage: {
          promptTokens: 100 + i,
          completionTokens: 25,
          totalTokens: 125 + i,
        },
      });
    }

    const compact = tracker.getCompactSnapshot();

    expect(compact.totalTurns).toBe(10);
    expect(compact.turns).toHaveLength(8);
    expect(compact.turns[0]?.turnId).toBe("turn-3");
    expect(compact.turns.at(-1)?.turnId).toBe("turn-10");
  });

  test("formatSummary avoids Infinity or NaN for zero-dollar thresholds", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        promptTokens: 1000,
        completionTokens: 100,
        totalTokens: 1100,
      },
    });
    tracker.setBudget({ stopAtUsd: 0 });

    const summary = tracker.formatSummary();

    expect(summary).toContain("Hard cap:  $0.00");
    expect(summary).not.toContain("Infinity%");
    expect(summary).not.toContain("NaN%");
  });
});
