import { describe, expect, test } from "bun:test";

import { deriveUsageCostBreakdown, type SessionUsageSnapshot } from "../src/session/costTracker";

function snapshotWithStoredTurnPricing(): SessionUsageSnapshot {
  return {
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
}

describe("deriveUsageCostBreakdown", () => {
  test("returns a copy of an authoritative snapshot breakdown", () => {
    const snapshot = snapshotWithStoredTurnPricing();
    snapshot.costBreakdown = {
      inputCostUsd: 1,
      cachedInputCostUsd: 2,
      cacheWriteInputCostUsd: 3,
      outputCostUsd: 4,
      otherCostUsd: 5,
    };
    const derived = deriveUsageCostBreakdown(snapshot);
    expect(derived).toEqual(snapshot.costBreakdown);
    expect(derived).not.toBe(snapshot.costBreakdown);
  });

  test("derives browser-safe spend buckets from stored turn pricing", () => {
    const snapshot = snapshotWithStoredTurnPricing();
    const globalRecord = globalThis as Record<string, unknown>;
    const originalProcess = globalRecord.process;

    globalRecord.process = undefined;
    try {
      const derived = deriveUsageCostBreakdown(snapshot);

      expect(derived?.inputCostUsd).toBeCloseTo(2.916549, 6);
      expect(derived?.cachedInputCostUsd).toBeCloseTo(0.2246799, 6);
      expect(derived?.outputCostUsd).toBeCloseTo(0.409617, 6);
      expect(derived?.otherCostUsd).toBeCloseTo(0, 6);
    } finally {
      globalRecord.process = originalProcess;
    }
  });

  test("reports spend without recorded pricing as unattributed", () => {
    const snapshot = snapshotWithStoredTurnPricing();
    snapshot.turns = [];

    expect(deriveUsageCostBreakdown(snapshot)).toEqual({
      inputCostUsd: 0,
      cachedInputCostUsd: 0,
      cacheWriteInputCostUsd: 0,
      outputCostUsd: 0,
      otherCostUsd: snapshot.estimatedTotalCostUsd as number,
    });
  });

  test("returns null when no cost is known", () => {
    const snapshot = snapshotWithStoredTurnPricing();
    snapshot.turns = [];
    snapshot.byModel = [];
    snapshot.estimatedTotalCostUsd = null;

    expect(deriveUsageCostBreakdown(snapshot)).toBeNull();
  });
});
