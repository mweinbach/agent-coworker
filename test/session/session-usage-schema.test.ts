import { describe, expect, test } from "bun:test";

import { sessionUsageSnapshotSchema, turnUsageSchema } from "../../src/session/sessionUsageSchema";

const iso = "2026-08-29T10:00:00.000Z";

function usage() {
  return {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
  };
}

function snapshot() {
  return {
    sessionId: "session-1",
    totalTurns: 1,
    totalPromptTokens: 10,
    totalCompletionTokens: 4,
    totalTokens: 14,
    estimatedTotalCostUsd: 0.01,
    costTrackingAvailable: true,
    byModel: [
      {
        provider: "openai" as const,
        model: "gpt-5.4",
        turns: 1,
        totalPromptTokens: 10,
        totalCompletionTokens: 4,
        totalTokens: 14,
        estimatedCostUsd: 0.01,
      },
    ],
    turns: [
      {
        turnId: "turn-1",
        turnIndex: 0,
        timestamp: iso,
        provider: "openai" as const,
        model: "gpt-5.4",
        usage: usage(),
        estimatedCostUsd: 0.01,
        pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      },
    ],
    budgetStatus: {
      configured: false,
      warnAtUsd: null,
      stopAtUsd: null,
      warningTriggered: false,
      stopTriggered: false,
      currentCostUsd: null,
    },
    createdAt: iso,
    updatedAt: iso,
  };
}

describe("session usage schemas", () => {
  test("accepts a canonical snapshot and trims ids", () => {
    expect(turnUsageSchema.parse(usage())).toEqual(usage());
    expect(sessionUsageSnapshotSchema.parse(snapshot()).sessionId).toBe("session-1");
    expect(
      sessionUsageSnapshotSchema.parse({
        ...snapshot(),
        sessionId: "  session-1  ",
      }).sessionId,
    ).toBe("session-1");
  });

  test("fails closed on extras, unknown providers, and offset-less timestamps", () => {
    expect(sessionUsageSnapshotSchema.safeParse({ ...snapshot(), extra: true }).success).toBe(
      false,
    );
    expect(
      sessionUsageSnapshotSchema.safeParse({
        ...snapshot(),
        sessionId: "   ",
      }).success,
    ).toBe(false);
    expect(
      sessionUsageSnapshotSchema.safeParse({
        ...snapshot(),
        totalTokens: -1,
      }).success,
    ).toBe(false);
    expect(
      sessionUsageSnapshotSchema.safeParse({
        ...snapshot(),
        turns: [
          {
            ...snapshot().turns[0],
            provider: "not-a-provider",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      sessionUsageSnapshotSchema.safeParse({
        ...snapshot(),
        createdAt: "2026-08-29T10:00:00.000",
      }).success,
    ).toBe(false);
    expect(turnUsageSchema.safeParse({ ...usage(), extra: true }).success).toBe(false);
    expect(turnUsageSchema.safeParse({ ...usage(), promptTokens: 1.5 }).success).toBe(false);
  });
});
