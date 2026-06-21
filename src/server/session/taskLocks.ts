import type { TaskRecord, TaskStatus } from "../../shared/tasks";
import type { TaskLockErrorData } from "../../types";

type TerminalTaskStatus = Extract<TaskStatus, "completed" | "cancelled" | "failed">;

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["completed", "cancelled", "failed"]);

type TaskSessionDb = {
  getActiveTaskForSourceSession?: (
    sessionId: string,
  ) => Pick<TaskRecord, "id" | "status" | "title"> | null | undefined;
  getTaskForThread?: (sessionId: string) => Pick<TaskRecord, "id" | "status"> | null | undefined;
};

export type TaskLockError = {
  message: string;
  data: TaskLockErrorData;
};

const pendingTerminalSessionLocks = new Map<string, TaskLockError>();

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function terminalTaskLock(task: Pick<TaskRecord, "id" | "status">): TaskLockError | null {
  if (!isTerminalTaskStatus(task.status)) return null;
  return {
    message: `Task ${task.id} is ${task.status} and cannot accept new turns until it is reopened or retried.`,
    data: {
      category: "task_locked",
      source: "session",
      lockKind: "terminal_task_thread",
      taskId: task.id,
      taskStatus: task.status,
    },
  };
}

export function activeSourceChatLock(
  task: Pick<TaskRecord, "id" | "status" | "title">,
): TaskLockError {
  return {
    message: `Chat is locked by active task ${task.id}: ${task.title}`,
    data: {
      category: "task_locked",
      source: "session",
      lockKind: "active_source_chat",
      taskId: task.id,
      taskStatus: task.status,
      taskTitle: task.title,
    },
  };
}

export function registerPendingTerminalTaskThreadLocks(
  task: Pick<TaskRecord, "id" | "title" | "threads">,
  status: TerminalTaskStatus,
): () => void {
  const locks = task.threads.map((thread) => {
    const lock: TaskLockError = {
      message: `Task ${task.id} is finalizing ${status} and cannot accept new turns until it is reopened or retried.`,
      data: {
        category: "task_locked",
        source: "session",
        lockKind: "terminal_task_thread",
        taskId: task.id,
        taskStatus: status,
      },
    };
    pendingTerminalSessionLocks.set(thread.sessionId, lock);
    return { sessionId: thread.sessionId, lock };
  });
  return () => {
    for (const { sessionId, lock } of locks) {
      if (pendingTerminalSessionLocks.get(sessionId) === lock) {
        pendingTerminalSessionLocks.delete(sessionId);
      }
    }
  };
}

export function getTaskThreadLock(
  sessionDb: TaskSessionDb | null | undefined,
  sessionId: string,
): TaskLockError | null {
  const pendingLock = pendingTerminalSessionLocks.get(sessionId);
  if (pendingLock) return pendingLock;
  const task = sessionDb?.getTaskForThread?.(sessionId);
  return task ? terminalTaskLock(task) : null;
}

export function getActiveSourceChatLock(
  sessionDb: TaskSessionDb | null | undefined,
  sessionId: string,
): TaskLockError | null {
  const activeTask = sessionDb?.getActiveTaskForSourceSession?.(sessionId);
  return activeTask ? activeSourceChatLock(activeTask) : null;
}

export function getSessionTaskLock(
  sessionDb: TaskSessionDb | null | undefined,
  sessionId: string,
): TaskLockError | null {
  return getTaskThreadLock(sessionDb, sessionId) ?? getActiveSourceChatLock(sessionDb, sessionId);
}
