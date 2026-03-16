import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import { AgentControl } from "../src/server/agents/AgentControl";
import type { SeededSessionContext } from "../src/server/session/SessionContext";
import type { AgentConfig } from "../src/types";
import type { SessionBinding } from "../src/server/startServer/types";
import type { PersistedSessionRecord } from "../src/server/sessionDb";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = "/tmp/agent-control";
  return {
    provider: "openai",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5.4-mini",
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
  test("passes a forked parent context seed into child session creation", async () => {
    const parentConfig = makeConfig();
    const childConfig = makeConfig({ model: "gpt-5.4-mini" });
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
    const control = new AgentControl({
      sessionBindings: new Map([
        ["root-1", { session: { buildForkContextSeed }, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
    });

    await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      message: "Handle the fix",
      forkContext: true,
    });

    expect(buildForkContextSeed).toHaveBeenCalledTimes(1);
    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        seedContext,
      }),
    );
    expect(childSession.sendUserMessage).toHaveBeenCalledWith("Handle the fix");
  });

  test("does not seed parent context when forkContext is omitted", async () => {
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
    const control = new AgentControl({
      sessionBindings: new Map([
        ["root-1", { session: { buildForkContextSeed }, socket: null }],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
    });

    await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      message: "Handle the fix",
    });

    expect(buildForkContextSeed).not.toHaveBeenCalled();
    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.not.objectContaining({
        seedContext: expect.anything(),
      }),
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
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
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
    const emitParentAgentStatus = mock(() => {});
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: {
        getSessionRecord: (sessionId: string) =>
          sessionId === "child-1" ? makePersistedChildRecord(config) : null,
      } as any,
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: true, resumedFromStorage: true };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus,
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

  test("resume reopens a hydrated closed child session", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    childSession.persistenceStatus = "closed";
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: {
        getSessionRecord: (sessionId: string) =>
          sessionId === "child-1"
            ? makePersistedChildRecord(config, { status: "closed", executionState: "closed" })
            : null,
      } as any,
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: true, resumedFromStorage: true };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
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
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: true, resumedFromStorage: true };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding,
      emitParentAgentStatus: () => {},
    });

    const summary = await control.close({
      parentSessionId: "root-1",
      agentId: "child-1",
    });

    expect(childSession.closeForHistory).toHaveBeenCalledTimes(1);
    expect(disposeBinding).toHaveBeenCalledWith(expect.anything(), "parent closed child agent");
    expect(summary.executionState).toBe("closed");
  });
});
