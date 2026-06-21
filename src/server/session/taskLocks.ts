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

export function getTaskThreadLock(
  sessionDb: TaskSessionDb | null | undefined,
  sessionId: string,
): TaskLockError | null {
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
