import { describe, expect, test } from "bun:test";
import { HistoryManager } from "../../src/server/session/HistoryManager";
import type { SessionContext } from "../../src/server/session/SessionContext";
import {
  createSteerCoordinator,
  type SteerCoordinatorDeps,
} from "../../src/server/session/turnExecution/steerCoordinator";

describe("SteerCoordinator", () => {
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
});
