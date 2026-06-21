import { describe, expect, test } from "bun:test";
import { HistoryManager } from "../../src/server/session/HistoryManager";
import type { SessionContext } from "../../src/server/session/SessionContext";
import {
  createSteerCoordinator,
  type SteerCoordinatorDeps,
} from "../../src/server/session/turnExecution/steerCoordinator";

describe("SteerCoordinator", () => {
  test("does not materialize live steer content when a task lock closes before build", async () => {
    const events: Array<Record<string, unknown>> = [];
    const state = {
      allMessages: [],
      messages: [],
      pendingSteers: [],
      running: true,
      currentTurnId: "turn-1",
      acceptingSteers: true,
      activeSteerHandler: null as SteerCoordinatorDeps["context"]["state"]["activeSteerHandler"],
    };
    const context = {
      id: "session-1",
      state,
      emit: (event: Record<string, unknown>) => events.push(event),
      emitError: (
        code: string,
        source: string,
        message: string,
        data?: Record<string, unknown>,
      ) => {
        events.push({ type: "error", sessionId: "session-1", code, source, message, data });
      },
      formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      queuePersistSessionSnapshot: (reason: string) => {
        events.push({ type: "persist", reason });
      },
    } as unknown as SessionContext;
    const historyManager = new HistoryManager(context);
    let lockChecks = 0;
    let buildCalls = 0;
    let handlerCalls = 0;

    state.activeSteerHandler = async () => {
      handlerCalls += 1;
    };

    const deps: SteerCoordinatorDeps = {
      context,
      historyManager,
      getTurnAttachmentValidationMessage: () => null,
      validateUploadedFileAttachments: async () => {},
      buildUserMessageContent: async (text) => {
        buildCalls += 1;
        return text;
      },
      classifyTurnError: () => ({ code: "internal_error", source: "session" }),
      getTaskLock: () => {
        lockChecks += 1;
        return lockChecks >= 2
          ? {
              message: "Task task-1 is finalizing cancelled and cannot accept steers.",
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
    };
    const coordinator = createSteerCoordinator(deps);

    await coordinator.sendSteerMessage("live steer", "turn-1", "client-steer-1");

    expect(buildCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(state.messages).toEqual([]);
    expect(state.allMessages).toEqual([]);
    expect(events.filter((event) => event.type === "user_message")).toHaveLength(0);
    expect(events.filter((event) => event.type === "steer_accepted")).toHaveLength(0);
    expect(events.filter((event) => event.type === "persist")).toHaveLength(0);
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        code: "task_locked",
        data: expect.objectContaining({
          lockKind: "terminal_task_thread",
          taskId: "task-1",
          taskStatus: "cancelled",
        }),
      }),
    ]);
  });

  test("does not materialize queued steer content when a task lock closes before drain build", async () => {
    const events: Array<Record<string, unknown>> = [];
    const state = {
      allMessages: [],
      messages: [],
      pendingSteers: [{ text: "queued steer", acceptedAt: "2026-06-21T00:00:00.000Z" }],
      running: true,
      currentTurnId: "turn-1",
      acceptingSteers: true,
      activeSteerHandler: null,
    };
    const context = {
      id: "session-1",
      state,
      emit: (event: Record<string, unknown>) => events.push(event),
      emitError: (
        code: string,
        source: string,
        message: string,
        data?: Record<string, unknown>,
      ) => {
        events.push({ type: "error", sessionId: "session-1", code, source, message, data });
      },
      formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      queuePersistSessionSnapshot: (reason: string) => {
        events.push({ type: "persist", reason });
      },
    } as unknown as SessionContext;
    const historyManager = new HistoryManager(context);
    let lockChecks = 0;
    let buildCalls = 0;

    const deps: SteerCoordinatorDeps = {
      context,
      historyManager,
      getTurnAttachmentValidationMessage: () => null,
      validateUploadedFileAttachments: async () => {},
      buildUserMessageContent: async (text) => {
        buildCalls += 1;
        return text;
      },
      classifyTurnError: () => ({ code: "internal_error", source: "session" }),
      getTaskLock: () => {
        lockChecks += 1;
        return lockChecks >= 2
          ? {
              message: "Chat is locked by active task task-1: promoted task",
              data: {
                category: "task_locked",
                source: "session",
                lockKind: "active_source_chat",
                taskId: "task-1",
                taskStatus: "working",
                taskTitle: "promoted task",
              },
            }
          : null;
      },
    };
    const coordinator = createSteerCoordinator(deps);

    await expect(coordinator.commitPendingSteers()).resolves.toEqual({
      messages: [],
      committedCount: 0,
    });

    expect(buildCalls).toBe(0);
    expect(state.pendingSteers).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.allMessages).toEqual([]);
    expect(events.filter((event) => event.type === "user_message")).toHaveLength(0);
    expect(events.filter((event) => event.type === "persist")).toHaveLength(0);
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        code: "task_locked",
        data: expect.objectContaining({
          lockKind: "active_source_chat",
          taskId: "task-1",
          taskStatus: "working",
        }),
      }),
    ]);
  });

  test("clears steers appended during pending drain when the final task lock closes", async () => {
    const events: Array<Record<string, unknown>> = [];
    const state = {
      allMessages: [],
      messages: [],
      pendingSteers: [{ text: "first queued steer", acceptedAt: "2026-06-21T00:00:00.000Z" }],
      running: true,
      currentTurnId: "turn-1",
      acceptingSteers: true,
      activeSteerHandler: null,
    };
    const context = {
      id: "session-1",
      state,
      emit: (event: Record<string, unknown>) => events.push(event),
      emitError: (
        code: string,
        source: string,
        message: string,
        data?: Record<string, unknown>,
      ) => {
        events.push({ type: "error", sessionId: "session-1", code, source, message, data });
      },
      formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      queuePersistSessionSnapshot: (reason: string) => {
        events.push({ type: "persist", reason });
      },
    } as unknown as SessionContext;
    const historyManager = new HistoryManager(context);
    const contentBuildEntered = Promise.withResolvers<void>();
    const releaseContentBuild = Promise.withResolvers<void>();
    let locked = false;

    const deps: SteerCoordinatorDeps = {
      context,
      historyManager,
      getTurnAttachmentValidationMessage: () => null,
      validateUploadedFileAttachments: async () => {},
      buildUserMessageContent: async (text) => {
        if (text === "first queued steer") {
          contentBuildEntered.resolve();
          await releaseContentBuild.promise;
        }
        return text;
      },
      classifyTurnError: () => ({ code: "internal_error", source: "session" }),
      getTaskLock: () =>
        locked
          ? {
              message: "Chat is locked by active task task-1: promoted task",
              data: {
                category: "task_locked",
                source: "session",
                lockKind: "active_source_chat",
                taskId: "task-1",
                taskStatus: "working",
                taskTitle: "promoted task",
              },
            }
          : null,
    };
    const coordinator = createSteerCoordinator(deps);

    const commitPromise = coordinator.commitPendingSteers();
    await contentBuildEntered.promise;

    await coordinator.sendSteerMessage("second queued steer", "turn-1", "steer-2");
    locked = true;
    releaseContentBuild.resolve();

    await expect(commitPromise).resolves.toEqual({ messages: [], committedCount: 0 });

    expect(state.pendingSteers).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.allMessages).toEqual([]);
    expect(events.filter((event) => event.type === "user_message")).toHaveLength(0);
    expect(events.filter((event) => event.type === "persist")).toHaveLength(0);
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        code: "task_locked",
        data: expect.objectContaining({
          lockKind: "active_source_chat",
          taskId: "task-1",
          taskStatus: "working",
        }),
      }),
    ]);
  });

  test("does not commit local steer state when a task lock closes during live handler delivery", async () => {
    const events: Array<Record<string, unknown>> = [];
    const state = {
      allMessages: [],
      messages: [],
      pendingSteers: [],
      running: true,
      currentTurnId: "turn-1",
      acceptingSteers: true,
      activeSteerHandler: null as SteerCoordinatorDeps["context"]["state"]["activeSteerHandler"],
    };
    const context = {
      id: "session-1",
      state,
      emit: (event: Record<string, unknown>) => events.push(event),
      emitError: (
        code: string,
        source: string,
        message: string,
        data?: Record<string, unknown>,
      ) => {
        events.push({ type: "error", sessionId: "session-1", code, source, message, data });
      },
      formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      queuePersistSessionSnapshot: (reason: string) => {
        events.push({ type: "persist", reason });
      },
    } as unknown as SessionContext;
    const historyManager = new HistoryManager(context);
    const handlerEntered = Promise.withResolvers<void>();
    const releaseHandler = Promise.withResolvers<void>();
    let locked = false;

    state.activeSteerHandler = async () => {
      handlerEntered.resolve();
      await releaseHandler.promise;
    };

    const deps: SteerCoordinatorDeps = {
      context,
      historyManager,
      getTurnAttachmentValidationMessage: () => null,
      validateUploadedFileAttachments: async () => {},
      buildUserMessageContent: async (text) => text,
      classifyTurnError: () => ({ code: "internal_error", source: "session" }),
      getTaskLock: () =>
        locked
          ? {
              message: "Task task-1 is finalizing cancelled and cannot accept steers.",
              data: {
                category: "task_locked",
                source: "session",
                lockKind: "terminal_task_thread",
                taskId: "task-1",
                taskStatus: "cancelled",
              },
            }
          : null,
    };
    const coordinator = createSteerCoordinator(deps);

    const steerPromise = coordinator.sendSteerMessage("live steer", "turn-1", "client-steer-1");
    await handlerEntered.promise;
    locked = true;
    releaseHandler.resolve();
    await steerPromise;

    expect(state.messages).toEqual([]);
    expect(state.allMessages).toEqual([]);
    expect(events.filter((event) => event.type === "user_message")).toHaveLength(0);
    expect(events.filter((event) => event.type === "steer_accepted")).toHaveLength(0);
    expect(events.filter((event) => event.type === "persist")).toHaveLength(0);
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        code: "task_locked",
        data: expect.objectContaining({
          lockKind: "terminal_task_thread",
          taskId: "task-1",
          taskStatus: "cancelled",
        }),
      }),
    ]);
  });
});
