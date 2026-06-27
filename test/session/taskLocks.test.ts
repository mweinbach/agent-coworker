import { describe, expect, test } from "bun:test";

import {
  getPendingTerminalTaskLock,
  getSessionTaskLock,
  registerPendingTerminalTaskLocks,
  registerSettlingTerminalSessionLock,
} from "../../src/server/session/taskLocks";

describe("task lock contracts", () => {
  test("pending terminal source-chat locks keep the active_source_chat data contract", () => {
    const release = registerPendingTerminalTaskLocks(
      {
        id: "task-1",
        title: "Finalize task",
        threads: [{ sessionId: "task-thread-1" }],
        sourceSessionId: "source-chat-1",
      },
      "completed",
    );
    try {
      expect(getPendingTerminalTaskLock("task-1")?.data).toMatchObject({
        lockKind: "terminal_task_thread",
        taskStatus: "completed",
      });
      expect(getSessionTaskLock(null, "task-thread-1")?.data).toMatchObject({
        lockKind: "terminal_task_thread",
        taskId: "task-1",
        taskStatus: "completed",
      });
      expect(getSessionTaskLock(null, "source-chat-1")?.data).toEqual({
        category: "task_locked",
        source: "session",
        lockKind: "active_source_chat",
        taskId: "task-1",
        taskStatus: "completed",
        taskTitle: "Finalize task",
      });
    } finally {
      release();
    }
  });

  test("durable terminal state takes precedence over a stale pending task-thread lock", () => {
    const release = registerPendingTerminalTaskLocks(
      {
        id: "task-1",
        title: "Finalize task",
        threads: [{ sessionId: "task-thread-1" }],
        sourceSessionId: null,
      },
      "failed",
    );
    try {
      const lock = getSessionTaskLock(
        {
          getTaskForThread: () => ({ id: "task-1", status: "failed" }),
        },
        "task-thread-1",
      );
      expect(lock?.message).toContain("is failed and cannot accept new turns");
      expect(lock?.message).not.toContain("finalizing failed");
      expect(lock?.data).toMatchObject({
        lockKind: "terminal_task_thread",
        taskId: "task-1",
        taskStatus: "failed",
      });
    } finally {
      release();
    }
  });

  test("settling turn locks survive pending-lock release and clean up independently", () => {
    const releasePending = registerPendingTerminalTaskLocks(
      {
        id: "task-1",
        title: "Finalize task",
        threads: [{ sessionId: "task-thread-1" }],
        sourceSessionId: null,
      },
      "cancelled",
    );
    const lock = getSessionTaskLock(null, "task-thread-1");
    if (!lock) throw new Error("Expected pending task lock");
    const releaseSettling = registerSettlingTerminalSessionLock("task-thread-1", lock);

    releasePending();
    expect(getPendingTerminalTaskLock("task-1")).toBeNull();
    expect(getSessionTaskLock(null, "task-thread-1")?.message).toContain("finalizing cancelled");

    releaseSettling();
    expect(getSessionTaskLock(null, "task-thread-1")).toBeNull();
  });
});
