import { defaultModelForProvider } from "@cowork/providers/catalog";
import { sameWorkspacePath } from "@cowork/utils/workspacePath";

import { captureProductEvent } from "../../lib/analytics";
import { pickWorkspaceDirectory, stopWorkspaceServer } from "../../lib/desktopCommands";
import { getDesktopPlatformInfo } from "../../lib/desktopPlatform";
import { applyWorkspaceOrder, reorderSidebarItemsById } from "../../ui/sidebarHelpers";
import {
  type AppStoreActions,
  basename,
  bumpWorkspaceJsonRpcSocketGeneration,
  bumpWorkspaceStartGeneration,
  clearPendingThreadSteers,
  clearWorkspaceJsonRpcSocketGeneration,
  clearWorkspaceStartState,
  disposeWorkspaceJsonRpcState,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  makeId,
  markWorkspaceServerStale,
  nowIso,
  persistNow,
  RUNTIME,
  requestWorkspaceSessions,
  type StoreGet,
  type StoreSet,
  sendThread,
  waitForWorkspaceServerRestartBackoff,
} from "../store.helpers";
import { resolveCurrentWorkspaceDefaultsSource } from "../store.helpers/oneOffWorkspaceRecord";
import { isStandardChatThread } from "../threadFilters";
import { getThreadSelectionIntent } from "../threadSelectionContext";
import type { WorkspaceRecord } from "../types";
import { hydrateThreadSelection } from "./thread";

export function createWorkspaceActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "addWorkspace"
  | "removeWorkspace"
  | "selectWorkspace"
  | "reorderWorkspaces"
  | "setWorkspacesOrder"
  | "restartWorkspaceServer"
  | "handleWorkspaceServerExited"
  | "setWorkspaceServerStartupProgress"
