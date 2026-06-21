import { describe, expect, test } from "bun:test";

import {
  getPendingTerminalTaskLock,
  getSessionTaskLock,
  registerPendingTerminalTaskLocks,
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
});
