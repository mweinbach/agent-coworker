import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/server/protocol";
import {
  buildInitialSessionSnapshot,
  decorateSessionSnapshot,
  initialCurrentTurnOutcome,
  normalizeHydratedSessionInfo,
  shouldReplayDisconnectedEvent,
} from "../../src/server/session/AgentSessionHydration";
import type {
  HydratedSessionState,
  SessionInfoState,
  SessionRuntimeState,
} from "../../src/server/session/SessionContext";
import type {
  SessionCostTracker,
  SessionUsageSnapshot,
  TurnCostEntry,
} from "../../src/session/costTracker";
import type { SessionSnapshot } from "../../src/shared/sessionSnapshot";

function sessionInfo(overrides: Partial<SessionInfoState> = {}): SessionInfoState {
  return {
    title: "Chat",
    titleSource: "manual",
    titleModel: "gpt-5.4",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    provider: "openai",
    model: "gpt-5.4",
    ...overrides,
  };
}

function hydrated(
  info: SessionInfoState,
  status: HydratedSessionState["status"],
): HydratedSessionState {
  return {
    sessionId: "session-1",
    sessionInfo: info,
    status,
    hasGeneratedTitle: true,
    messages: [],
    providerState: null,
    todos: [],
    harnessContext: null,
    backupsEnabledOverride: null,
    costTracker: null,
  };
}

function usageSnapshot(turns: TurnCostEntry[]): SessionUsageSnapshot {
  return {
    sessionId: "session-1",
    totalTurns: turns.length,
    totalPromptTokens: 10,
    totalCompletionTokens: 4,
    totalTokens: 14,
    estimatedTotalCostUsd: null,
    costTrackingAvailable: true,
    byModel: [],
    turns,
    budgetStatus: {
      configured: false,
      warnAtUsd: null,
      stopAtUsd: null,
      warningTriggered: false,
      stopTriggered: false,
      currentCostUsd: null,
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:02:00.000Z",
  };
}

function turn(estimatedCostUsd: number | null, usageCost?: number): TurnCostEntry {
  return {
    turnId: "turn-1",
    turnIndex: 0,
    timestamp: "2026-09-01T00:02:00.000Z",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      ...(usageCost === undefined ? {} : { estimatedCostUsd: usageCost }),
    },
    estimatedCostUsd,
    pricing: null,
  };
}

function runtimeState(
  info: SessionInfoState,
  costTracker: SessionCostTracker | null,
): SessionRuntimeState {
  return {
    sessionInfo: info,
    allMessages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ],
    todos: [{ content: "ship", status: "pending", activeForm: "shipping" }],
    costTracker,
  } as SessionRuntimeState;
}

function snapshotFor(state: SessionRuntimeState): SessionSnapshot {
  return buildInitialSessionSnapshot({
    sessionId: "session-1",
    state,
    lastEventSeq: 7,
    hasPendingAsk: false,
    hasPendingApproval: true,
  });
}

describe("normalizeHydratedSessionInfo", () => {
  test("returns nothing when there is no persisted session", () => {
    expect(normalizeHydratedSessionInfo(undefined)).toBeUndefined();
    expect(initialCurrentTurnOutcome(undefined)).toBe("completed");
  });

  test("fills a missing root execution state without rewriting one that is already set", () => {
    const missing = sessionInfo();
    const active = normalizeHydratedSessionInfo(hydrated(missing, "active"));
    expect(active).not.toBe(missing);
    expect(active?.executionState).toBe("completed");
    expect(missing.executionState).toBeUndefined();

    const closed = sessionInfo();
    expect(normalizeHydratedSessionInfo(hydrated(closed, "closed"))?.executionState).toBe("closed");

    const running = sessionInfo({ executionState: "running" });
    expect(normalizeHydratedSessionInfo(hydrated(running, "active"))).toBe(running);
    expect(normalizeHydratedSessionInfo(hydrated(running, "closed"))).toBe(running);

    const completed = sessionInfo({ executionState: "completed" });
    expect(normalizeHydratedSessionInfo(hydrated(completed, "active"))).toBe(completed);
  });

  test("marks an interrupted agent errored and leaves the persisted record unchanged", () => {
    const running = sessionInfo({ sessionKind: "agent", executionState: "running" });
    const restored = normalizeHydratedSessionInfo(hydrated(running, "active"));
    expect(restored).not.toBe(running);
    expect(restored?.executionState).toBe("errored");
    expect(running.executionState).toBe("running");
    expect(initialCurrentTurnOutcome(hydrated(running, "active"))).toBe("error");

    const pending = sessionInfo({ sessionKind: "agent", executionState: "pending_init" });
    expect(normalizeHydratedSessionInfo(hydrated(pending, "active"))?.executionState).toBe(
      "errored",
    );
    expect(initialCurrentTurnOutcome(hydrated(pending, "active"))).toBe("error");
  });

  test("closes an agent whose session is closed and keeps a finished agent completed", () => {
    const running = sessionInfo({ sessionKind: "agent", executionState: "running" });
    const closed = normalizeHydratedSessionInfo(hydrated(running, "closed"));
    expect(closed?.executionState).toBe("closed");
    expect(initialCurrentTurnOutcome(hydrated(running, "closed"))).toBe("completed");

    const finished = sessionInfo({ sessionKind: "agent", executionState: "completed" });
    expect(normalizeHydratedSessionInfo(hydrated(finished, "active"))).toBe(finished);
    expect(initialCurrentTurnOutcome(hydrated(finished, "active"))).toBe("completed");

    const alreadyErrored = sessionInfo({ sessionKind: "agent", executionState: "errored" });
    expect(normalizeHydratedSessionInfo(hydrated(alreadyErrored, "active"))).toBe(alreadyErrored);
    expect(initialCurrentTurnOutcome(hydrated(alreadyErrored, "active"))).toBe("error");
  });
});

