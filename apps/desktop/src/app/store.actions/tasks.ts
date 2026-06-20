import { sameWorkspacePath } from "@cowork/utils/workspacePath";
import {
  type ArtifactDiff,
  type ArtifactPreview,
  artifactDiffSchema,
  artifactPreviewSchema,
} from "../../../../../src/server/artifacts/types";
import {
  type TaskArtifactDetail,
  type TaskCreationInput,
  type TaskQuestionAnswerInput,
  type TaskQuestionResumeStatus,
  type TaskRecord,
  type TaskSummary,
  taskActivitySchema,
  taskArtifactDetailSchema,
  taskArtifactRevisionSchema,
  taskCheckpointSchema,
  taskRecordSchema,
  taskSummarySchema,
} from "../../../../../src/shared/tasks";
import { getDesktopPlatformInfo } from "../../lib/desktopPlatform";
import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import {
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  makeId,
  nowIso,
  persistNow,
  pushNotification,
  syncDesktopStateCache,
} from "../store.helpers";
import { registerWorkspaceJsonRpcRouter, requestJsonRpc } from "../store.helpers/jsonRpcSocket";
import { isOneOffChatWorkspace, type ThreadRecord } from "../types";

const taskRouterCleanupByWorkspace = new Map<string, () => void>();

export type TaskActionDependencies = {
  ensureControlSocket: typeof ensureControlSocket;
  ensureServerRunning: typeof ensureServerRunning;
  ensureThreadRuntime: typeof ensureThreadRuntime;
  registerWorkspaceJsonRpcRouter: typeof registerWorkspaceJsonRpcRouter;
  requestJsonRpc: typeof requestJsonRpc;
  syncDesktopStateCache: typeof syncDesktopStateCache;
  persistNow: typeof persistNow;
};

const defaultTaskActionDependencies: TaskActionDependencies = {
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  registerWorkspaceJsonRpcRouter,
  requestJsonRpc,
  syncDesktopStateCache,
  persistNow,
};

function workspacePlatform(): NodeJS.Platform {
  return getDesktopPlatformInfo().rawPlatform as NodeJS.Platform;
}

