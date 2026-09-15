import { describe, expect, test } from "bun:test";

import type { SessionUsageSnapshot } from "../../src/session/costTracker";
import { sessionUsageSnapshotSchema, turnUsageSchema } from "../../src/session/sessionUsageSchema";

const timestamp = "2026-09-15T10:00:00.000Z";

function validSnapshot(overrides: Record<string, unknown> = {}): SessionUsageSnapshot {
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
        provider: "openai",
        model: "gpt-5.2",
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
        timestamp,
        provider: "openai",
        model: "gpt-5.2",
        usage: {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
        },
        estimatedCostUsd: 0.01,
        pricing: null,
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
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  } as SessionUsageSnapshot;
}

describe("session usage snapshot schema", () => {
  test("accepts a minimal persisted snapshot and nullable cost fields", () => {
    expect(sessionUsageSnapshotSchema.parse(validSnapshot())).toEqual(validSnapshot());
    expect(
      sessionUsageSnapshotSchema.parse(
        validSnapshot({
          estimatedTotalCostUsd: null,
          turns: [
            {
              turnId: "turn-1",
              turnIndex: 0,
              timestamp,
              provider: "openai",
              model: "gpt-5.2",
              usage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                estimatedCostUsd: 0,
              },
              estimatedCostUsd: null,
              pricing: {
                inputPerMillion: 1.75,
                outputPerMillion: 14,
              },
            },
          ],
        }),
      ).estimatedTotalCostUsd,
    ).toBeNull();
  });

  test("turn usage rejects extras, negatives, and non-integers", () => {
    expect(turnUsageSchema.parse({ promptTokens: 1, completionTokens: 2, totalTokens: 3 })).toEqual(
      {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      },
    );
    expect(
      turnUsageSchema.safeParse({ promptTokens: -1, completionTokens: 0, totalTokens: 0 }).success,
    ).toBe(false);
    expect(
      turnUsageSchema.safeParse({ promptTokens: 1.5, completionTokens: 0, totalTokens: 0 }).success,
    ).toBe(false);
    expect(
      turnUsageSchema.safeParse({
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("snapshot parse fails closed on blank ids, extras, and invalid timestamps", () => {
    expect(sessionUsageSnapshotSchema.safeParse(validSnapshot({ sessionId: "   " })).success).toBe(
      false,
    );
    expect(sessionUsageSnapshotSchema.safeParse(validSnapshot({ extra: true })).success).toBe(
      false,
    );
    expect(
      sessionUsageSnapshotSchema.safeParse(validSnapshot({ createdAt: "2026-09-15" })).success,
    ).toBe(false);
    expect(
      sessionUsageSnapshotSchema.safeParse(
        validSnapshot({
          turns: [
            {
              turnId: "",
              turnIndex: 0,
              timestamp,
              provider: "openai",
              model: "gpt-5.2",
              usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
              estimatedCostUsd: null,
              pricing: null,
            },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      sessionUsageSnapshotSchema.safeParse(
        validSnapshot({
          budgetStatus: {
            configured: true,
            warnAtUsd: 1,
            stopAtUsd: 2,
            warningTriggered: false,
            stopTriggered: false,
          },
        }),
      ).success,
    ).toBe(false);
  });
});
