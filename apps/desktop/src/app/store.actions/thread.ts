import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import * as desktopCommands from "../../lib/desktopCommands";
import type { ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  beginThreadSelectionRequest,
  buildContextPreamble,
  clearPendingThreadSteers,
  clearThreadSelectionRequest,
  extractUsageStateFromTranscript,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  isCurrentThreadSelectionRequest,
  makeId,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  requestSessionSnapshot,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  syncDesktopStateCache,
  truncateTitle,
} from "../store.helpers";
import { hydrateTranscriptSnapshot } from "../transcriptHydration";
import type {
  SessionSnapshot,
  SessionSnapshotFingerprint,
  ThreadBusyPolicy,
  ThreadRecord,
  TranscriptEvent,
  WorkspaceRecord,
} from "../types";

export function createThreadActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "removeThread" | "deleteThreadHistory" | "renameThread" | "newThread" | "selectThread" | "reconnectThread" | "sendMessage" | "cancelThread" | "clearThreadUsageHardCap" | "setThreadModel" | "setComposerText" | "setInjectContext" | "answerAsk" | "answerApproval" | "dismissPrompt" | "loadAllThreadUsage"> {
  const waitForSelectionFrame = async () => {
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        setTimeout(resolve, 0);
        return;
      }

      const schedule = typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0);

      schedule(() => {
        setTimeout(resolve, 0);
      });
    });
  };

  const isSelectionCurrent = (threadId: string, requestId: number) =>
    get().selectedThreadId === threadId && isCurrentThreadSelectionRequest(threadId, requestId);

  const clearThreadHydrationIfCurrent = (threadId: string, requestId: number) => {
    if (!isCurrentThreadSelectionRequest(threadId, requestId)) {
      return;
    }
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            hydrating: false,
            transcriptOnly: false,
          },
        },
      };
    });
    clearThreadSelectionRequest(threadId, requestId);
  };

  const closeThreadSession = (threadId: string) => {
    sendThread(get, threadId, (sessionId) => ({ type: "session_close", sessionId }));
  };

  const threadFingerprint = (thread: ThreadRecord): SessionSnapshotFingerprint => ({
    updatedAt: thread.lastMessageAt,
    messageCount: thread.messageCount,
    lastEventSeq: thread.lastEventSeq,
  });

  const fingerprintMatches = (left: SessionSnapshotFingerprint, right: SessionSnapshotFingerprint): boolean =>
    left.updatedAt === right.updatedAt
    && left.messageCount === right.messageCount
    && left.lastEventSeq === right.lastEventSeq;

  const cacheSessionSnapshot = (snapshot: SessionSnapshot) => {
    RUNTIME.sessionSnapshots.set(snapshot.sessionId, {
      fingerprint: {
        updatedAt: snapshot.updatedAt,
        messageCount: snapshot.messageCount,
        lastEventSeq: snapshot.lastEventSeq,
      },
      snapshot,
    });
    syncDesktopStateCache(get);
  };

  const applySessionSnapshot = (threadId: string, sessionId: string, snapshot: SessionSnapshot) => {
    set((s) => {
      const nextThreads = s.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              title: snapshot.title,
              titleSource: snapshot.titleSource,
              lastMessageAt: snapshot.updatedAt,
              sessionId,
              messageCount: snapshot.messageCount,
              lastEventSeq: snapshot.lastEventSeq,
            }
          : thread,
      );
      const currentRuntime = s.threadRuntimeById[threadId];
      return {
        threads: nextThreads,
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...currentRuntime,
            sessionId,
            sessionKind: snapshot.sessionKind,
            parentSessionId: snapshot.parentSessionId,
            role: snapshot.role,
            mode: snapshot.mode,
            depth: snapshot.depth ?? 0,
            nickname: snapshot.nickname,
            requestedModel: snapshot.requestedModel,
            effectiveModel: snapshot.effectiveModel,
            requestedReasoningEffort: snapshot.requestedReasoningEffort,
            effectiveReasoningEffort: snapshot.effectiveReasoningEffort,
            executionState: snapshot.executionState,
            lastMessagePreview: snapshot.lastMessagePreview,
            agents: snapshot.agents,
            sessionUsage: snapshot.sessionUsage,
            lastTurnUsage: snapshot.lastTurnUsage,
            feed: snapshot.feed,
            hydrating: false,
            transcriptOnly: false,
            connected: currentRuntime?.connected ?? false,
            config: currentRuntime?.config ?? null,
            sessionConfig: currentRuntime?.sessionConfig ?? null,
            enableMcp: currentRuntime?.enableMcp ?? null,
            busy: currentRuntime?.busy ?? false,
            busySince: currentRuntime?.busySince ?? null,
            activeTurnId: currentRuntime?.activeTurnId ?? null,
            pendingSteer: currentRuntime?.pendingSteer ?? null,
            wsUrl: currentRuntime?.wsUrl ?? null,
          },
        },
      };
    });
  };

  const transcriptIdsForThread = (
    thread: Pick<ThreadRecord, "id" | "sessionId" | "legacyTranscriptId">,
  ): string[] => {
    const ids = [thread.legacyTranscriptId ?? null, thread.sessionId ?? null, thread.id];
    return [...new Set(ids.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
  };

  const sessionSnapshotIdsForThread = (
    thread: Pick<ThreadRecord, "sessionId">,
    runtimeSessionId?: string | null,
  ): string[] => {
    const ids = [runtimeSessionId ?? null, thread.sessionId ?? null];
    return [...new Set(ids.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
  };

  const readTranscriptEvents = async (
    thread: Pick<ThreadRecord, "id" | "sessionId" | "legacyTranscriptId">,
  ): Promise<TranscriptEvent[] | null> => {
    const transcriptIds = transcriptIdsForThread(thread);
    if (transcriptIds.length === 0) return null;

    const transcripts: TranscriptEvent[][] = [];
    let successfulReads = 0;
    let firstError: unknown = null;

    for (const transcriptId of transcriptIds) {
      try {
        const events = await desktopCommands.readTranscript({ threadId: transcriptId });
        transcripts.push(events);
        successfulReads += 1;
      } catch (error) {
        firstError ??= error;
      }
    }

    if (successfulReads === 0 && firstError) {
      throw firstError;
    }

    return transcripts
      .flat()
      .sort((left, right) => left.ts.localeCompare(right.ts));
  };

  const hydrateLegacyTranscript = async (thread: ThreadRecord) => {
    const transcriptIds = transcriptIdsForThread(thread);
    if (transcriptIds.length === 0) return null;

    if (transcriptIds.length === 1 && typeof desktopCommands.hydrateTranscript === "function") {
      return await desktopCommands.hydrateTranscript({ threadId: transcriptIds[0]! });
    }

    const transcript: TranscriptEvent[] = [];
    let successfulReads = 0;
    let firstError: unknown = null;
    for (const transcriptId of transcriptIds) {
      try {
        transcript.push(...await desktopCommands.readTranscript({ threadId: transcriptId }));
        successfulReads += 1;
      } catch (error) {
        firstError ??= error;
      }
    }

    if (successfulReads === 0 && firstError) {
      throw firstError;
    }

    transcript.sort((left, right) => left.ts.localeCompare(right.ts));
    return hydrateTranscriptSnapshot(transcript);
  };

  return {
    removeThread: async (threadId: string) => {
      const thread = get().threads.find((t) => t.id === threadId);
      const runtimeSessionId = get().threadRuntimeById[threadId]?.sessionId ?? null;
      const sessionSnapshotIds =
        thread
          ? sessionSnapshotIdsForThread(thread, runtimeSessionId)
          : runtimeSessionId
            ? [runtimeSessionId]
            : [];
      const sock = RUNTIME.threadSockets.get(threadId);
      closeThreadSession(threadId);
      RUNTIME.threadSockets.delete(threadId);
      RUNTIME.optimisticUserMessageIds.delete(threadId);
      RUNTIME.pendingThreadMessages.delete(threadId);
      RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(threadId);
      RUNTIME.pendingWorkspaceDefaultApplyModeByThread.delete(threadId);
      RUNTIME.modelStreamByThread.delete(threadId);
      RUNTIME.threadSelectionRequests.delete(threadId);
      clearPendingThreadSteers(threadId);
      try {
        sock?.close();
      } catch {
        // ignore
      }

      for (const sessionId of sessionSnapshotIds) {
        RUNTIME.sessionSnapshots.delete(sessionId);
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

      if (thread) {
        for (const transcriptId of transcriptIdsForThread(thread)) {
          try {
            await desktopCommands.deleteTranscript({ threadId: transcriptId });
          } catch {
            // ignore
          }
        }
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

      const createSessionImmediately = opts?.mode === "session" || Boolean(opts?.firstMessage?.trim());
      if (!createSessionImmediately) {
        const existingDraft = get().threads.find((thread) => thread.workspaceId === workspaceId && thread.draft === true);
        if (existingDraft) {
          set({
            selectedThreadId: existingDraft.id,
            view: "chat",
          });
          ensureThreadRuntime(get, set, existingDraft.id);
          await persistNow(get);
          return;
        }
      }

      let url: string | null = null;
      if (createSessionImmediately) {
        await ensureServerRunning(get, set, workspaceId);
        ensureControlSocket(get, set, workspaceId);

        const wsRt = get().workspaceRuntimeById[workspaceId];
        url = wsRt?.serverUrl ?? null;
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
        messageCount: 0,
        lastEventSeq: 0,
        draft: !createSessionImmediately,
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

      if (!createSessionImmediately) {
        return;
      }

      if (!url) {
        return;
      }

      ensureThreadSocket(get, set, threadId, url, opts?.firstMessage, false);
    },
  

    selectThread: async (threadId: string) => {
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;

      ensureThreadRuntime(get, set, threadId);
      if (thread.draft) {
        set((s) => ({
          selectedThreadId: threadId,
          selectedWorkspaceId: thread.workspaceId,
          view: "chat",
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...s.threadRuntimeById[threadId],
              hydrating: false,
              transcriptOnly: false,
            },
          },
        }));
        syncDesktopStateCache(get);
        return;
      }
      const rt = get().threadRuntimeById[threadId];
      if (get().selectedThreadId === threadId && (RUNTIME.threadSelectionRequests.has(threadId) || RUNTIME.threadSockets.has(threadId))) {
        return;
      }

      const alreadyLoaded = rt?.feed && rt.feed.length > 0;
      const sessionId = rt?.sessionId ?? thread.sessionId;
      const expectedFingerprint = threadFingerprint(thread);
      const cachedSnapshot = sessionId ? RUNTIME.sessionSnapshots.get(sessionId) : null;
      const matchingCachedSnapshot =
        sessionId && cachedSnapshot && fingerprintMatches(cachedSnapshot.fingerprint, expectedFingerprint)
          ? cachedSnapshot.snapshot
          : null;

      if (sessionId && cachedSnapshot && !matchingCachedSnapshot) {
        console.debug(
          `[selectThread] Cache fingerprint mismatch for session ${sessionId}: cached ${JSON.stringify(cachedSnapshot.fingerprint)} vs expected ${JSON.stringify(expectedFingerprint)}`,
        );
      }

      const skipHarnessSnapshotFetch = Boolean(alreadyLoaded && matchingCachedSnapshot);
      const shouldFetchHarnessSnapshot =
        Boolean(sessionId)
        && !skipHarnessSnapshotFetch
        && (thread.messageCount > 0 || thread.lastEventSeq > 0 || Boolean(thread.legacyTranscriptId));

      const requestId = beginThreadSelectionRequest(threadId);
      set((s) => ({
        selectedThreadId: threadId,
        selectedWorkspaceId: thread.workspaceId,
        view: "chat",
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...s.threadRuntimeById[threadId],
            hydrating: !alreadyLoaded && !matchingCachedSnapshot,
            transcriptOnly: false,
          },
        },
      }));
      syncDesktopStateCache(get);

      await waitForSelectionFrame();
      if (!isSelectionCurrent(threadId, requestId)) {
        clearThreadHydrationIfCurrent(threadId, requestId);
        return;
      }

      let appliedCachedSnapshot = false;
      if (matchingCachedSnapshot && sessionId && skipHarnessSnapshotFetch) {
        applySessionSnapshot(threadId, sessionId, matchingCachedSnapshot);
        appliedCachedSnapshot = true;
      }

      if (!isSelectionCurrent(threadId, requestId)) {
        if (appliedCachedSnapshot) {
          clearThreadHydrationIfCurrent(threadId, requestId);
        }
        return;
      }

      let stayTranscriptOnly = false;
      if (!alreadyLoaded || matchingCachedSnapshot) {
        try {
          let loadedFromHarness = false;
          if (sessionId && shouldFetchHarnessSnapshot) {
            await ensureServerRunning(get, set, thread.workspaceId);
            ensureControlSocket(get, set, thread.workspaceId);
            const snapshot = await requestSessionSnapshot(get, set, thread.workspaceId, sessionId);
            if (!isSelectionCurrent(threadId, requestId)) {
              clearThreadHydrationIfCurrent(threadId, requestId);
              return;
            }
            if (snapshot) {
              applySessionSnapshot(threadId, sessionId, snapshot);
              cacheSessionSnapshot(snapshot);
              loadedFromHarness = true;
            } else if (matchingCachedSnapshot) {
              applySessionSnapshot(threadId, sessionId, matchingCachedSnapshot);
            } else {
              stayTranscriptOnly = true;
            }
          }

          if (!loadedFromHarness && !matchingCachedSnapshot && !alreadyLoaded) {
            const snapshot = await hydrateLegacyTranscript(thread);
            if (!snapshot) {
              throw new Error("No harness snapshot or legacy transcript cache was available.");
            }
            if (!isSelectionCurrent(threadId, requestId)) {
              clearThreadHydrationIfCurrent(threadId, requestId);
              return;
            }
            set((s) => ({
              threadRuntimeById: {
                ...s.threadRuntimeById,
                [threadId]: {
                  ...s.threadRuntimeById[threadId],
                  sessionUsage: snapshot.sessionUsage,
                  lastTurnUsage: snapshot.lastTurnUsage,
                  agents: snapshot.agents,
                  feed: snapshot.feed,
                  hydrating: false,
                  transcriptOnly: true,
                },
              },
            }));
          }
        } catch (error) {
          if (!isSelectionCurrent(threadId, requestId)) {
            clearThreadHydrationIfCurrent(threadId, requestId);
            return;
          }

          const detail = error instanceof Error ? error.message : String(error);
          set((s) => ({
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "error",
              title: "Transcript load failed",
              detail,
            }),
          }));
          clearThreadHydrationIfCurrent(threadId, requestId);
          return;
        }
      }

      if (!isSelectionCurrent(threadId, requestId)) {
        clearThreadHydrationIfCurrent(threadId, requestId);
        return;
      }

      if (stayTranscriptOnly) {
        set((s) => ({
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...s.threadRuntimeById[threadId], hydrating: false, transcriptOnly: true },
          },
        }));
        clearThreadSelectionRequest(threadId, requestId);
        return;
      }

      set((s) => ({
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...s.threadRuntimeById[threadId], hydrating: false, transcriptOnly: false },
        },
      }));

      await get().reconnectThread(threadId, undefined, { selectionRequestId: requestId });
      clearThreadSelectionRequest(threadId, requestId);
    },
  

    reconnectThread: async (threadId: string, firstMessage?: string, opts?: { selectionRequestId?: number }) => {
      const isReconnectCurrent = () =>
        opts?.selectionRequestId === undefined
        || (get().selectedThreadId === threadId && isCurrentThreadSelectionRequest(threadId, opts.selectionRequestId));

      ensureThreadRuntime(get, set, threadId);
  
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;

      if (thread.draft && !firstMessage?.trim()) {
        return;
      }
  
      await get().selectWorkspace(thread.workspaceId);
      if (!isReconnectCurrent()) return;
      await ensureServerRunning(get, set, thread.workspaceId);
      if (!isReconnectCurrent()) return;
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
      if (!isReconnectCurrent()) return;
  
      if (firstMessage && firstMessage.trim()) {
        queuePendingThreadMessage(threadId, firstMessage);
      }
      ensureThreadSocket(get, set, threadId, url, firstMessage, Boolean(firstMessage?.trim()));
    },
  

    sendMessage: async (text: string, busyPolicy: ThreadBusyPolicy = "reject") => {
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
  
      const ok = sendUserMessageToThread(get, set, activeThreadId, trimmed, busyPolicy);
      if (!ok) return;
      if (busyPolicy === "steer" && rt?.busy) return;

      set({ composerText: "" });
    },
  

    cancelThread: (threadId: string, opts?: { includeSubagents?: boolean }) => {
      const ok = sendThread(get, threadId, (sid) => ({
        type: "cancel",
        sessionId: sid,
        ...(opts?.includeSubagents !== undefined ? { includeSubagents: opts.includeSubagents } : {}),
      }));
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

    clearThreadUsageHardCap: (threadId: string) => {
      const ok = sendThread(get, threadId, (sessionId) => ({
        type: "set_session_usage_budget",
        sessionId,
        stopAtUsd: null,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to clear the session hard cap.",
          }),
        }));
        return;
      }

      appendThreadTranscript(threadId, "client", {
        type: "set_session_usage_budget",
        sessionId: get().threadRuntimeById[threadId]?.sessionId,
        stopAtUsd: null,
      });
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

    loadAllThreadUsage: async () => {
      const threads = get().threads;
      const existing = get().threadRuntimeById;

      await Promise.all(
        threads.map(async (thread) => {
          // Skip threads that already have usage loaded
          const rt = existing[thread.id];
          if (rt?.sessionUsage !== undefined && rt.sessionUsage !== null) return;

          try {
            const transcript = await readTranscriptEvents(thread);
            if (!transcript) return; // No transcript available
            const usageState = extractUsageStateFromTranscript(transcript);
            if (!usageState.sessionUsage) return; // No usage in this thread

            ensureThreadRuntime(get, set, thread.id);
            set((s) => ({
              threadRuntimeById: {
                ...s.threadRuntimeById,
                [thread.id]: {
                  ...s.threadRuntimeById[thread.id],
                  ...usageState,
                },
              },
            }));
          } catch {
            // Skip threads whose transcripts can't be read
          }
        }),
      );
    },
  };
}
