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
    waitForPersistenceIdle: mock(async (_opts?: { throwOnError?: boolean }) => {}),
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
    cancelAndWaitForSettlement: mock(async (_opts?: { timeoutMs?: number }) => {
      session.cancel();
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

function makeControlWithChildren(children: ReturnType<typeof makeChildSession>[]) {
  const bindings = new Map<string, SessionBinding>(
    children.map((session) => [
      session.id,
      { session, runtime: null, socket: null, sinks: new Map() },
    ]),
  );
  return new AgentControl({
    sessionBindings: bindings,
    sessionDb: null,
    getConnectedProviders: async () => ["openai"],
    buildSession: () => {
      throw new Error("A registered child should not be rebuilt");
    },
    loadAgentPrompt: async () => "child system prompt",
    disposeBinding: () => {},
    emitParentAgentStatus: () => {},
    emitParentLog: () => {},
  });
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
  test("appends an internal system prompt suffix for workflow children", async () => {
    const parentConfig = makeConfig();
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
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: buildSession as any,
      loadAgentPrompt: async () => "child system prompt\n",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "research",
      message: "Return structured data",
      systemPromptSuffix: "workflow schema mode",
    });

    expect(buildSession).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        system: "child system prompt\n\nworkflow schema mode",
      }),
    );
  });

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

  test("waits for initial persistence before starting the child turn", async () => {
    const parentConfig = makeConfig();
    const childSession = makeChildSession(parentConfig);
    const barrierEntered = Promise.withResolvers<void>();
    const releaseBarrier = Promise.withResolvers<void>();
    childSession.waitForPersistenceIdle = mock(async (opts?: { throwOnError?: boolean }) => {
      expect(opts).toEqual({ throwOnError: true });
      barrierEntered.resolve();
      await releaseBarrier.promise;
    });
    const control = new AgentControl({
      sessionBindings: new Map(),
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

    const spawn = control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      message: "Start after persistence",
      contextMode: "none",
    });
    await barrierEntered.promise;

    expect(childSession.sendUserMessage).not.toHaveBeenCalled();
    releaseBarrier.resolve();
    await spawn;
    expect(childSession.sendUserMessage).toHaveBeenCalledWith("Start after persistence");
  });

  test("does not start a child turn when initial persistence fails", async () => {
    const parentConfig = makeConfig();
    const childSession = makeChildSession(parentConfig);
    const persistenceError = new Error("session DB write lock timed out");
    childSession.waitForPersistenceIdle = mock(async () => {
      throw persistenceError;
    });
    const deleteSession = mock(async () => {});
    const disposeBinding = mock(() => {});
    const emitParentAgentStatus = mock(() => {});
    const sessionBindings = new Map<string, SessionBinding>();
    const control = new AgentControl({
      sessionBindings,
      sessionDb: { deleteSession } as any,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding,
      emitParentAgentStatus,
      emitParentLog: () => {},
    });

    await expect(
      control.spawn({
        parentSessionId: "root-1",
        parentConfig,
        role: "worker",
        message: "Must not start",
        contextMode: "none",
      }),
    ).rejects.toBe(persistenceError);

    expect(childSession.sendUserMessage).not.toHaveBeenCalled();
    expect(emitParentAgentStatus).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith(childSession.id);
    expect(sessionBindings.has(childSession.id)).toBe(false);
    expect(disposeBinding).toHaveBeenCalledWith(
      expect.anything(),
      "child spawn failed before execution",
      { closeSharedCodexClient: false },
    );
  });

  test("preserves the initial persistence error when orphaned child cleanup also fails", async () => {
    const parentConfig = makeConfig();
    const childSession = makeChildSession(parentConfig);
    const persistenceError = new Error("session snapshot write failed");
    const cleanupError = new Error("session cleanup write lock timed out");
    childSession.waitForPersistenceIdle = mock(async () => {
      throw persistenceError;
    });
    const deleteSession = mock(async () => {
      throw cleanupError;
    });
    const emitParentLog = mock(() => {});
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: { deleteSession } as any,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog,
    });

    await expect(
      control.spawn({
        parentSessionId: "root-1",
        parentConfig,
        role: "worker",
        message: "Must not start",
        contextMode: "none",
      }),
    ).rejects.toBe(persistenceError);

    expect(deleteSession).toHaveBeenCalledWith(childSession.id);
    expect(emitParentLog).toHaveBeenCalledWith(
      "root-1",
      expect.stringContaining(cleanupError.message),
    );
  });

  test("admits all 16 children awaiting initial persistence without double-counting reservations", async () => {
    const parentConfig = makeConfig();
    const persistenceGate = Promise.withResolvers<void>();
    const admissions = Array.from({ length: 16 }, () => Promise.withResolvers<void>());
    const pendingSpawns: Array<Promise<unknown>> = [];
    let nextChildIndex = 0;
    const control = new AgentControl({
      sessionBindings: new Map(),
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        const childIndex = nextChildIndex++;
        const childSession = makeChildSession(parentConfig);
        childSession.id = `child-${childIndex}`;
        childSession.getLatestAssistantText = () => "Inherited parent assistant message";
        childSession.waitForPersistenceIdle = mock(async () => {
          admissions[childIndex]?.resolve();
          await persistenceGate.promise;
        });
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    try {
      for (let childIndex = 0; childIndex < admissions.length; childIndex += 1) {
        const spawn = control.spawn({
          parentSessionId: "root-1",
          parentConfig,
          role: "worker",
          message: `Start child ${childIndex}`,
          contextMode: "none",
        });
        pendingSpawns.push(spawn);

        const admission = await Promise.race([
          admissions[childIndex]!.promise.then(() => "admitted"),
          spawn.then(
            () => "completed",
            (error: unknown) => error,
          ),
        ]);
        expect(admission).toBe("admitted");
      }

      const initializing = await control.list("root-1");
      expect(initializing).toHaveLength(16);
      expect(initializing.every((child) => child.executionState === "pending_init")).toBe(true);

      await expect(
        control.spawn({
          parentSessionId: "root-1",
          parentConfig,
          role: "worker",
          message: "One too many",
          contextMode: "none",
        }),
      ).rejects.toThrow(/active child agents \(limit 16\)/);
    } finally {
      persistenceGate.resolve();
      await Promise.allSettled(pendingSpawns);
    }
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

  test("rejects spawning past the active-children limit while children are running", async () => {
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
        waitForPersistenceIdle: async () => {},
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

  test("releases a reserved spawn slot when setup fails before binding registration", async () => {
    const parentConfig = makeConfig();
    const turnGate = Promise.withResolvers<void>();
    let nextId = 0;
    let promptLoads = 0;
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
        waitForPersistenceIdle: async () => {},
        sendUserMessage: async () => await turnGate.promise,
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
      loadAgentPrompt: async () => {
        promptLoads += 1;
        if (promptLoads === 1) {
          throw new Error("prompt load failed");
        }
        return "child system prompt";
      },
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await expect(
      control.spawn({
        parentSessionId: "root-1",
        parentConfig,
        role: "worker",
        message: "first attempt fails before a child is registered",
      }),
    ).rejects.toThrow("prompt load failed");

    try {
      const results = await Promise.allSettled(
        Array.from({ length: 16 }, () =>
          control.spawn({ parentSessionId: "root-1", parentConfig, role: "worker", message: "go" }),
        ),
      );
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);

      await expect(
        control.spawn({
          parentSessionId: "root-1",
          parentConfig,
          role: "worker",
          message: "one too many after the failed attempt",
        }),
      ).rejects.toThrow(/active child agents/);
    } finally {
      turnGate.resolve();
    }
  });

  test("cancelAll waits for pending child spawn registration before settling", async () => {
    const parentConfig = makeConfig();
    const childSession = makeChildSession(parentConfig);
    const loadPromptEntered = Promise.withResolvers<void>();
    const releaseLoadPrompt = Promise.withResolvers<void>();
    childSession.cancelAndWaitForSettlement = mock(async () => {
      childSession.cancel();
    });
    const bindings = new Map<string, SessionBinding>([
      [
        "root-1",
        {
          session: { isAgentOf: () => false, persistenceStatus: "active" },
          socket: null,
        },
      ] as unknown as [string, SessionBinding],
    ]);
    const control = new AgentControl({
      sessionBindings: bindings,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = childSession;
        return { session: childSession, isResume: false, resumedFromStorage: false };
      }) as any,
      loadAgentPrompt: async () => {
        loadPromptEntered.resolve();
        await releaseLoadPrompt.promise;
        return "child system prompt";
      },
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    const spawnPromise = control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      role: "worker",
      message: "start child work",
    });
    await loadPromptEntered.promise;

    let cancelResolved = false;
    const cancelPromise = control.cancelAll("root-1", { timeoutMs: 1_000 }).then(() => {
      cancelResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelResolved).toBe(false);

    releaseLoadPrompt.resolve();
    await spawnPromise;
    await cancelPromise;

    expect(childSession.cancelAndWaitForSettlement).toHaveBeenCalledTimes(1);
    expect(cancelResolved).toBe(true);
  });

  test("cancelAll drains interrupt replacement generations to a fixed point", async () => {
    const parentConfig = makeConfig();
    const childSession = makeChildSession(parentConfig);
    childSession.isBusy = false;
    const firstRunEntered = Promise.withResolvers<void>();
    const releaseFirstRun = Promise.withResolvers<void>();
    const replacementRunEntered = Promise.withResolvers<void>();
    const releaseReplacementRun = Promise.withResolvers<void>();
    let runIndex = 0;
    let currentRunSettled: Promise<void> = Promise.resolve();
    childSession.sendUserMessage = mock(async () => {
      runIndex += 1;
      if (runIndex === 1) {
        childSession.isBusy = true;
        currentRunSettled = releaseFirstRun.promise.finally(() => {
          childSession.isBusy = false;
        });
        firstRunEntered.resolve();
        await currentRunSettled;
        return;
      }
      childSession.isBusy = true;
      currentRunSettled = releaseReplacementRun.promise.finally(() => {
        childSession.isBusy = false;
      });
      replacementRunEntered.resolve();
      await currentRunSettled;
    });
    childSession.cancel = mock(() => {
      childSession.isBusy = false;
    });
    childSession.cancelAndWaitForSettlement = mock(async () => {
      childSession.cancel();
      await currentRunSettled;
    });
    const control = new AgentControl({
      sessionBindings: new Map([["child-1", { session: childSession, socket: null }]]) as Map<
        string,
        SessionBinding
      >,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: (() => {
        throw new Error("unused");
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    await control.sendInput({
      parentSessionId: "root-1",
      agentId: "child-1",
      message: "first child run",
    });
    await firstRunEntered.promise;

    const replacement = control.sendInput({
      parentSessionId: "root-1",
      agentId: "child-1",
      message: "replacement child run",
      interrupt: true,
    });
    await Promise.resolve();
    const cancelled = control.cancelAll("root-1", { timeoutMs: 1_000 });

    releaseFirstRun.resolve();
    await replacementRunEntered.promise;
    await replacement;
    await expect(
      Promise.race([
        cancelled.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]),
    ).resolves.toBe("pending");

    releaseReplacementRun.resolve();
    await expect(cancelled).resolves.toBeUndefined();
    expect(childSession.cancelAndWaitForSettlement).toHaveBeenCalledTimes(1);
    expect(childSession.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  test("late spawn lock restores an existing binding and disposes only the new child", async () => {
    const parentConfig = makeConfig();
    const existingChild = makeChildSession(parentConfig);
    const getExistingChildInfo = existingChild.getSessionInfoEvent;
    existingChild.getSessionInfoEvent = () => ({
      ...getExistingChildInfo(),
      executionState: "completed",
    });
    const newChild = makeChildSession(parentConfig);
    const existingBinding = { session: existingChild, socket: null } as unknown as SessionBinding;
    const bindings = new Map<string, SessionBinding>([
      [
        "root-1",
        { session: { isAgentOf: () => false, persistenceStatus: "active" }, socket: null },
      ],
      ["child-1", existingBinding],
    ] as unknown as Array<[string, SessionBinding]>);
    const disposeBinding = mock(() => {});
    let lockChecks = 0;
    const control = new AgentControl({
      sessionBindings: bindings,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = newChild;
        return { session: newChild, isResume: false, resumedFromStorage: false };
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding,
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
      getParentTaskLock: () => {
        lockChecks += 1;
        return lockChecks >= 3
          ? {
              message: "Parent task is finalizing cancelled.",
              data: {
                category: "task_locked",
                source: "session",
                lockKind: "terminal_task_thread",
                taskId: "task-1",
                taskStatus: "cancelled",
              },
            }
          : null;
      },
    });

    await expect(
      control.spawn({
        parentSessionId: "root-1",
        parentConfig,
        role: "worker",
        message: "blocked child work",
      }),
    ).rejects.toThrow("Parent task is finalizing cancelled.");

    expect(bindings.get("child-1")).toBe(existingBinding);
    expect(disposeBinding).toHaveBeenCalledTimes(1);
    expect(disposeBinding.mock.calls[0]?.[0]).not.toBe(existingBinding);
    expect(newChild.sendUserMessage).not.toHaveBeenCalled();
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

  test("rejects a blocked cross-provider ref before building a child session", async () => {
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

    await expect(
      control.spawn({
        parentSessionId: "root-1",
        parentConfig,
        role: "worker",
        model: "opencode-go:glm-5",
        message: "Investigate with exact target",
      }),
    ).rejects.toThrow(/not in this workspace allowlist/);

    expect(buildSession).not.toHaveBeenCalled();
    expect(emitParentLog).not.toHaveBeenCalled();
  });
});

describe("AgentControl admission settlement", () => {
  function makeAdmissionHarness(loadAgentPrompt: () => Promise<string>) {
    const parentConfig = makeConfig();
    const child = makeChildSession(parentConfig);
    const spawnedChild = makeChildSession(parentConfig);
    spawnedChild.id = "child-2";
    const bindings = new Map<string, SessionBinding>([
      [child.id, { session: child, runtime: null, socket: null, sinks: new Map() }],
    ]);
    const control = new AgentControl({
      sessionBindings: bindings,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: ((binding: SessionBinding) => {
        binding.session = spawnedChild;
        return { session: spawnedChild, isResume: false, resumedFromStorage: false };
      }) as any,
      loadAgentPrompt,
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });
    return { control, parentConfig, child, spawnedChild };
  }

  test("cancelAll drains mixed spawn and deferred interrupt admissions without blocking another parent", async () => {
    const promptEntered = Promise.withResolvers<void>();
    const releasePrompt = Promise.withResolvers<string>();
    const firstRun = Promise.withResolvers<void>();
    const replacementRun = Promise.withResolvers<void>();
    const cancellationEntered = Promise.withResolvers<void>();
    const { control, parentConfig, child, spawnedChild } = makeAdmissionHarness(async () => {
      promptEntered.resolve();
      return await releasePrompt.promise;
    });
    child.sendUserMessage = mock(async (message: string) => {
      await (message === "first" ? firstRun.promise : replacementRun.promise);
    });
    child.cancelAndWaitForSettlement = mock(async () => {
      child.cancel();
      cancellationEntered.resolve();
      await replacementRun.promise;
    });
    await control.sendInput({ parentSessionId: "root-1", agentId: child.id, message: "first" });

    const spawned = control.spawn({
      parentSessionId: "root-1",
      parentConfig,
      message: "spawn alongside replacement",
    });
    const replacement = control.sendInput({
      parentSessionId: "root-1",
      agentId: child.id,
      message: "replacement",
      interrupt: true,
    });
    let cancellationSettled = false;
    const cancelled = control.cancelAll("root-1", { timeoutMs: 1_000 }).then(() => {
      cancellationSettled = true;
    });
    try {
      expect(child.cancel).not.toHaveBeenCalled();
      expect(child.sendUserMessage).toHaveBeenCalledTimes(1);
      await promptEntered.promise;
      await expect(control.cancelAll("other-root", { timeoutMs: 0 })).resolves.toBeUndefined();
      releasePrompt.resolve("child system prompt");
      await spawned;
      expect(child.cancel).toHaveBeenCalledTimes(1);
      expect(child.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(child.cancelAndWaitForSettlement).not.toHaveBeenCalled();
      expect(spawnedChild.cancelAndWaitForSettlement).not.toHaveBeenCalled();

      firstRun.resolve();
      await replacement;
      await cancellationEntered.promise;
      expect(child.sendUserMessage).toHaveBeenCalledTimes(2);
      expect(cancellationSettled).toBe(false);
      replacementRun.resolve();
      await cancelled;
      expect(child.cancelAndWaitForSettlement).toHaveBeenCalledTimes(1);
      expect(spawnedChild.cancelAndWaitForSettlement).toHaveBeenCalledTimes(1);
      expect(cancellationSettled).toBe(true);
    } finally {
      releasePrompt.resolve("child system prompt");
      firstRun.resolve();
      replacementRun.resolve();
      await Promise.allSettled([spawned, replacement, cancelled]);
    }
  });

  test("rejected spawn and deferred input admissions are removed without poisoning cancellation", async () => {
    const promptEntered = Promise.withResolvers<void>();
    const releasePrompt = Promise.withResolvers<string>();
    const spawnError = new Error("prompt load failed");
    const { control, parentConfig, child, spawnedChild } = makeAdmissionHarness(async () => {
      promptEntered.resolve();
      return await releasePrompt.promise;
    });
    child.isBusy = true;
    const admissions = Promise.allSettled([
      control.spawn({ parentSessionId: "root-1", parentConfig, message: "failing spawn" }),
      control.sendInput({ parentSessionId: "root-1", agentId: child.id, message: "busy input" }),
    ]);
    const cancelled = control.cancelAll("root-1", { timeoutMs: 1_000 });
    try {
      await promptEntered.promise;
      expect(child.cancelAndWaitForSettlement).not.toHaveBeenCalled();
      releasePrompt.reject(spawnError);
      const results = await admissions;
      expect(results[0]).toEqual({ status: "rejected", reason: spawnError });
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: { message: "Child agent child-1 is busy" },
      });
      await expect(cancelled).resolves.toBeUndefined();
      expect(child.cancelAndWaitForSettlement).toHaveBeenCalledTimes(1);
      expect(spawnedChild.sendUserMessage).not.toHaveBeenCalled();
      expect(child.sendUserMessage).not.toHaveBeenCalled();
      await expect(control.cancelAll("root-1", { timeoutMs: 0 })).resolves.toBeUndefined();
      await control.sendInput({ parentSessionId: "root-1", agentId: child.id, message: "retry" });
      expect(child.sendUserMessage).toHaveBeenCalledTimes(1);
      await expect(control.cancelAll("root-1", { timeoutMs: 0 })).resolves.toBeUndefined();
    } finally {
      releasePrompt.reject(spawnError);
      await Promise.allSettled([admissions, cancelled]);
    }
  });
});

describe("AgentControl persisted child control", () => {
  test("reserves a follow-up before the child reports busy", async () => {
    const child = makeChildSession(makeConfig());
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    child.sendUserMessage = mock(async () => {
      await pending;
    });
    const control = makeControlWithChildren([child]);
    try {
      await control.sendInput({
        parentSessionId: "root-1",
        agentId: child.id,
        message: "First follow-up",
      });
      await expect(
        control.sendInput({
          parentSessionId: "root-1",
          agentId: child.id,
          message: "Competing follow-up",
        }),
      ).rejects.toThrow("busy");
      expect(child.sendUserMessage).toHaveBeenCalledTimes(1);
      const waiting = await control.wait({
        parentSessionId: "root-1",
        agentIds: [child.id],
        timeoutMs: 0,
      });
      expect(waiting.timedOut).toBe(true);
      expect(waiting.agents[0]?.executionState).toBe("running");
      expect((await control.list("root-1"))[0]).toMatchObject({
        executionState: "running",
        busy: true,
      });
      expect(
        (await control.inspect({ parentSessionId: "root-1", agentId: child.id })).agent,
      ).toMatchObject({ executionState: "running", busy: true });
    } finally {
      finish();
    }
  });

  test("limits resumed children even while their follow-up startup is pending", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const children = Array.from({ length: 17 }, (_, index) => {
      const child = makeChildSession(makeConfig());
      child.id = `completed-${index}`;
      const getInfo = child.getSessionInfoEvent;
      child.getSessionInfoEvent = () => ({ ...getInfo(), executionState: "completed" });
      child.getLatestAssistantText = () => "Previous result";
      child.sendUserMessage = mock(async () => {
        await pending;
      });
      return child;
    });
    const control = makeControlWithChildren(children);
    try {
      const outcomes = await Promise.allSettled(
        children.map((child) =>
          control.sendInput({
            parentSessionId: "root-1",
            agentId: child.id,
            message: "Continue",
          }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(16);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(children.at(-1)?.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      finish();
    }
  });

  test("explicit follow-up starts a fresh run for an interrupted child", async () => {
    const child = makeChildSession(makeConfig());
    const turnGate = Promise.withResolvers<void>();
    let executionState = "errored";
    const getInfo = child.getSessionInfoEvent;
    child.getSessionInfoEvent = () => ({ ...getInfo(), executionState });
    child.currentTurnOutcome = "error";
    child.getLatestAssistantText = () => "Previous partial work";
    child.sendUserMessage = mock(async () => {
      await turnGate.promise;
      child.currentTurnOutcome = "completed";
      executionState = "completed";
    });
    const control = makeControlWithChildren([child]);
    try {
      await control.sendInput({
        parentSessionId: "root-1",
        agentId: child.id,
        message: "Inspect the interruption and continue",
      });
      expect(
        (await control.inspect({ parentSessionId: "root-1", agentId: child.id })).agent,
      ).toMatchObject({ executionState: "running", busy: true });
      turnGate.resolve();
      const result = await control.wait({
        parentSessionId: "root-1",
        agentIds: [child.id],
        timeoutMs: 1_000,
      });
      expect(result.readyAgentIds).toEqual([child.id]);
      expect(result.erroredAgentIds).toEqual([]);
      expect(result.agents[0]?.executionState).toBe("completed");
    } finally {
      turnGate.resolve();
    }
  });

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

  test("wait reports interrupted child execution as errored when no assistant result exists", async () => {
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

    expect(result.timedOut).toBe(false);
    expect(result.mode).toBe("any");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.executionState).toBe("errored");
    expect(result.readyAgentIds).toEqual(["child-1"]);
    expect(result.erroredAgentIds).toEqual(["child-1"]);
  });

  test("wait does not mistake inherited assistant text for interrupted child completion", async () => {
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
    expect(result.agents[0]?.executionState).toBe("errored");
    expect(result.readyAgentIds).toEqual(["child-1"]);
    expect(result.erroredAgentIds).toEqual(["child-1"]);
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

  test("list marks an unowned persisted pending_init child errored", async () => {
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
    expect(summaries[0]?.executionState).toBe("errored");
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

  test("cancelAll waits for child sessions to settle after cancellation", async () => {
    const config = makeConfig();
    const childSettled = Promise.withResolvers<void>();
    const childSession = makeChildSession(config);
    childSession.cancelAndWaitForSettlement = mock(async (opts?: { timeoutMs?: number }) => {
      expect(opts?.timeoutMs).toBeGreaterThan(0);
      expect(opts?.timeoutMs).toBeLessThanOrEqual(75);
      await childSettled.promise;
    });
    const control = new AgentControl({
      sessionBindings: new Map([["child-1", { session: childSession, socket: null }]]) as Map<
        string,
        SessionBinding
      >,
      sessionDb: null,
      getConnectedProviders: async () => ["openai"],
      buildSession: (() => {
        throw new Error("unused");
      }) as any,
      loadAgentPrompt: async () => "child system prompt",
      disposeBinding: () => {},
      emitParentAgentStatus: () => {},
      emitParentLog: () => {},
    });

    const cancelled = control.cancelAll("root-1", { timeoutMs: 75 });
    await Promise.resolve();

    expect(childSession.cancelAndWaitForSettlement).toHaveBeenCalledTimes(1);
    await expect(
      Promise.race([
        cancelled.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]),
    ).resolves.toBe("pending");

    childSettled.resolve();
    await expect(cancelled).resolves.toBeUndefined();
  });

  test("cancelAll continues cancelling siblings after one child throws", async () => {
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

    await expect(control.cancelAll("root-1")).rejects.toThrow("cancel exploded");
    expect(firstChild.cancel).toHaveBeenCalledTimes(1);
    expect(secondChild.cancel).toHaveBeenCalledTimes(1);
    expect(emitParentLog).toHaveBeenCalledWith(
      "root-1",
      "Failed to cancel child agent child-err: cancel exploded",
    );
  });
});
