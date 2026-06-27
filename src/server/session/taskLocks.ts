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

export type TaskLockedError = Error & {
  code: "task_locked";
  source: "session";
  data: TaskLockErrorData;
};

const pendingTerminalSessionLocks = new Map<string, TaskLockError>();
const pendingTerminalTaskLocks = new Map<string, TaskLockError>();
const settlingTerminalSessionLocks = new Map<
  string,
  Array<{ token: object; lock: TaskLockError }>
>();

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

function pendingTerminalSourceChatLock(
  task: Pick<TaskRecord, "id" | "title">,
  status: TerminalTaskStatus,
): TaskLockError {
  return {
    message: `Chat is locked while task ${task.id} is finalizing ${status}: ${task.title}`,
    data: {
      category: "task_locked",
      source: "session",
      lockKind: "active_source_chat",
      taskId: task.id,
      taskStatus: status,
      taskTitle: task.title,
    },
  };
}

export function makeTaskLockedError(lock: TaskLockError): TaskLockedError {
  return Object.assign(new Error(lock.message), {
    code: "task_locked" as const,
    source: "session" as const,
    data: lock.data,
  });
}

export function isTaskLockedError(error: unknown): error is TaskLockedError {
  return (
    error instanceof Error &&
    (error as { code?: unknown; source?: unknown }).code === "task_locked" &&
    (error as { source?: unknown }).source === "session"
  );
}

export function registerPendingTerminalTaskLocks(
  task: Pick<TaskRecord, "id" | "title" | "threads" | "sourceSessionId">,
  status: TerminalTaskStatus,
): () => void {
  const taskLock = pendingTerminalTaskLock(task, status);
  pendingTerminalTaskLocks.set(task.id, taskLock);
  return registerPendingTerminalSessionLocksForTask(task, status, taskLock);
}

function registerPendingTerminalSessionLocksForTask(
  task: Pick<TaskRecord, "id" | "title" | "threads" | "sourceSessionId">,
  status: TerminalTaskStatus,
  taskLock: TaskLockError,
): () => void {
  const locks: Array<{ sessionId: string; lock: TaskLockError }> = [];
  const taskSessionIds = new Set(task.threads.map((thread) => thread.sessionId));
  for (const sessionId of taskSessionIds) {
    const lock = taskLock;
    pendingTerminalSessionLocks.set(sessionId, lock);
    locks.push({ sessionId, lock });
  }
  if (task.sourceSessionId && !taskSessionIds.has(task.sourceSessionId)) {
    const lock = pendingTerminalSourceChatLock(task, status);
    pendingTerminalSessionLocks.set(task.sourceSessionId, lock);
    locks.push({ sessionId: task.sourceSessionId, lock });
  }
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

export function registerSettlingTerminalSessionLock(
  sessionId: string,
  lock: TaskLockError,
): () => void {
  const registration = { token: {}, lock };
  const registrations = settlingTerminalSessionLocks.get(sessionId) ?? [];
  registrations.push(registration);
  settlingTerminalSessionLocks.set(sessionId, registrations);
  return () => {
    const current = settlingTerminalSessionLocks.get(sessionId);
    if (!current) return;
    const remaining = current.filter((candidate) => candidate.token !== registration.token);
    if (remaining.length > 0) settlingTerminalSessionLocks.set(sessionId, remaining);
    else settlingTerminalSessionLocks.delete(sessionId);
  };
}

export function getTaskThreadLock(
  sessionDb: TaskSessionDb | null | undefined,
  sessionId: string,
): TaskLockError | null {
  const task = sessionDb?.getTaskForThread?.(sessionId);
  const durableLock = task ? terminalTaskLock(task) : null;
  if (durableLock) return durableLock;
  const pendingLock = pendingTerminalSessionLocks.get(sessionId);
  if (pendingLock) return pendingLock;
  return settlingTerminalSessionLocks.get(sessionId)?.at(-1)?.lock ?? null;
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
  getLiveParentSessionId?: (sessionId: string) => string | null | undefined,
): TaskLockError | null {
  return getSessionTaskLockRecursive(sessionDb, sessionId, new Set(), getLiveParentSessionId);
}

function getSessionTaskLockRecursive(
  sessionDb: TaskSessionDb | null | undefined,
  sessionId: string,
  seen: Set<string>,
  getLiveParentSessionId?: (sessionId: string) => string | null | undefined,
): TaskLockError | null {
  if (seen.has(sessionId)) return null;
  seen.add(sessionId);
  const directLock =
    getTaskThreadLock(sessionDb, sessionId) ?? getActiveSourceChatLock(sessionDb, sessionId);
  if (directLock) return directLock;
  const liveParentSessionId = getLiveParentSessionId?.(sessionId) ?? null;
  const parentSessionId =
    liveParentSessionId ?? sessionDb?.getSessionRecord?.(sessionId)?.parentSessionId ?? null;
  return parentSessionId
    ? getSessionTaskLockRecursive(sessionDb, parentSessionId, seen, getLiveParentSessionId)
    : null;
}
