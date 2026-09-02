import { describe, expect, test } from "bun:test";

import {
  deriveUsageCostBreakdown,
  SessionCostTracker,
  type SessionUsageSnapshot,
} from "../src/session/costTracker";

function createLegacyTieredSnapshot(): SessionUsageSnapshot {
  const tracker = new SessionCostTracker("session-1");
  for (let index = 0; index < 2; index += 1) {
    tracker.recordTurn({
      turnId: `turn-${index + 1}`,
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        promptTokens: 150_000,
        completionTokens: 1_000,
        totalTokens: 151_000,
      },
    });
  }

  const snapshot = tracker.getSnapshot();
  delete snapshot.costBreakdown;
  for (const summary of snapshot.byModel) delete summary.costBreakdown;
  for (const entry of snapshot.turns) delete entry.costBreakdown;
  return snapshot;
}

describe("SessionCostTracker", () => {
  test("records unattributed workflow spend and emits a usage update", () => {
    const tracker = new SessionCostTracker("session-1", { stopAtUsd: 1 });
    const updates: number[] = [];
    tracker.addListener((event) => {
      if (event.type === "usage_changed") {
        updates.push(event.cumulative.estimatedTotalCostUsd ?? -1);
      }
    });

    tracker.recordUnattributedCost(1.25);

    expect(tracker.getSnapshot()).toMatchObject({
      estimatedTotalCostUsd: 1.25,
      costBreakdown: { otherCostUsd: 1.25 },
      budgetStatus: { stopTriggered: true, currentCostUsd: 1.25 },
    });
    expect(updates).toEqual([1.25]);
  });

  test("emits authoritative budget flags when unattributed spend crosses thresholds", () => {
    const tracker = new SessionCostTracker("session-1", { warnAtUsd: 0.5, stopAtUsd: 1 });
    const updates: SessionUsageSnapshot["budgetStatus"][] = [];
    const alerts: string[] = [];

    tracker.addListener((event) => {
      if (event.type === "usage_changed") {
        updates.push(event.cumulative.budgetStatus);
      } else if (event.type === "budget_warning" || event.type === "budget_exceeded") {
        alerts.push(event.type);
      }
    });

    tracker.recordUnattributedCost(1.25);
    tracker.recordUnattributedCost(0.25);

    expect(updates).toEqual([
      expect.objectContaining({
        warningTriggered: true,
        stopTriggered: true,
        currentCostUsd: 1.25,
      }),
      expect.objectContaining({
        warningTriggered: true,
        stopTriggered: true,
        currentCostUsd: 1.5,
      }),
    ]);
    expect(alerts).toEqual(["budget_warning", "budget_exceeded"]);
  });

  test("clears stop-triggered state when hard-stop threshold is removed", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.2",
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

  test("restores tracker state from a persisted snapshot", () => {
    const original = new SessionCostTracker("session-1");
    original.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.2",
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

  test("keeps lifetime cost unavailable after unpriced turns leave retained history", () => {
    const tracker = new SessionCostTracker("session-1");
    const usage = { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 };
    tracker.recordTurn({
      turnId: "unpriced",
      provider: "nvidia",
      model: "uncatalogued-model",
      usage,
    });
    for (let index = 0; index < 512; index += 1) {
      tracker.recordTurn({
        turnId: `priced-${index}`,
        provider: "openai",
        model: "gpt-5.2",
        usage,
      });
    }

    const snapshot = tracker.getSnapshot();
    expect(snapshot.turns).toHaveLength(512);
    expect(snapshot.turns.every((entry) => entry.estimatedCostUsd !== null)).toBe(true);

    const restored = SessionCostTracker.fromSnapshot(snapshot);
    restored.recordTurn({
      turnId: "after-restore",
      provider: "openai",
      model: "gpt-5.2",
      usage,
    });

    expect(restored.getSnapshot()).toMatchObject({
      totalTurns: 514,
      estimatedTotalCostUsd: null,
      costTrackingAvailable: false,
      budgetStatus: { currentCostUsd: null },
    });
    expect(restored.getSnapshot().costBreakdown).toBeUndefined();
  });

  test("starts cost tracking normally after restoring an empty session", () => {
    const tracker = new SessionCostTracker("session-1");
    const restored = SessionCostTracker.fromSnapshot(tracker.getSnapshot());
    restored.recordTurn({
      turnId: "first-turn",
      provider: "openai",
      model: "gpt-5.2",
      usage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
    });

    expect(restored.getSnapshot()).toMatchObject({
      estimatedTotalCostUsd: 0.00315,
      costTrackingAvailable: true,
    });
  });

  test("uses cached prompt token pricing discounts when available", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.2",
      usage: {
        promptTokens: 1_000_000,
        cachedPromptTokens: 400_000,
        completionTokens: 500_000,
        totalTokens: 1_500_000,
      },
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeCloseTo(8.12, 6);
  });

  test("uses GPT-5.5 long-context pricing for large app-server turns", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "codex-cli",
      model: "gpt-5.5",
      usage: {
        promptTokens: 300_000,
        cachedPromptTokens: 100_000,
        completionTokens: 100_000,
        totalTokens: 400_000,
      },
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeCloseTo(6.6, 6);
  });

  test("prices known requests before aggregating tiered turn usage", () => {
    const tracker = new SessionCostTracker("session-1", { stopAtUsd: 1 });
    const requestUsage = {
      promptTokens: 150_000,
      completionTokens: 1_000,
      totalTokens: 151_000,
    };
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      usage: { promptTokens: 300_000, completionTokens: 2_000, totalTokens: 302_000 },
      requestUsages: [requestUsage, requestUsage],
    });

    const snapshot = tracker.getSnapshot();
    expect(snapshot.estimatedTotalCostUsd).toBeCloseTo(0.624, 6);
    expect(snapshot.costBreakdown?.inputCostUsd).toBeCloseTo(0.6, 6);
    expect(snapshot.costBreakdown?.outputCostUsd).toBeCloseTo(0.024, 6);
    expect(snapshot).toMatchObject({ totalTurns: 1, totalTokens: 302_000 });
    expect(tracker.isBudgetExceeded()).toBe(false);
  });

  test("applies long-context pricing only to known requests above the threshold", () => {
    const tracker = new SessionCostTracker("session-1");
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      usage: { promptTokens: 400_000, completionTokens: 2_000, totalTokens: 402_000 },
      requestUsages: [
        { promptTokens: 150_000, completionTokens: 1_000, totalTokens: 151_000 },
        { promptTokens: 250_000, completionTokens: 1_000, totalTokens: 251_000 },
      ],
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeCloseTo(1.33, 6);
  });

  test("treats incomplete request token totals as opaque usage", () => {
    const tracker = new SessionCostTracker("session-1");
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      usage: { promptTokens: 300_000, completionTokens: 2_000, totalTokens: 302_000 },
      requestUsages: [{ promptTokens: 150_000, completionTokens: 1_000, totalTokens: 151_000 }],
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeNull();
  });

  test("treats mismatched request cache totals as opaque usage", () => {
    const tracker = new SessionCostTracker("session-1");
    const requestUsage = {
      promptTokens: 150_000,
      completionTokens: 1_000,
      totalTokens: 151_000,
      cachedPromptTokens: 50_000,
    };
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      usage: {
        promptTokens: 300_000,
        completionTokens: 2_000,
        totalTokens: 302_000,
        cachedPromptTokens: 200_000,
      },
      requestUsages: [requestUsage, requestUsage],
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeNull();
  });

  test("prices the full opaque aggregate when incomplete request metadata has linear pricing", () => {
    const tracker = new SessionCostTracker("session-1");
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.2",
      usage: { promptTokens: 2_000, completionTokens: 200, totalTokens: 2_200 },
      requestUsages: [{ promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 }],
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeCloseTo(0.0063, 6);
  });

  for (const [label, requestUsages] of [
    ["unknown", null],
    ["empty", []],
  ] as const) {
    test(`keeps opaque tiered cost unavailable with ${label} request boundaries`, () => {
      const tracker = new SessionCostTracker("session-1");
      tracker.recordTurn({
        turnId: "turn-1",
        provider: "google",
        model: "gemini-3.1-pro-preview",
        usage: {
          promptTokens: 300_000,
          completionTokens: 2_000,
          totalTokens: 302_000,
          estimatedCostUsd: 0.624,
        },
        requestUsages,
      });

      expect(tracker.getSnapshot()).toMatchObject({
        estimatedTotalCostUsd: null,
        costTrackingAvailable: false,
        totalTokens: 302_000,
      });
      expect(tracker.getSnapshot().costBreakdown).toBeUndefined();
    });
  }

  test("prices opaque usage when its total cannot cross a context tier", () => {
    const tracker = new SessionCostTracker("session-1");
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      usage: { promptTokens: 200_000, completionTokens: 1_000, totalTokens: 201_000 },
      requestUsages: null,
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeCloseTo(0.412, 6);
  });

  test("prices opaque usage additively for models without context tiers", () => {
    const tracker = new SessionCostTracker("session-1");
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.2",
      usage: { promptTokens: 300_000, completionTokens: 2_000, totalTokens: 302_000 },
      requestUsages: [],
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeCloseTo(0.553, 6);
  });

  test("sums runtime estimates across known uncatalogued requests", () => {
    const tracker = new SessionCostTracker("session-1");
    const usage = { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 };
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "nvidia",
      model: "uncatalogued-model",
      usage: { promptTokens: 2_000, completionTokens: 200, totalTokens: 2_200 },
      requestUsages: [
        { ...usage, estimatedCostUsd: 0.1 },
        { ...usage, estimatedCostUsd: 0.2 },
      ],
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeCloseTo(0.3, 6);
    expect(tracker.getSnapshot().costBreakdown?.otherCostUsd).toBeCloseTo(0.3, 6);
  });

  test("keeps cost unavailable when any known request is unpriced", () => {
    const tracker = new SessionCostTracker("session-1");
    const usage = { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 };
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "nvidia",
      model: "uncatalogued-model",
      usage: {
        promptTokens: 2_000,
        completionTokens: 200,
        totalTokens: 2_200,
        estimatedCostUsd: 0.1,
      },
      requestUsages: [{ ...usage, estimatedCostUsd: 0.1 }, usage],
    });

    expect(tracker.getSnapshot()).toMatchObject({
      estimatedTotalCostUsd: null,
      costTrackingAvailable: false,
    });
  });

  test("stores cached and reasoning token breakdowns without double-charging output", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        promptTokens: 1_000_000,
        cachedPromptTokens: 400_000,
        cacheWritePromptTokens: 100_000,
        completionTokens: 500_000,
        reasoningOutputTokens: 125_000,
        totalTokens: 1_500_000,
      },
    });

    const snapshot = tracker.getSnapshot();

    expect(snapshot.totalCachedPromptTokens).toBe(400_000);
    expect(snapshot.totalCacheWritePromptTokens).toBe(100_000);
    expect(snapshot.totalReasoningOutputTokens).toBe(125_000);
    expect(snapshot.byModel[0]?.totalCachedPromptTokens).toBe(400_000);
    expect(snapshot.byModel[0]?.totalCacheWritePromptTokens).toBe(100_000);
    expect(snapshot.byModel[0]?.totalReasoningOutputTokens).toBe(125_000);
    expect(snapshot.estimatedTotalCostUsd).toBeCloseTo(9.495, 6);
    expect(snapshot.costBreakdown?.inputCostUsd).toBeCloseTo(1.5, 6);
    expect(snapshot.costBreakdown?.cachedInputCostUsd).toBeCloseTo(0.12, 6);
    expect(snapshot.costBreakdown?.cacheWriteInputCostUsd).toBeCloseTo(0.375, 6);
    expect(snapshot.costBreakdown?.outputCostUsd).toBeCloseTo(7.5, 6);
    expect(snapshot.byModel[0]?.costBreakdown?.cachedInputCostUsd).toBeCloseTo(0.12, 6);
    expect(snapshot.turns[0]?.costBreakdown?.cacheWriteInputCostUsd).toBeCloseTo(0.375, 6);
  });

  test("derives missing spend buckets from legacy persisted usage snapshots", () => {
    const legacySnapshot: SessionUsageSnapshot = {
      sessionId: "session-1",
      totalTurns: 3,
      totalPromptTokens: 3_442_232,
      totalCompletionTokens: 45_513,
      totalTokens: 2_023_803,
      totalCachedPromptTokens: 1_497_866,
      totalReasoningOutputTokens: 33_924,
      estimatedTotalCostUsd: 3.5508459,
      costTrackingAvailable: true,
      byModel: [
        {
          provider: "google",
          model: "gemini-3.5-flash",
          turns: 3,
          totalPromptTokens: 3_442_232,
          totalCompletionTokens: 45_513,
          totalTokens: 2_023_803,
          totalCachedPromptTokens: 1_497_866,
          totalReasoningOutputTokens: 33_924,
          estimatedCostUsd: 3.5508459,
        },
      ],
      turns: [],
      budgetStatus: {
        configured: false,
        warnAtUsd: null,
        stopAtUsd: null,
        warningTriggered: false,
        stopTriggered: false,
        currentCostUsd: 3.5508459,
      },
      createdAt: "2026-05-29T12:31:40.910Z",
      updatedAt: "2026-05-29T13:00:26.616Z",
    };

    const derived = deriveUsageCostBreakdown(legacySnapshot);
    expect(derived?.inputCostUsd).toBeCloseTo(2.916549, 6);
    expect(derived?.cachedInputCostUsd).toBeCloseTo(0.2246799, 6);
    expect(derived?.outputCostUsd).toBeCloseTo(0.409617, 6);
    expect(derived?.otherCostUsd).toBeCloseTo(0, 6);

    const restored = SessionCostTracker.fromSnapshot(legacySnapshot).getSnapshot();
    expect(restored.costBreakdown?.inputCostUsd).toBeCloseTo(2.916549, 6);
    expect(restored.costBreakdown?.cachedInputCostUsd).toBeCloseTo(0.2246799, 6);
    expect(restored.costBreakdown?.outputCostUsd).toBeCloseTo(0.409617, 6);
    expect(restored.costBreakdown?.otherCostUsd).toBeCloseTo(0, 6);
  });

  test("derives legacy tiered spend from individual turns rather than model totals", () => {
    const snapshot = createLegacyTieredSnapshot();
    const restored = SessionCostTracker.fromSnapshot(snapshot).getSnapshot();

    expect(restored.estimatedTotalCostUsd).toBeCloseTo(1.56, 6);
    expect(restored.costBreakdown).toEqual({
      inputCostUsd: 1.5,
      cachedInputCostUsd: 0,
      cacheWriteInputCostUsd: 0,
      outputCostUsd: 0.06,
      otherCostUsd: 0,
    });
  });

  test("restores legacy spend buckets after compacting zero-token turns", () => {
    const tracker = new SessionCostTracker("legacy-compacted-session");
    for (let index = 0; index < 3; index += 1) {
      tracker.recordTurn({
        turnId: `turn-${index + 1}`,
        provider: "openai",
        model: "gpt-5.5",
        usage:
          index < 2
            ? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
            : { promptTokens: 150_000, completionTokens: 1_000, totalTokens: 151_000 },
      });
    }

    const snapshot = tracker.getCompactSnapshot(1);
    const expectedBreakdown = snapshot.costBreakdown;
    delete snapshot.costBreakdown;
    for (const summary of snapshot.byModel) delete summary.costBreakdown;
    for (const entry of snapshot.turns) delete entry.costBreakdown;

    expect(deriveUsageCostBreakdown(snapshot, { resolveMissingPricing: false })).toEqual(
      expectedBreakdown,
    );
    expect(SessionCostTracker.fromSnapshot(snapshot).getSnapshot().costBreakdown).toEqual(
      expectedBreakdown,
    );
  });

  test.each([0, 1])(
    "preserves legacy tiered spend as unattributed with only %i retained turns",
    (retainedTurns) => {
      const snapshot = createLegacyTieredSnapshot();
      snapshot.turns = snapshot.turns.slice(0, retainedTurns);

      expect(deriveUsageCostBreakdown(snapshot)).toEqual({
        inputCostUsd: 0,
        cachedInputCostUsd: 0,
        cacheWriteInputCostUsd: 0,
        outputCostUsd: 0,
        otherCostUsd: snapshot.estimatedTotalCostUsd,
      });
    },
  );

  test("derives browser-safe spend buckets from stored turn pricing", () => {
    const legacySnapshot: SessionUsageSnapshot = {
      sessionId: "session-1",
      totalTurns: 1,
      totalPromptTokens: 3_442_232,
      totalCompletionTokens: 45_513,
      totalTokens: 2_023_803,
      totalCachedPromptTokens: 1_497_866,
      totalReasoningOutputTokens: 33_924,
      estimatedTotalCostUsd: 3.5508459,
      costTrackingAvailable: true,
      byModel: [
        {
          provider: "google",
          model: "gemini-3.5-flash",
          turns: 1,
          totalPromptTokens: 3_442_232,
          totalCompletionTokens: 45_513,
          totalTokens: 2_023_803,
          totalCachedPromptTokens: 1_497_866,
          totalReasoningOutputTokens: 33_924,
          estimatedCostUsd: 3.5508459,
        },
      ],
      turns: [
        {
          turnId: "turn-1",
          turnIndex: 1,
          timestamp: "2026-05-29T13:00:26.616Z",
          provider: "google",
          model: "gemini-3.5-flash",
          usage: {
            promptTokens: 3_442_232,
            completionTokens: 45_513,
            cachedPromptTokens: 1_497_866,
            reasoningOutputTokens: 33_924,
            totalTokens: 2_023_803,
          },
          estimatedCostUsd: 3.5508459,
          pricing: {
            inputPerMillion: 1.5,
            cachedInputPerMillion: 0.15,
            outputPerMillion: 9,
          },
        },
      ],
      budgetStatus: {
        configured: false,
        warnAtUsd: null,
        stopAtUsd: null,
        warningTriggered: false,
        stopTriggered: false,
        currentCostUsd: 3.5508459,
      },
      createdAt: "2026-05-29T12:31:40.910Z",
      updatedAt: "2026-05-29T13:00:26.616Z",
    };
    const globalRecord = globalThis as Record<string, unknown>;
    const originalProcess = globalRecord.process;

    globalRecord.process = undefined;
    try {
      const derived = deriveUsageCostBreakdown(legacySnapshot, {
        resolveMissingPricing: false,
      });

      expect(derived?.inputCostUsd).toBeCloseTo(2.916549, 6);
      expect(derived?.cachedInputCostUsd).toBeCloseTo(0.2246799, 6);
      expect(derived?.outputCostUsd).toBeCloseTo(0.409617, 6);
      expect(derived?.otherCostUsd).toBeCloseTo(0, 6);
    } finally {
      globalRecord.process = originalProcess;
    }
  });

  test("uses catalog pricing before runtime-provided estimated cost when available", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.2",
      usage: {
        promptTokens: 1000,
        completionTokens: 100,
        totalTokens: 1100,
        estimatedCostUsd: 1.23,
      },
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBeCloseTo(0.00315, 6);
    expect(tracker.getSnapshot().turns[0]?.estimatedCostUsd).toBeCloseTo(0.00315, 6);
  });

  test("uses runtime-provided estimated cost when catalog pricing is unavailable", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "nvidia",
      model: "uncatalogued-model",
      usage: {
        promptTokens: 1000,
        completionTokens: 100,
        totalTokens: 1100,
        estimatedCostUsd: 1.23,
      },
    });

    expect(tracker.getSnapshot().estimatedTotalCostUsd).toBe(1.23);
    expect(tracker.getSnapshot().turns[0]?.estimatedCostUsd).toBe(1.23);
    expect(tracker.getSnapshot().costBreakdown?.otherCostUsd).toBe(1.23);
  });

  test("invalidates aggregate cost availability after an uncatalogued turn", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.2",
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
    expect(tracker.getSnapshot().costBreakdown).toBeUndefined();
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
      model: "gpt-5.2",
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        totalTokens: 2_000_000,
      },
    });

    expect(alerts).toEqual([
      { type: "budget_warning", currentCostUsd: 15.75, thresholdUsd: 1 },
      { type: "budget_exceeded", currentCostUsd: 15.75, thresholdUsd: 2 },
    ]);
  });

  test("getSnapshot returns decoupled copies of mutable state", () => {
    const tracker = new SessionCostTracker("session-1");

    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.2",
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
      model: "gpt-5.2",
      turns: 1,
      totalTokens: 1250,
    });
    expect(freshSnapshot.turns[0]).toMatchObject({
      model: "gpt-5.2",
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
        model: "gpt-5.2",
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

  test.each([0, -1, 0.5])("getCompactSnapshot omits turn history for a limit of %d", (limit) => {
    const tracker = new SessionCostTracker("session-1");
    tracker.recordTurn({
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.2",
      usage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
    });

    const snapshot = tracker.getCompactSnapshot(limit);
    expect(snapshot.turns).toEqual([]);
    expect(snapshot.totalTurns).toBe(1);
    expect(snapshot.totalTokens).toBe(1_100);
  });
});
