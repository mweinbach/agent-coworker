import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PersistentAgentSummary } from "../../src/shared/agents";
import { makeSession, REAL_AGENT, resetAgentSessionMocks } from "./agentSession.harness";

describe("AgentSession child-agent events", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  test("recordAgentStatus updates and persists the parent snapshot", async () => {
    const persistSessionMutation = mock(async () => 7);
    const persistSessionSnapshot = mock(async () => {});
    const { session, events } = makeSession({
      sessionDb: {
        persistSessionMutation,
        persistSessionSnapshot,
      } as any,
    });
    await session.waitForPersistenceIdle();
    persistSessionMutation.mockClear();
    persistSessionSnapshot.mockClear();

    const now = "2026-05-29T19:43:58.000Z";
    const agent: PersistentAgentSummary = {
      agentId: "child-1",
      parentSessionId: session.id,
      role: "research",
      mode: "collaborative",
      depth: 1,
      taskType: "research",
      effectiveModel: "gemini-3-flash-preview",
      title: "WoA Ecosystem Analysis",
      provider: "google",
      createdAt: now,
      updatedAt: now,
      lifecycleState: "active",
      executionState: "running",
      busy: true,
      lastMessagePreview: "Starting research.",
      sessionUsage: {
        sessionId: "child-1",
        totalTurns: 1,
        totalPromptTokens: 100,
        totalCompletionTokens: 20,
        totalCachedPromptTokens: 40,
        totalTokens: 120,
        estimatedTotalCostUsd: 0.002,
        costBreakdown: {
          inputCostUsd: 0.001,
          cachedInputCostUsd: 0.0001,
          cacheWriteInputCostUsd: 0,
          outputCostUsd: 0.0009,
          otherCostUsd: 0,
        },
        costTrackingAvailable: true,
        byModel: [],
        turns: [],
        budgetStatus: {
          configured: false,
          warnAtUsd: null,
          stopAtUsd: null,
          warningTriggered: false,
          stopTriggered: false,
          currentCostUsd: 0.002,
        },
        createdAt: now,
        updatedAt: now,
      },
      lastTurnUsage: {
        promptTokens: 100,
        cachedPromptTokens: 40,
        completionTokens: 20,
        totalTokens: 120,
        estimatedCostUsd: 0.002,
      },
    };

    session.recordAgentStatus(agent);

    expect(events.at(-1)).toEqual({
      type: "agent_status",
      sessionId: session.id,
      agent,
    });
    expect(session.peekSessionSnapshot().agents).toEqual([agent]);
    expect(session.peekSessionSnapshot().agents[0]?.sessionUsage?.costBreakdown?.inputCostUsd).toBe(
      0.001,
    );

    await session.waitForPersistenceIdle();

    expect(persistSessionMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        eventType: "session.agent_status",
      }),
    );
    const persistedSnapshot = persistSessionSnapshot.mock.calls[0]?.[1] as
      | { agents?: PersistentAgentSummary[] }
      | undefined;
    expect(persistedSnapshot?.agents).toEqual([agent]);
  });
});
