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
import type { ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  buildContextPreamble,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  mapTranscriptToFeed,
  normalizeProviderChoice,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";

export function createWorkspaceActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "addWorkspace" | "removeWorkspace" | "selectWorkspace" | "restartWorkspaceServer"> {
  const closeControlSession = (workspaceId: string) => {
    sendControl(get, workspaceId, (sessionId) => ({ type: "session_close", sessionId }));
  };

  const closeThreadSession = (threadId: string) => {
    sendThread(get, threadId, (sessionId) => ({ type: "session_close", sessionId }));
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
        defaultProvider: "google",
        defaultModel: defaultModelForProvider("google"),
        defaultSubAgentModel: defaultModelForProvider("google"),
        defaultEnableMcp: true,
        yolo: false,
      };
  
      set((s) => ({
        workspaces: [ws, ...s.workspaces],
        selectedWorkspaceId: ws.id,
        view: stayInSettings ? "settings" : "chat",
      }));
      ensureWorkspaceRuntime(get, set, ws.id);
      await persistNow(get);
      await get().selectWorkspace(ws.id);
    },
  

    removeWorkspace: async (workspaceId: string) => {
      const control = RUNTIME.controlSockets.get(workspaceId);
      closeControlSession(workspaceId);
      RUNTIME.controlSockets.delete(workspaceId);
      try {
        control?.close();
      } catch {
        // ignore
      }
  
      for (const thread of get().threads) {
        if (thread.workspaceId !== workspaceId) continue;
        const sock = RUNTIME.threadSockets.get(thread.id);
        closeThreadSession(thread.id);
        RUNTIME.threadSockets.delete(thread.id);
        RUNTIME.optimisticUserMessageIds.delete(thread.id);
        RUNTIME.pendingThreadMessages.delete(thread.id);
        RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(thread.id);
        RUNTIME.modelStreamByThread.delete(thread.id);
        try {
          sock?.close();
        } catch {
          // ignore
        }
      }
  
      try {
        await stopWorkspaceServer({ workspaceId });
      } catch {
        // ignore
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
      await persistNow(get);
    },
  

    selectWorkspace: async (workspaceId: string) => {
      set((s) => ({
        selectedWorkspaceId: workspaceId,
        view: s.view === "settings" ? "settings" : "chat",
      }));
      ensureWorkspaceRuntime(get, set, workspaceId);
  
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
  
      set((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, lastOpenedAt: nowIso() } : w)),
      }));
      await persistNow(get);
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
    },
  

    restartWorkspaceServer: async (workspaceId) => {
      const control = RUNTIME.controlSockets.get(workspaceId);
      closeControlSession(workspaceId);
      control?.close();
      RUNTIME.controlSockets.delete(workspaceId);

      for (const thread of get().threads) {
        if (thread.workspaceId !== workspaceId) continue;
        const sock = RUNTIME.threadSockets.get(thread.id);
        closeThreadSession(thread.id);
        sock?.close();
        RUNTIME.threadSockets.delete(thread.id);
        RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(thread.id);
      }
  
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
          },
        },
      }));
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
    },

  };
}
