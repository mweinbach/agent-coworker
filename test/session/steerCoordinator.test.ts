import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HistoryManager } from "../../src/server/session/HistoryManager";
import type { SessionContext } from "../../src/server/session/SessionContext";
import {
  createSteerCoordinator,
  type SteerCoordinatorDeps,
} from "../../src/server/session/turnExecution/steerCoordinator";
import { createUserMessageAttachmentHelpers } from "../../src/server/session/turnExecution/userMessageAttachments";

describe("SteerCoordinator", () => {
  test("correlates an accepted queued steer with its later dropped error", async () => {
    const events: Array<Record<string, unknown>> = [];
    const state = {
      allMessages: [],
      messages: [],
      pendingSteers: [],
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
    const coordinator = createSteerCoordinator({
      context,
      historyManager: new HistoryManager(context),
      getTurnAttachmentValidationMessage: () => null,
      validateUploadedFileAttachments: async () => {},
      buildUserMessageContent: async (text) => text,
      classifyTurnError: () => ({ code: "internal_error", source: "session" }),
    });

    await coordinator.sendSteerMessage(
      "queued steer",
      "turn-1",
      "client-steer-1",
      undefined,
      undefined,
      undefined,
      "steer-request-1",
    );
    coordinator.rejectPendingSteers("The turn ended before queued guidance was used.");

    expect(state.pendingSteers).toEqual([]);
    expect(events.filter((event) => event.type === "steer_accepted")).toEqual([
      expect.objectContaining({
        clientMessageId: "client-steer-1",
        steerRequestId: "steer-request-1",
      }),
    ]);
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        clientMessageId: "client-steer-1",
        steerRequestId: "steer-request-1",
        message: "The turn ended before queued guidance was used.",
      }),
    ]);
    expect(events.filter((event) => event.type === "user_message")).toHaveLength(0);
  });

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

  test("keeps the admitted turn interrupt latched while live steer materialization resumes", async () => {
    const events: Array<Record<string, unknown>> = [];
    const abortController = new AbortController();
    const state = {
      allMessages: [],
      messages: [],
      pendingSteers: [],
      running: true,
      currentTurnId: "turn-1",
      acceptingSteers: true,
      abortController,
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
    let buildCalls = 0;
    let handlerCalls = 0;

    state.activeSteerHandler = async () => {
      handlerCalls += 1;
    };

    const coordinator = createSteerCoordinator({
      context,
      historyManager,
      getTurnAttachmentValidationMessage: () => null,
      validateUploadedFileAttachments: async () => {},
      buildUserMessageContent: async (text) => {
        buildCalls += 1;
        abortController.abort();
        state.abortController = null as never;
        return text;
      },
      classifyTurnError: () => ({ code: "internal_error", source: "session" }),
      getTaskLock: () => null,
    });

    await coordinator.sendSteerMessage("live steer", "turn-1", "client-steer-1");

    expect(buildCalls).toBe(1);
    expect(handlerCalls).toBe(0);
    expect(state.messages).toEqual([]);
    expect(state.allMessages).toEqual([]);
    expect(events.filter((event) => event.type === "user_message")).toHaveLength(0);
    expect(events.filter((event) => event.type === "steer_accepted")).toHaveLength(0);
    expect(events.filter((event) => event.type === "persist")).toHaveLength(0);
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        code: "validation_failed",
        message: "Turn was interrupted before the steer could be accepted.",
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
      expect.objectContaining({
        code: "task_locked",
        clientMessageId: "steer-2",
        data: expect.objectContaining({
          lockKind: "active_source_chat",
          taskId: "task-1",
          taskStatus: "working",
        }),
      }),
    ]);
  });

  test("commits local steer state when live handler delivery succeeds", async () => {
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

    expect(state.messages).toEqual([{ role: "user", content: "live steer" }]);
    expect(state.allMessages).toEqual([{ role: "user", content: "live steer" }]);
    expect(events.filter((event) => event.type === "user_message")).toEqual([
      expect.objectContaining({
        text: "live steer",
        clientMessageId: "client-steer-1",
      }),
    ]);
    expect(events.filter((event) => event.type === "steer_accepted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "persist")).toEqual([
      { type: "persist", reason: "session.steer_committed" },
    ]);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
  });

  test("emits foreign ABORT_ERR from live steer handlers instead of swallowing it", async () => {
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
    state.activeSteerHandler = async () => {
      throw Object.assign(new Error("provider abort was not a task lock"), {
        code: "ABORT_ERR" as const,
      });
    };
    const coordinator = createSteerCoordinator({
      context,
      historyManager,
      getTurnAttachmentValidationMessage: () => null,
      validateUploadedFileAttachments: async () => {},
      buildUserMessageContent: async (text) => text,
      classifyTurnError: () => ({ code: "provider_error", source: "provider" }),
      getTaskLock: () => null,
    });

    await coordinator.sendSteerMessage("live steer", "turn-1", "client-steer-1");

    expect(state.messages).toEqual([]);
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        code: "provider_error",
        source: "provider",
        message: "provider abort was not a task lock",
      }),
    ]);
  });

  test("rolls back live steer inline attachments when the task lock closes after write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "steer-live-rollback-"));
    const uploadsDir = path.join(dir, "deep", "nested", "uploads");
    const events: Array<Record<string, unknown>> = [];
    const state = {
      allMessages: [],
      messages: [],
      pendingSteers: [],
      running: true,
      currentTurnId: "turn-1",
      acceptingSteers: true,
      activeSteerHandler: null as SteerCoordinatorDeps["context"]["state"]["activeSteerHandler"],
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        workingDirectory: dir,
        uploadsDirectory: uploadsDir,
      },
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
    const attachmentHelpers = createUserMessageAttachmentHelpers(context);
    let lockChecks = 0;
    let handlerCalls = 0;
    state.activeSteerHandler = async () => {
      handlerCalls += 1;
    };
    const coordinator = createSteerCoordinator({
      context,
      historyManager,
      getTurnAttachmentValidationMessage: () => null,
      validateUploadedFileAttachments: attachmentHelpers.validateUploadedFileAttachments,
      buildUserMessageContent: attachmentHelpers.buildUserMessageContent,
      classifyTurnError: () => ({ code: "internal_error", source: "session" }),
      getTaskLock: () => {
        lockChecks += 1;
        return lockChecks < 6
          ? null
          : {
              message: "Task task-1 is finalizing cancelled and cannot accept steers.",
              data: {
                category: "task_locked",
                source: "session",
                lockKind: "terminal_task_thread",
                taskId: "task-1",
                taskStatus: "cancelled",
              },
            };
      },
    });

    try {
      await coordinator.sendSteerMessage("live steer", "turn-1", "client-steer-1", [
        {
          filename: "live.txt",
          contentBase64: Buffer.from("live attachment").toString("base64"),
          mimeType: "text/plain",
        },
      ]);

      expect(handlerCalls).toBe(0);
      expect(state.messages).toEqual([]);
      expect(events.filter((event) => event.type === "user_message")).toHaveLength(0);
      expect(events.filter((event) => event.type === "persist")).toHaveLength(0);
      await expect(fs.readdir(uploadsDir)).rejects.toThrow();
      await expect(fs.stat(path.join(dir, "deep"))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("rolls back queued steer inline attachments on a final task lock", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "steer-queued-rollback-"));
    const uploadsDir = path.join(dir, "deep", "nested", "uploads");
    const events: Array<Record<string, unknown>> = [];
    const state = {
      allMessages: [],
      messages: [],
      pendingSteers: [
        {
          text: "queued steer",
          attachments: [
            {
              filename: "one.txt",
              contentBase64: Buffer.from("one").toString("base64"),
              mimeType: "text/plain",
            },
            {
              filename: "two.txt",
              contentBase64: Buffer.from("two").toString("base64"),
              mimeType: "text/plain",
            },
          ],
          acceptedAt: "2026-06-21T00:00:00.000Z",
        },
      ],
      running: true,
      currentTurnId: "turn-1",
      acceptingSteers: true,
      activeSteerHandler: null,
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        workingDirectory: dir,
        uploadsDirectory: uploadsDir,
      },
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
    const attachmentHelpers = createUserMessageAttachmentHelpers(context);
    let lockChecks = 0;
    const coordinator = createSteerCoordinator({
      context,
      historyManager,
      getTurnAttachmentValidationMessage: () => null,
      validateUploadedFileAttachments: attachmentHelpers.validateUploadedFileAttachments,
      buildUserMessageContent: attachmentHelpers.buildUserMessageContent,
      classifyTurnError: () => ({ code: "internal_error", source: "session" }),
      getTaskLock: () => {
        lockChecks += 1;
        return lockChecks < 9
          ? null
          : {
              message: "Chat is locked by active task task-1: promoted task",
              data: {
                category: "task_locked",
                source: "session",
                lockKind: "active_source_chat",
                taskId: "task-1",
                taskStatus: "working",
              },
            };
      },
    });

    try {
      await expect(coordinator.commitPendingSteers()).resolves.toEqual({
        messages: [],
        committedCount: 0,
      });

      expect(state.pendingSteers).toEqual([]);
      expect(state.messages).toEqual([]);
      expect(events.filter((event) => event.type === "user_message")).toHaveLength(0);
      expect(events.filter((event) => event.type === "persist")).toHaveLength(0);
      await expect(fs.readdir(uploadsDir)).rejects.toThrow();
      await expect(fs.stat(path.join(dir, "deep"))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
