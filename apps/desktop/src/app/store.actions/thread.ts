import {
  appendAttachmentSkippedNotes,
  createComposerAttachmentFile,
  resolveComposerAttachmentsForWorkspace,
} from "../../lib/composerAttachments";
import * as desktopCommands from "../../lib/desktopCommands";
import { type NewChatLandingTarget, resolveDefaultNewChatTarget } from "../../lib/newChatLanding";
import { buildAttachmentSignature, buildUserInputDisplayText } from "../attachmentInputs";
import {
  googleProviderOptionsForReasoningEffort,
  isGoogleReasoningEffortValue,
  isOpenAiReasoningEffortValue,
} from "../openaiCompatibleProviderOptions";
import { isSandboxApprovalThreadVisible } from "../sandboxApprovalVisibility";
import {
  type AppStoreActions,
  type AppStoreState,
  appendThreadTranscript,
  beginThreadSelectionRequest,
  buildContextPreamble,
  bumpWorkspaceJsonRpcSocketGeneration,
  bumpWorkspaceStartGeneration,
  clearPendingThreadSteers,
  clearThreadSelectionRequest,
  clearWorkspaceJsonRpcSocketGeneration,
  clearWorkspaceStartState,
  disposeWorkspaceJsonRpcState,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  extractUsageStateFromTranscript,
  isCurrentThreadSelectionRequest,
  makeId,
  nowIso,
  persistNow,
  pushNotification,
  queuePendingThreadMessage,
  RUNTIME,
  requestJsonRpcControlEvent,
  requestSessionSnapshot,
  type StoreGet,
  type StoreSet,
  sendThread,
  sendUserMessageToThread,
  syncDesktopStateCache,
  truncateTitle,
} from "../store.helpers";
import type { FileAttachmentInput } from "../store.helpers/jsonRpcSocket";
import { requestJsonRpc } from "../store.helpers/jsonRpcSocket";
import { createOneOffWorkspaceRecord } from "../store.helpers/oneOffWorkspaceRecord";
import { waitForNextPaintOrTimeout } from "../store.helpers/paintScheduling";
import { MAX_FEED_ITEMS } from "../store.helpers/threadEventReducerContext";
import { isStandardChatThread } from "../threadFilters";
import { hydrateTranscriptSnapshot } from "../transcriptHydration";
import {
  type FeedItem,
  isOneOffChatWorkspace,
  type SandboxApprovalPrompt,
  type SessionSnapshot,
  type SessionSnapshotFingerprint,
  type ThreadBusyPolicy,
  type ThreadRecord,
  type TranscriptEvent,
} from "../types";

type HydrateThreadSelectionOptions = {
  preserveView?: boolean;
  reconnectAfterHydration?: boolean;
  skipWorkspaceSelectOnReconnect?: boolean;
};

/**
 * Queue the first message of a brand-new chat AND render its user bubble
 * immediately, before the workspace socket/thread session exist. The
 * pre-generated clientMessageId travels with the queued message so the
 * eventual `turn/start` reuses it and the server echo dedups against the
 * optimistic bubble instead of rendering a duplicate.
 */
function queueOptimisticFirstThreadMessage(
  set: StoreSet,
  threadId: string,
  text: string,
  attachments?: FileAttachmentInput[],
  references?: import("../../lib/wsProtocol").TurnReference[],
): void {
  const trimmed = text.trim();
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!trimmed && !hasAttachments) return;

  const clientMessageId = makeId();
  queuePendingThreadMessage(threadId, trimmed, attachments, references, clientMessageId);

  const optimisticSeen = RUNTIME.optimisticUserMessageIds.get(threadId) ?? new Set<string>();
  optimisticSeen.add(clientMessageId);
  RUNTIME.optimisticUserMessageIds.set(threadId, optimisticSeen);

  const bubble: FeedItem = {
    id: clientMessageId,
    kind: "message",
    role: "user",
    ts: nowIso(),
    text: buildUserInputDisplayText(trimmed, attachments),
  };
  set((s) => {
    const rt = s.threadRuntimeById[threadId];
    if (!rt) return {};
    return {
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [threadId]: {
          ...rt,
          feed: [...rt.feed, bubble].slice(-MAX_FEED_ITEMS),
          pendingTurnStart: {
            clientMessageId,
            text: trimmed,
            attachmentSignature: buildAttachmentSignature(attachments),
            status: "sending",
          },
        },
      },
    };
  });
}

