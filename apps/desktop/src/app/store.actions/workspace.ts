import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import {
  deleteTranscript,
  listDirectory,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  stopWorkspaceServer,
  openPath,
  revealPath,
  copyPath,
  createDirectory,
  renamePath,
  trashPath,
} from "../../lib/desktopCommands";
import { type ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  bumpWorkspaceJsonRpcSocketGeneration,
  bumpWorkspaceStartGeneration,
  buildContextPreamble,
  clearPendingThreadSteers,
  clearWorkspaceJsonRpcSocketGeneration,
  clearWorkspaceStartState,
  disposeWorkspaceJsonRpcState,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  mapTranscriptToFeed,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  requestWorkspaceSessions,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";
import { reorderSidebarItemsById } from "../../ui/sidebarHelpers";
import { hydrateThreadSelection } from "./thread";

export function createWorkspaceActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "addWorkspace" | "removeWorkspace" | "selectWorkspace" | "reorderWorkspaces" | "restartWorkspaceServer"> {
  const closeThreadSession = (threadId: string) => {
    sendThread(get, threadId, (sessionId) => ({ type: "session_close", sessionId }));
  };

  const preferredThreadIdForWorkspace = (workspaceId: string): string | null => {
    const state = get();
    const currentThreadId = state.selectedThreadId;
    const currentThread = currentThreadId
      ? state.threads.find((thread) => thread.id === currentThreadId) ?? null
      : null;

    if (currentThread?.workspaceId === workspaceId) {
      return currentThread.id;
    }

    const workspaceThreads = state.threads
      .filter((thread) => thread.workspaceId === workspaceId)
      .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));

    return workspaceThreads[0]?.id ?? null;
  };

  return {
    addWorkspace: async () => {
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
      const ws: WorkspaceRecord = {
        id: makeId(),
        name: basename(dir),
        path: dir,
        createdAt: nowIso(),
        lastOpenedAt: nowIso(),
        wsProtocol: "jsonrpc",
        defaultProvider: "google",
        defaultModel: defaultModelForProvider("google"),
        defaultPreferredChildModel: defaultModelForProvider("google"),
        defaultChildModelRoutingMode: "same-provider",
        defaultPreferredChildModelRef: `google:${defaultModelForProvider("google")}`,
        defaultAllowedChildModelRefs: [],
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      };
  
      set((s) => ({
        workspaces: [ws, ...s.workspaces],
        selectedWorkspaceId: ws.id,
        view: stayInSettings ? "settings" : "chat",
      }));
      ensureWorkspaceRuntime(get, set, ws.id);
      await persistNow(get);
      await ensureServerRunning(get, set, ws.id);
      ensureControlSocket(get, set, ws.id);
      void requestWorkspaceSessions(get, set, ws.id);
    },
  

    removeWorkspace: async (workspaceId: string) => {
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
        const selectedWorkspaceId = s.selectedWorkspaceId === workspaceId ? (remainingWorkspaces[0]?.id ?? null) : s.selectedWorkspaceId;
        const selectedThreadId =
          s.selectedThreadId && remainingThreads.some((t) => t.id === s.selectedThreadId) ? s.selectedThreadId : null;
      return {
          workspaces: remainingWorkspaces,
          threads: remainingThreads,
          selectedWorkspaceId,
          selectedThreadId,
        };
      });
      clearWorkspaceStartState(workspaceId);
      await persistNow(get);
    },
  

    selectWorkspace: async (workspaceId: string) => {
      const wasSelected = get().selectedWorkspaceId === workspaceId;
      const nextThreadId = preferredThreadIdForWorkspace(workspaceId);
      const hydrateSelectedThreadPromise = nextThreadId
        ? hydrateThreadSelection(get, set, nextThreadId, {
            preserveView: true,
            reconnectAfterHydration: true,
            skipWorkspaceSelectOnReconnect: true,
          })
        : null;
      set((s) => ({
        selectedWorkspaceId: workspaceId,
        selectedThreadId: nextThreadId,
        view: s.view === "settings" ? "settings" : s.view,
      }));
      ensureWorkspaceRuntime(get, set, workspaceId);
  
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
  
      if (!wasSelected) {
        set((s) => ({
          workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, lastOpenedAt: nowIso() } : w)),
        }));
        await persistNow(get);
      }
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      void requestWorkspaceSessions(get, set, workspaceId);
      if (hydrateSelectedThreadPromise) {
        await hydrateSelectedThreadPromise;
      }
    },

    reorderWorkspaces: async (sourceWorkspaceId: string, targetWorkspaceId: string) => {
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
  

    restartWorkspaceServer: async (workspaceId) => {
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

  };
}