describe("shouldReplayDisconnectedEvent", () => {
  test("replays conversation and interaction events", () => {
    for (const type of [
      "user_message",
      "assistant_message",
      "ask",
      "approval",
      "interaction_resolved",
      "error",
      "file_uploaded",
      "budget_exceeded",
    ] as const) {
      expect(shouldReplayDisconnectedEvent({ type } as SessionEvent)).toBe(true);
    }
  });

  test("does not replay catalogs, snapshots, or live control events", () => {
    for (const type of [
      "server_hello",
      "agent_status",
      "session_snapshot",
      "steer_accepted",
      "tools",
      "session_deleted",
      "pong",
    ] as const) {
      expect(shouldReplayDisconnectedEvent({ type } as SessionEvent)).toBe(false);
    }
  });
});

describe("decorateSessionSnapshot", () => {
  test("copies live session fields and isolates todo mutations", () => {
    const info = sessionInfo({
      sessionKind: "agent",
      depth: 0,
      parentSessionId: "root-1",
      role: "worker",
    });
    const state = runtimeState(info, null);
    const snapshot = snapshotFor(state);
    snapshot.title = "stale";
    snapshot.depth = 4;
    snapshot.lastEventSeq = 1;

    const decorated = decorateSessionSnapshot(snapshot, {
      state,
      lastEventSeq: 12,
      hasPendingAsk: true,
      hasPendingApproval: false,
    });

    expect(decorated).toBe(snapshot);
    expect(decorated).toMatchObject({
      title: "Chat",
      titleModel: "gpt-5.4",
      sessionKind: "agent",
      parentSessionId: "root-1",
      role: "worker",
      depth: 0,
      nickname: null,
      taskType: null,
      targetPaths: null,
      profile: null,
      messageCount: 2,
      lastEventSeq: 12,
      hasPendingAsk: true,
      hasPendingApproval: false,
      sessionUsage: null,
    });
    decorated.todos[0]!.content = "changed";
    expect(state.todos[0]?.content).toBe("ship");
  });

  test("keeps a prior last-turn cost when the tracker has no turns", () => {
    const state = runtimeState(sessionInfo(), {
      getSnapshot: () => usageSnapshot([]),
    } as SessionCostTracker);
    const snapshot = snapshotFor(state);
    snapshot.lastTurnUsage = {
      turnId: "turn-old",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };

    const decorated = decorateSessionSnapshot(snapshot, {
      state,
      lastEventSeq: 7,
      hasPendingAsk: false,
      hasPendingApproval: true,
    });

    expect(decorated.sessionUsage?.turns).toEqual([]);
    expect(decorated.lastTurnUsage).toEqual(snapshot.lastTurnUsage);
  });

  test("publishes the latest turn cost without inventing a null estimate", () => {
    const withCost = runtimeState(sessionInfo(), {
      getSnapshot: () => usageSnapshot([turn(1.25, 0.4)]),
    } as SessionCostTracker);
    const priced = decorateSessionSnapshot(snapshotFor(withCost), {
      state: withCost,
      lastEventSeq: 7,
      hasPendingAsk: false,
      hasPendingApproval: false,
    });
    expect(priced.lastTurnUsage).toEqual({
      turnId: "turn-1",
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
        estimatedCostUsd: 1.25,
      },
    });

    const unpriced = runtimeState(sessionInfo(), {
      getSnapshot: () => usageSnapshot([turn(null)]),
    } as SessionCostTracker);
    const plain = decorateSessionSnapshot(snapshotFor(unpriced), {
      state: unpriced,
      lastEventSeq: 7,
      hasPendingAsk: false,
      hasPendingApproval: false,
    });
    expect(plain.lastTurnUsage?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    });
    expect(plain.lastTurnUsage?.usage).not.toHaveProperty("estimatedCostUsd");

    const usageOnly = runtimeState(sessionInfo(), {
      getSnapshot: () => usageSnapshot([turn(null, 0.4)]),
    } as SessionCostTracker);
    const kept = decorateSessionSnapshot(snapshotFor(usageOnly), {
      state: usageOnly,
      lastEventSeq: 7,
      hasPendingAsk: false,
      hasPendingApproval: false,
    });
    expect(kept.lastTurnUsage?.usage.estimatedCostUsd).toBe(0.4);
  });
});
