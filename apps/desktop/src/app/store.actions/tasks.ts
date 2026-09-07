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
  taskActivitySchema,
  taskArtifactDetailSchema,
  taskArtifactRevisionSchema,
  taskCheckpointSchema,
  taskRecordSchema,
  taskSummarySchema,
} from "../../../../../src/shared/tasks";
import { createEmptyTaskCreationDraft } from "../creationDrafts";
import { appNavigation } from "../navigation";
import type { AbortableActionOptions, AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import {
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  makeId,
  nowIso,
  operationKey,
  persistNow,
  pushNotification,
  runAcknowledgedOperation,
  syncDesktopStateCache,
} from "../store.helpers";
import { registerWorkspaceJsonRpcRouter, requestJsonRpc } from "../store.helpers/jsonRpcSocket";
import {
  beginCreationOperationIntent,
  invalidateNavigationIntent,
  isCreationNavigationIntentCurrent,
  isOperationAbortError,
  isThreadNavigationIntentCurrent,
} from "../store.helpers/operationIntent";
import { persist } from "../store.helpers/persistence";
import { isOneOffChatWorkspace, type OperationResult } from "../types";
import {
  mergeTaskSummaries,
  upsertTask,
  workspaceIdForTask,
  workspacePathsMatch,
} from "./taskState";

const taskRouterCleanupByWorkspace = new Map<string, () => void>();

export type TaskActionDependencies = {
  ensureControlSocket: typeof ensureControlSocket;
  ensureServerRunning: typeof ensureServerRunning;
  ensureThreadRuntime: typeof ensureThreadRuntime;
  registerWorkspaceJsonRpcRouter: typeof registerWorkspaceJsonRpcRouter;
  requestJsonRpc: typeof requestJsonRpc;
  syncDesktopStateCache: typeof syncDesktopStateCache;
  persist: typeof persist;
  persistNow: typeof persistNow;
};

const defaultTaskActionDependencies: TaskActionDependencies = {
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  registerWorkspaceJsonRpcRouter,
  requestJsonRpc,
  syncDesktopStateCache,
  persist,
  persistNow,
};

type TaskLifecycleMethod =
  | "task/accept"
  | "task/requestChanges"
  | "task/cancel"
  | "task/reopen"
  | "task/retry";

function terminalLifecycleActionForMethod(method: TaskLifecycleMethod): "reopen" | "retry" | null {
  if (method === "task/reopen") return "reopen";
  if (method === "task/retry") return "retry";
  return null;
}

function taskLifecycleLabel(method: TaskLifecycleMethod): string {
  switch (method) {
    case "task/accept":
      return "Accept task";
    case "task/requestChanges":
      return "Request task changes";
    case "task/cancel":
      return "Cancel task";
    case "task/reopen":
      return "Reopen task";
    case "task/retry":
      return "Retry task";
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcProperty(result: unknown, key: string): unknown {
  return isRecord(result) ? result[key] : undefined;
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
      if (get().desktopFeatureFlags.tasks !== true) return;
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
      const sourceSessionId =
        typeof params.sourceSessionId === "string" ? params.sourceSessionId : null;
      const sourceThread = sourceSessionId
        ? get().threads.find(
            (thread) => thread.id === sourceSessionId || thread.sessionId === sourceSessionId,
          )
        : null;
      const canTakeOver =
        sourceThread != null &&
        appNavigation.getSnapshot().view === "chat" &&
        get().selectedThreadId === sourceThread.id &&
        isThreadNavigationIntentCurrent(sourceThread.id);
      if (!canTakeOver) {
        deps.syncDesktopStateCache(get);
        return;
      }
      const mainThread = task.threads[0];
      const workspaceId = workspaceIdForTask(get, task);
      set({
        selectedWorkspaceId: workspaceId ?? get().selectedWorkspaceId,
        selectedTaskId: task.id,
        selectedThreadId: mainThread?.sessionId ?? null,
        newTaskWorkspaceId: null,
        navigation: { view: "task" },
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
        updatedAt: activity.createdAt > current.updatedAt ? activity.createdAt : current.updatedAt,
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
                audience: "background",
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
  options: AbortableActionOptions = {},
): Promise<void> {
  if (options.signal?.aborted) return;
  await deps.ensureServerRunning(get, set, workspaceId, options);
  if (options.signal?.aborted) return;
  deps.ensureControlSocket(get, set, workspaceId);
  if (options.signal?.aborted) return;
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
  | "setTaskCreationDraft"
  | "setTaskCreationError"
  | "clearTaskCreationDraft"
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
  const taskListRequests = new Map<string, symbol>();

  const setTaskCreationError = (revision: number, message: string | null): boolean => {
    let applied = false;
    set((state) => {
      if (state.taskCreationDraft.revision !== revision) return {};
      applied = true;
      return {
        taskCreationError: message ? { revision, message } : null,
      };
    });
    if (applied) deps.persist(get);
    return applied;
  };
  const clearTaskCreationDraft = (revision: number): boolean => {
    let cleared = false;
    set((state) => {
      if (state.taskCreationDraft.revision !== revision) return {};
      cleared = true;
      return {
        taskCreationDraft: createEmptyTaskCreationDraft(
          revision + 1,
          state.taskCreationDraft.workspaceId,
        ),
        taskCreationError: null,
      };
    });
    if (cleared) deps.persist(get);
    return cleared;
  };
  const mutateLifecycle = async (
    taskId: string,
    method: TaskLifecycleMethod,
    extra: Record<string, unknown> = {},
  ): Promise<OperationResult> => {
    const label = taskLifecycleLabel(method);
    return await runAcknowledgedOperation(get, set, {
      key: operationKey("task", "lifecycle", taskId),
      label,
      errorTitle: `${label} failed`,
      errorMessage: `Unable to ${label.toLowerCase()}.`,
      execute: async () => {
        const task = get().tasksById[taskId];
        if (!task) throw new Error("Task not found.");
        const workspaceId = workspaceIdForTask(get, task);
        const workspace = workspaceId
          ? get().workspaces.find((item) => item.id === workspaceId)
          : null;
        if (!workspaceId || !workspace) throw new Error("Task workspace not found.");
        const terminalAction = terminalLifecycleActionForMethod(method);
        const lifecycleRequest =
          terminalAction !== null
            ? {
                action: terminalAction,
                expectedRevision: task.revision,
                requestId: makeId(),
              }
            : null;
        if (lifecycleRequest) {
          set((state) => ({
            taskLifecycleRequestByTaskId: {
              ...(state.taskLifecycleRequestByTaskId ?? {}),
              [taskId]: lifecycleRequest,
            },
          }));
        }
        const lifecycleRequestIsCurrent = () =>
          !lifecycleRequest ||
          get().taskLifecycleRequestByTaskId[taskId]?.requestId === lifecycleRequest.requestId;
        try {
          await ensureTaskTransport(get, set, workspaceId, deps);
          if (!lifecycleRequestIsCurrent()) {
            throw new Error("A newer task request replaced this operation.");
          }
          const result: unknown = await deps.requestJsonRpc(get, set, workspaceId, method, {
            cwd: workspace.path,
            taskId,
            expectedRevision: task.revision,
            ...extra,
          });
          if (!lifecycleRequestIsCurrent()) {
            throw new Error("A newer task request replaced this operation.");
          }
          const parsed = taskRecordSchema.safeParse(rpcProperty(result, "task"));
          if (!parsed.success) throw new Error(`Invalid ${method} response`);
          upsertTask(set, get, parsed.data, deps);
        } finally {
          if (lifecycleRequest) {
            set((state) => {
              const current = state.taskLifecycleRequestByTaskId?.[taskId];
              if (current?.requestId !== lifecycleRequest.requestId) return {};
              const next = { ...(state.taskLifecycleRequestByTaskId ?? {}) };
              delete next[taskId];
              return { taskLifecycleRequestByTaskId: next };
            });
          }
        }
      },
    });
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
  ): Promise<OperationResult<TaskArtifactDetail>> => {
    return await runAcknowledgedOperation(get, set, {
      key: operationKey("task", "artifact", method, taskId, String(params.artifactId ?? "")),
      label: "Update task artifact",
      errorTitle: "Artifact not updated",
      errorMessage: "Unable to update artifact.",
      execute: async () => {
        const context = taskRequestContext(taskId);
        if (!context) throw new Error("Task not found.");
        await ensureTaskTransport(get, set, context.workspaceId, deps);
        const result: unknown = await deps.requestJsonRpc(get, set, context.workspaceId, method, {
          taskId,
          expectedRevision: context.task.revision,
          ...params,
        });
        const parsedTask = taskRecordSchema.safeParse(rpcProperty(result, "task"));
        if (!parsedTask.success) throw new Error(`Invalid ${method} task`);
        const detail = parseArtifactDetail(rpcProperty(result, "detail"), method);
        upsertTask(set, get, parsedTask.data, deps);
        return detail;
      },
    });
  };

  return {
    setTaskCreationDraft: (patch) => {
      set((state) => ({
        taskCreationDraft: {
          ...state.taskCreationDraft,
          ...patch,
          revision: state.taskCreationDraft.revision + 1,
          updatedAt: nowIso(),
        },
        taskCreationError: null,
      }));
      deps.persist(get);
    },

    setTaskCreationError,
    clearTaskCreationDraft,

    openNewTask: async (workspaceId) => {
      if (get().desktopFeatureFlags.tasks !== true) return;
      invalidateNavigationIntent();
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
        navigation: { view: "task" },
        taskError: null,
      }));
      deps.syncDesktopStateCache(get);
      await get().refreshTasks(project.id);
    },

    refreshTasks: async (workspaceId, options = {}) => {
      if (options.signal?.aborted) return;
      if (get().desktopFeatureFlags.tasks !== true) return;
      const resolvedWorkspaceId = workspaceId ?? get().selectedWorkspaceId;
      const workspace = resolvedWorkspaceId
        ? get().workspaces.find((item) => item.id === resolvedWorkspaceId)
        : null;
      if (!resolvedWorkspaceId || !workspace) return;
      const request = Symbol();
      const summariesBeforeRequest = new Map(
        (get().taskSummariesByWorkspaceId[resolvedWorkspaceId] ?? []).map((task) => [
          task.id,
          task,
        ]),
      );
      taskListRequests.set(resolvedWorkspaceId, request);
      const ownsRequest = () => taskListRequests.get(resolvedWorkspaceId) === request;
      const isCurrent = () =>
        ownsRequest() &&
        options.signal?.aborted !== true &&
        get().workspaces.some((item) => item.id === resolvedWorkspaceId);
      set((state) => ({
        taskListLoadingByWorkspaceId: {
          ...state.taskListLoadingByWorkspaceId,
          [resolvedWorkspaceId]: true,
        },
      }));
      try {
        await ensureTaskTransport(get, set, resolvedWorkspaceId, deps, options);
        if (!isCurrent()) return;
        const result: unknown = await deps.requestJsonRpc(
          get,
          set,
          resolvedWorkspaceId,
          "task/list",
          { cwd: workspace.path },
          options,
        );
        if (!isCurrent()) return;
        const parsed = taskSummarySchema.array().safeParse(rpcProperty(result, "tasks"));
        if (!parsed.success) throw new Error("Invalid task/list response");
        set((state) => ({
          taskSummariesByWorkspaceId: {
            ...state.taskSummariesByWorkspaceId,
            [resolvedWorkspaceId]: mergeTaskSummaries(
              state.taskSummariesByWorkspaceId[resolvedWorkspaceId] ?? [],
              parsed.data,
              summariesBeforeRequest,
            ),
          },
          taskError: null,
        }));
      } catch (error) {
        if (!isCurrent()) return;
        notifyError(set, "Unable to load tasks", error);
      } finally {
        if (ownsRequest()) {
          taskListRequests.delete(resolvedWorkspaceId);
          set((state) =>
            state.workspaces.some((item) => item.id === resolvedWorkspaceId)
              ? {
                  taskListLoadingByWorkspaceId: {
                    ...state.taskListLoadingByWorkspaceId,
                    [resolvedWorkspaceId]: false,
                  },
                }
              : {},
          );
        }
      }
    },

    startTask: async ({ workspaceId, task: rawTask, draftRevision, intent, signal, onPhase }) => {
      const operationIntent = intent ?? beginCreationOperationIntent();
      const canNavigate = () =>
        isCreationNavigationIntentCurrent(operationIntent) && signal?.aborted !== true;
      const reportPhase = onPhase ?? (() => undefined);
      const task: TaskCreationInput = rawTask;
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("task", "create", workspaceId, task.idempotencyKey),
        label: "Create task",
        errorTitle: "Task not created",
        errorMessage: "Unable to create task.",
        execute: async () => {
          if (get().desktopFeatureFlags.tasks !== true) {
            throw new Error("Task mode is not enabled.");
          }
          const workspace = get().workspaces.find((item) => item.id === workspaceId);
          if (!workspace || isOneOffChatWorkspace(workspace)) {
            throw new Error("Select a project workspace before creating a task.");
          }
          if (draftRevision !== undefined) {
            setTaskCreationError(draftRevision, null);
          }
          try {
            reportPhase("starting-server");
            await ensureTaskTransport(get, set, workspaceId, deps, { signal });
            reportPhase("creating");
            const requestParams = {
              cwd: workspace.path,
              ...task,
            };
            const result: unknown = signal
              ? await deps.requestJsonRpc(get, set, workspaceId, "task/create", requestParams, {
                  signal,
                })
              : await deps.requestJsonRpc(get, set, workspaceId, "task/create", requestParams);
            const parsed = taskRecordSchema.safeParse(rpcProperty(result, "task"));
            if (!parsed.success) throw new Error("Invalid task/create response");
            upsertTask(set, get, parsed.data, deps, rpcProperty(result, "thread"));
            const mainThread = parsed.data.threads[0];
            set(
              canNavigate()
                ? {
                    selectedWorkspaceId: workspaceId,
                    selectedTaskId: parsed.data.id,
                    selectedThreadId: mainThread?.sessionId ?? null,
                    newTaskWorkspaceId: null,
                    navigation: { view: "task" },
                    taskError: null,
                  }
                : { taskError: null },
            );
            if (mainThread && canNavigate()) {
              await get().reconnectThread(mainThread.sessionId, undefined, {
                skipWorkspaceSelect: true,
                refreshSnapshot: true,
              });
            }
            if (draftRevision !== undefined && canNavigate()) {
              clearTaskCreationDraft(draftRevision);
            }
            deps.syncDesktopStateCache(get);
            return parsed.data;
          } catch (error) {
            if (draftRevision !== undefined) {
              setTaskCreationError(
                draftRevision,
                isOperationAbortError(error)
                  ? "Task creation cancelled. Your brief was preserved."
                  : error instanceof Error
                    ? error.message
                    : String(error),
              );
            }
            throw error;
          }
        },
      });
    },

    selectTask: async (taskId, options = {}) => {
      const isCurrent = () => options.signal?.aborted !== true;
      if (!isCurrent()) return;
      const selectionIntent = beginCreationOperationIntent();
      const canNavigate = () => isCurrent() && isCreationNavigationIntentCurrent(selectionIntent);
      if (get().desktopFeatureFlags.tasks !== true) return;
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
        await ensureTaskTransport(get, set, workspaceId, deps, options);
        if (!isCurrent()) return;
        const result: unknown = await deps.requestJsonRpc(
          get,
          set,
          workspaceId,
          "task/read",
          { cwd: workspace.path, taskId },
          options,
        );
        if (!isCurrent()) return;
        const parsed = taskRecordSchema.safeParse(rpcProperty(result, "task"));
        if (!parsed.success) throw new Error("Task was not found");
        if (!isCurrent()) return;
        upsertTask(set, get, parsed.data, deps);
        const mainThread = (get().tasksById[taskId] ?? parsed.data).threads[0];
        if (!canNavigate()) return;
        set({
          selectedWorkspaceId: workspaceId,
          selectedTaskId: taskId,
          selectedThreadId: mainThread?.sessionId ?? null,
          newTaskWorkspaceId: null,
          ...(options?.preserveView ? {} : { navigation: { view: "task" } }),
          taskError: null,
        });
        if (mainThread) {
          await get().reconnectThread(mainThread.sessionId, undefined, {
            skipWorkspaceSelect: true,
            refreshSnapshot: true,
            signal: options.signal,
          });
          if (!canNavigate()) return;
        }
        if (!canNavigate()) return;
        deps.syncDesktopStateCache(get);
      } catch (error) {
        if (!canNavigate()) return;
        notifyError(set, "Unable to open task", error);
      }
    },

    selectTaskThread: async (taskId, taskThreadId) => {
      if (get().desktopFeatureFlags.tasks !== true) return;
      const task = get().tasksById[taskId];
      const thread = task?.threads.find((item) => item.id === taskThreadId);
      if (!task || !thread) return;
      invalidateNavigationIntent();
      set({
        selectedTaskId: taskId,
        selectedThreadId: thread.sessionId,
        navigation: { view: "task" },
      });
      await get().reconnectThread(thread.sessionId, undefined, {
        skipWorkspaceSelect: true,
        refreshSnapshot: true,
      });
    },

    createTaskThread: async (taskId, title, workItemId, options = {}) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("task", "thread", "create", taskId),
        label: "Create task thread",
        errorTitle: "Task thread not created",
        errorMessage: "Unable to create task thread.",
        execute: async () => {
          const operationIntent = options.intent ?? beginCreationOperationIntent();
          const canNavigate = () =>
            isCreationNavigationIntentCurrent(operationIntent) && options.signal?.aborted !== true;
          if (get().desktopFeatureFlags.tasks !== true) {
            throw new Error("Task mode is not enabled.");
          }
          const task = get().tasksById[taskId];
          if (!task) throw new Error("Task not found.");
          const workspaceId = workspaceIdForTask(get, task);
          const workspace = workspaceId
            ? get().workspaces.find((item) => item.id === workspaceId)
            : null;
          if (!workspaceId || !workspace) throw new Error("Task workspace not found.");
          options.onPhase?.("starting-server");
          await ensureTaskTransport(get, set, workspaceId, deps, options);
          options.onPhase?.("creating");
          const requestParams = {
            cwd: workspace.path,
            taskId,
            expectedRevision: task.revision,
            title: title.trim(),
            ...(workItemId ? { workItemId } : {}),
          };
          const result: unknown = options.signal
            ? await deps.requestJsonRpc(
                get,
                set,
                workspaceId,
                "task/thread/create",
                requestParams,
                { signal: options.signal },
              )
            : await deps.requestJsonRpc(get, set, workspaceId, "task/thread/create", requestParams);
          const parsed = taskRecordSchema.safeParse(rpcProperty(result, "task"));
          if (!parsed.success) throw new Error("Invalid task/thread/create response");
          upsertTask(set, get, parsed.data, deps, rpcProperty(result, "thread"));
          const previousIds = new Set(task.threads.map((item) => item.id));
          const created = parsed.data.threads.find((item) => !previousIds.has(item.id));
          if (created && canNavigate()) {
            set({
              selectedThreadId: created.sessionId,
              selectedTaskId: taskId,
              navigation: { view: "task" },
            });
            await get().reconnectThread(created.sessionId, undefined, {
              skipWorkspaceSelect: true,
            });
          }
        },
      });
    },

    updateTaskBrief: async (taskId, patch) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("task", "brief", taskId),
        label: "Save task brief",
        errorTitle: "Task brief not saved",
        errorMessage: "Unable to update task brief.",
        execute: async () => {
          const task = get().tasksById[taskId];
          if (!task) throw new Error("Task not found.");
          const workspaceId = workspaceIdForTask(get, task);
          const workspace = workspaceId
            ? get().workspaces.find((item) => item.id === workspaceId)
            : null;
          if (!workspaceId || !workspace) throw new Error("Task workspace not found.");
          await ensureTaskTransport(get, set, workspaceId, deps);
          const result: unknown = await deps.requestJsonRpc(
            get,
            set,
            workspaceId,
            "task/updateBrief",
            {
              cwd: workspace.path,
              taskId,
              expectedRevision: task.revision,
              ...patch,
            },
          );
          const parsed = taskRecordSchema.safeParse(rpcProperty(result, "task"));
          if (!parsed.success) throw new Error("Invalid task/updateBrief response");
          upsertTask(set, get, parsed.data, deps);
        },
      });
    },

    acceptTask: async (taskId) => {
      return await mutateLifecycle(taskId, "task/accept");
    },
    requestTaskChanges: async (taskId, feedback) => {
      return await mutateLifecycle(taskId, "task/requestChanges", { feedback });
    },
    cancelTask: async (taskId, reason) => {
      return await mutateLifecycle(taskId, "task/cancel", reason ? { reason } : {});
    },
    reopenTask: async (taskId, reason) => {
      return await mutateLifecycle(taskId, "task/reopen", reason ? { reason } : {});
    },
    retryTask: async (taskId) => await mutateLifecycle(taskId, "task/retry"),

    resolveTaskQuestions: async (
      taskId: string,
      answers: TaskQuestionAnswerInput[],
    ): Promise<OperationResult<TaskQuestionResumeStatus>> => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("task", "questions", taskId),
        label: "Submit task answers",
        errorTitle: "Task answers not submitted",
        errorMessage: "Unable to answer task questions.",
        execute: async () => {
          const context = taskRequestContext(taskId);
          if (!context) throw new Error("Task not found.");
          if (answers.length === 0) throw new Error("Answer at least one question.");
          await ensureTaskTransport(get, set, context.workspaceId, deps);
          const result: unknown = await deps.requestJsonRpc(
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
          const parsedTask = taskRecordSchema.safeParse(rpcProperty(result, "task"));
          const resumeStatus = rpcProperty(result, "resumeStatus");
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
        },
      });
    },

    readTaskArtifact: async (taskId, artifactId) => {
      const context = taskRequestContext(taskId);
      if (!context) return null;
      try {
        await ensureTaskTransport(get, set, context.workspaceId, deps);
        const result: unknown = await deps.requestJsonRpc(
          get,
          set,
          context.workspaceId,
          "task/artifact/read",
          { taskId, artifactId },
        );
        return parseArtifactDetail(rpcProperty(result, "detail"), "task/artifact/read");
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
        const result: unknown = await deps.requestJsonRpc(
          get,
          set,
          context.workspaceId,
          "task/artifact/version/compare",
          { taskId, artifactId, baseVersionId, targetVersionId },
        );
        return parseArtifactDiff(rpcProperty(result, "comparison"));
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
        const result: unknown = await deps.requestJsonRpc(
          get,
          set,
          context.workspaceId,
          "task/artifact/version/preview",
          { taskId, artifactId, versionId },
        );
        const responseVersionId = rpcProperty(result, "versionId");
        if (typeof responseVersionId !== "string") {
          throw new Error("Invalid task/artifact/version/preview version id");
        }
        return {
          versionId: responseVersionId,
          preview: parseArtifactPreview(rpcProperty(result, "preview")),
        };
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
      const normalizedInstruction = instruction.trim();
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("task", "artifact", "revision", taskId, artifactId),
        label: "Start artifact revision",
        errorTitle: "Artifact revision not started",
        errorMessage: "Unable to start artifact revision.",
        execute: async () => {
          const operationIntent = beginCreationOperationIntent();
          if (get().desktopFeatureFlags.tasks !== true) {
            throw new Error("Task mode is not enabled.");
          }
          const context = taskRequestContext(taskId);
          if (!context) throw new Error("Task not found.");
          if (!normalizedInstruction) throw new Error("Enter a revision instruction.");
          await ensureTaskTransport(get, set, context.workspaceId, deps);
          const result: unknown = await deps.requestJsonRpc(
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
          const parsedTask = taskRecordSchema.safeParse(rpcProperty(result, "task"));
          const parsedRevision = taskArtifactRevisionSchema.safeParse(
            rpcProperty(result, "revision"),
          );
          const threadValue = rpcProperty(result, "thread");
          const thread = isRecord(threadValue) ? threadValue : null;
          if (!parsedTask.success || !parsedRevision.success || typeof thread?.id !== "string") {
            throw new Error("Invalid task/artifact/revision/start response");
          }
          const detail = parseArtifactDetail(
            rpcProperty(result, "detail"),
            "task/artifact/revision/start",
          );
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
          if (isCreationNavigationIntentCurrent(operationIntent)) {
            set({
              selectedWorkspaceId: context.workspaceId,
              selectedTaskId: taskId,
              selectedThreadId: thread.id,
              navigation: { view: "task" },
            });
            await get().reconnectThread(thread.id, undefined, {
              skipWorkspaceSelect: true,
              refreshSnapshot: true,
            });
          }
          deps.syncDesktopStateCache(get);
          return detail;
        },
      });
    },
  };
}

export const __internalTaskActions = {
  reset() {
    for (const cleanup of taskRouterCleanupByWorkspace.values()) cleanup();
    taskRouterCleanupByWorkspace.clear();
  },
};
