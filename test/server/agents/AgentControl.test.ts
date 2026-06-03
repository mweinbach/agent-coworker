import { describe, expect, mock, test } from "bun:test";

import { AgentControl } from "../../../src/server/agents/AgentControl";
import type { AgentControlDeps } from "../../../src/server/agents/types";

describe("AgentControl", () => {
  test("closes child sessions without closing the shared codex app-server client", async () => {
    const closeForHistory = mock(async () => {});
    const disposeBinding = mock(() => {});
    const childSession = {
      id: "child-1",
      sessionKind: "agent",
      parentSessionId: "parent-1",
      role: "reviewer",
      persistenceStatus: "active",
      isBusy: false,
      currentTurnOutcome: "success",
      isAgentOf: (parentSessionId: string) => parentSessionId === "parent-1",
      cancel: mock(() => {}),
      closeForHistory,
      getSessionInfoEvent: () => ({
        sessionKind: "agent",
        parentSessionId: "parent-1",
        role: "reviewer",
        mode: "delegate",
        depth: 1,
        title: "Reviewer",
        provider: "codex-cli",
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      }),
      getCompactUsageSnapshot: () => null,
      getLastTurnUsage: () => null,
      getLatestAssistantText: () => "done",
      getPublicConfig: () => ({ model: "gpt-5.5" }),
    };
    const binding = {
      session: childSession,
      runtime: null,
      socket: null,
      sinks: new Map(),
    };
    const sessionBindings = new Map<string, typeof binding>([["child-1", binding]]);
    const control = new AgentControl({
      sessionBindings,
      sessionDb: null,
      getConnectedProviders: async () => [],
      buildSession: (() => {
        throw new Error("unexpected buildSession call");
      }) as AgentControlDeps["buildSession"],
      loadAgentPrompt: async () => "",
      disposeBinding,
      emitParentAgentStatus: mock(() => {}),
      emitParentLog: mock(() => {}),
    } as unknown as AgentControlDeps);

    await control.close({ parentSessionId: "parent-1", agentId: "child-1" });

    expect(closeForHistory).toHaveBeenCalledWith({ closeSharedCodexClient: false });
    expect(disposeBinding).toHaveBeenCalledWith(binding, "parent closed child agent", {
      closeSharedCodexClient: false,
    });
    expect(sessionBindings.has("child-1")).toBe(false);
  });
});
