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

const sessionInfo = (overrides: Partial<SessionInfoState> = {}): SessionInfoState => ({
  title: "Chat",
  titleSource: "manual",
  titleModel: "gpt-5.4",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:01:00.000Z",
  provider: "openai",
  model: "gpt-5.4",
  ...overrides,
});

const hydrated = (
  info: SessionInfoState,
  status: HydratedSessionState["status"],
): HydratedSessionState => ({
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
});

const usageSnapshot = (turns: TurnCostEntry[]): SessionUsageSnapshot => ({
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
});

const turn = (estimatedCostUsd: number | null, usageCost?: number): TurnCostEntry => ({
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
});

const runtimeState = (
  info: SessionInfoState,
  costTracker: SessionCostTracker | null,
): SessionRuntimeState =>
  ({
    sessionInfo: info,
    allMessages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ],
    todos: [{ content: "ship", status: "pending", activeForm: "shipping" }],
    costTracker,
  }) as SessionRuntimeState;

const snapshotFor = (state: SessionRuntimeState) =>
  buildInitialSessionSnapshot({
    sessionId: "session-1",
    state,
    lastEventSeq: 7,
    hasPendingAsk: false,
    hasPendingApproval: true,
  });

describe("normalizeHydratedSessionInfo", () => {
  test("normalizes root and agent execution states without mutating persisted records", () => {
    expect(normalizeHydratedSessionInfo(undefined)).toBeUndefined();
    expect(initialCurrentTurnOutcome(undefined)).toBe("completed");

    const missing = sessionInfo();
    const active = normalizeHydratedSessionInfo(hydrated(missing, "active"));
    expect(active).not.toBe(missing);
    expect(active?.executionState).toBe("completed");
    expect(missing.executionState).toBeUndefined();
    expect(normalizeHydratedSessionInfo(hydrated(sessionInfo(), "closed"))?.executionState).toBe(
      "closed",
    );

    const runningRoot = sessionInfo({ executionState: "running" });
    expect(normalizeHydratedSessionInfo(hydrated(runningRoot, "active"))).toBe(runningRoot);
    expect(normalizeHydratedSessionInfo(hydrated(runningRoot, "closed"))).toBe(runningRoot);
    const completedRoot = sessionInfo({ executionState: "completed" });
    expect(normalizeHydratedSessionInfo(hydrated(completedRoot, "active"))).toBe(completedRoot);

    for (const state of ["running", "pending_init"] as const) {
      const interrupted = sessionInfo({ sessionKind: "agent", executionState: state });
      const restored = normalizeHydratedSessionInfo(hydrated(interrupted, "active"));
      expect(restored).not.toBe(interrupted);
      expect(restored?.executionState).toBe("errored");
      expect(interrupted.executionState).toBe(state);
      expect(initialCurrentTurnOutcome(hydrated(interrupted, "active"))).toBe("error");
    }

    const runningAgent = sessionInfo({ sessionKind: "agent", executionState: "running" });
    expect(normalizeHydratedSessionInfo(hydrated(runningAgent, "closed"))?.executionState).toBe(
      "closed",
    );
    expect(initialCurrentTurnOutcome(hydrated(runningAgent, "closed"))).toBe("completed");

    const finished = sessionInfo({ sessionKind: "agent", executionState: "completed" });
    expect(normalizeHydratedSessionInfo(hydrated(finished, "active"))).toBe(finished);
    expect(initialCurrentTurnOutcome(hydrated(finished, "active"))).toBe("completed");

    const errored = sessionInfo({ sessionKind: "agent", executionState: "errored" });
    expect(normalizeHydratedSessionInfo(hydrated(errored, "active"))).toBe(errored);
    expect(initialCurrentTurnOutcome(hydrated(errored, "active"))).toBe("error");
  });
});

describe("shouldReplayDisconnectedEvent", () => {
  test("replays conversation and interaction events and skips live control events", () => {
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
    const state = runtimeState(
      sessionInfo({
        sessionKind: "agent",
        depth: 0,
        parentSessionId: "root-1",
        role: "worker",
      }),
      null,
    );
    const snapshot = Object.assign(snapshotFor(state), {
      title: "stale",
      depth: 4,
      lastEventSeq: 1,
    });

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

  test("preserves prior lastTurnUsage on empty tracker and publishes latest turn cost without null estimates", () => {
    const emptyState = runtimeState(sessionInfo(), {
      getSnapshot: () => usageSnapshot([]),
    } as SessionCostTracker);
    const snapshotWithPrior = snapshotFor(emptyState);
    snapshotWithPrior.lastTurnUsage = {
      turnId: "turn-old",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    const emptyDecorated = decorateSessionSnapshot(snapshotWithPrior, {
      state: emptyState,
      lastEventSeq: 7,
      hasPendingAsk: false,
      hasPendingApproval: true,
    });
    expect(emptyDecorated.sessionUsage?.turns).toEqual([]);
    expect(emptyDecorated.lastTurnUsage).toEqual(snapshotWithPrior.lastTurnUsage);

    const decorateTurns = (turns: TurnCostEntry[]) => {
      const state = runtimeState(sessionInfo(), {
        getSnapshot: () => usageSnapshot(turns),
      } as SessionCostTracker);
      return decorateSessionSnapshot(snapshotFor(state), {
        state,
        lastEventSeq: 7,
        hasPendingAsk: false,
        hasPendingApproval: false,
      }).lastTurnUsage;
    };

    expect(decorateTurns([turn(1.25, 0.4)])).toEqual({
      turnId: "turn-1",
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, estimatedCostUsd: 1.25 },
    });
    const plain = decorateTurns([turn(null)]);
    expect(plain?.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(plain?.usage).not.toHaveProperty("estimatedCostUsd");
    expect(decorateTurns([turn(null, 0.4)])?.usage.estimatedCostUsd).toBe(0.4);
  });
});
