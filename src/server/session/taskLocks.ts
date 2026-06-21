import type { TaskRecord, TaskStatus } from "../../shared/tasks";
import type { TaskLockErrorData } from "../../types";

type TerminalTaskStatus = Extract<TaskStatus, "completed" | "cancelled" | "failed">;

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["completed", "cancelled", "failed"]);

type TaskSessionDb = {
  getActiveTaskForSourceSession?: (
    sessionId: string,
  ) => Pick<TaskRecord, "id" | "status" | "title"> | null | undefined;
  getTaskForThread?: (sessionId: string) => Pick<TaskRecord, "id" | "status"> | null | undefined;
  getSessionRecord?: (sessionId: string) => { parentSessionId?: string | null } | null | undefined;
};

export type TaskLockError = {
  message: string;
  data: TaskLockErrorData;
};

const pendingTerminalSessionLocks = new Map<string, TaskLockError>();
const pendingTerminalTaskLocks = new Map<string, TaskLockError>();

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

function pendingTerminalTaskLock(
  task: Pick<TaskRecord, "id" | "title">,
  status: TerminalTaskStatus,
): TaskLockError {
  return {
    message: `Task ${task.id} is finalizing ${status} and cannot be changed until terminal quiescence finishes.`,
    data: {
      category: "task_locked",
      source: "session",
      lockKind: "terminal_task_thread",
      taskId: task.id,
      taskStatus: status,
    },
  };
}

export function registerPendingTerminalTaskLocks(
  task: Pick<TaskRecord, "id" | "title" | "threads" | "sourceSessionId">,
  status: TerminalTaskStatus,
): () => void {
  const taskLock = pendingTerminalTaskLock(task, status);
  pendingTerminalTaskLocks.set(task.id, taskLock);
  const sessionIds = new Set(task.threads.map((thread) => thread.sessionId));
  if (task.sourceSessionId) sessionIds.add(task.sourceSessionId);
  const locks = Array.from(sessionIds).map((sessionId) => {
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
    pendingTerminalSessionLocks.set(sessionId, lock);
    return { sessionId, lock };
  });
  return () => {
    if (pendingTerminalTaskLocks.get(task.id) === taskLock) {
      pendingTerminalTaskLocks.delete(task.id);
    }
    for (const { sessionId, lock } of locks) {
      if (pendingTerminalSessionLocks.get(sessionId) === lock) {
        pendingTerminalSessionLocks.delete(sessionId);
      }
    }
  };
}

export function getPendingTerminalTaskLock(taskId: string): TaskLockError | null {
  return pendingTerminalTaskLocks.get(taskId) ?? null;
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
  return getSessionTaskLockRecursive(sessionDb, sessionId, new Set());
}

function getSessionTaskLockRecursive(
  sessionDb: TaskSessionDb | null | undefined,
  sessionId: string,
  seen: Set<string>,
): TaskLockError | null {
  if (seen.has(sessionId)) return null;
  seen.add(sessionId);
  const directLock =
    getTaskThreadLock(sessionDb, sessionId) ?? getActiveSourceChatLock(sessionDb, sessionId);
  if (directLock) return directLock;
  const parentSessionId = sessionDb?.getSessionRecord?.(sessionId)?.parentSessionId ?? null;
  return parentSessionId ? getSessionTaskLockRecursive(sessionDb, parentSessionId, seen) : null;
}
