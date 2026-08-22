import { describe, expect, test } from "bun:test";

import {
  contentText,
  initialCurrentTurnOutcome,
  normalizeHydratedSessionInfo,
  shouldReplayDisconnectedEvent,
} from "../../src/server/session/AgentSessionHydration";
import type {
  HydratedSessionState,
  SessionInfoState,
} from "../../src/server/session/SessionContext";

function sessionInfo(overrides: Partial<SessionInfoState> = {}): SessionInfoState {
  return {
    title: "Session",
    titleSource: "default",
    titleModel: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    provider: "openai",
    model: "gpt-5.4",
    ...overrides,
  };
}

function hydrated(
  overrides: Partial<HydratedSessionState> & {
    sessionInfo?: Partial<SessionInfoState>;
  } = {},
): HydratedSessionState {
  const { sessionInfo: infoOverrides, ...rest } = overrides;
  return {
    sessionId: "session-1",
    sessionInfo: sessionInfo(infoOverrides),
    status: "active",
    hasGeneratedTitle: false,
    messages: [],
    providerState: null,
    todos: [],
    harnessContext: null,
    backupsEnabledOverride: null,
    costTracker: null,
    ...rest,
  };
}

describe("AgentSessionHydration", () => {
  test("contentText joins string and multimodal text parts", () => {
    expect(contentText("  hello  ")).toBe("hello");
    expect(contentText({ text: "nope" })).toBe("");
    expect(contentText([" a ", { text: " b " }, { inputText: " c " }, null, 1])).toBe("a\nb\nc");
  });

  test("normalizeHydratedSessionInfo remaps non-terminal agent state after close", () => {
    expect(normalizeHydratedSessionInfo(undefined)).toBeUndefined();

    const closedRunning = hydrated({
      status: "closed",
      sessionInfo: { sessionKind: "agent", executionState: "running" },
    });
    expect(normalizeHydratedSessionInfo(closedRunning)?.executionState).toBe("closed");

    const liveRunning = hydrated({
      status: "active",
      sessionInfo: { sessionKind: "agent", executionState: "running" },
    });
    expect(normalizeHydratedSessionInfo(liveRunning)?.executionState).toBe("completed");

    const completed = hydrated({
      status: "active",
      sessionInfo: { sessionKind: "agent", executionState: "completed" },
    });
    expect(normalizeHydratedSessionInfo(completed)).toBe(completed.sessionInfo);

    const rootRunning = hydrated({
      status: "closed",
      sessionInfo: { sessionKind: "root", executionState: "running" },
    });
    expect(normalizeHydratedSessionInfo(rootRunning)?.executionState).toBe("running");
  });

  test("initialCurrentTurnOutcome is error only for hydrated errored agents", () => {
    expect(initialCurrentTurnOutcome(undefined)).toBe("completed");
    expect(
      initialCurrentTurnOutcome(
        hydrated({
          sessionInfo: { sessionKind: "agent", executionState: "errored" },
        }),
      ),
    ).toBe("error");
    expect(
      initialCurrentTurnOutcome(
        hydrated({
          sessionInfo: { sessionKind: "agent", executionState: "running" },
        }),
      ),
    ).toBe("completed");
  });

  test("shouldReplayDisconnectedEvent allowlists control-plane-safe events", () => {
    expect(
      shouldReplayDisconnectedEvent({
        type: "assistant_message",
        sessionId: "session-1",
        text: "hi",
      }),
    ).toBe(true);
    expect(
      shouldReplayDisconnectedEvent({
        type: "session_usage",
        sessionId: "session-1",
        usage: null,
      }),
    ).toBe(true);
    expect(
      shouldReplayDisconnectedEvent({
        type: "session_settings",
        sessionId: "session-1",
        enableMcp: true,
        enableMemory: true,
        memoryRequireApproval: false,
      }),
    ).toBe(false);
    expect(
      shouldReplayDisconnectedEvent({
        type: "tools",
        sessionId: "session-1",
        tools: [],
      }),
    ).toBe(false);
  });
});
