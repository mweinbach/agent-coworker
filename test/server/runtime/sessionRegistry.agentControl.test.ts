import { describe, expect, mock, test } from "bun:test";

import { SessionRegistry } from "../../../src/server/runtime/SessionRegistry";
import type { SessionDependencies } from "../../../src/server/session/SessionContext";
import type { SessionBinding } from "../../../src/server/startServer/types";

function createDeletionHarness() {
  const flushingStarted = Promise.withResolvers<void>();
  const pendingPersistence = Promise.withResolvers<void>();
  const operations: string[] = [];
  const createBinding = (id: string, parentSessionId: string | null) => {
    const cancelAndWaitForSettlement = mock(async () => {
      operations.push(`settled:${id}`);
    });
    const dispose = mock(() => {
      operations.push(`disposed:${id}`);
    });
    const waitForPersistenceIdle = mock(async () => {
      if (id === "grandchild") {
        flushingStarted.resolve();
        await pendingPersistence.promise;
      }
      operations.push(`persisted:${id}`);
    });
    const binding = {
      session: null,
      socket: { close: mock(() => {}) },
      sinks: new Map([[`journal:${id}`, () => {}]]),
      runtime: {
        id,
        read: {
          parentSessionId,
          sessionKind: parentSessionId ? "agent" : "root",
          workingDirectory: "/workspace",
          isAgentOf: (parentId: string) => parentSessionId === parentId,
        },
        turns: { cancel: mock(() => {}), cancelAndWaitForSettlement },
        lifecycle: { dispose, waitForPersistenceIdle },
      },
    } as unknown as SessionBinding;
    return { binding, cancelAndWaitForSettlement, dispose, waitForPersistenceIdle };
  };
  const root = createBinding("root", null);
  const grandchild = createBinding("grandchild", "persisted-child");
  const liveDescendant = createBinding("live-descendant", "grandchild");
  const unrelated = createBinding("unrelated", null);
  const deleteSession = mock(async (_sessionId: string) => {
    operations.push("deleted");
  });
  const taskCoordinator = { isTaskThread: mock(() => false) };
  const getActiveTaskForSourceSession = mock((): { id: string } | null => null);
  const waitForJournalIdle = mock(async (sessionId: string) => {
    operations.push(`journal:${sessionId}`);
  });
  const registry = Object.assign(Object.create(SessionRegistry.prototype), {
    config: { userCoworkDir: "/workspace/.cowork", projectCoworkDir: "/workspace/.cowork" },
    discoveredSkills: [],
    options: {
      env: {},
      sessionDb: {
        getActiveTaskForSourceSession,
        getSessionRecord: () => ({ workingDirectory: "/workspace" }),
        listSessionTreeIds: () => ["root", "persisted-child", "grandchild"],
        listAgentSessions: () => [{ agentId: "persisted-child" }],
        deleteSession,
      },
      taskCoordinator,
      threadJournal: { waitForIdle: waitForJournalIdle },
    },
    sessionBindings: new Map([
      ["live-descendant", liveDescendant.binding],
      ["grandchild", grandchild.binding],
      ["persisted-child", { session: null, runtime: null, socket: null, sinks: new Map() }],
      ["root", root.binding],
      ["unrelated", unrelated.binding],
    ]),
    sessionIdleSince: new Map([
      ["grandchild", 0],
      ["persisted-child", 0],
    ]),
  }) as SessionRegistry;
  const dependencies = (
    registry as unknown as {
      buildSessionCommon: (binding: SessionBinding) => Partial<SessionDependencies>;
    }
  ).buildSessionCommon(root.binding);
  if (!dependencies.deleteSessionImpl) throw new Error("Missing session deletion handler");
  return {
    registry,
    root,
    grandchild,
    liveDescendant,
    unrelated,
    deleteSession,
    deleteSessionImpl: dependencies.deleteSessionImpl,
    flushingStarted,
    pendingPersistence,
    operations,
    taskCoordinator,
    getActiveTaskForSourceSession,
    waitForJournalIdle,
    createBinding,
  };
}

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

  test("settles and flushes every descendant before deleting a session tree", async () => {
    const harness = createDeletionHarness();
    const deletion = harness.deleteSessionImpl({
      requesterSessionId: "requester",
      targetSessionId: "root",
    });
    try {
      await Promise.race([deletion, harness.flushingStarted.promise]);

      expect(harness.deleteSession).not.toHaveBeenCalled();
      for (const session of [harness.root, harness.grandchild, harness.liveDescendant]) {
        expect(session.cancelAndWaitForSettlement).toHaveBeenCalledWith({
          includeSubagents: false,
          timeoutMs: 5_000,
        });
        expect(session.dispose).toHaveBeenCalledWith("session root deleted", {
          closeSharedCodexClient: false,
        });
      }
      expect(harness.unrelated.dispose).not.toHaveBeenCalled();

      harness.pendingPersistence.resolve();
      await deletion;

      expect(harness.operations.at(-1)).toBe("deleted");
      expect(harness.operations).toContain("persisted:grandchild");
      expect(harness.deleteSession).toHaveBeenCalledWith("root");
      for (const sessionId of ["root", "persisted-child", "grandchild", "live-descendant"]) {
        expect(harness.registry.sessionBindings.has(sessionId)).toBe(false);
        expect(harness.registry.sessionIdleSince.has(sessionId)).toBe(false);
        expect(harness.waitForJournalIdle).toHaveBeenCalledWith(sessionId);
      }
      expect(harness.registry.sessionBindings.has("unrelated")).toBe(true);
    } finally {
      harness.pendingPersistence.resolve();
      await deletion;
    }
  });

  test("preserves database rows when a descendant turn cannot settle", async () => {
    const harness = createDeletionHarness();
    harness.grandchild.cancelAndWaitForSettlement.mockRejectedValueOnce(
      new Error("descendant turn did not settle"),
    );
    harness.pendingPersistence.resolve();

    await expect(
      harness.deleteSessionImpl({ requesterSessionId: "requester", targetSessionId: "root" }),
    ).rejects.toThrow("descendant turn did not settle");

    expect(harness.deleteSession).not.toHaveBeenCalled();
    expect(harness.root.dispose).not.toHaveBeenCalled();
    expect(harness.registry.sessionBindings.has("root")).toBe(true);
  });

  test("settles parents before discovering children created by an in-flight spawn", async () => {
    const harness = createDeletionHarness();
    const rootStarted = Promise.withResolvers<void>();
    const rootSettled = Promise.withResolvers<void>();
    const lateChild = harness.createBinding("late-child", "root");
    const lateDescendant = harness.createBinding("late-descendant", "grandchild");
    harness.pendingPersistence.resolve();
    harness.root.cancelAndWaitForSettlement.mockImplementationOnce(async () => {
      rootStarted.resolve();
      await rootSettled.promise;
      harness.registry.sessionBindings.set("late-child", lateChild.binding);
    });
    harness.grandchild.cancelAndWaitForSettlement.mockImplementationOnce(async () => {
      harness.registry.sessionBindings.set("late-descendant", lateDescendant.binding);
    });

    const deletion = harness.deleteSessionImpl({
      requesterSessionId: "requester",
      targetSessionId: "root",
    });
    try {
      await rootStarted.promise;
      expect(harness.grandchild.cancelAndWaitForSettlement).not.toHaveBeenCalled();
      rootSettled.resolve();
      await deletion;

      for (const descendant of [lateChild, lateDescendant]) {
        expect(descendant.cancelAndWaitForSettlement).toHaveBeenCalledTimes(1);
        expect(descendant.dispose).toHaveBeenCalledTimes(1);
        expect(descendant.waitForPersistenceIdle).toHaveBeenCalledTimes(1);
      }
      expect(harness.registry.sessionBindings.has("late-child")).toBe(false);
      expect(harness.registry.sessionBindings.has("late-descendant")).toBe(false);
      expect(harness.operations.at(-1)).toBe("deleted");
    } finally {
      rootSettled.resolve();
      await deletion;
    }
  });

  test("keeps task-owned and active-task source sessions protected from deletion", async () => {
    const harness = createDeletionHarness();
    harness.taskCoordinator.isTaskThread.mockReturnValueOnce(true);
    await expect(
      harness.deleteSessionImpl({ requesterSessionId: "requester", targetSessionId: "root" }),
    ).rejects.toThrow("Task threads must be managed through the task lifecycle");

    harness.getActiveTaskForSourceSession.mockReturnValueOnce({ id: "active-task" });
    await expect(
      harness.deleteSessionImpl({ requesterSessionId: "requester", targetSessionId: "root" }),
    ).rejects.toThrow("Chat is locked by active task active-task");
    expect(harness.deleteSession).not.toHaveBeenCalled();
    expect(harness.root.cancelAndWaitForSettlement).not.toHaveBeenCalled();
  });
});
