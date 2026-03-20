import { describe, expect, test } from "bun:test";

import type { SessionSnapshot } from "../src/shared/sessionSnapshot";
import { SessionSnapshotProjector } from "../src/server/session/SessionSnapshotProjector";

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "session-1",
    title: "Session",
    titleSource: "default",
    titleModel: null,
    provider: "openai",
    model: "gpt-5.4",
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: null,
    nickname: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: null,
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    feed: [],
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
    ...overrides,
  };
}

describe("SessionSnapshotProjector", () => {
  test("tracks ask and approval events in the projected snapshot", () => {
    const projector = new SessionSnapshotProjector(makeSnapshot());

    projector.applyEvent(
      {
        type: "ask",
        sessionId: "session-1",
        requestId: "ask-1",
        question: "question: Should we proceed?",
        options: ["yes"],
      },
      "2026-03-20T00:00:01.000Z",
    );

    projector.applyEvent(
      {
        type: "approval",
        sessionId: "session-1",
        requestId: "approval-1",
        command: "rm -rf /tmp",
        dangerous: true,
        reasonCode: "matches_dangerous_pattern",
      },
      "2026-03-20T00:00:02.000Z",
    );

    expect(projector.getSnapshot()).toMatchObject({
      hasPendingAsk: true,
      hasPendingApproval: true,
      feed: [
        {
          kind: "system",
          line: "question: Should we proceed?",
        },
        {
          kind: "system",
          line: "approval requested: rm -rf /tmp",
        },
      ],
    });
  });

  test("reset_done clears pending prompt flags along with other transient snapshot state", () => {
    const projector = new SessionSnapshotProjector(
      makeSnapshot({
        feed: [{ id: "existing-feed", kind: "system", ts: "2026-03-20T00:00:00.000Z", line: "existing" }],
        agents: [
          {
            agentId: "agent-1",
            parentSessionId: "session-1",
            role: "worker",
            mode: "collaborative",
            depth: 1,
            title: "Worker",
            provider: "openai",
            effectiveModel: "gpt-5.4",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
            lifecycleState: "active",
            executionState: "running",
            busy: true,
          },
        ],
        todos: [{ content: "Task", status: "pending", activeForm: "" }],
        sessionUsage: {
          sessionId: "session-1",
          estimatedTotalCostUsd: 1.23,
          totalTurns: 1,
          totalPromptTokens: 1,
          totalCompletionTokens: 2,
          totalTokens: 3,
          costTrackingAvailable: true,
          byModel: [],
          turns: [
            {
              turnId: "turn-1",
              turnIndex: 0,
              timestamp: "2026-03-20T00:00:00.000Z",
              provider: "openai",
              model: "gpt-5.4",
              usage: {
                promptTokens: 1,
                completionTokens: 2,
                totalTokens: 3,
              },
              estimatedCostUsd: 1.23,
              pricing: null,
            },
          ],
          budgetStatus: {
            configured: false,
            warnAtUsd: null,
            stopAtUsd: null,
            warningTriggered: false,
            stopTriggered: false,
            currentCostUsd: 1.23,
          },
          createdAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        },
        lastTurnUsage: {
          turnId: "turn-1",
          usage: {
            promptTokens: 1,
            completionTokens: 2,
            totalTokens: 3,
          },
        },
        hasPendingAsk: true,
        hasPendingApproval: true,
      }),
    );

    projector.applyEvent({ type: "reset_done", sessionId: "session-1" }, "2026-03-20T00:00:03.000Z");

    expect(projector.getSnapshot()).toMatchObject({
      feed: [],
      agents: [],
      todos: [],
      sessionUsage: null,
      lastTurnUsage: null,
      hasPendingAsk: false,
      hasPendingApproval: false,
    });
  });
});