> {
  const closeThreadSession = (threadId: string) => {
    sendThread(get, threadId, (sessionId) => ({ type: "session_close", sessionId }));
  };

  const preferredThreadIdForWorkspace = (workspaceId: string): string | null => {
    const state = get();
    const currentThreadId = state.selectedThreadId;
    const currentThread = currentThreadId
      ? (state.threads.find((thread) => thread.id === currentThreadId) ?? null)
      : null;

    if (
      currentThread?.workspaceId === workspaceId &&
      isStandardChatThread(currentThread, { includeDrafts: true })
    ) {
      return currentThread.id;
    }

    const workspaceThreads = state.threads
      .filter(
        (thread) =>
          thread.workspaceId === workspaceId &&
          isStandardChatThread(thread, { includeDrafts: true }),
      )
      .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));

    return workspaceThreads[0]?.id ?? null;
  };

  const preferredTaskThreadId = (taskId: string, currentThreadId: string | null): string | null => {
    const state = get();
    const task = state.tasksById[taskId];
    if (currentThreadId) {
      const currentThread = state.threads.find((thread) => thread.id === currentThreadId);
      if (
        currentThread?.taskId === taskId ||
        task?.threads.some((thread) => thread.sessionId === currentThreadId)
      ) {
        return currentThreadId;
      }
    }

    return (
      task?.threads[0]?.sessionId ??
      state.threads
        .filter((thread) => thread.taskId === taskId)
        .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))[0]?.id ??
      null
    );
  };

  const taskBelongsToWorkspace = (taskId: string | null, workspaceId: string): boolean => {
    if (!taskId) return false;
    const state = get();
    if ((state.taskSummariesByWorkspaceId[workspaceId] ?? []).some((task) => task.id === taskId)) {
      return true;
    }
    const task = state.tasksById[taskId];
    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (!task || !workspace) return false;
    return sameWorkspacePath(
      task.workspacePath,
      workspace.path,
      getDesktopPlatformInfo().rawPlatform as NodeJS.Platform,
    );
  };

  const isWorkspaceLifecycleEnabled = () => get().desktopFeatureFlags.workspaceLifecycle !== false;

  return {
    addWorkspace: async () => {
      if (!isWorkspaceLifecycleEnabled()) return;
      if (RUNTIME.workspacePickerOpen) return;
      RUNTIME.workspacePickerOpen = true;

      let dir: string | null = null;
      try {
        dir = await pickWorkspaceDirectory();
      } finally {
        RUNTIME.workspacePickerOpen = false;
      }
      if (!dir) return;

      const existing = get().workspaces.find((w) => w.path === dir);
      if (existing) {
        await get().selectWorkspace(existing.id);
        return;
      }

      const stayInSettings = get().view === "settings";
      const source = resolveCurrentWorkspaceDefaultsSource(get);
      const defaultProvider = source?.defaultProvider ?? "google";
      const defaultModel =
        source?.defaultModel?.trim() ||
        get().providerDefaultModelByProvider[defaultProvider] ||
        defaultModelForProvider(defaultProvider);
      const defaultPreferredChildModel = source?.defaultPreferredChildModel?.trim() || defaultModel;
      const defaultChildModelRoutingMode = source?.defaultChildModelRoutingMode ?? "same-provider";
      const defaultPreferredChildModelRef =
        source?.defaultPreferredChildModelRef?.trim() ||
        `${defaultProvider}:${defaultPreferredChildModel || defaultModel}`;
      const ws: WorkspaceRecord = {
        id: makeId(),
        name: basename(dir),
        path: dir,
        workspaceKind: "project",
        createdAt: nowIso(),
        lastOpenedAt: nowIso(),
        wsProtocol: "jsonrpc",
        defaultProvider,
        defaultModel,
        defaultPreferredChildModel,
        defaultChildModelRoutingMode,
        defaultPreferredChildModelRef,
        defaultAllowedChildModelRefs: [...(source?.defaultAllowedChildModelRefs ?? [])],
        defaultToolOutputOverflowChars: source?.defaultToolOutputOverflowChars,
        providerOptions: source?.providerOptions,
        userName: source?.userName,
        userProfile: source?.userProfile,
        defaultEnableMcp: source?.defaultEnableMcp ?? true,
        defaultBackupsEnabled: source?.defaultBackupsEnabled ?? false,
        yolo: source?.yolo ?? true,
      };

      set((s) => ({
        workspaces: [ws, ...s.workspaces],
        selectedWorkspaceId: ws.id,
        view: stayInSettings ? "settings" : "chat",
      }));
      captureProductEvent("workspace_added", {
        eventSource: "renderer",
        workspaceCount: get().workspaces.length,
        mcpEnabled: ws.defaultEnableMcp,
        yoloEnabled: ws.yolo,
      });
      ensureWorkspaceRuntime(get, set, ws.id);
      await persistNow(get);
      await ensureServerRunning(get, set, ws.id);
      ensureControlSocket(get, set, ws.id);
      void requestWorkspaceSessions(get, set, ws.id);
    },

    removeWorkspace: async (workspaceId: string) => {
      if (!isWorkspaceLifecycleEnabled()) return;
      bumpWorkspaceStartGeneration(workspaceId);
      bumpWorkspaceJsonRpcSocketGeneration(workspaceId);

      for (const thread of get().threads) {
        if (thread.workspaceId !== workspaceId) continue;
        closeThreadSession(thread.id);
        RUNTIME.optimisticUserMessageIds.delete(thread.id);
        RUNTIME.pendingThreadMessages.delete(thread.id);
        RUNTIME.pendingThreadAttachments.delete(thread.id);
        RUNTIME.threadSelectionRequests.delete(thread.id);
        RUNTIME.pendingWorkspaceDefaultApplyByThread.delete(thread.id);
        RUNTIME.modelStreamByThread.delete(thread.id);
        clearPendingThreadSteers(thread.id);
      }

      const jsonRpcSocket = RUNTIME.jsonRpcSockets.get(workspaceId);
      try {
        jsonRpcSocket?.close();
      } catch {
        // ignore
      }
      RUNTIME.jsonRpcSockets.delete(workspaceId);
      clearWorkspaceJsonRpcSocketGeneration(workspaceId);

      try {
        await stopWorkspaceServer({ workspaceId });
      } catch {
        // ignore
      } finally {
        disposeWorkspaceJsonRpcState(get, workspaceId);
      }

      set((s) => {
        const remainingWorkspaces = s.workspaces.filter((w) => w.id !== workspaceId);
        const remainingThreads = s.threads.filter((t) => t.workspaceId !== workspaceId);
        const selectedWorkspaceId =
          s.selectedWorkspaceId === workspaceId
            ? (remainingWorkspaces[0]?.id ?? null)
            : s.selectedWorkspaceId;
        const selectedTaskId =
          selectedWorkspaceId && taskBelongsToWorkspace(s.selectedTaskId, selectedWorkspaceId)
            ? s.selectedTaskId
            : null;
        const threadSelectionIntent = getThreadSelectionIntent(
          s.view,
          s.lastNonSettingsView,
          selectedTaskId,
        );
        const selectedThread = s.selectedThreadId
          ? (remainingThreads.find((t) => t.id === s.selectedThreadId) ?? null)
          : null;
        let selectedThreadId: string | null = null;
        if (selectedWorkspaceId && selectedThread?.workspaceId === selectedWorkspaceId) {
          if (threadSelectionIntent.context === "task" && threadSelectionIntent.selectedTaskId) {
            const selectedTask = s.tasksById[threadSelectionIntent.selectedTaskId];
            const selectedThreadBelongsToTask =
              selectedThread.taskId === threadSelectionIntent.selectedTaskId ||
              selectedTask?.threads.some((thread) => thread.sessionId === selectedThread.id) ===
                true;
            selectedThreadId = selectedThreadBelongsToTask ? selectedThread.id : null;
          } else if (
            threadSelectionIntent.context === "chat" &&
            isStandardChatThread(selectedThread, { includeDrafts: true })
          ) {
            selectedThreadId = selectedThread.id;
          }
        }
        return {
          workspaces: remainingWorkspaces,
          threads: remainingThreads,
          selectedWorkspaceId,
          selectedThreadId,
          selectedTaskId,
          newTaskWorkspaceId: s.newTaskWorkspaceId === workspaceId ? null : s.newTaskWorkspaceId,
        };
      });
      clearWorkspaceStartState(workspaceId);
      await persistNow(get);
      captureProductEvent("workspace_removed", {
        eventSource: "renderer",
        workspaceCount: get().workspaces.length,
      });
    },

    selectWorkspace: async (workspaceId: string) => {
      const wasSelected = get().selectedWorkspaceId === workspaceId;
      const currentState = get();
      const threadSelectionIntent = getThreadSelectionIntent(
        currentState.view,
        currentState.lastNonSettingsView,
        currentState.selectedTaskId,
      );
      const selectedTaskId =
        threadSelectionIntent.context === "task" &&
        threadSelectionIntent.selectedTaskId &&
        taskBelongsToWorkspace(threadSelectionIntent.selectedTaskId, workspaceId)
          ? threadSelectionIntent.selectedTaskId
          : null;
      const nextThreadId =
        threadSelectionIntent.context === "task"
          ? selectedTaskId
            ? preferredTaskThreadId(selectedTaskId, currentState.selectedThreadId)
            : null
          : preferredThreadIdForWorkspace(workspaceId);
      const hydrateSelectedThreadPromise = nextThreadId
        ? hydrateThreadSelection(get, set, nextThreadId, {
            preserveView: true,
            reconnectAfterHydration: true,
            skipWorkspaceSelectOnReconnect: true,
          })
        : null;
      set((s) => {
        const retargetNewTask =
          getThreadSelectionIntent(s.view, s.lastNonSettingsView, selectedTaskId).context ===
            "task" && selectedTaskId === null;
        return {
          selectedWorkspaceId: workspaceId,
          selectedThreadId: nextThreadId,
          selectedTaskId,
          newTaskWorkspaceId: retargetNewTask ? workspaceId : null,
          newTaskWorkspaceRequestId: retargetNewTask
            ? s.newTaskWorkspaceRequestId + 1
            : s.newTaskWorkspaceRequestId,
          view: s.view === "settings" ? "settings" : s.view,
        };
      });
      ensureWorkspaceRuntime(get, set, workspaceId);

      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;

      if (!wasSelected) {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, lastOpenedAt: nowIso() } : w,
          ),
        }));
        await persistNow(get);
      }

      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      void requestWorkspaceSessions(get, set, workspaceId);
      void get().refreshTasks(workspaceId);
      if (hydrateSelectedThreadPromise) {
        await hydrateSelectedThreadPromise;
      }
    },

    reorderWorkspaces: async (sourceWorkspaceId: string, targetWorkspaceId: string) => {
      if (!isWorkspaceLifecycleEnabled()) return;
      const nextWorkspaces = reorderSidebarItemsById(
        get().workspaces,
        sourceWorkspaceId,
        targetWorkspaceId,
      );

      if (nextWorkspaces === get().workspaces) {
        return;
      }

      set({ workspaces: nextWorkspaces });
      await persistNow(get);
    },

    setWorkspacesOrder: async (orderedIds: string[]) => {
      if (!isWorkspaceLifecycleEnabled()) return;
      const nextWorkspaces = applyWorkspaceOrder(get().workspaces, orderedIds);

      if (nextWorkspaces === get().workspaces) {
        return;
      }

      set({ workspaces: nextWorkspaces });
      await persistNow(get);
    },

    setWorkspaceServerStartupProgress: ({ workspaceId, progress }) => {
      set((state) => {
        const runtime = state.workspaceRuntimeById[workspaceId];
        if (!runtime?.starting || runtime.serverUrl) return {};
        return {
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            [workspaceId]: { ...runtime, startupProgress: progress },
          },
        };
      });
    },

    restartWorkspaceServer: async (workspaceId) => {
      if (!isWorkspaceLifecycleEnabled()) return;
      bumpWorkspaceStartGeneration(workspaceId);
      bumpWorkspaceJsonRpcSocketGeneration(workspaceId);

      for (const thread of get().threads) {
        if (thread.workspaceId !== workspaceId) continue;
        closeThreadSession(thread.id);
        RUNTIME.threadSelectionRequests.delete(thread.id);
        RUNTIME.pendingWorkspaceDefaultApplyByThread.delete(thread.id);
      }

      const jsonRpcSocket = RUNTIME.jsonRpcSockets.get(workspaceId);
      try {
        jsonRpcSocket?.close();
      } catch {
        // ignore
      }
      RUNTIME.jsonRpcSockets.delete(workspaceId);

      try {
        await stopWorkspaceServer({ workspaceId });
      } catch {
        // ignore
      }

      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            serverUrl: null,
            startupProgress: null,
            controlSessionId: null,
            controlConfig: null,
            controlSessionConfig: null,
            workspaceBackupsPath: null,
            workspaceBackups: [],
            workspaceBackupsLoading: false,
            workspaceBackupsError: null,
            workspaceBackupPendingActionKeys: {},
            workspaceBackupDelta: null,
            workspaceBackupDeltaLoading: false,
            workspaceBackupDeltaError: null,
          },
        },
      }));

      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      void requestWorkspaceSessions(get, set, workspaceId);
    },

    handleWorkspaceServerExited: (event) => {
      if (!isWorkspaceLifecycleEnabled()) return;
      const { workspaceId } = event;
      const current = get();
      if (!current.workspaces.some((workspace) => workspace.id === workspaceId)) return;
      const currentUrl = current.workspaceRuntimeById[workspaceId]?.serverUrl ?? null;
      if (event.url && currentUrl && event.url !== currentUrl) return;
      bumpWorkspaceStartGeneration(workspaceId);
      markWorkspaceServerStale(get, set, workspaceId, "Workspace server exited");
      void (async () => {
        await waitForWorkspaceServerRestartBackoff(workspaceId);
        await ensureServerRunning(get, set, workspaceId);
        ensureControlSocket(get, set, workspaceId);
        void requestWorkspaceSessions(get, set, workspaceId);
      })();
    },
  };
}