function findLatestSandboxApprovalPrompt(
  state: AppStoreState,
): { threadId: string; prompt: SandboxApprovalPrompt } | null {
  const selectedThreadId = state.selectedThreadId;
  const selectedPrompt = selectedThreadId
    ? state.sandboxApprovalsByThread[selectedThreadId]?.at(-1)
    : undefined;
  if (
    selectedThreadId &&
    selectedPrompt &&
    isSandboxApprovalThreadVisible(state, selectedThreadId)
  ) {
    return { threadId: selectedThreadId, prompt: selectedPrompt };
  }

  let latest: { threadId: string; prompt: SandboxApprovalPrompt } | null = null;
  for (const [threadId, prompts] of Object.entries(state.sandboxApprovalsByThread)) {
    if (!isSandboxApprovalThreadVisible(state, threadId)) continue;
    for (const prompt of prompts) {
      if (!latest) {
        latest = { threadId, prompt };
        continue;
      }
      const promptSequence = prompt.receivedSequence ?? 0;
      const latestSequence = latest.prompt.receivedSequence ?? 0;
      if (promptSequence > latestSequence) {
        latest = { threadId, prompt };
      }
    }
  }

  return latest;
}

export async function hydrateThreadSelection(
  get: StoreGet,
  set: StoreSet,
  threadId: string,
  options: HydrateThreadSelectionOptions = {},
): Promise<void> {
  const isSelectionCurrent = (requestId: number) =>
    get().selectedThreadId === threadId && isCurrentThreadSelectionRequest(threadId, requestId);

  const clearThreadHydrationIfCurrent = (requestId: number) => {
    if (!isCurrentThreadSelectionRequest(threadId, requestId)) {
      return;
    }
    set((state) => {
      const rt = state.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...state.threadRuntimeById,
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

  const thread = get().threads.find((candidate) => candidate.id === threadId);
  if (!thread) return;
  const selectedTaskIdForThread = (candidate: ThreadRecord): string | null => {
    if (isStandardChatThread(candidate, { includeDrafts: true })) return null;
    return typeof candidate.taskId === "string" && candidate.taskId.trim().length > 0
      ? candidate.taskId
      : null;
  };

  const threadFingerprint = (candidate: ThreadRecord): SessionSnapshotFingerprint => ({
    updatedAt: candidate.lastMessageAt,
    messageCount: candidate.messageCount,
    lastEventSeq: candidate.lastEventSeq,
  });

  const fingerprintMatches = (
    left: SessionSnapshotFingerprint,
    right: SessionSnapshotFingerprint,
  ): boolean =>
    left.updatedAt === right.updatedAt &&
    left.messageCount === right.messageCount &&
    left.lastEventSeq === right.lastEventSeq;

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

  const applySessionSnapshot = (
    selectedThreadId: string,
    sessionId: string,
    snapshot: SessionSnapshot,
  ) => {
    set((state) => {
      const nextThreads = state.threads.map((candidate) =>
        candidate.id === selectedThreadId
          ? {
              ...candidate,
              title: snapshot.title,
              titleSource: snapshot.titleSource,
              lastMessageAt: snapshot.updatedAt,
              sessionId,
              messageCount: snapshot.messageCount,
              lastEventSeq: snapshot.lastEventSeq,
            }
          : candidate,
      );
      const currentRuntime = state.threadRuntimeById[selectedThreadId];
      const currentThread = state.threads.find((candidate) => candidate.id === selectedThreadId);
      const snapshotWorkspace = currentThread
        ? state.workspaces.find((workspace) => workspace.id === currentThread.workspaceId)
        : null;
      const snapshotConfig =
        currentRuntime?.config ??
        (snapshotWorkspace
          ? {
              provider: snapshot.provider,
              model: snapshot.model,
              workingDirectory: snapshotWorkspace.path,
            }
          : null);
      return {
        threads: nextThreads,
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [selectedThreadId]: {
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
            config: snapshotConfig,
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
    candidate: Pick<ThreadRecord, "id" | "sessionId" | "legacyTranscriptId">,
  ): string[] => {
    const ids = [candidate.legacyTranscriptId ?? null, candidate.sessionId ?? null, candidate.id];
    return [
      ...new Set(
        ids.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        ),
      ),
    ];
  };

  const hydrateLegacyTranscript = async (candidate: ThreadRecord) => {
    const transcriptIds = transcriptIdsForThread(candidate);
    if (transcriptIds.length === 0) return null;

    if (transcriptIds.length === 1 && typeof desktopCommands.hydrateTranscript === "function") {
      const firstTranscriptId = transcriptIds[0];
      if (!firstTranscriptId) return null;
      return await desktopCommands.hydrateTranscript({ threadId: firstTranscriptId });
    }

    const transcript: TranscriptEvent[] = [];
    let successfulReads = 0;
    let firstError: unknown = null;
    for (const transcriptId of transcriptIds) {
      try {
        transcript.push(...(await desktopCommands.readTranscript({ threadId: transcriptId })));
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

  ensureThreadRuntime(get, set, threadId);
  if (thread.draft) {
    const selectedTaskId = selectedTaskIdForThread(thread);
    set((state) => ({
      selectedThreadId: threadId,
      selectedWorkspaceId: thread.workspaceId,
      selectedTaskId,
      view: options.preserveView ? state.view : "chat",
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          hydrating: false,
          transcriptOnly: false,
        },
      },
    }));
    syncDesktopStateCache(get);
    return;
  }

  const rt = get().threadRuntimeById[threadId];
  if (get().selectedThreadId === threadId && RUNTIME.threadSelectionRequests.has(threadId)) {
    const selectedTaskId = selectedTaskIdForThread(thread);
    set((state) => ({
      selectedWorkspaceId: thread.workspaceId,
      selectedTaskId,
      view: options.preserveView ? state.view : "chat",
    }));
    syncDesktopStateCache(get);
    return;
  }
  if (get().selectedThreadId === threadId && rt?.connected) {
    const selectedTaskId = selectedTaskIdForThread(thread);
    set((state) => ({
      selectedWorkspaceId: thread.workspaceId,
      selectedTaskId,
      view: options.preserveView ? state.view : "chat",
    }));
    syncDesktopStateCache(get);
    if (options.reconnectAfterHydration) {
      void get()
        .reconnectThread(threadId, undefined, {
          skipWorkspaceSelect: options.skipWorkspaceSelectOnReconnect,
          refreshSnapshot: false,
        })
        .catch(() => {
          // The next socket reconnect or thread selection will re-assert the live subscription.
        });
    }
    return;
  }

  const alreadyLoaded = rt?.feed && rt.feed.length > 0;
  const sessionId = rt?.sessionId ?? thread.sessionId;
  const expectedFingerprint = threadFingerprint(thread);
  const cachedSnapshot = sessionId ? RUNTIME.sessionSnapshots.get(sessionId) : null;
  const matchingCachedSnapshot =
    sessionId &&
    cachedSnapshot &&
    fingerprintMatches(cachedSnapshot.fingerprint, expectedFingerprint)
      ? cachedSnapshot.snapshot
      : null;

  if (sessionId && cachedSnapshot && !matchingCachedSnapshot) {
    console.debug(
      `[selectThread] Cache fingerprint mismatch for session ${sessionId}: cached ${JSON.stringify(cachedSnapshot.fingerprint)} vs expected ${JSON.stringify(expectedFingerprint)}`,
    );
  }

  const skipHarnessSnapshotFetch = Boolean(alreadyLoaded && matchingCachedSnapshot);
  const shouldFetchHarnessSnapshot =
    Boolean(sessionId) &&
    !skipHarnessSnapshotFetch &&
    (thread.messageCount > 0 || thread.lastEventSeq > 0 || Boolean(thread.legacyTranscriptId));

  const requestId = beginThreadSelectionRequest(threadId);
  const selectedTaskId = selectedTaskIdForThread(thread);
  set((state) => ({
    selectedThreadId: threadId,
    selectedWorkspaceId: thread.workspaceId,
    selectedTaskId,
    view: options.preserveView ? state.view : "chat",
    threadRuntimeById: {
      ...state.threadRuntimeById,
      [threadId]: {
        ...state.threadRuntimeById[threadId],
        hydrating: !alreadyLoaded && !matchingCachedSnapshot,
        transcriptOnly: false,
      },
    },
  }));
  syncDesktopStateCache(get);

  let appliedCachedSnapshot = false;
  if (matchingCachedSnapshot && sessionId) {
    applySessionSnapshot(threadId, sessionId, matchingCachedSnapshot);
    appliedCachedSnapshot = true;
  }

  await waitForNextPaintOrTimeout();
  if (!isSelectionCurrent(requestId)) {
    clearThreadHydrationIfCurrent(requestId);
    return;
  }

  if (!isSelectionCurrent(requestId)) {
    if (appliedCachedSnapshot) {
      clearThreadHydrationIfCurrent(requestId);
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
        if (!isSelectionCurrent(requestId)) {
          clearThreadHydrationIfCurrent(requestId);
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
        if (!isSelectionCurrent(requestId)) {
          clearThreadHydrationIfCurrent(requestId);
          return;
        }
        set((state) => {
          const currentRuntime = state.threadRuntimeById[threadId];
          return {
            threadRuntimeById: {
              ...state.threadRuntimeById,
              [threadId]: {
                ...currentRuntime,
                sessionUsage: snapshot.sessionUsage,
                lastTurnUsage: snapshot.lastTurnUsage,
                agents: snapshot.agents,
                feed: snapshot.feed,
                hydrating: false,
                transcriptOnly: true,
              },
            },
          };
        });
      }
    } catch (error) {
      if (!isSelectionCurrent(requestId)) {
        clearThreadHydrationIfCurrent(requestId);
        return;
      }

      const detail = error instanceof Error ? error.message : String(error);
      set((state) => ({
        notifications: pushNotification(state.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Transcript load failed",
          detail,
        }),
      }));
      clearThreadHydrationIfCurrent(requestId);
      return;
    }
  }

  if (!isSelectionCurrent(requestId)) {
    clearThreadHydrationIfCurrent(requestId);
    return;
  }

  if (stayTranscriptOnly) {
    set((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          hydrating: false,
          transcriptOnly: true,
        },
      },
    }));
    clearThreadSelectionRequest(threadId, requestId);
    return;
  }

  set((state) => ({
    threadRuntimeById: {
      ...state.threadRuntimeById,
      [threadId]: { ...state.threadRuntimeById[threadId], hydrating: false, transcriptOnly: false },
    },
  }));

  if (options.reconnectAfterHydration) {
    await get().reconnectThread(threadId, undefined, {
      selectionRequestId: requestId,
      skipWorkspaceSelect: options.skipWorkspaceSelectOnReconnect,
    });
  }
  clearThreadSelectionRequest(threadId, requestId);
}

export function createThreadActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "removeThread"
  | "archiveThread"
  | "restoreThread"
  | "deleteThreadHistory"
  | "renameThread"
  | "newThread"
  | "openNewChatLanding"
  | "setNewChatLandingTarget"
  | "selectThread"
  | "reconnectThread"
  | "sendMessage"
  | "cancelThread"
  | "clearThreadUsageHardCap"
  | "setThreadModel"
  | "setThreadReasoningEffort"
  | "setComposerText"
  | "setInjectContext"
  | "answerAsk"
  | "answerApproval"
  | "dismissPrompt"
  | "loadAllThreadUsage"
> {
  const closeThreadSession = (threadId: string) => {
    sendThread(get, threadId, (sessionId) => ({ type: "session_close", sessionId }));
  };

  const transcriptIdsForThread = (
    thread: Pick<ThreadRecord, "id" | "sessionId" | "legacyTranscriptId">,
  ): string[] => {
    const ids = [thread.legacyTranscriptId ?? null, thread.sessionId ?? null, thread.id];
    return [
      ...new Set(
        ids.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        ),
      ),
    ];
  };

  const sessionSnapshotIdsForThread = (
    thread: Pick<ThreadRecord, "sessionId">,
    runtimeSessionId?: string | null,
  ): string[] => {
    const ids = [runtimeSessionId ?? null, thread.sessionId ?? null];
    return [
      ...new Set(
        ids.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        ),
      ),
    ];
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

    return transcripts.flat().sort((left, right) => left.ts.localeCompare(right.ts));
  };

  const projectWorkspaces = () =>
    get().workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace));

  const cleanupRemovedWorkspaceRuntime = async (workspaceId: string): Promise<void> => {
    bumpWorkspaceStartGeneration(workspaceId);
    bumpWorkspaceJsonRpcSocketGeneration(workspaceId);
    const jsonRpcSocket = RUNTIME.jsonRpcSockets.get(workspaceId);
    try {
      jsonRpcSocket?.close();
    } catch {
      // ignore
    }
    RUNTIME.jsonRpcSockets.delete(workspaceId);
    clearWorkspaceJsonRpcSocketGeneration(workspaceId);

    try {
      await desktopCommands.stopWorkspaceServer({ workspaceId });
    } catch {
      // ignore
    } finally {
      disposeWorkspaceJsonRpcState(get, workspaceId);
      clearWorkspaceStartState(workspaceId);
    }
  };

  return {
    archiveThread: async (threadId: string) => {
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, archived: true, archivedAt: nowIso() } : t,
        ),
        selectedThreadId: s.selectedThreadId === threadId ? null : s.selectedThreadId,
      }));
      await persistNow(get);
    },

    restoreThread: async (threadId: string) => {
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, archived: false, archivedAt: undefined } : t,
        ),
      }));
      await persistNow(get);
    },

    removeThread: async (threadId: string) => {
      const thread = get().threads.find((t) => t.id === threadId);
      const runtimeSessionId = get().threadRuntimeById[threadId]?.sessionId ?? null;
      const sessionSnapshotIds = thread
        ? sessionSnapshotIdsForThread(thread, runtimeSessionId)
        : runtimeSessionId
          ? [runtimeSessionId]
          : [];
      closeThreadSession(threadId);
      RUNTIME.optimisticUserMessageIds.delete(threadId);
      RUNTIME.pendingThreadMessages.delete(threadId);
      RUNTIME.pendingThreadAttachments.delete(threadId);
      RUNTIME.pendingThreadReferences.delete(threadId);
      RUNTIME.pendingWorkspaceDefaultApplyByThread.delete(threadId);
      RUNTIME.modelStreamByThread.delete(threadId);
      RUNTIME.threadSelectionRequests.delete(threadId);
      clearPendingThreadSteers(threadId);

      for (const sessionId of sessionSnapshotIds) {
        RUNTIME.sessionSnapshots.delete(sessionId);
      }

      const threadWorkspace = thread
        ? (get().workspaces.find((workspace) => workspace.id === thread.workspaceId) ?? null)
        : null;
      const removeOneOffWorkspace =
        Boolean(thread && isOneOffChatWorkspace(threadWorkspace)) &&
        !get().threads.some(
          (candidate) => candidate.id !== threadId && candidate.workspaceId === thread?.workspaceId,
        );
      const workspaceIdToRemove = removeOneOffWorkspace && thread ? thread.workspaceId : null;

      set((s) => {
        const remainingThreads = s.threads.filter((t) => t.id !== threadId);
        const selectedThreadId = s.selectedThreadId === threadId ? null : s.selectedThreadId;
        const nextPromptModal = s.promptModal?.threadId === threadId ? null : s.promptModal;
        const remainingWorkspaces = workspaceIdToRemove
          ? s.workspaces.filter((workspace) => workspace.id !== workspaceIdToRemove)
          : s.workspaces;
        const fallbackWorkspaceId =
          remainingWorkspaces.find((workspace) => !isOneOffChatWorkspace(workspace))?.id ??
          remainingWorkspaces[0]?.id ??
          null;

        const nextThreadRuntimeById = { ...s.threadRuntimeById };
        delete nextThreadRuntimeById[threadId];

        const nextSandboxApprovals = { ...s.sandboxApprovalsByThread };
        delete nextSandboxApprovals[threadId];

        return {
          workspaces: remainingWorkspaces,
          threads: remainingThreads,
          selectedThreadId,
          promptModal: nextPromptModal,
          sandboxApprovalsByThread: nextSandboxApprovals,
          threadRuntimeById: nextThreadRuntimeById,
          selectedWorkspaceId:
            s.selectedWorkspaceId === workspaceIdToRemove
              ? fallbackWorkspaceId
              : s.selectedWorkspaceId,
          pluginManagementWorkspaceId:
            s.pluginManagementWorkspaceId === workspaceIdToRemove
              ? null
              : s.pluginManagementWorkspaceId,
          pluginManagementMode:
            s.pluginManagementWorkspaceId === workspaceIdToRemove &&
            s.pluginManagementMode === "workspace"
              ? "auto"
              : s.pluginManagementMode,
        };
      });

      if (workspaceIdToRemove) {
        await cleanupRemovedWorkspaceRuntime(workspaceIdToRemove);
      }

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

      let deleteOk = false;
      if (targetSessionId) {
        await ensureServerRunning(get, set, thread.workspaceId);
        ensureControlSocket(get, set, thread.workspaceId);
        deleteOk = await requestJsonRpcControlEvent(
          get,
          set,
          thread.workspaceId,
          "cowork/session/delete",
          {
            cwd: get().workspaces.find((workspace) => workspace.id === thread.workspaceId)?.path,
            targetSessionId,
          },
        );
      }

      await get().removeThread(threadId);

      if (!targetSessionId) return;

      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: deleteOk ? "info" : "error",
          title: deleteOk ? "Session history deleted" : "Delete session history failed",
          detail: deleteOk ? targetSessionId : "Control session is unavailable.",
        }),
      }));
    },

    renameThread: (threadId: string, newTitle: string) => {
      const trimmed = newTitle.trim();
      if (!trimmed) return;

      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, title: trimmed, titleSource: "manual" } : t,
        ),
      }));
      void persistNow(get);

      sendThread(get, threadId, (sessionId) => ({
        type: "set_session_title",
        sessionId,
        title: trimmed,
      }));
    },

    newThread: async (opts) => {
      const explicitWorkspace = opts?.workspaceId
        ? (get().workspaces.find((workspace) => workspace.id === opts.workspaceId) ?? null)
        : null;
      const scope =
        opts?.scope ??
        (explicitWorkspace && !isOneOffChatWorkspace(explicitWorkspace) ? "project" : "oneOff");
      const hasQueuedAttachments =
        (opts?.attachments && opts.attachments.length > 0) ||
        (opts?.attachmentFiles && opts.attachmentFiles.length > 0);
      const createSessionImmediately =
        opts?.mode === "session" || Boolean(opts?.firstMessage?.trim()) || hasQueuedAttachments;

      let workspaceId: string | null = null;
      if (scope === "oneOff") {
        try {
          const oneOffWorkspace = await createOneOffWorkspaceRecord(
            get,
            opts?.titleHint ?? opts?.firstMessage,
          );
          workspaceId = oneOffWorkspace.id;
          set((s) => ({
            workspaces: [oneOffWorkspace, ...s.workspaces],
            selectedWorkspaceId: oneOffWorkspace.id,
          }));
          ensureWorkspaceRuntime(get, set, oneOffWorkspace.id);
        } catch (error) {
          set((s) => ({
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "error",
              title: "Unable to create chat",
              detail: error instanceof Error ? error.message : String(error),
            }),
          }));
          return false;
        }
      } else {
        workspaceId =
          opts?.workspaceId ??
          (get().selectedWorkspaceId &&
          !isOneOffChatWorkspace(
            get().workspaces.find((workspace) => workspace.id === get().selectedWorkspaceId),
          )
            ? get().selectedWorkspaceId
            : null) ??
          projectWorkspaces()[0]?.id ??
          null;

        if (!workspaceId) {
          if (get().desktopFeatureFlags.workspaceLifecycle === false) {
            set((s) => ({
              notifications: pushNotification(s.notifications, {
                id: makeId(),
                ts: nowIso(),
                kind: "info",
                title: "Workspace management is disabled",
                detail:
                  "Enable Workspace lifecycle actions in Settings -> Feature Flags to add a project workspace.",
              }),
            }));
            return false;
          }
          await get().addWorkspace();
          workspaceId = projectWorkspaces()[0]?.id ?? null;
          if (!workspaceId) return false;
        }

        if (get().selectedWorkspaceId !== workspaceId) {
          set({ selectedWorkspaceId: workspaceId });
        }

        if (!createSessionImmediately) {
          const existingDraft = get().threads.find(
            (thread) => thread.workspaceId === workspaceId && thread.draft === true,
          );
          if (existingDraft) {
            set({
              selectedThreadId: existingDraft.id,
              selectedTaskId: null,
              view: "chat",
              newChatLandingTarget: null,
            });
            ensureThreadRuntime(get, set, existingDraft.id);
            await persistNow(get);
            return true;
          }
        }
      }

      if (!workspaceId) return false;

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
          return false;
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
        selectedTaskId: null,
        view: "chat",
        composerText: "",
        newChatLandingTarget: null,
      }));
      ensureThreadRuntime(get, set, threadId);
      set((s) => ({
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...s.threadRuntimeById[threadId],
            transcriptOnly: false,
            draftComposerProvider: opts?.provider ?? null,
            draftComposerModel: opts?.model?.trim() || null,
            composerReasoningEffort: opts?.reasoningEffort ?? null,
          },
        },
      }));
      await persistNow(get);

      if (!createSessionImmediately) {
        return true;
      }

      if (!url) {
        return false;
      }

      let firstMessage = opts?.firstMessage ?? "";
      let resolvedAttachments = opts?.attachments;
      if (opts?.attachmentFiles && opts.attachmentFiles.length > 0) {
        const resolved = await resolveComposerAttachmentsForWorkspace(
          get,
          set,
          workspaceId,
          opts.attachmentFiles.map(createComposerAttachmentFile),
          { threadId },
        );
        resolvedAttachments = resolved.attachments.length > 0 ? resolved.attachments : undefined;
        firstMessage = appendAttachmentSkippedNotes(firstMessage, resolved.skippedNotes);
      }

      const hasFirstMessage = Boolean(firstMessage.trim());
      const hasResolvedAttachments = Boolean(resolvedAttachments && resolvedAttachments.length > 0);
      if (hasFirstMessage || hasResolvedAttachments) {
        queueOptimisticFirstThreadMessage(
          set,
          threadId,
          firstMessage,
          resolvedAttachments,
          opts?.references,
        );
      }
      ensureThreadSocket(
        get,
        set,
        threadId,
        url,
        firstMessage,
        hasFirstMessage,
        resolvedAttachments,
      );
      return true;
    },

    openNewChatLanding: async (opts?: {
      defaultTargetKind?: "project" | "oneOff";
      target?: NewChatLandingTarget;
    }) => {
      const state = get();
      const landingTarget: NewChatLandingTarget =
        opts?.target ??
        (opts?.defaultTargetKind === "oneOff"
          ? { kind: "oneOff" }
          : resolveDefaultNewChatTarget(state.workspaces, state.selectedWorkspaceId));
      set({
        selectedThreadId: null,
        selectedTaskId: null,
        view: "chat",
        composerText: "",
        newChatLandingTarget: landingTarget,
      });
      syncDesktopStateCache(get);
      await persistNow(get);
    },

    setNewChatLandingTarget: (target) => {
      set({ newChatLandingTarget: target });
      syncDesktopStateCache(get);
    },

    selectThread: async (threadId: string) => {
      set({ newChatLandingTarget: null });
      await hydrateThreadSelection(get, set, threadId, {
        reconnectAfterHydration: true,
        skipWorkspaceSelectOnReconnect: true,
      });
    },

    reconnectThread: async (
      threadId: string,
      firstMessage?: string,
      opts?: {
        selectionRequestId?: number;
        skipWorkspaceSelect?: boolean;
        attachments?: import("../store.helpers/jsonRpcSocket").FileAttachmentInput[];
        references?: import("../../lib/wsProtocol").TurnReference[];
        refreshSnapshot?: boolean;
      },
    ) => {
      const isReconnectCurrent = () =>
        opts?.selectionRequestId === undefined ||
        (get().selectedThreadId === threadId &&
          isCurrentThreadSelectionRequest(threadId, opts.selectionRequestId));

      ensureThreadRuntime(get, set, threadId);

      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return false;

      const hasQueuedAttachments = opts?.attachments && opts.attachments.length > 0;
      if (thread.draft && !firstMessage?.trim() && !hasQueuedAttachments) {
        return false;
      }

      if (!opts?.skipWorkspaceSelect) {
        await get().selectWorkspace(thread.workspaceId);
        if (!isReconnectCurrent()) return false;
      }
      await ensureServerRunning(get, set, thread.workspaceId);
      if (!isReconnectCurrent()) return false;
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
        return false;
      }
      if (!isReconnectCurrent()) return false;

      const hasFirstMessage = firstMessage?.trim();
      if (hasFirstMessage || hasQueuedAttachments) {
        queuePendingThreadMessage(
          threadId,
          firstMessage ?? "",
          opts?.attachments,
          opts?.references,
        );
      }
      ensureThreadSocket(
        get,
        set,
        threadId,
        url,
        firstMessage,
        Boolean(firstMessage?.trim()),
        opts?.attachments,
        opts?.refreshSnapshot !== undefined ? { refreshSnapshot: opts.refreshSnapshot } : undefined,
      );
      return true;
    },

    sendMessage: async (
      text: string,
      busyPolicy: ThreadBusyPolicy = "reject",
      attachments?: import("../store.helpers/jsonRpcSocket").FileAttachmentInput[],
      references?: import("../../lib/wsProtocol").TurnReference[],
    ): Promise<boolean> => {
      const activeThreadId = get().selectedThreadId;
      if (!activeThreadId) return false;

      const thread = get().threads.find((t) => t.id === activeThreadId);
      if (!thread) return false;

      if (!(thread.workspaceId in get().taskSummariesByWorkspaceId)) {
        await get().refreshTasks(thread.workspaceId);
      }

      const rt = get().threadRuntimeById[activeThreadId];
      const trimmed = text.trim();
      const hasAttachments = attachments && attachments.length > 0;
      if (!trimmed && !hasAttachments) return false;

      const taskCommand = !hasAttachments ? trimmed.match(/^\/task(?:\s+([\s\S]*))?$/i) : null;
      if (taskCommand) {
        try {
          await ensureServerRunning(get, set, thread.workspaceId);
          ensureControlSocket(get, set, thread.workspaceId);
          await requestJsonRpc(get, set, thread.workspaceId, "command/execute", {
            threadId: activeThreadId,
            name: "task",
            arguments: taskCommand[1]?.trim() ?? "",
            clientMessageId: makeId(),
          });
          set({ composerText: "" });
          return true;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          set((state) => ({
            notifications: pushNotification(state.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "error",
              title: "Unable to start task mode",
              detail,
            }),
          }));
          return false;
        }
      }

      if (rt?.transcriptOnly) {
        const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
        const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
        const workspace = get().workspaces.find((candidate) => candidate.id === thread.workspaceId);
        const started = await get().newThread({
          workspaceId: thread.workspaceId,
          scope: isOneOffChatWorkspace(workspace) ? "oneOff" : "project",
          titleHint: thread.title,
          firstMessage,
          attachments,
          references,
        });
        if (!started) return false;
        set({ composerText: "" });
        return true;
      }

      if (thread.status !== "active" || !rt?.sessionId) {
        const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
        const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
        const reconnected = await get().reconnectThread(activeThreadId, firstMessage, {
          attachments,
          references,
        });
        if (!reconnected) return false;
        set({ composerText: "" });
        return true;
      }

      const accepted = sendUserMessageToThread(
        get,
        set,
        activeThreadId,
        trimmed,
        busyPolicy,
        attachments,
        references,
      );
      if (!accepted) return false;
      if (busyPolicy === "steer" && rt?.busy) return true;

      set({ composerText: "" });
      return true;
    },

    cancelThread: (threadId: string, opts?: { includeSubagents?: boolean }) => {
      const ok = sendThread(get, threadId, (sid) => ({
        type: "cancel",
        sessionId: sid,
        ...(opts?.includeSubagents !== undefined
          ? { includeSubagents: opts.includeSubagents }
          : {}),
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
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;

      if (thread.draft) {
        set((s) => ({
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...s.threadRuntimeById[threadId],
              draftComposerProvider: provider,
              draftComposerModel: model,
              composerReasoningEffort: null,
            },
          },
        }));
        return;
      }

      const rt = get().threadRuntimeById[threadId];
      if (!rt?.sessionId) return;
      set((state) => ({
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [threadId]: {
            ...state.threadRuntimeById[threadId],
            composerReasoningEffort: null,
          },
        },
      }));
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
      if (pendingApply?.draftModelSelection) {
        RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
          ...pendingApply,
          draftModelSelection: null,
        });
      }
      const ok = sendThread(get, threadId, (sessionId) => ({
        type: "set_model",
        sessionId,
        provider,
        model,
      }));
      if (ok) {
        appendThreadTranscript(threadId, "client", {
          type: "set_model",
          sessionId: rt.sessionId,
          provider,
          model,
        });
      }
    },

    setThreadReasoningEffort: (threadId, provider, effort) => {
      const providerConfig =
        (provider === "openai" || provider === "codex-cli") && isOpenAiReasoningEffortValue(effort)
          ? { [provider]: { reasoningEffort: effort } }
          : provider === "google" && isGoogleReasoningEffortValue(effort)
            ? { google: googleProviderOptionsForReasoningEffort(effort) }
            : null;
      if (!providerConfig) return;
      const thread = get().threads.find((candidate) => candidate.id === threadId);
      if (!thread) return;
      ensureThreadRuntime(get, set, threadId);
      const currentRuntime = get().threadRuntimeById[threadId];
      if (!thread.draft && currentRuntime?.busy) return;

      set((state) => ({
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [threadId]: {
            ...state.threadRuntimeById[threadId],
            composerReasoningEffort: effort,
          },
        },
      }));

      if (thread.draft) return;
      const rt = currentRuntime;
      if (!rt?.sessionId) return;
      const config = {
        providerOptions: providerConfig,
      };
      const ok = sendThread(get, threadId, (sessionId) => ({
        type: "set_config",
        sessionId,
        config,
      }));
      if (ok) {
        appendThreadTranscript(threadId, "client", {
          type: "set_config",
          sessionId: rt.sessionId,
          config,
        });
      }
    },

    setComposerText: (text) => set({ composerText: text }),

    setInjectContext: (v) => set({ injectContext: v }),

    answerAsk: (threadId, requestId, answer) => {
      const sent = sendThread(get, threadId, (sessionId) => ({
        type: "ask_response",
        sessionId,
        requestId,
        answer,
      }));
      if (!sent) {
        // Socket disconnected — keep the modal open so the user can retry
        // once reconnected rather than silently swallowing the answer.
        return;
      }
      appendThreadTranscript(threadId, "client", {
        type: "ask_response",
        sessionId: get().threadRuntimeById[threadId]?.sessionId,
        requestId,
        answer,
      });
      set({ promptModal: null });
    },

    answerApproval: (threadId, requestId, approved) => {
      const sent = sendThread(get, threadId, (sessionId) => ({
        type: "approval_response",
        sessionId,
        requestId,
        approved,
      }));
      if (!sent) {
        return;
      }
      appendThreadTranscript(threadId, "client", {
        type: "approval_response",
        sessionId: get().threadRuntimeById[threadId]?.sessionId,
        requestId,
        approved,
      });
      // Clear the modal (ordinary approvals) and drop any matching inline
      // sandbox-escalation prompt for this thread.
      set((s) => {
        const existing = s.sandboxApprovalsByThread[threadId];
        const promptModal =
          s.promptModal?.kind === "approval" &&
          s.promptModal.threadId === threadId &&
          s.promptModal.prompt.requestId === requestId
            ? null
            : s.promptModal;
        if (!existing) return { promptModal };
        const remaining = existing.filter((p) => p.requestId !== requestId);
        const nextSandbox = { ...s.sandboxApprovalsByThread };
        if (remaining.length > 0) nextSandbox[threadId] = remaining;
        else delete nextSandbox[threadId];
        return { promptModal, sandboxApprovalsByThread: nextSandbox };
      });
    },

    dismissPrompt: () => {
      const state = get();
      if (state.promptModal) {
        set({ promptModal: null });
        return;
      }

      const pending = findLatestSandboxApprovalPrompt(state);
      if (pending) {
        state.answerApproval(pending.threadId, pending.prompt.requestId, false);
      }
    },

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
