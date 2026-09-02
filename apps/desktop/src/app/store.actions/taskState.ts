import type { TaskRecord, TaskSummary } from "../../../../../src/shared/tasks";
import { canonicalWorkspacePath, sameWorkspacePath } from "../../../../../src/utils/workspacePath";
import { getDesktopPlatformInfo } from "../../lib/desktopPlatform";
import type { ensureThreadRuntime, StoreGet, StoreSet } from "../store.helpers";
import type { ThreadRecord } from "../types";

function workspacePlatform(): NodeJS.Platform {
  return getDesktopPlatformInfo().rawPlatform as NodeJS.Platform;
}

export function workspacePathsMatch(a: string, b: string): boolean {
  const platform = workspacePlatform();
  if (sameWorkspacePath(a, b, platform)) return true;
  if (platform !== "win32") return false;

  const aCurrentDriveRooted = isCurrentDriveRootedWindowsPath(a);
  const bCurrentDriveRooted = isCurrentDriveRootedWindowsPath(b);
  if (aCurrentDriveRooted === bCurrentDriveRooted) return false;

  if (aCurrentDriveRooted) {
    const drive = windowsDrivePrefix(b);
    return drive
      ? sameWorkspacePath(`${drive}${normalizeWindowsSeparators(a)}`, b, platform)
      : false;
  }

  const drive = windowsDrivePrefix(a);
  return drive ? sameWorkspacePath(a, `${drive}${normalizeWindowsSeparators(b)}`, platform) : false;
}

function normalizeWindowsSeparators(value: string): string {
  return value.trim().replaceAll("/", "\\");
}

function isCurrentDriveRootedWindowsPath(value: string): boolean {
  return /^\\(?!\\)/.test(normalizeWindowsSeparators(value));
}

function windowsDrivePrefix(value: string): string | null {
  return /^([a-z]:)\\/.exec(canonicalWorkspacePath(value, "win32"))?.[1] ?? null;
}

function taskSummary(task: TaskRecord): TaskSummary {
  return {
    id: task.id,
    workspacePath: task.workspacePath,
    title: task.title,
    objective: task.objective,
    status: task.status,
    revision: task.revision,
    reviewRequired: task.reviewRequired,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    threadCount: task.threadCount,
    completedWorkItemCount: task.completedWorkItemCount,
    totalWorkItemCount: task.totalWorkItemCount,
    activeBlockerCount: task.activeBlockerCount,
    pendingQuestionCount: task.pendingQuestionCount,
    blockingQuestionCount: task.blockingQuestionCount,
    ...(task.context ? { context: task.context } : {}),
    ...(task.sourceSessionId !== undefined ? { sourceSessionId: task.sourceSessionId } : {}),
    ...(task.creationOrigin ? { creationOrigin: task.creationOrigin } : {}),
    ...(task.reviewRounds !== undefined ? { reviewRounds: task.reviewRounds } : {}),
  };
}

export function workspaceIdForTask(
  get: StoreGet,
  task: Pick<TaskSummary, "workspacePath">,
): string | null {
  return (
    get().workspaces.find((workspace) => workspacePathsMatch(workspace.path, task.workspacePath))
      ?.id ?? null
  );
}

function synthesizeTaskThreads(
  get: StoreGet,
  task: TaskRecord,
  threadMetadata?: Record<string, unknown>,
): ThreadRecord[] {
  const workspaceId = workspaceIdForTask(get, task);
  if (!workspaceId) return [];
  const existingThreads = new Map(get().threads.map((thread) => [thread.id, thread]));
  return task.threads.map((taskThread) => {
    const existing = existingThreads.get(taskThread.sessionId);
    const metadata =
      threadMetadata && threadMetadata.id === taskThread.sessionId ? threadMetadata : null;
    return {
      ...existing,
      id: taskThread.sessionId,
      workspaceId,
      title: taskThread.title,
      titleSource: existing?.titleSource ?? "manual",
      createdAt:
        typeof metadata?.createdAt === "string" ? metadata.createdAt : taskThread.createdAt,
      lastMessageAt:
        typeof metadata?.updatedAt === "string"
          ? metadata.updatedAt
          : (existing?.lastMessageAt ?? taskThread.updatedAt),
      status: "active",
      sessionId: taskThread.sessionId,
      messageCount:
        typeof metadata?.messageCount === "number"
          ? metadata.messageCount
          : (existing?.messageCount ?? 0),
      lastEventSeq:
        typeof metadata?.lastEventSeq === "number"
          ? metadata.lastEventSeq
          : (existing?.lastEventSeq ?? 0),
      draft: false,
      taskId: task.id,
      taskThreadId: taskThread.id,
    };
  });
}

function mergeTaskThreads(existing: ThreadRecord[], taskThreads: ThreadRecord[]): ThreadRecord[] {
  const ids = new Set(taskThreads.map((thread) => thread.id));
  return [...taskThreads, ...existing.filter((thread) => !ids.has(thread.id))];
}

export function upsertTask(
  set: StoreSet,
  get: StoreGet,
  task: TaskRecord,
  deps: { ensureThreadRuntime: typeof ensureThreadRuntime },
  metadata?: unknown,
): void {
  const workspaceId = workspaceIdForTask(get, task);
  if (!workspaceId) return;
  const current = get().tasksById[task.id];
  if (current && current.revision > task.revision) return;
  const parsedMetadata =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>)
      : undefined;
  const taskThreads = synthesizeTaskThreads(get, task, parsedMetadata);
  set((state) => {
    const summaries = state.taskSummariesByWorkspaceId[workspaceId] ?? [];
    const nextSummary = taskSummary(task);
    const nextSummaries = mergeTaskSummaries(summaries, [nextSummary]);
    return {
      tasksById: { ...state.tasksById, [task.id]: task },
      taskSummariesByWorkspaceId: {
        ...state.taskSummariesByWorkspaceId,
        [workspaceId]: nextSummaries,
      },
      threads: mergeTaskThreads(state.threads, taskThreads),
      taskError: null,
    };
  });
  for (const thread of taskThreads) deps.ensureThreadRuntime(get, set, thread.id);
}

export function mergeTaskSummaries(
  current: readonly TaskSummary[],
  incoming: readonly TaskSummary[],
  beforeRequest?: ReadonlyMap<string, TaskSummary>,
): TaskSummary[] {
  const incomingIds = new Set(incoming.map((task) => task.id));
  const merged = new Map(
    current
      .filter(
        (task) => !beforeRequest || incomingIds.has(task.id) || beforeRequest.get(task.id) !== task,
      )
      .map((task) => [task.id, task]),
  );
  for (const task of incoming) {
    const previous = merged.get(task.id);
    if (
      !previous ||
      task.revision > previous.revision ||
      (task.revision === previous.revision && task.updatedAt >= previous.updatedAt)
    ) {
      merged.set(task.id, task);
    }
  }
  return [...merged.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
