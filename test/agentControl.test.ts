import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import { AgentControl } from "../src/server/agents/AgentControl";
import type { SeededSessionContext } from "../src/server/session/SessionContext";
import type { AgentConfig } from "../src/types";
import type { SessionBinding } from "../src/server/startServer/types";

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
  return {
    id: "child-1",
    sessionKind: "agent",
    parentSessionId: "root-1",
    role: "worker",
    persistenceStatus: "active",
    isBusy: false,
    currentTurnOutcome: "completed",
    beginDisconnectedReplayBuffer: mock(() => {}),
    sendUserMessage,
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