function workspacePathsMatch(a: string, b: string): boolean {
  return sameWorkspacePath(a, b, workspacePlatform());
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

function workspaceIdForTask(
  get: StoreGet,
  task: Pick<TaskSummary, "workspacePath">,
): string | null {
  return (
    get().workspaces.find((workspace) => workspacePathsMatch(workspace.path, task.workspacePath))
      ?.id ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArtifactDetail(value: unknown, method: string): TaskArtifactDetail {
  const parsed = taskArtifactDetailSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid ${method} artifact detail`);
  }
  return parsed.data;
}

function parseArtifactDiff(value: unknown): ArtifactDiff {
  const parsed = artifactDiffSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid task/artifact/version/compare response");
  }
  return parsed.data;
}

function parseArtifactPreview(value: unknown): ArtifactPreview {
  const parsed = artifactPreviewSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid task/artifact/version/preview response");
  }
  return parsed.data;
}

function synthesizeTaskThreads(
  get: StoreGet,
  task: TaskRecord,
  threadMetadata?: Record<string, unknown>,
): ThreadRecord[] {
  const workspaceId = workspaceIdForTask(get, task);
  if (!workspaceId) return [];
  return task.threads.map((taskThread) => {
    const existing = get().threads.find((thread) => thread.id === taskThread.sessionId);
    const metadata =
      threadMetadata && threadMetadata.id === taskThread.sessionId ? threadMetadata : null;
    return {
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

function upsertTask(
  set: StoreSet,
  get: StoreGet,
  task: TaskRecord,
  deps: TaskActionDependencies,
  metadata?: unknown,
): void {
  const workspaceId = workspaceIdForTask(get, task);
  if (!workspaceId) return;
  const parsedMetadata =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>)
      : undefined;
  const taskThreads = synthesizeTaskThreads(get, task, parsedMetadata);
  set((state) => {
    const summaries = state.taskSummariesByWorkspaceId[workspaceId] ?? [];
    const nextSummary = taskSummary(task);
    const nextSummaries = [nextSummary, ...summaries.filter((item) => item.id !== task.id)].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt),
    );
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

function ensureTaskRouter(
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  deps: TaskActionDependencies,
): void {
  taskRouterCleanupByWorkspace.get(workspaceId)?.();
  const workspace = get().workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return;
  const routerCleanup = deps.registerWorkspaceJsonRpcRouter(workspaceId, (message) => {
    if (message.kind !== "notification") return;
    const params =
      typeof message.params === "object" && message.params !== null
        ? (message.params as Record<string, unknown>)
        : null;
    if (
      !params ||
      typeof params.cwd !== "string" ||
      !workspacePathsMatch(params.cwd, workspace.path)
    ) {
      return;
    }
    if (message.method === "task/updated") {
      const parsed = taskRecordSchema.safeParse(params.task);
      if (parsed.success) upsertTask(set, get, parsed.data, deps);
      return;
    }
    if (message.method === "task/created") {
      const parsed = taskRecordSchema.safeParse(params.task);
      if (!parsed.success || params.takeover !== true) return;
      const task = parsed.data;
      const workspaceDisposition = params.workspaceDisposition;
      if (workspaceDisposition === "promote_one_off") {
        set((state) => ({
          workspaces: state.workspaces.map((candidate) =>
            workspacePathsMatch(candidate.path, task.workspacePath)
              ? { ...candidate, name: task.title, workspaceKind: "project" as const }
              : candidate,
          ),
        }));
        void deps.persistNow(get);
      }
      upsertTask(set, get, task, deps);
      const mainThread = task.threads[0];
      const workspaceId = workspaceIdForTask(get, task);
      set({
        selectedWorkspaceId: workspaceId ?? get().selectedWorkspaceId,
        selectedTaskId: task.id,
        selectedThreadId: mainThread?.sessionId ?? null,
        newTaskWorkspaceId: null,
        view: "task",
        contextSidebarCollapsed: false,
        taskError: null,
      });
      if (mainThread) {
        void get().reconnectThread(mainThread.sessionId, undefined, {
          skipWorkspaceSelect: true,
          refreshSnapshot: true,
        });
      }
      deps.syncDesktopStateCache(get);
      return;
    }
    if (message.method === "task/activity") {
      const taskId = typeof params.taskId === "string" ? params.taskId : null;
      const current = taskId ? get().tasksById[taskId] : null;
      if (!current) return;
      const parsedActivity = taskActivitySchema.safeParse(params.activity);
      if (!parsedActivity.success) return;
      const activity = parsedActivity.data;
      const next = {
        ...current,
        updatedAt: activity.createdAt,
        activity: [activity, ...current.activity.filter((item) => item.id !== activity.id)],
      };
      upsertTask(set, get, next, deps);
      if (activity.kind === "input_requested" && current.blockingQuestionCount > 0) {
        const notificationId = `task-input:${activity.id}`;
        set((state) => ({
          notifications: state.notifications.some((item) => item.id === notificationId)
            ? state.notifications
            : pushNotification(state.notifications, {
                id: notificationId,
                ts: activity.createdAt,
                kind: "info",
                title: `${current.title} needs input`,
                detail: activity.summary,
              }),
        }));
      }
      return;
    }
    if (message.method === "task/checkpointCreated") {
      const taskId = typeof params.taskId === "string" ? params.taskId : null;
      const current = taskId ? get().tasksById[taskId] : null;
      const parsedCheckpoint = taskCheckpointSchema.safeParse(params.checkpoint);
      if (current && parsedCheckpoint.success) {
        upsertTask(set, get, { ...current, latestCheckpoint: parsedCheckpoint.data }, deps);
      }
    }
  });
  const cleanup = () => {
    routerCleanup();
    taskRouterCleanupByWorkspace.delete(workspaceId);
  };
  taskRouterCleanupByWorkspace.set(workspaceId, cleanup);
}

async function ensureTaskTransport(
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  deps: TaskActionDependencies,
): Promise<void> {
  await deps.ensureServerRunning(get, set, workspaceId);
  deps.ensureControlSocket(get, set, workspaceId);
  ensureTaskRouter(get, set, workspaceId, deps);
}

function notifyError(set: StoreSet, title: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  set((state) => ({
    taskError: detail,
    notifications: pushNotification(state.notifications, {
      id: makeId(),
      ts: nowIso(),
      kind: "error",
      title,
      detail,
    }),
  }));
}

export function createTaskActions(
  set: StoreSet,
  get: StoreGet,
  deps: TaskActionDependencies = defaultTaskActionDependencies,
): Pick<
  AppStoreActions,
  | "openNewTask"
  | "refreshTasks"
  | "startTask"
  | "selectTask"
  | "selectTaskThread"
  | "createTaskThread"
  | "updateTaskBrief"
  | "acceptTask"
  | "requestTaskChanges"
  | "cancelTask"
  | "reopenTask"
  | "retryTask"
  | "resolveTaskQuestions"
  | "readTaskArtifact"
  | "captureTaskArtifactVersion"
  | "compareTaskArtifactVersions"
  | "previewTaskArtifactVersion"
  | "restoreTaskArtifactVersion"
  | "acceptTaskArtifactVersion"
  | "startTaskArtifactRevision"
> {
  const mutateLifecycle = async (
    taskId: string,
    method: "task/accept" | "task/requestChanges" | "task/cancel" | "task/reopen" | "task/retry",
    extra: Record<string, unknown> = {},
  ): Promise<boolean> => {
    const task = get().tasksById[taskId];
    if (!task) return false;
    const workspaceId = workspaceIdForTask(get, task);
    const workspace = workspaceId ? get().workspaces.find((item) => item.id === workspaceId) : null;
    if (!workspaceId || !workspace) return false;
    try {
      await ensureTaskTransport(get, set, workspaceId, deps);
      const result = await deps.requestJsonRpc(get, set, workspaceId, method, {
        cwd: workspace.path,
        taskId,
        expectedRevision: task.revision,
        ...extra,
      });
      const parsed = taskRecordSchema.safeParse(result?.task);
      if (!parsed.success) throw new Error(`Invalid ${method} response`);
      upsertTask(set, get, parsed.data, deps);
      return true;
    } catch (error) {
      notifyError(set, "Unable to update task", error);
      return false;
    }
  };

  const taskRequestContext = (taskId: string) => {
    const task = get().tasksById[taskId];
    if (!task) return null;
    const workspaceId = workspaceIdForTask(get, task);
    const workspace = workspaceId ? get().workspaces.find((item) => item.id === workspaceId) : null;
    if (!workspaceId || !workspace) return null;
    return { task, workspaceId };
  };

  const applyArtifactMutation = async (
    taskId: string,
    method:
      | "task/artifact/version/capture"
      | "task/artifact/version/restore"
      | "task/artifact/version/accept",
    params: Record<string, unknown>,
  ): Promise<TaskArtifactDetail | null> => {
    const context = taskRequestContext(taskId);
    if (!context) return null;
    try {
      await ensureTaskTransport(get, set, context.workspaceId, deps);
      const result = await deps.requestJsonRpc(get, set, context.workspaceId, method, {
        taskId,
        expectedRevision: context.task.revision,
        ...params,
      });
      const parsedTask = taskRecordSchema.safeParse(result?.task);
      if (!parsedTask.success) throw new Error(`Invalid ${method} task`);
      const detail = parseArtifactDetail(result?.detail, method);
      upsertTask(set, get, parsedTask.data, deps);
      return detail;
    } catch (error) {
      notifyError(set, "Unable to update artifact", error);
      return null;
    }
  };

  return {
    openNewTask: async (workspaceId) => {
      const project =
        (workspaceId
          ? get().workspaces.find((item) => item.id === workspaceId)
          : get().workspaces.find(
              (item) => item.id === get().selectedWorkspaceId && !isOneOffChatWorkspace(item),
            )) ?? get().workspaces.find((item) => !isOneOffChatWorkspace(item));
      if (!project) {
        await get().addWorkspace();
        const addedProject = get().workspaces.find((item) => !isOneOffChatWorkspace(item));
        if (addedProject) await get().openNewTask(addedProject.id);
        return;
      }
      set((state) => ({
        selectedWorkspaceId: project.id,
        selectedThreadId: null,
        selectedTaskId: null,
        newTaskWorkspaceId: project.id,
        newTaskWorkspaceRequestId: state.newTaskWorkspaceRequestId + 1,
        view: "task",
        taskError: null,
      }));
      deps.syncDesktopStateCache(get);
      await get().refreshTasks(project.id);
    },

    refreshTasks: async (workspaceId) => {
      const resolvedWorkspaceId = workspaceId ?? get().selectedWorkspaceId;
      const workspace = resolvedWorkspaceId
        ? get().workspaces.find((item) => item.id === resolvedWorkspaceId)
        : null;
      if (!resolvedWorkspaceId || !workspace) return;
      set((state) => ({
        taskListLoadingByWorkspaceId: {
          ...state.taskListLoadingByWorkspaceId,
          [resolvedWorkspaceId]: true,
        },
      }));
      try {
        await ensureTaskTransport(get, set, resolvedWorkspaceId, deps);
        const result = await deps.requestJsonRpc(get, set, resolvedWorkspaceId, "task/list", {
          cwd: workspace.path,
        });
        const values = Array.isArray(result?.tasks) ? result.tasks : [];
        const tasks = values.flatMap((value: unknown) => {
          const parsed = taskSummarySchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        });
        set((state) => ({
          taskSummariesByWorkspaceId: {
            ...state.taskSummariesByWorkspaceId,
            [resolvedWorkspaceId]: tasks,
          },
          taskListLoadingByWorkspaceId: {
            ...state.taskListLoadingByWorkspaceId,
            [resolvedWorkspaceId]: false,
          },
          taskError: null,
        }));
      } catch (error) {
        set((state) => ({
          taskListLoadingByWorkspaceId: {
            ...state.taskListLoadingByWorkspaceId,
            [resolvedWorkspaceId]: false,
          },
        }));
        notifyError(set, "Unable to load tasks", error);
      }
    },

    startTask: async ({ workspaceId, task: rawTask }) => {
      const workspace = get().workspaces.find((item) => item.id === workspaceId);
      if (!workspace || isOneOffChatWorkspace(workspace)) return null;
      const task: TaskCreationInput = rawTask;
      try {
        await ensureTaskTransport(get, set, workspaceId, deps);
        const result = await deps.requestJsonRpc(get, set, workspaceId, "task/create", {
          cwd: workspace.path,
          ...task,
        });
        const parsed = taskRecordSchema.safeParse(result?.task);
        if (!parsed.success) throw new Error("Invalid task/create response");
        upsertTask(set, get, parsed.data, deps, result?.thread);
        const mainThread = parsed.data.threads[0];
        set({
          selectedWorkspaceId: workspaceId,
          selectedTaskId: parsed.data.id,
          selectedThreadId: mainThread?.sessionId ?? null,
          newTaskWorkspaceId: null,
          view: "task",
          taskError: null,
        });
        if (mainThread) {
          await get().reconnectThread(mainThread.sessionId, undefined, {
            skipWorkspaceSelect: true,
            refreshSnapshot: true,
          });
        }
        deps.syncDesktopStateCache(get);
        return parsed.data;
      } catch (error) {
        notifyError(set, "Unable to create task", error);
        return null;
      }
    },

    selectTask: async (taskId) => {
      const summaryEntry = Object.entries(get().taskSummariesByWorkspaceId).find(([, tasks]) =>
        tasks.some((task) => task.id === taskId),
      );
      const cached = get().tasksById[taskId];
      const workspaceId = summaryEntry?.[0] ?? (cached ? workspaceIdForTask(get, cached) : null);
      const workspace = workspaceId
        ? get().workspaces.find((item) => item.id === workspaceId)
        : null;
      if (!workspaceId || !workspace) return;
      try {
        await ensureTaskTransport(get, set, workspaceId, deps);
        const result = await deps.requestJsonRpc(get, set, workspaceId, "task/read", {
          cwd: workspace.path,
          taskId,
        });
        const parsed = taskRecordSchema.safeParse(result?.task);
        if (!parsed.success) throw new Error("Task was not found");
        upsertTask(set, get, parsed.data, deps);
        const mainThread = parsed.data.threads[0];
        set({
          selectedWorkspaceId: workspaceId,
          selectedTaskId: taskId,
          selectedThreadId: mainThread?.sessionId ?? null,
          newTaskWorkspaceId: null,
          view: "task",
          taskError: null,
        });
        if (mainThread) {
          await get().reconnectThread(mainThread.sessionId, undefined, {
            skipWorkspaceSelect: true,
            refreshSnapshot: true,
          });
        }
        deps.syncDesktopStateCache(get);
      } catch (error) {
        notifyError(set, "Unable to open task", error);
      }
    },

    selectTaskThread: async (taskId, taskThreadId) => {
      const task = get().tasksById[taskId];
      const thread = task?.threads.find((item) => item.id === taskThreadId);
      if (!task || !thread) return;
      set({ selectedTaskId: taskId, selectedThreadId: thread.sessionId, view: "task" });
      await get().reconnectThread(thread.sessionId, undefined, {
        skipWorkspaceSelect: true,
        refreshSnapshot: true,
      });
    },

    createTaskThread: async (taskId, title, workItemId) => {
      const task = get().tasksById[taskId];
      if (!task) return;
      const workspaceId = workspaceIdForTask(get, task);
      const workspace = workspaceId
        ? get().workspaces.find((item) => item.id === workspaceId)
        : null;
      if (!workspaceId || !workspace) return;
      try {
        await ensureTaskTransport(get, set, workspaceId, deps);
        const result = await deps.requestJsonRpc(get, set, workspaceId, "task/thread/create", {
          cwd: workspace.path,
          taskId,
          expectedRevision: task.revision,
          title: title.trim(),
          ...(workItemId ? { workItemId } : {}),
        });
        const parsed = taskRecordSchema.safeParse(result?.task);
        if (!parsed.success) throw new Error("Invalid task/thread/create response");
        upsertTask(set, get, parsed.data, deps, result?.thread);
        const previousIds = new Set(task.threads.map((item) => item.id));
        const created = parsed.data.threads.find((item) => !previousIds.has(item.id));
        if (created) {
          set({ selectedThreadId: created.sessionId, selectedTaskId: taskId, view: "task" });
          await get().reconnectThread(created.sessionId, undefined, { skipWorkspaceSelect: true });
        }
      } catch (error) {
        notifyError(set, "Unable to create task thread", error);
      }
    },

    updateTaskBrief: async (taskId, patch) => {
      const task = get().tasksById[taskId];
      if (!task) return false;
      const workspaceId = workspaceIdForTask(get, task);
      const workspace = workspaceId
        ? get().workspaces.find((item) => item.id === workspaceId)
        : null;
      if (!workspaceId || !workspace) return false;
      try {
        await ensureTaskTransport(get, set, workspaceId, deps);
        const result = await deps.requestJsonRpc(get, set, workspaceId, "task/updateBrief", {
          cwd: workspace.path,
          taskId,
          expectedRevision: task.revision,
          ...patch,
        });
        const parsed = taskRecordSchema.safeParse(result?.task);
        if (!parsed.success) throw new Error("Invalid task/updateBrief response");
        upsertTask(set, get, parsed.data, deps);
        return true;
      } catch (error) {
        notifyError(set, "Unable to update task brief", error);
        return false;
      }
    },

    acceptTask: async (taskId) => {
      await mutateLifecycle(taskId, "task/accept");
    },
    requestTaskChanges: async (taskId, feedback) => {
      await mutateLifecycle(taskId, "task/requestChanges", { feedback });
    },
    cancelTask: async (taskId, reason) => {
      await mutateLifecycle(taskId, "task/cancel", reason ? { reason } : {});
    },
    reopenTask: async (taskId, reason) => {
      await mutateLifecycle(taskId, "task/reopen", reason ? { reason } : {});
    },
    retryTask: async (taskId) => await mutateLifecycle(taskId, "task/retry"),

    resolveTaskQuestions: async (
      taskId: string,
      answers: TaskQuestionAnswerInput[],
    ): Promise<TaskQuestionResumeStatus | null> => {
      const context = taskRequestContext(taskId);
      if (!context || answers.length === 0) return null;
      try {
        await ensureTaskTransport(get, set, context.workspaceId, deps);
        const result = await deps.requestJsonRpc(
          get,
          set,
          context.workspaceId,
          "task/questions/resolve",
          {
            cwd: context.task.workspacePath,
            taskId,
            expectedRevision: context.task.revision,
            answers,
          },
        );
        const parsedTask = taskRecordSchema.safeParse(result?.task);
        const resumeStatus = result?.resumeStatus;
        if (
          !parsedTask.success ||
          (resumeStatus !== "queued" &&
            resumeStatus !== "steered" &&
            resumeStatus !== "not_needed" &&
            resumeStatus !== "failed")
        ) {
          throw new Error("Invalid task/questions/resolve response");
        }
        upsertTask(set, get, parsedTask.data, deps);
        return resumeStatus;
      } catch (error) {
        notifyError(set, "Unable to answer task questions", error);
        return null;
      }
    },

    readTaskArtifact: async (taskId, artifactId) => {
      const context = taskRequestContext(taskId);
      if (!context) return null;
      try {
        await ensureTaskTransport(get, set, context.workspaceId, deps);
        const result = await deps.requestJsonRpc(
          get,
          set,
          context.workspaceId,
          "task/artifact/read",
          { taskId, artifactId },
        );
        return parseArtifactDetail(result?.detail, "task/artifact/read");
      } catch (error) {
        notifyError(set, "Unable to load artifact history", error);
        return null;
      }
    },

    captureTaskArtifactVersion: async (taskId, artifactId, changeSummary) =>
      await applyArtifactMutation(taskId, "task/artifact/version/capture", {
        artifactId,
        ...(changeSummary?.trim() ? { changeSummary: changeSummary.trim() } : {}),
      }),

    compareTaskArtifactVersions: async (taskId, artifactId, baseVersionId, targetVersionId) => {
      const context = taskRequestContext(taskId);
      if (!context) return null;
      try {
        await ensureTaskTransport(get, set, context.workspaceId, deps);
        const result = await deps.requestJsonRpc(
          get,
          set,
          context.workspaceId,
          "task/artifact/version/compare",
          { taskId, artifactId, baseVersionId, targetVersionId },
        );
        return parseArtifactDiff(result?.comparison);
      } catch (error) {
        notifyError(set, "Unable to compare artifact versions", error);
        return null;
      }
    },

    previewTaskArtifactVersion: async (taskId, artifactId, versionId) => {
      const context = taskRequestContext(taskId);
      if (!context) return null;
      try {
        await ensureTaskTransport(get, set, context.workspaceId, deps);
        const result = await deps.requestJsonRpc(
          get,
          set,
          context.workspaceId,
          "task/artifact/version/preview",
          { taskId, artifactId, versionId },
        );
        if (typeof result?.versionId !== "string") {
          throw new Error("Invalid task/artifact/version/preview version id");
        }
        return { versionId: result.versionId, preview: parseArtifactPreview(result.preview) };
      } catch (error) {
        notifyError(set, "Unable to preview artifact version", error);
        return null;
      }
    },

    restoreTaskArtifactVersion: async (taskId, artifactId, versionId) =>
      await applyArtifactMutation(taskId, "task/artifact/version/restore", {
        artifactId,
        versionId,
      }),

    acceptTaskArtifactVersion: async (taskId, artifactId, versionId) =>
      await applyArtifactMutation(taskId, "task/artifact/version/accept", {
        artifactId,
        ...(versionId ? { versionId } : {}),
      }),

    startTaskArtifactRevision: async (taskId, artifactId, baseVersionId, instruction) => {
      const context = taskRequestContext(taskId);
      const normalizedInstruction = instruction.trim();
      if (!context || !normalizedInstruction) return null;
      try {
        await ensureTaskTransport(get, set, context.workspaceId, deps);
        const result = await deps.requestJsonRpc(
          get,
          set,
          context.workspaceId,
          "task/artifact/revision/start",
          {
            taskId,
            artifactId,
            baseVersionId,
            instruction: normalizedInstruction,
            expectedRevision: context.task.revision,
          },
        );
        const parsedTask = taskRecordSchema.safeParse(result?.task);
        const parsedRevision = taskArtifactRevisionSchema.safeParse(result?.revision);
        const thread = isRecord(result?.thread) ? result.thread : null;
        if (!parsedTask.success || !parsedRevision.success || typeof thread?.id !== "string") {
          throw new Error("Invalid task/artifact/revision/start response");
        }
        const detail = parseArtifactDetail(result?.detail, "task/artifact/revision/start");
        const focusedTaskThread = parsedTask.data.threads.find(
          (candidate) => candidate.id === parsedRevision.data.taskThreadId,
        );
        if (
          !focusedTaskThread ||
          focusedTaskThread.sessionId !== parsedRevision.data.sessionId ||
          focusedTaskThread.sessionId !== thread.id
        ) {
          throw new Error("Artifact revision did not return its focused task thread");
        }
        upsertTask(set, get, parsedTask.data, deps, thread);
        set({
          selectedWorkspaceId: context.workspaceId,
          selectedTaskId: taskId,
          selectedThreadId: thread.id,
          view: "task",
        });
        await get().reconnectThread(thread.id, undefined, {
          skipWorkspaceSelect: true,
          refreshSnapshot: true,
        });
        deps.syncDesktopStateCache(get);
        return detail;
      } catch (error) {
        notifyError(set, "Unable to start artifact revision", error);
        return null;
      }
    },
  };
}

export const __internalTaskActions = {
  reset() {
    for (const cleanup of taskRouterCleanupByWorkspace.values()) cleanup();
    taskRouterCleanupByWorkspace.clear();
  },
};
