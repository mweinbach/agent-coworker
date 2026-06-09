import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentControl } from "../src/server/agents/AgentControl";
import { upsertAgentProfile } from "../src/server/agents/profiles";
import { parseChildAgentReport } from "../src/server/agents/reportParser";
import type { SeededSessionContext } from "../src/server/session/SessionContext";
import type { PersistedSessionRecord } from "../src/server/sessionDb";
import type { SessionBinding } from "../src/server/startServer/types";
import type { AgentConfig } from "../src/types";

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
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

async function makeTempConfig(overrides: Partial<AgentConfig> = {}): Promise<AgentConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-control-test-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return makeConfig({
    workingDirectory: workspace,
    outputDirectory: path.join(workspace, "output"),
    uploadsDirectory: path.join(workspace, "uploads"),
    projectCoworkDir: path.join(workspace, ".cowork"),
    userCoworkDir: path.join(home, ".cowork"),
    builtInDir: root,
    builtInConfigDir: path.join(root, "config"),
    ...overrides,
  });
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

function makePersistedChildRecord(
  config: AgentConfig,
  overrides: Partial<PersistedSessionRecord> = {},
): PersistedSessionRecord {
  const now = "2026-03-16T15:00:00.000Z";
  return {
    sessionId: "child-1",
    sessionKind: "agent",
    parentSessionId: "root-1",
    role: "worker",
    mode: "collaborative",
    depth: 1,
    nickname: null,
    taskType: null,
    targetPaths: null,
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
      todos: [
        { content: "Reproduce the bug", status: "completed", activeForm: "Reproducing the bug" },
      ],
      harnessContext: {
        runId: "run-1",
        objective: "Fix the review findings",
        acceptanceCriteria: ["Preserve parent transcript"],
        constraints: ["Do not lose session context"],
        updatedAt: "2026-03-16T15:00:00.000Z",
      },
    };
    const childSession = makeChildSession(childConfig);
    const buildSession = mock(
      (
        binding: SessionBinding,
        _persistedSessionId?: string,
        overrides?: Record<string, unknown>,
      ) => {
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false, overrides };
      },
    );
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

  test("rejects spawning beyond the maximum depth", async () => {
    const parentConfig = makeConfig();
    const control = new AgentControl({
      sessionBindings: new Map([
        [
          "root-1",
          {
            session: { isAgentOf: () => false, persistenceStatus: "active" },
            socket: null,
          },
        ],
      ]) as unknown as Map<string, SessionBinding>,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: (() => {
        throw new Error("buildSession should not run when the depth cap rejects");
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await expect(
      control.spawn({
        parentSessionId: "root-1",
        parentConfig,
        role: "worker",
        message: "Recurse",
        // A child (depth 1) trying to spawn — no role permits this.
        parentDepth: 1,
      }),
    ).rejects.toThrow(/maximum spawn depth/);
  });

  test("rejects spawning past the active-children limit", async () => {
    const parentConfig = makeConfig();
    const bindings = new Map<string, SessionBinding>([
      [
        "root-1",
        {
          session: { isAgentOf: () => false, persistenceStatus: "active" },
          socket: null,
        },
      ] as unknown as [string, SessionBinding],
    ]);
    for (let i = 0; i < 16; i += 1) {
      bindings.set(`child-${i}`, {
        session: {
          isAgentOf: (parent: string) => parent === "root-1",
          persistenceStatus: "active",
          // These 16 children are actively running, so they each occupy a slot.
          isBusy: true,
          getSessionInfoEvent: () => ({ executionState: "running" }),
          getLatestAssistantText: () => null,
        },
        socket: null,
      } as unknown as SessionBinding);
    }
    const control = new AgentControl({
      sessionBindings: bindings,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: (() => {
        throw new Error("buildSession should not run when the concurrency cap rejects");
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await expect(
      control.spawn({
        parentSessionId: "root-1",
        parentConfig,
        role: "worker",
        message: "One too many",
      }),
    ).rejects.toThrow(/active child agents/);
  });

  test("allows spawning when prior children have completed but remain open", async () => {
    const parentConfig = makeConfig();
    const childSession = makeChildSession(parentConfig);
    const bindings = new Map<string, SessionBinding>([
      [
        "root-1",
        {
          session: {
            isAgentOf: () => false,
            persistenceStatus: "active",
            buildForkContextSeed: () => ({ messages: [], todos: [], harnessContext: null }),
          },
          socket: null,
        },
      ] as unknown as [string, SessionBinding],
    ]);
    // 16 children that already finished: still open (persistenceStatus "active")
    // but idle (not busy, completed) — these must NOT occupy concurrency slots.
    for (let i = 0; i < 16; i += 1) {
      bindings.set(`done-${i}`, {
        session: {
          isAgentOf: (parent: string) => parent === "root-1",
          persistenceStatus: "active",
          isBusy: false,
          currentTurnOutcome: "completed",
          getSessionInfoEvent: () => ({ executionState: "completed" }),
          getLatestAssistantText: () => "done",
        },
        socket: null,
      } as unknown as SessionBinding);
    }
    const control = new AgentControl({
      sessionBindings: bindings,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await expect(
      control.spawn({
        parentSessionId: "root-1",
        parentConfig,
        role: "worker",
        message: "One more after the others finished",
      }),
    ).resolves.toBeDefined();
    expect(childSession.sendUserMessage).toHaveBeenCalledWith("One more after the others finished");
  });

  test("reserves slots so parallel spawns cannot race past the concurrency cap", async () => {
    const parentConfig = makeConfig();
    let nextId = 0;
    const bindings = new Map<string, SessionBinding>([
      [
        "root-1",
        {
          session: { isAgentOf: () => false, persistenceStatus: "active" },
          socket: null,
        },
      ] as unknown as [string, SessionBinding],
    ]);
    const makeUniqueChild = () => {
      const id = `child-${nextId++}`;
      return {
        id,
        sessionKind: "agent",
        parentSessionId: "root-1",
        role: "worker",
        persistenceStatus: "active",
        isBusy: false,
        currentTurnOutcome: "completed",
        isAgentOf: (parent: string) => parent === "root-1",
        beginDisconnectedReplayBuffer: () => {},
        sendUserMessage: async () => {},
        getSessionInfoEvent: () => ({ mode: "collaborative", depth: 1, executionState: "running" }),
        getLatestAssistantText: () => null,
        getPublicConfig: () => parentConfig,
        getCompactUsageSnapshot: () => null,
        getLastTurnUsage: () => null,
      } as any;
    };
    const control = new AgentControl({
      sessionBindings: bindings,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        const session = makeUniqueChild();
        binding.session = session;
        return { session, isResume: false, resumedFromStorage: false };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    // Fire many spawns at once. Without the synchronous slot reservation they
    // would all read the same pre-registration count of 0 and all succeed.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        control.spawn({ parentSessionId: "root-1", parentConfig, role: "worker", message: "go" }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toBe(16);
    expect(rejected).toHaveLength(4);
    expect(rejected[0]?.reason?.message).toMatch(/active child agents/);
  });

  test("builds a briefing seed with optional structured context when contextMode is brief", async () => {
    const parentConfig = makeConfig();
    const seedContext: SeededSessionContext = {
      messages: [
        { role: "user", content: "Parent briefing:\nFocus on the parser regression only." },
      ],
      todos: [
        { content: "Reproduce the bug", status: "completed", activeForm: "Reproducing the bug" },
      ],
      harnessContext: {
        runId: "run-1",
        objective: "Fix the review findings",
        acceptanceCriteria: ["Preserve the essential parent context"],
        constraints: ["Do not clone the full parent transcript"],
        updatedAt: "2026-03-16T15:00:00.000Z",
      },
    };
    const childSession = makeChildSession(parentConfig);
    const buildSession = mock(
      (
        binding: SessionBinding,
        _persistedSessionId?: string,
        overrides?: Record<string, unknown>,
      ) => {
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false, overrides };
      },
    );
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

  test("resolves profileRef before role and stores a profile snapshot on the child", async () => {
    const parentConfig = await makeTempConfig();
    await upsertAgentProfile(parentConfig, {
      version: 1,
      scope: "workspace",
      id: "research-review",
      displayName: "Research Review",
      description: "Research-focused profile.",
      enabled: true,
      baseRole: "research",
      prompt: "Use sourced claims only.",
      allowedBuiltInTools: ["read", "webSearch"],
      allowedMcpServers: ["github"],
      skillNames: ["source-pack-report"],
      model: "gpt-5-mini",
      reasoningEffort: "high",
      defaultTaskType: "verify",
      defaultContextMode: "brief",
    });
    const seedContext: SeededSessionContext = {
      messages: [{ role: "user", content: "Parent briefing:\nCheck the research plan." }],
      todos: [],
      harnessContext: null,
    };
    const childConfig = makeConfig({
      ...parentConfig,
      model: "gpt-5-mini",
      preferredChildModel: "gpt-5-mini",
    });
    const childSession = makeChildSession(childConfig);
    const baseInfo = childSession.getSessionInfoEvent;
    const buildContextSeed = mock(() => seedContext);
    const buildSession = mock(
      (
        binding: SessionBinding,
        _persistedSessionId?: string,
        overrides?: Record<string, unknown>,
      ) => {
        const sessionInfoPatch = overrides?.sessionInfoPatch as Record<string, unknown>;
        childSession.role = sessionInfoPatch.role;
        childSession.getSessionInfoEvent = () => ({
          ...baseInfo(),
          ...sessionInfoPatch,
        });
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false, overrides };
      },
    );
    const loadAgentPrompt = mock(
      async (_config: AgentConfig, role: string, profile: unknown) => "profile system prompt",
    );
    const control = new AgentControl({
      sessionBindings: new Map([
        [
          "root-1",
          {
            session: {
              buildForkContextSeed: mock(() => ({
                messages: [],
                todos: [],
                harnessContext: null,
              })),
              buildContextSeed,
            },
            socket: null,
          },
        ],
      ]) as Map<string, SessionBinding>,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: buildSession as any,
      loadAgentPrompt,
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    const summary = await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "reviewer",
      profileRef: "research-review",
      message: "Check the research plan.",
      briefing: "Check the research plan.",
    });

    expect(buildContextSeed).toHaveBeenCalledWith({
      contextMode: "brief",
      briefing: "Check the research plan.",
      includeParentTodos: false,
      includeHarnessContext: false,
    });
    expect(loadAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5-mini" }),
      "research",
      expect.objectContaining({
        id: "research-review",
        ref: "workspace:research-review",
        baseRole: "research",
        prompt: "Use sourced claims only.",
      }),
    );
    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        config: expect.objectContaining({ model: "gpt-5-mini" }),
        system: "profile system prompt",
        seedContext,
        sessionInfoPatch: expect.objectContaining({
          role: "research",
          taskType: "verify",
          profile: expect.objectContaining({
            id: "research-review",
            allowedMcpServers: ["github"],
            skillNames: ["source-pack-report"],
          }),
          requestedModel: "gpt-5-mini",
          effectiveModel: "gpt-5-mini",
          requestedReasoningEffort: "high",
          effectiveReasoningEffort: "high",
        }),
      }),
    );
    expect(summary.role).toBe("research");
    expect(summary.profile).toEqual(
      expect.objectContaining({
        id: "research-review",
        ref: "workspace:research-review",
      }),
    );
  });

  test("returns the post-dispatch running summary from spawn", async () => {
    const parentConfig = makeConfig();
    const childSession = makeChildSession(parentConfig);
    childSession.sendUserMessage = mock(() => new Promise<void>(() => {}));
    childSession.getSessionInfoEvent = () => ({
      type: "session_info",
      sessionId: "child-1",
      title: "Child session",
      titleSource: "default",
      titleModel: null,
      provider: parentConfig.provider,
      model: parentConfig.model,
      sessionKind: "agent",
      parentSessionId: "root-1",
      role: "worker",
      mode: "collaborative",
      depth: 1,
      nickname: "plan-auth",
      taskType: "plan",
      targetPaths: ["src/auth", "test/auth"],
      createdAt: "2026-03-16T15:00:00.000Z",
      updatedAt: "2026-03-16T15:00:00.000Z",
      effectiveModel: parentConfig.model,
      executionState: "pending_init",
    });
    const buildSession = mock((binding: SessionBinding) => {
      binding.session = childSession;
      return { session: childSession, isResume: false, resumedFromStorage: false };
    });
    const emitParentAgentStatus = mock(() => {});
    const control = new AgentControl({
      sessionBindings: new Map([
        [
          "root-1",
          {
            session: {
              buildForkContextSeed: () => ({ messages: [], todos: [], harnessContext: null }),
            },
            socket: null,
          },
        ],
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
      nickname: " plan-auth ",
      taskType: "plan",
      targetPaths: ["src/auth", " test/auth ", "src/auth"],
    });

    expect(summary.executionState).toBe("running");
    expect(summary.busy).toBe(true);
    expect(summary.nickname).toBe("plan-auth");
    expect(summary.taskType).toBe("plan");
    expect(summary.targetPaths).toEqual(["src/auth", "test/auth"]);
    expect(childSession.isBusy).toBe(false);
    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        sessionInfoPatch: expect.objectContaining({
          nickname: "plan-auth",
          taskType: "plan",
          targetPaths: ["src/auth", "test/auth"],
        }),
      }),
    );
    expect(emitParentAgentStatus).toHaveBeenLastCalledWith(
      "root-1",
      expect.objectContaining({
        agentId: "child-1",
        nickname: "plan-auth",
        taskType: "plan",
        targetPaths: ["src/auth", "test/auth"],
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
    const buildSession = mock(
      (
        binding: SessionBinding,
        _persistedSessionId?: string,
        overrides?: Record<string, unknown>,
      ) => {
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false, overrides };
      },
    );
    const control = new AgentControl({
      sessionBindings: new Map([
        [
          "root-1",
          {
            session: {
              buildForkContextSeed: () => ({ messages: [], todos: [], harnessContext: null }),
            },
            socket: null,
          },
        ],
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
    const buildSession = mock(
      (
        binding: SessionBinding,
        _persistedSessionId?: string,
        overrides?: Record<string, unknown>,
      ) => {
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false, overrides };
      },
    );
    const emitParentLog = mock(() => {});
    const control = new AgentControl({
      sessionBindings: new Map([
        [
          "root-1",
          {
            session: {
              buildForkContextSeed: () => ({ messages: [], todos: [], harnessContext: null }),
            },
            socket: null,
          },
        ],
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
      return {
        session: childSession,
        isResume: true,
        resumedFromStorage: true,
        persistedSessionId,
      };
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
      mode: "all",
    });

    expect(result.timedOut).toBe(false);
    expect(result.mode).toBe("all");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.executionState).toBe("completed");
    expect(result.readyAgentIds).toEqual(["child-1"]);
    expect(emitParentAgentStatus).toHaveBeenCalled();
  });

  test("wait keeps hydrated stale running child status running when no assistant result exists", async () => {
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
          sessionId === "child-1"
            ? makePersistedChildRecord(config, { executionState: "running" })
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

    const result = await control.wait({
      parentSessionId: "root-1",
      agentIds: ["child-1"],
      timeoutMs: 10,
    });

    expect(result.timedOut).toBe(true);
    expect(result.mode).toBe("any");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.executionState).toBe("running");
    expect(result.readyAgentIds).toEqual([]);
  });

  test("wait treats stale running child with an assistant result as completed", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    const getSessionInfoEvent = childSession.getSessionInfoEvent;
    childSession.getSessionInfoEvent = () => ({
      ...getSessionInfoEvent(),
      executionState: "running",
    });
    childSession.getLatestAssistantText = () =>
      'Finished\n\n<agent_report>{"status":"completed","summary":"Done"}</agent_report>';
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: {
        getSessionRecord: (sessionId: string) =>
          sessionId === "child-1"
            ? makePersistedChildRecord(config, { executionState: "running" })
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

    const result = await control.wait({
      parentSessionId: "root-1",
      agentIds: ["child-1"],
      timeoutMs: 10,
      includeFinalMessage: true,
      includeReport: true,
    });

    expect(result.timedOut).toBe(false);
    expect(result.agents[0]?.executionState).toBe("completed");
    expect(result.readyAgentIds).toEqual(["child-1"]);
    expect(result.inspections).toEqual([
      expect.objectContaining({
        agentId: "child-1",
        latestAssistantText: expect.stringContaining("Finished"),
        parsedReport: { status: "completed", summary: "Done" },
        reportValid: true,
      }),
    ]);
  });

  test("inspect returns latest assistant text, parsed report, and usage for hydrated children", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    childSession.getLatestAssistantText = () =>
      [
        "Finished the task.",
        "<agent_report>",
        JSON.stringify({
          status: "completed",
          summary: "Task finished",
          filesRead: ["src/agent.ts"],
        }),
        "</agent_report>",
      ].join("\n");
    childSession.getCompactUsageSnapshot = () => ({
      sessionId: "child-1",
      totalTurns: 1,
      totalPromptTokens: 5,
      totalCompletionTokens: 7,
      totalTokens: 12,
      estimatedTotalCostUsd: 0.01,
      costBreakdown: {
        inputCostUsd: 0.002,
        cachedInputCostUsd: 0,
        cacheWriteInputCostUsd: 0,
        outputCostUsd: 0.008,
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

    const inspected = await control.inspect({
      parentSessionId: "root-1",
      agentId: "child-1",
    });

    expect(inspected.agent.agentId).toBe("child-1");
    expect(inspected.latestAssistantText).toContain("Finished the task.");
    expect(inspected.parsedReport).toEqual(parseChildAgentReport(inspected.latestAssistantText));
    expect(inspected.parsedReport).toEqual(
      expect.objectContaining({
        status: "completed",
        summary: "Task finished",
        filesRead: ["src/agent.ts"],
      }),
    );
    expect(inspected.sessionUsage?.totalTokens).toBe(12);
    expect(inspected.lastTurnUsage?.totalTokens).toBe(12);
    expect(emitParentAgentStatus).toHaveBeenCalledWith(
      "root-1",
      expect.objectContaining({
        agentId: "child-1",
        lastMessagePreview: expect.stringContaining("Finished the task."),
        sessionUsage: expect.objectContaining({ estimatedTotalCostUsd: 0.01 }),
        lastTurnUsage: expect.objectContaining({ totalTokens: 12 }),
      }),
    );
  });

  test("inspect falls back to legacy fenced JSON when no tagged report exists", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    childSession.getLatestAssistantText = () =>
      [
        "Finished the task.",
        "```json",
        JSON.stringify({
          status: "completed",
          summary: "Legacy task finished",
          filesRead: ["src/legacy-agent.ts"],
        }),
        "```",
      ].join("\n");
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

    expect(inspected.parsedReport).toEqual(parseChildAgentReport(inspected.latestAssistantText));
    expect(inspected.parsedReport).toEqual(
      expect.objectContaining({
        status: "completed",
        summary: "Legacy task finished",
        filesRead: ["src/legacy-agent.ts"],
      }),
    );
  });

  test("list keeps hydrated stale pending_init child status pending when no assistant result exists", async () => {
    const config = makeConfig();
    const childSession = makeChildSession(config);
    const getSessionInfoEvent = childSession.getSessionInfoEvent;
    childSession.getSessionInfoEvent = () => ({
      ...getSessionInfoEvent(),
      executionState: "pending_init",
    });
    const control = new AgentControl({
      sessionBindings: new Map([["child-1", { session: childSession, socket: null }]]) as Map<
        string,
        SessionBinding
      >,
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
    expect(summaries[0]?.executionState).toBe("pending_init");
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

    expect(childSession.closeForHistory).toHaveBeenCalledWith({ closeSharedCodexClient: false });
    expect(disposeBinding).toHaveBeenCalledWith(expect.anything(), "parent closed child agent", {
      closeSharedCodexClient: false,
    });
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
    expect(emitParentLog).toHaveBeenCalledWith(
      "root-1",
      "Failed to cancel child agent child-err: cancel exploded",
    );
  });
});
