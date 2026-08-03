import { describe, expect, mock, test } from "bun:test";

import { SessionRegistry } from "../../../src/server/runtime/SessionRegistry";

describe("SessionRegistry AgentControl integration", () => {
  test("preserves the shared Codex client when closing a child agent", async () => {
    const lifecycleDispose = mock(() => {});
    const closeForHistory = mock(async () => {});
    const childSession = {
      id: "child-session",
      sessionKind: "agent",
      parentSessionId: "parent-session",
      role: "research",
      persistenceStatus: "active",
      isBusy: false,
      currentTurnOutcome: "completed",
      isAgentOf: (parentSessionId: string) => parentSessionId === "parent-session",
      cancel: mock(() => {}),
      closeForHistory,
      getSessionInfoEvent: () => ({
        title: "Research child",
        provider: "codex-cli",
        createdAt: "2026-08-03T18:52:39.000Z",
        updatedAt: "2026-08-03T18:53:50.000Z",
        effectiveModel: "gpt-5.4",
      }),
      getLatestAssistantText: () => "Done",
      getCompactUsageSnapshot: () => null,
      getLastTurnUsage: () => null,
    };
    const childBinding = {
      session: childSession,
      runtime: {
        turns: { cancel: mock(() => {}) },
        lifecycle: { dispose: lifecycleDispose },
      },
      socket: null,
      sinks: new Map(),
    };
    const registry = Object.assign(Object.create(SessionRegistry.prototype), {
      agentControl: null,
      config: {},
      options: {
        sessionDb: null,
        loadAgentPrompt: mock(async () => ""),
        taskCoordinator: {
          getForThread: () => null,
          getActiveForSourceSession: () => null,
        },
      },
      sessionBindings: new Map([[childSession.id, childBinding]]),
      sessionIdleSince: new Map(),
    }) as SessionRegistry;

    const control = (
      registry as unknown as {
        getAgentControl: () => {
          close: (opts: { parentSessionId: string; agentId: string }) => Promise<unknown>;
        };
      }
    ).getAgentControl();
    await control.close({ parentSessionId: "parent-session", agentId: childSession.id });

    expect(closeForHistory).toHaveBeenCalledWith({ closeSharedCodexClient: false });
    expect(lifecycleDispose).toHaveBeenCalledWith("parent closed child agent", {
      closeSharedCodexClient: false,
    });
  });
});
