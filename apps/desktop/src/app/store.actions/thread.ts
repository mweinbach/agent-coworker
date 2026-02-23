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

export function createThreadActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "removeThread" | "deleteThreadHistory" | "renameThread" | "newThread" | "selectThread" | "reconnectThread" | "sendMessage" | "cancelThread" | "setThreadModel" | "setComposerText" | "setInjectContext" | "answerAsk" | "answerApproval" | "dismissPrompt"> {
  const closeThreadSession = (threadId: string) => {
    sendThread(get, threadId, (sessionId) => ({ type: "session_close", sessionId }));
  };

  return {
    removeThread: async (threadId: string) => {
      const sock = RUNTIME.threadSockets.get(threadId);
      closeThreadSession(threadId);
      RUNTIME.threadSockets.delete(threadId);
      RUNTIME.optimisticUserMessageIds.delete(threadId);
      RUNTIME.pendingThreadMessages.delete(threadId);
      RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(threadId);
      RUNTIME.modelStreamByThread.delete(threadId);
      try {
        sock?.close();
      } catch {
        // ignore
      }
  
      set((s) => {
        const remainingThreads = s.threads.filter((t) => t.id !== threadId);
        const selectedThreadId = s.selectedThreadId === threadId ? null : s.selectedThreadId;
        const nextPromptModal = s.promptModal?.threadId === threadId ? null : s.promptModal;
  
        const nextThreadRuntimeById = { ...s.threadRuntimeById };
        delete nextThreadRuntimeById[threadId];
  
      return {
          threads: remainingThreads,
          selectedThreadId,
          promptModal: nextPromptModal,
          threadRuntimeById: nextThreadRuntimeById,
        };
      });
  
      try {
        await deleteTranscript({ threadId });
      } catch {
        // ignore
      }

      await persistNow(get);
    },


    deleteThreadHistory: async (threadId: string) => {
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
      const targetSessionId = get().threadRuntimeById[threadId]?.sessionId ?? thread.sessionId;

      await get().removeThread(threadId);

      if (!targetSessionId) return;

      await ensureServerRunning(get, set, thread.workspaceId);
      ensureControlSocket(get, set, thread.workspaceId);
      const ok = sendControl(get, thread.workspaceId, (sessionId) => ({
        type: "delete_session",
        sessionId,
        targetSessionId,
      }));

      if (ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Session history deleted",
            detail: targetSessionId,
          }),
        }));
        return;
      }

      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Delete session history failed",
          detail: "Control session is unavailable.",
        }),
      }));
    },
  

    renameThread: (threadId: string, newTitle: string) => {
      const trimmed = newTitle.trim();
      if (!trimmed) return;

      set((s) => ({
        threads: s.threads.map((t) => (t.id === threadId ? { ...t, title: trimmed, titleSource: "manual" } : t)),
      }));
      void persistNow(get);

      sendThread(get, threadId, (sessionId) => ({
        type: "set_session_title",
        sessionId,
        title: trimmed,
      }));
    },


    newThread: async (opts) => {
      let workspaceId = opts?.workspaceId ?? get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        await get().addWorkspace();
        workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
        if (!workspaceId) return;
      }
  
      if (get().selectedWorkspaceId !== workspaceId) {
        set({ selectedWorkspaceId: workspaceId });
      }
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const wsRt = get().workspaceRuntimeById[workspaceId];
      const url = wsRt?.serverUrl;
      if (!url) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Unable to create session",
            detail: wsRt?.error ?? "Workspace server is not ready.",
          }),
        }));
        return;
      }
  
      const threadId = makeId();
      const createdAt = nowIso();
      const title = opts?.titleHint ? truncateTitle(opts.titleHint) : "New thread";
  
      const thread: ThreadRecord = {
        id: threadId,
        workspaceId,
        title,
        titleSource: "default",
        createdAt,
        lastMessageAt: createdAt,
        status: "active",
        sessionId: null,
        lastEventSeq: 0,
      };
  
      set((s) => ({
        threads: [thread, ...s.threads],
        selectedThreadId: threadId,
        view: "chat",
      }));
      ensureThreadRuntime(get, set, threadId);
      set((s) => ({
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...s.threadRuntimeById[threadId], transcriptOnly: false },
        },
      }));
      await persistNow(get);
  
      ensureThreadSocket(get, set, threadId, url, opts?.firstMessage);
    },
  

    selectThread: async (threadId: string) => {
      set({ selectedThreadId: threadId, view: "chat" });
      ensureThreadRuntime(get, set, threadId);
  
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
  
      const rt = get().threadRuntimeById[threadId];
      const alreadyLoaded = rt?.feed && rt.feed.length > 0;
      if (!alreadyLoaded) {
        const transcript = await readTranscript({ threadId });
        const feed = mapTranscriptToFeed(transcript);
        set((s) => ({
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...s.threadRuntimeById[threadId], feed, transcriptOnly: false },
          },
        }));
      }
  
      set((s) => ({
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...s.threadRuntimeById[threadId], transcriptOnly: false },
        },
      }));
  
      await get().reconnectThread(threadId);
    },
  

    reconnectThread: async (threadId: string, firstMessage?: string) => {
      ensureThreadRuntime(get, set, threadId);
  
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
  
      await get().selectWorkspace(thread.workspaceId);
      await ensureServerRunning(get, set, thread.workspaceId);
      ensureControlSocket(get, set, thread.workspaceId);
  
      const url = get().workspaceRuntimeById[thread.workspaceId]?.serverUrl;
      if (!url) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Workspace server unavailable",
            detail: "Workspace server is not ready.",
          }),
        }));
        return;
      }
  
      if (firstMessage && firstMessage.trim()) {
        queuePendingThreadMessage(threadId, firstMessage);
      }
      ensureThreadSocket(get, set, threadId, url);
    },
  

    sendMessage: async (text: string) => {
      const activeThreadId = get().selectedThreadId;
      if (!activeThreadId) return;
  
      const thread = get().threads.find((t) => t.id === activeThreadId);
      if (!thread) return;
  
      const rt = get().threadRuntimeById[activeThreadId];
      const trimmed = text.trim();
      if (!trimmed) return;
  
      if (rt?.transcriptOnly) {
        const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
        const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
        await get().newThread({ workspaceId: thread.workspaceId, titleHint: thread.title, firstMessage });
        set({ composerText: "" });
        return;
      }
  
      if (thread.status !== "active" || !rt?.sessionId) {
        const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
        const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
        await get().reconnectThread(activeThreadId, firstMessage);
        set({ composerText: "" });
        return;
      }
  
      if (rt.busy) return;
  
      const ok = sendUserMessageToThread(get, set, activeThreadId, trimmed);
      if (!ok) return;
  
      set({ composerText: "" });
    },
  

    cancelThread: (threadId: string) => {
      const ok = sendThread(get, threadId, (sid) => ({ type: "cancel", sessionId: sid }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to cancel this run.",
          }),
        }));
      }
    },
  

    setThreadModel: (threadId, provider, model) => {
      const rt = get().threadRuntimeById[threadId];
      if (!rt?.sessionId) return;
      const ok = sendThread(get, threadId, (sessionId) => ({
        type: "set_model",
        sessionId,
        provider,
        model,
      }));
      if (ok) {
        appendThreadTranscript(threadId, "client", { type: "set_model", sessionId: rt.sessionId, provider, model });
      }
    },

    setComposerText: (text) => set({ composerText: text }),

    setInjectContext: (v) => set({ injectContext: v }),

    answerAsk: (threadId, requestId, answer) => {
      const sent = sendThread(get, threadId, (sessionId) => ({ type: "ask_response", sessionId, requestId, answer }));
      if (!sent) {
        // Socket disconnected — keep the modal open so the user can retry
        // once reconnected rather than silently swallowing the answer.
        return;
      }
      appendThreadTranscript(threadId, "client", { type: "ask_response", sessionId: get().threadRuntimeById[threadId]?.sessionId, requestId, answer });
      set({ promptModal: null });
    },
  

    answerApproval: (threadId, requestId, approved) => {
      sendThread(get, threadId, (sessionId) => ({ type: "approval_response", sessionId, requestId, approved }));
      appendThreadTranscript(threadId, "client", { type: "approval_response", sessionId: get().threadRuntimeById[threadId]?.sessionId, requestId, approved });
      set({ promptModal: null });
    },
  

    dismissPrompt: () => set({ promptModal: null }),
  
  };
}
