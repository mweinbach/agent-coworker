import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import { AgentControl } from "../src/server/agents/AgentControl";
import { parseChildAgentReport } from "../src/shared/agents";
import type { SeededSessionContext } from "../src/server/session/SessionContext";
import type { AgentConfig } from "../src/types";
import type { SessionBinding } from "../src/server/startServer/types";
import type { PersistedSessionRecord } from "../src/server/sessionDb";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = "/tmp/agent-control";
  return {
    provider: "openai",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5-mini",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

function makeChildSession(config: AgentConfig) {
  const sendUserMessage = mock(async () => {});
  const session = {
    id: "child-1",
    sessionKind: "agent",
    parentSessionId: "root-1",
    role: "worker",
    persistenceStatus: "active",
    isBusy: false,
    currentTurnOutcome: "completed",
    beginDisconnectedReplayBuffer: mock(() => {}),
    sendUserMessage,
    reopenForHistory: mock(() => {
      session.persistenceStatus = "active";
    }),
    closeForHistory: mock(async () => {
      session.persistenceStatus = "closed";
    }),
    cancel: mock(() => {
      session.isBusy = false;
    }),
    isAgentOf: (parentSessionId: string) => parentSessionId === session.parentSessionId,
    getSessionInfoEvent: () => ({
      type: "session_info",
      sessionId: "child-1",
      title: "Child session",
      titleSource: "default",
      titleModel: null,
      provider: config.provider,
      model: config.model,
      sessionKind: "agent",
      parentSessionId: "root-1",
      role: "worker",
      mode: "collaborative",
      depth: 1,
      createdAt: "2026-03-16T15:00:00.000Z",
      updatedAt: "2026-03-16T15:00:00.000Z",
      effectiveModel: config.model,
      executionState: "pending_init",
    }),
    getPublicConfig: () => config,
    getLatestAssistantText: () => null,
    getCompactUsageSnapshot: () => null,
    getLastTurnUsage: () => null,
  } as any;
  return session;
}

function makePersistedChildRecord(config: AgentConfig, overrides: Partial<PersistedSessionRecord> = {}): PersistedSessionRecord {
  const now = "2026-03-16T15:00:00.000Z";
  return {
    sessionId: "child-1",
    sessionKind: "agent",
    parentSessionId: "root-1",
    role: "worker",
    mode: "collaborative",
    depth: 1,
    nickname: null,
    requestedModel: null,
    effectiveModel: config.model,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: "completed",
    lastMessagePreview: null,
    title: "Child session",
    titleSource: "default",
    titleModel: null,
    provider: config.provider,
    model: config.model,
    workingDirectory: config.workingDirectory,
    outputDirectory: config.outputDirectory,
    uploadsDirectory: config.uploadsDirectory,
    enableMcp: true,
    backupsEnabledOverride: null,
    createdAt: now,
    updatedAt: now,
    status: "active",
    hasPendingAsk: false,
    hasPendingApproval: false,
    messageCount: 1,
    lastEventSeq: 1,
    systemPrompt: "child system prompt",
    messages: [],
    providerState: null,
    todos: [],
    harnessContext: null,
    costTracker: null,
    ...overrides,
  };
}

describe("AgentControl.spawn", () => {
  test("passes a full parent context seed into child session creation when contextMode is full", async () => {
    const parentConfig = makeConfig();
    const childConfig = makeConfig({ model: "gpt-5-mini", preferredChildModel: "gpt-5-mini" });
    const seedContext: SeededSessionContext = {
      messages: [
        { role: "user", content: "Investigate this failure" },
        { role: "assistant", content: [{ type: "output_text", text: "I found the regression." }] },
      ],
      todos: [{ content: "Reproduce the bug", status: "completed", activeForm: "Reproducing the bug" }],
      harnessContext: {
        runId: "run-1",
        objective: "Fix the review findings",
        acceptanceCriteria: ["Preserve parent transcript"],
        constraints: ["Do not lose session context"],
        updatedAt: "2026-03-16T15:00:00.000Z",
      },
    };
    const childSession = makeChildSession(childConfig);
    const buildSession = mock((binding: SessionBinding, _persistedSessionId?: string, overrides?: Record<string, unknown>) => {
      binding.session = childSession;
      return { session: childSession, isResume: false, resumedFromStorage: false, overrides };
    });
    const buildForkContextSeed = mock(() => seedContext);
    const buildContextSeed = mock(() => ({
      messages: [],
      todos: [],
      harnessContext: null,
    }));
    const control = new AgentControl({
      sessionBindings: new Map([
        ["root-1", { session: { buildForkContextSeed, buildContextSeed }, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      message: "Handle the fix",
      contextMode: "full",
    });

    expect(buildForkContextSeed).toHaveBeenCalledTimes(1);
    expect(buildContextSeed).not.toHaveBeenCalled();
    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        seedContext,
      }),
    );
    expect(childSession.sendUserMessage).toHaveBeenCalledWith("Handle the fix");
  });

  test("builds a briefing seed with optional structured context when contextMode is brief", async () => {
    const parentConfig = makeConfig();
    const seedContext: SeededSessionContext = {
      messages: [{ role: "user", content: "Parent briefing:\nFocus on the parser regression only." }],
      todos: [{ content: "Reproduce the bug", status: "completed", activeForm: "Reproducing the bug" }],
      harnessContext: {
        runId: "run-1",
        objective: "Fix the review findings",
        acceptanceCriteria: ["Preserve the essential parent context"],
        constraints: ["Do not clone the full parent transcript"],
        updatedAt: "2026-03-16T15:00:00.000Z",
      },
    };
    const childSession = makeChildSession(parentConfig);
    const buildSession = mock((binding: SessionBinding, _persistedSessionId?: string, overrides?: Record<string, unknown>) => {
      binding.session = childSession;
      return { session: childSession, isResume: false, resumedFromStorage: false, overrides };
    });
    const buildForkContextSeed = mock(() => ({
      messages: [],
      todos: [],
      harnessContext: null,
    }));
    const buildContextSeed = mock(() => seedContext);
    const control = new AgentControl({
      sessionBindings: new Map([
        ["root-1", { session: { buildForkContextSeed, buildContextSeed }, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      message: "Handle the fix",
      contextMode: "brief",
      briefing: "Focus on the parser regression only.",
      includeParentTodos: true,
      includeHarnessContext: true,
    });

    expect(buildForkContextSeed).not.toHaveBeenCalled();
    expect(buildContextSeed).toHaveBeenCalledWith({
      contextMode: "brief",
      briefing: "Focus on the parser regression only.",
      includeParentTodos: true,
      includeHarnessContext: true,
    });
    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        seedContext,
      }),
    );
    expect(childSession.sendUserMessage).toHaveBeenCalledWith("Handle the fix");
  });

  test("does not seed parent context when contextMode defaults to none", async () => {
    const parentConfig = makeConfig();
    const childSession = makeChildSession(parentConfig);
    const buildSession = mock((binding: SessionBinding) => {
      binding.session = childSession;
      return { session: childSession, isResume: false, resumedFromStorage: false };
    });
    const buildForkContextSeed = mock(() => ({
      messages: [],
      todos: [],
      harnessContext: null,
    }));
    const buildContextSeed = mock(() => ({
      messages: [],
      todos: [],
      harnessContext: null,
    }));
    const control = new AgentControl({
      sessionBindings: new Map([
        ["root-1", { session: { buildForkContextSeed, buildContextSeed }, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      message: "Handle the fix",
    });

    expect(buildForkContextSeed).not.toHaveBeenCalled();
    expect(buildContextSeed).not.toHaveBeenCalled();
    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.not.objectContaining({
        seedContext: expect.anything(),
      }),
    );
  });

  test("returns the post-dispatch running summary from spawn", async () => {
    const parentConfig = makeConfig();
    const childSession = makeChildSession(parentConfig);
    childSession.sendUserMessage = mock(() => new Promise<void>(() => {}));
    const buildSession = mock((binding: SessionBinding) => {
      binding.session = childSession;
      return { session: childSession, isResume: false, resumedFromStorage: false };
    });
    const emitParentAgentStatus = mock(() => {});
    const control = new AgentControl({
      sessionBindings: new Map([
        ["root-1", { session: { buildForkContextSeed: () => ({ messages: [], todos: [], harnessContext: null }) }, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus,
      emitParentLog: () => {},
    });

    const summary = await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      message: "Handle the fix",
    });

    expect(summary.executionState).toBe("running");
    expect(summary.busy).toBe(true);
    expect(childSession.isBusy).toBe(false);
    expect(emitParentAgentStatus).toHaveBeenLastCalledWith(
      "root-1",
      expect.objectContaining({
        agentId: "child-1",
        executionState: "running",
        busy: true,
      }),
    );
  });

  test("routes an allowlisted cross-provider child target when the provider is connected", async () => {
    const parentConfig = makeConfig({
      provider: "codex-cli",
      model: "gpt-5.4",
      preferredChildModel: "gpt-5.4",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModelRef: "opencode-zen:glm-5",
      allowedChildModelRefs: ["opencode-zen:glm-5"],
    });
    const childConfig = makeConfig({
      provider: "opencode-zen",
      model: "glm-5",
      preferredChildModel: "glm-5",
      preferredChildModelRef: "opencode-zen:glm-5",
      childModelRoutingMode: "cross-provider-allowlist",
      allowedChildModelRefs: ["opencode-zen:glm-5"],
    });
    const childSession = makeChildSession(childConfig);
    const buildSession = mock((binding: SessionBinding, _persistedSessionId?: string, overrides?: Record<string, unknown>) => {
      binding.session = childSession;
      return { session: childSession, isResume: false, resumedFromStorage: false, overrides };
    });
    const control = new AgentControl({
      sessionBindings: new Map([
        ["root-1", { session: { buildForkContextSeed: () => ({ messages: [], todos: [], harnessContext: null }) }, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      getConnectedProviders: async () => ["codex-cli", "opencode-zen"],
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      model: "opencode-zen:glm-5",
      message: "Investigate with glm-5",
    });

    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        config: expect.objectContaining({
          provider: "opencode-zen",
          model: "glm-5",
        }),
      }),
    );
    expect(childSession.sendUserMessage).toHaveBeenCalledWith("Investigate with glm-5");
  });

  test("falls back to the parent target and logs when a cross-provider ref is not allowlisted", async () => {
    const parentConfig = makeConfig({
      provider: "codex-cli",
      model: "gpt-5.4",
      preferredChildModel: "gpt-5.4",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModelRef: "codex-cli:gpt-5.4",
      allowedChildModelRefs: [],
    });
    const childSession = makeChildSession(parentConfig);
    const buildSession = mock((binding: SessionBinding, _persistedSessionId?: string, overrides?: Record<string, unknown>) => {
      binding.session = childSession;
      return { session: childSession, isResume: false, resumedFromStorage: false, overrides };
    });
    const emitParentLog = mock(() => {});
    const control = new AgentControl({
      sessionBindings: new Map([
        ["root-1", { session: { buildForkContextSeed: () => ({ messages: [], todos: [], harnessContext: null }) }, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      getConnectedProviders: async () => ["codex-cli", "opencode-go"],
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog,
    });

    await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      model: "opencode-go:glm-5",
      message: "Investigate with fallback",
    });

    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        config: expect.objectContaining({
          provider: "codex-cli",
          model: "gpt-5.4",
        }),
      }),
    );
    expect(emitParentLog).toHaveBeenCalledWith(
      "root-1",
      expect.stringContaining("falling back to codex-cli:gpt-5.4"),
    );
  });

});

describe("AgentControl persisted child control", () => {
  test("sendInput hydrates a persisted child session before dispatching", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    const buildSession = mock((binding: SessionBinding, persistedSessionId?: string) => {
      binding.session = childSession;
      return { session: childSession, isResume: true, resumedFromStorage: true, persistedSessionId };
    });
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: {
        getSessionRecord: (sessionId: string) =>
          sessionId === "child-1" ? makePersistedChildRecord(config) : null,
      } as any,
      getConnectedProviders: async () => ["openai"],
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await control.sendInput({
      parentSessionId: "root-1",
      agentId: "child-1",
      message: "Continue the task",
    });

    expect(buildSession).toHaveBeenCalledTimes(1);
    expect(buildSession.mock.calls[0]?.[1]).toBe("child-1");
    expect(childSession.beginDisconnectedReplayBuffer).toHaveBeenCalledTimes(1);
    expect(childSession.sendUserMessage).toHaveBeenCalledWith("Continue the task");
  });

  test("wait publishes hydrated terminal child status immediately", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    const getSessionInfoEvent = childSession.getSessionInfoEvent;
    childSession.getSessionInfoEvent = () => ({
      ...getSessionInfoEvent(),
      executionState: "completed",
    });
    const emitParentAgentStatus = mock(() => {});
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: {
        getSessionRecord: (sessionId: string) =>
          sessionId === "child-1" ? makePersistedChildRecord(config) : null,
      } as any,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: true, resumedFromStorage: true };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus,
      emitParentLog: () => {},
    });

    const result = await control.wait({
      parentSessionId: "root-1",
      agentIds: ["child-1"],
      timeoutMs: 10,
    });

    expect(result.timedOut).toBe(false);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.executionState).toBe("completed");
    expect(emitParentAgentStatus).toHaveBeenCalled();
  });

  test("wait normalizes hydrated stale running child status to completed when idle", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    const getSessionInfoEvent = childSession.getSessionInfoEvent;
    childSession.getSessionInfoEvent = () => ({
      ...getSessionInfoEvent(),
      executionState: "running",
    });
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: {
        getSessionRecord: (sessionId: string) =>
          sessionId === "child-1" ? makePersistedChildRecord(config, { executionState: "running" }) : null,
      } as any,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: true, resumedFromStorage: true };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    const result = await control.wait({
      parentSessionId: "root-1",
      agentIds: ["child-1"],
      timeoutMs: 10,
    });

    expect(result.timedOut).toBe(false);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.executionState).toBe("completed");
  });

  test("inspect returns latest assistant text, parsed report, and usage for hydrated children", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    childSession.getLatestAssistantText = () => [
      "Finished the task.",
      "```json",
      JSON.stringify({
        status: "completed",
        summary: "Task finished",
        filesRead: ["src/agent.ts"],
      }),
      "```",
    ].join("\n");
    childSession.getCompactUsageSnapshot = () => ({
      sessionId: "child-1",
      totalTurns: 1,
      totalPromptTokens: 5,
      totalCompletionTokens: 7,
      totalTokens: 12,
      estimatedTotalCostUsd: 0.01,
      costTrackingAvailable: true,
      byModel: [],
      turns: [],
      budgetStatus: {
        configured: false,
        warnAtUsd: null,
        stopAtUsd: null,
        warningTriggered: false,
        stopTriggered: false,
        currentCostUsd: 0.01,
      },
      createdAt: "2026-03-16T15:00:00.000Z",
      updatedAt: "2026-03-16T15:00:00.000Z",
    });
    childSession.getLastTurnUsage = () => ({
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
      estimatedCostUsd: 0.01,
    });
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: {
        getSessionRecord: (sessionId: string) =>
          sessionId === "child-1" ? makePersistedChildRecord(config) : null,
      } as any,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: true, resumedFromStorage: true };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    const inspected = await control.inspect({
      parentSessionId: "root-1",
      agentId: "child-1",
    });

    expect(inspected.agent.agentId).toBe("child-1");
    expect(inspected.latestAssistantText).toContain("Finished the task.");
    expect(inspected.parsedReport).toEqual(parseChildAgentReport(inspected.latestAssistantText));
    expect(inspected.parsedReport).toEqual(expect.objectContaining({
      status: "completed",
      summary: "Task finished",
      filesRead: ["src/agent.ts"],
    }));
    expect(inspected.sessionUsage?.totalTokens).toBe(12);
    expect(inspected.lastTurnUsage?.totalTokens).toBe(12);
  });

  test("list normalizes hydrated stale pending_init child status to completed when idle", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    const getSessionInfoEvent = childSession.getSessionInfoEvent;
    childSession.getSessionInfoEvent = () => ({
      ...getSessionInfoEvent(),
      executionState: "pending_init",
    });
    const control = new AgentControl({
      sessionBindings: new Map([
        ["child-1", { session: childSession, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: {
        listAgentSessions: () => [],
      } as any,
      getConnectedProviders: async () => ["openai"],
      buildSession: mock(() => {
        throw new Error("should not build a new session");
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    const summaries = await control.list("root-1");

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.executionState).toBe("completed");
  });

  test("resume reopens a hydrated closed child session", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    childSession.persistenceStatus = "closed";
    const getSessionInfoEvent = childSession.getSessionInfoEvent;
    let executionState: "closed" | "completed" = "closed";
    childSession.getSessionInfoEvent = () => ({
      ...getSessionInfoEvent(),
      executionState,
    });
    childSession.reopenForHistory = mock(() => {
      childSession.persistenceStatus = "active";
      executionState = "completed";
    });
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: {
        getSessionRecord: (sessionId: string) =>
          sessionId === "child-1"
            ? makePersistedChildRecord(config, { status: "closed", executionState: "closed" })
            : null,
      } as any,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: true, resumedFromStorage: true };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    const summary = await control.resume({
      parentSessionId: "root-1",
      agentId: "child-1",
    });

    expect(childSession.reopenForHistory).toHaveBeenCalledTimes(1);
    expect(summary.lifecycleState).toBe("active");
    expect(summary.executionState).toBe("completed");
  });

  test("close hydrates a persisted child session before closing it", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    const disposeBinding = mock(() => {});
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: {
        getSessionRecord: (sessionId: string) =>
          sessionId === "child-1" ? makePersistedChildRecord(config) : null,
      } as any,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: true, resumedFromStorage: true };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding,
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    const summary = await control.close({
      parentSessionId: "root-1",
      agentId: "child-1",
    });

    expect(childSession.closeForHistory).toHaveBeenCalledTimes(1);
    expect(disposeBinding).toHaveBeenCalledWith(expect.anything(), "parent closed child agent");
    expect(summary.executionState).toBe("closed");
  });

  test("cancelAll continues cancelling siblings after one child throws", () => {
    const config = makeConfig();
    const firstChild = makeChildSession(config);
    firstChild.id = "child-err";
    firstChild.cancel = mock(() => {
      throw new Error("cancel exploded");
    });
    const secondChild = makeChildSession(config);
    secondChild.id = "child-ok";
    const emitParentLog = mock(() => {});
    const control = new AgentControl({
      sessionBindings: new Map([
        ["child-err", { session: firstChild, socket: null }],
        ["child-ok", { session: secondChild, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: (() => {
        throw new Error("unused");
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog,
    });

    expect(() => control.cancelAll("root-1")).not.toThrow();
    expect(firstChild.cancel).toHaveBeenCalledTimes(1);
    expect(secondChild.cancel).toHaveBeenCalledTimes(1);
    expect(emitParentLog).toHaveBeenCalledWith("root-1", "Failed to cancel child agent child-err: cancel exploded");
  });
});
