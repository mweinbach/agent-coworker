import {
  appendAttachmentSkippedNotes,
  createComposerAttachmentFile,
  resolveComposerAttachmentsForWorkspace,
} from "../../lib/composerAttachments";
import * as desktopCommands from "../../lib/desktopCommands";
import { type NewChatLandingTarget, resolveDefaultNewChatTarget } from "../../lib/newChatLanding";
import { buildAttachmentSignature, buildUserInputDisplayText } from "../attachmentInputs";
import {
  type ComposerDraft,
  type ComposerDraftAttachment,
  type ComposerDraftRevision,
  clearComposerDraftRevision,
  composerDraftKeyForThread,
  createComposerDraftAttachment,
  createEmptyComposerDraft,
  getComposerDraftAttachmentValidationMessage,
  pruneComposerDrafts as pruneComposerDraftEntries,
  resolveActiveComposerDraftKey,
  revokeComposerDraftAttachmentPreviews,
} from "../composerDrafts";
import { isInteractionThreadVisible } from "../interactionVisibility";
import {
  googleProviderOptionsForReasoningEffort,
  isGoogleReasoningEffortValue,
  isOpenAiReasoningEffortValue,
} from "../openaiCompatibleProviderOptions";
import {
  type AbortableActionOptions,
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
  getEffectiveThreadLastEventSeq,
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
import {
  beginCreationOperationIntent,
  invalidateNavigationIntent,
  isCreationNavigationIntentCurrent,
  isOperationAbortError,
  recordThreadNavigationIntent,
  waitForOperation,
} from "../store.helpers/operationIntent";
import { waitForNextPaintOrTimeout } from "../store.helpers/paintScheduling";
import { persist } from "../store.helpers/persistence";
import { MAX_FEED_ITEMS } from "../store.helpers/threadEventReducerContext";
import { isStandardChatThread } from "../threadFilters";
import { hydrateTranscriptSnapshot } from "../transcriptHydration";
import {
  type ChatInteraction,
  type FeedItem,
  isOneOffChatWorkspace,
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
} & AbortableActionOptions;

function createEmptyComposerDraftForState(state: AppStoreState, key: string): ComposerDraft {
  const draft = createEmptyComposerDraft(nowIso());
  const revisionFloor = state.composerDraftRevisionFloorByKey[key];
  return revisionFloor
    ? {
        ...draft,
        revision: revisionFloor.revision,
        generation: revisionFloor.generation,
      }
    : draft;
}

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
  draftSubmission?: ComposerDraftRevision,
): void {
  const trimmed = text.trim();
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!trimmed && !hasAttachments) return;

  const clientMessageId = makeId();
  queuePendingThreadMessage(
    threadId,
    trimmed,
    attachments,
    references,
    clientMessageId,
    draftSubmission,
  );

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

function updateInteraction(
  set: StoreSet,
  threadId: string,
  requestId: string,
  update: (interaction: ChatInteraction) => ChatInteraction,
): void {
  set((state) => {
    const interactions = state.interactionsByThread[threadId];
    if (!interactions?.some((interaction) => interaction.requestId === requestId)) {
      return {};
    }
    return {
      interactionsByThread: {
        ...state.interactionsByThread,
        [threadId]: interactions.map((interaction) =>
          interaction.requestId === requestId ? update(interaction) : interaction,
        ),
      },
    };
  });
}

function findLatestVisibleSandboxInteraction(
  state: AppStoreState,
): { threadId: string; interaction: ChatInteraction } | null {
  const eligible = (interaction: ChatInteraction) =>
    interaction.kind === "approval" &&
    interaction.approvalKind === "sandbox" &&
    (interaction.status === "pending" || interaction.status === "failed");
  const selectedThreadId = state.selectedThreadId;
  const selectedInteraction = selectedThreadId
    ? state.interactionsByThread[selectedThreadId]?.filter(eligible).at(-1)
    : undefined;
  if (
    selectedThreadId &&
    selectedInteraction &&
    isInteractionThreadVisible(state, selectedThreadId)
  ) {
    return { threadId: selectedThreadId, interaction: selectedInteraction };
  }

  let latest: { threadId: string; interaction: ChatInteraction } | null = null;
  for (const [threadId, interactions] of Object.entries(state.interactionsByThread)) {
    if (!isInteractionThreadVisible(state, threadId)) continue;
    for (const interaction of interactions) {
      if (!eligible(interaction)) continue;
      if (!latest || interaction.receivedSequence > latest.interaction.receivedSequence) {
        latest = { threadId, interaction };
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
  const isOperationCurrent = () => options.signal?.aborted !== true;
  const isSelectionCurrent = (requestId: number) =>
    isOperationCurrent() &&
    get().selectedThreadId === threadId &&
    isCurrentThreadSelectionRequest(threadId, requestId);

  const clearThreadHydrationIfCurrent = (requestId: number) => {
    if (!isOperationCurrent() || !isCurrentThreadSelectionRequest(threadId, requestId)) {
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

  if (!isOperationCurrent()) return;
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
    lastEventSeq: getEffectiveThreadLastEventSeq(get(), candidate.id),
  });

  const fingerprintMatches = (
    left: SessionSnapshotFingerprint,
    right: SessionSnapshotFingerprint,
  ): boolean =>
    left.updatedAt === right.updatedAt &&
    left.messageCount === right.messageCount &&
    left.lastEventSeq === right.lastEventSeq;

  const cacheSessionSnapshot = (snapshot: SessionSnapshot) => {
    if (!isOperationCurrent()) return;
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
    if (!isOperationCurrent()) return;
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
            lastEventSeq: snapshot.lastEventSeq,
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
    if (!isOperationCurrent()) return null;
    const transcriptIds = transcriptIdsForThread(candidate);
    if (transcriptIds.length === 0) return null;

    if (transcriptIds.length === 1 && typeof desktopCommands.hydrateTranscript === "function") {
      const firstTranscriptId = transcriptIds[0];
      if (!firstTranscriptId) return null;
      const snapshot = await desktopCommands.hydrateTranscript({ threadId: firstTranscriptId });
      return isOperationCurrent() ? snapshot : null;
    }

    const transcript: TranscriptEvent[] = [];
    let successfulReads = 0;
    let firstError: unknown = null;
    for (const transcriptId of transcriptIds) {
      if (!isOperationCurrent()) return null;
      try {
        transcript.push(...(await desktopCommands.readTranscript({ threadId: transcriptId })));
        if (!isOperationCurrent()) return null;
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

  if (!isOperationCurrent()) return;
  ensureThreadRuntime(get, set, threadId);
  if (thread.draft) {
    if (!isOperationCurrent()) return;
    const selectedTaskId = selectedTaskIdForThread(thread);
    set((state) => {
      return {
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
      };
    });
    syncDesktopStateCache(get);
    return;
  }

  const rt = get().threadRuntimeById[threadId];
  if (get().selectedThreadId === threadId && RUNTIME.threadSelectionRequests.has(threadId)) {
    if (!isOperationCurrent()) return;
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
    if (!isOperationCurrent()) return;
    const selectedTaskId = selectedTaskIdForThread(thread);
    set((state) => ({
      selectedWorkspaceId: thread.workspaceId,
      selectedTaskId,
      view: options.preserveView ? state.view : "chat",
    }));
    syncDesktopStateCache(get);
    if (options.reconnectAfterHydration) {
      const reconnect = get().reconnectThread(threadId, undefined, {
        skipWorkspaceSelect: options.skipWorkspaceSelectOnReconnect,
        refreshSnapshot: false,
        signal: options.signal,
      });
      if (options.signal) {
        await reconnect.catch(() => {
          // The next socket reconnect or thread selection will re-assert the live subscription.
        });
      } else {
        void reconnect.catch(() => {
          // The next socket reconnect or thread selection will re-assert the live subscription.
        });
      }
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
    (thread.messageCount > 0 ||
      getEffectiveThreadLastEventSeq(get(), thread.id) > 0 ||
      Boolean(thread.legacyTranscriptId));

  if (!isOperationCurrent()) return;
  const requestId = beginThreadSelectionRequest(threadId);
  const selectedTaskId = selectedTaskIdForThread(thread);
  if (!isOperationCurrent()) return;
  set((state) => {
    if (!isOperationCurrent()) return {};
    return {
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
    };
  });
  if (!isOperationCurrent()) return;
  syncDesktopStateCache(get);

  let appliedCachedSnapshot = false;
  if (matchingCachedSnapshot && sessionId) {
    if (!isOperationCurrent()) return;
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
        await ensureServerRunning(get, set, thread.workspaceId, { signal: options.signal });
        if (!isSelectionCurrent(requestId)) {
          clearThreadHydrationIfCurrent(requestId);
          return;
        }
        ensureControlSocket(get, set, thread.workspaceId);
        if (!isSelectionCurrent(requestId)) {
          clearThreadHydrationIfCurrent(requestId);
          return;
        }
        const snapshot = await requestSessionSnapshot(get, set, thread.workspaceId, sessionId);
        if (!isSelectionCurrent(requestId)) {
          clearThreadHydrationIfCurrent(requestId);
          return;
        }
        if (snapshot) {
          if (!isSelectionCurrent(requestId)) return;
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
    if (!isOperationCurrent()) return;
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

  if (!isOperationCurrent()) return;
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
      signal: options.signal,
    });
  }
  if (!isOperationCurrent()) return;
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
  | "addComposerAttachments"
  | "removeComposerAttachment"
  | "setComposerDraftModel"
  | "setComposerDraftReasoningEffort"
  | "clearComposerDraft"
  | "discardComposerDraft"
  | "pruneComposerDrafts"
  | "setInjectContext"
  | "answerAsk"
  | "answerApproval"
  | "dismissPrompt"
  | "retryInteractionResponse"
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
      get().discardComposerDraft(composerDraftKeyForThread(threadId));
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
        const remainingWorkspaces = workspaceIdToRemove
          ? s.workspaces.filter((workspace) => workspace.id !== workspaceIdToRemove)
          : s.workspaces;
        const fallbackWorkspaceId =
          remainingWorkspaces.find((workspace) => !isOneOffChatWorkspace(workspace))?.id ??
          remainingWorkspaces[0]?.id ??
          null;

        const nextThreadRuntimeById = { ...s.threadRuntimeById };
        delete nextThreadRuntimeById[threadId];

        const nextInteractionsByThread = { ...s.interactionsByThread };
        delete nextInteractionsByThread[threadId];

        return {
          workspaces: remainingWorkspaces,
          threads: remainingThreads,
          selectedThreadId,
          interactionsByThread: nextInteractionsByThread,
          threadRuntimeById: nextThreadRuntimeById,
          selectedWorkspaceId:
            s.selectedWorkspaceId === workspaceIdToRemove
              ? fallbackWorkspaceId
              : s.selectedWorkspaceId,
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
      const operationIntent = opts?.intent ?? beginCreationOperationIntent();
      const canNavigate = () => isCreationNavigationIntentCurrent(operationIntent);
      const reportPhase = opts?.onPhase ?? (() => {});
      reportPhase("preparing");
      if (opts?.signal?.aborted) return false;
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
          const oneOffWorkspace = await waitForOperation(
            createOneOffWorkspaceRecord(get, opts?.titleHint ?? opts?.firstMessage),
            opts?.signal,
          );
          workspaceId = oneOffWorkspace.id;
          set((s) => {
            const next = {
              workspaces: [oneOffWorkspace, ...s.workspaces],
            };
            return canNavigate() ? { ...next, selectedWorkspaceId: oneOffWorkspace.id } : next;
          });
          ensureWorkspaceRuntime(get, set, oneOffWorkspace.id);
        } catch (error) {
          if (isOperationAbortError(error)) return false;
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
          await get().addWorkspace({ intent: operationIntent });
          workspaceId = projectWorkspaces()[0]?.id ?? null;
          if (!workspaceId) return false;
        }

        if (canNavigate() && get().selectedWorkspaceId !== workspaceId) {
          set({ selectedWorkspaceId: workspaceId });
        }

        if (!createSessionImmediately) {
          const existingDraft = get().threads.find(
            (thread) => thread.workspaceId === workspaceId && thread.draft === true,
          );
          if (existingDraft) {
            if (canNavigate()) {
              set({
                selectedThreadId: existingDraft.id,
                selectedTaskId: null,
                view: "chat",
                newChatLandingTarget: null,
              });
            }
            ensureThreadRuntime(get, set, existingDraft.id);
            await persistNow(get);
            return true;
          }
        }
      }

      if (!workspaceId) return false;

      let url: string | null = null;
      if (createSessionImmediately) {
        reportPhase("starting-server");
        try {
          await ensureServerRunning(get, set, workspaceId, { signal: opts?.signal });
        } catch (error) {
          if (isOperationAbortError(error)) return false;
          throw error;
        }
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
      let firstMessage = opts?.firstMessage ?? "";
      let resolvedAttachments = opts?.attachments;
      if (opts?.attachmentFiles && opts.attachmentFiles.length > 0) {
        reportPhase("processing-attachments");
        try {
          const resolved = await resolveComposerAttachmentsForWorkspace(
            get,
            set,
            workspaceId,
            opts.attachmentFiles.map(createComposerAttachmentFile),
            { threadId, signal: opts.signal },
          );
          resolvedAttachments = resolved.attachments.length > 0 ? resolved.attachments : undefined;
          firstMessage = appendAttachmentSkippedNotes(firstMessage, resolved.skippedNotes);
        } catch (error) {
          if (isOperationAbortError(error)) return false;
          throw error;
        }
      }
      if (opts?.signal?.aborted) return false;
      reportPhase("creating");
      const createdAt = nowIso();
      const title = opts?.titleHint ? truncateTitle(opts.titleHint) : "New chat";

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

      let queuedDraftSubmission = opts?.draftSubmission;
      set((s) => {
        let composerDraftsByKey = s.composerDraftsByKey;
        if (queuedDraftSubmission) {
          const submittedDraft = composerDraftsByKey[queuedDraftSubmission.key];
          if (submittedDraft?.revision === queuedDraftSubmission.revision) {
            const nextKey = composerDraftKeyForThread(threadId);
            const nextDrafts = { ...composerDraftsByKey };
            delete nextDrafts[queuedDraftSubmission.key];
            nextDrafts[nextKey] = submittedDraft;
            composerDraftsByKey = nextDrafts;
            queuedDraftSubmission = {
              key: nextKey,
              revision: queuedDraftSubmission.revision,
            };
          }
        }
        const next = {
          threads: [thread, ...s.threads],
          composerDraftsByKey,
        };
        return canNavigate()
          ? {
              ...next,
              selectedWorkspaceId: workspaceId,
              selectedThreadId: threadId,
              selectedTaskId: null,
              view: "chat" as const,
              newChatLandingTarget: null,
            }
          : next;
      });
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

      const hasFirstMessage = Boolean(firstMessage.trim());
      const hasResolvedAttachments = Boolean(resolvedAttachments && resolvedAttachments.length > 0);
      if (hasFirstMessage || hasResolvedAttachments) {
        queueOptimisticFirstThreadMessage(
          set,
          threadId,
          firstMessage,
          resolvedAttachments,
          opts?.references,
          queuedDraftSubmission,
        );
        recordThreadNavigationIntent(threadId, operationIntent);
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
      invalidateNavigationIntent();
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
        newChatLandingTarget: landingTarget,
      });
      syncDesktopStateCache(get);
      await persistNow(get);
    },

    setNewChatLandingTarget: (target) => {
      invalidateNavigationIntent();
      set({ newChatLandingTarget: target });
      syncDesktopStateCache(get);
    },

    selectThread: async (threadId: string, options = {}) => {
      if (options.signal?.aborted) return;
      invalidateNavigationIntent();
      set({ newChatLandingTarget: null });
      if (options.signal?.aborted) return;
      await hydrateThreadSelection(get, set, threadId, {
        reconnectAfterHydration: true,
        skipWorkspaceSelectOnReconnect: true,
        signal: options.signal,
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
        signal?: AbortSignal;
        draftSubmission?: ComposerDraftRevision;
      },
    ) => {
      const isReconnectCurrent = () =>
        opts?.signal?.aborted !== true &&
        (opts?.selectionRequestId === undefined ||
          (get().selectedThreadId === threadId &&
            isCurrentThreadSelectionRequest(threadId, opts.selectionRequestId)));

      if (!isReconnectCurrent()) return false;
      ensureThreadRuntime(get, set, threadId);

      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return false;

      const hasQueuedAttachments = opts?.attachments && opts.attachments.length > 0;
      if (thread.draft && !firstMessage?.trim() && !hasQueuedAttachments) {
        return false;
      }

      if (!opts?.skipWorkspaceSelect) {
        await get().selectWorkspace(thread.workspaceId, { signal: opts?.signal });
        if (!isReconnectCurrent()) return false;
      }
      await ensureServerRunning(get, set, thread.workspaceId, { signal: opts?.signal });
      if (!isReconnectCurrent()) return false;
      ensureControlSocket(get, set, thread.workspaceId);

      const url = get().workspaceRuntimeById[thread.workspaceId]?.serverUrl;
      if (!url) {
        if (!isReconnectCurrent()) return false;
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
        if (!isReconnectCurrent()) return false;
        queuePendingThreadMessage(
          threadId,
          firstMessage ?? "",
          opts?.attachments,
          opts?.references,
          undefined,
          opts?.draftSubmission,
        );
      }
      if (!isReconnectCurrent()) return false;
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
      options?: {
        targetThreadId?: string;
        draftSubmission?: ComposerDraftRevision;
        retryToolItemIds?: string[];
      },
    ): Promise<boolean> => {
      const activeThreadId = options?.targetThreadId ?? get().selectedThreadId;
      if (!activeThreadId) return false;

      const thread = get().threads.find((t) => t.id === activeThreadId);
      if (!thread) return false;
      const threadDraftKey = composerDraftKeyForThread(activeThreadId);
      const currentDraft = get().composerDraftsByKey[threadDraftKey];
      const draftSubmission =
        options?.draftSubmission ??
        (currentDraft && currentDraft.text.trim() === text.trim()
          ? { key: threadDraftKey, revision: currentDraft.revision }
          : undefined);

      if (!(thread.workspaceId in get().taskSummariesByWorkspaceId)) {
        // Warm task summaries without blocking the send; the server enforces
        // task locks authoritatively and the UI catches up when this resolves.
        void get().refreshTasks(thread.workspaceId);
      }

      const rt = get().threadRuntimeById[activeThreadId];
      const trimmed = text.trim();
      const hasAttachments = attachments && attachments.length > 0;
      if (!trimmed && !hasAttachments) return false;

      const taskCommand = !hasAttachments ? trimmed.match(/^\/task(?:\s+([\s\S]*))?$/i) : null;
      if (taskCommand) {
        try {
          recordThreadNavigationIntent(activeThreadId);
          await ensureServerRunning(get, set, thread.workspaceId);
          ensureControlSocket(get, set, thread.workspaceId);
          await requestJsonRpc(get, set, thread.workspaceId, "command/execute", {
            threadId: activeThreadId,
            name: "task",
            arguments: taskCommand[1]?.trim() ?? "",
            clientMessageId: makeId(),
          });
          if (draftSubmission) get().clearComposerDraft(draftSubmission);
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
          draftSubmission,
        });
        if (!started) return false;
        return true;
      }

      if (thread.status !== "active" || !rt?.sessionId) {
        const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
        const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
        const reconnected = await get().reconnectThread(activeThreadId, firstMessage, {
          attachments,
          references,
          draftSubmission,
        });
        if (!reconnected) return false;
        recordThreadNavigationIntent(activeThreadId);
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
        undefined,
        draftSubmission,
        options?.retryToolItemIds,
      );
      if (!accepted) return false;
      recordThreadNavigationIntent(activeThreadId);
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
      } else {
        // The change never left the client, so no session_config ack will
        // arrive to clear the optimistic value — revert it now so the selector
        // does not stay stuck on an effort the session never received.
        set((state) => {
          const current = state.threadRuntimeById[threadId];
          if (!current || current.composerReasoningEffort !== effort) return {};
          return {
            threadRuntimeById: {
              ...state.threadRuntimeById,
              [threadId]: { ...current, composerReasoningEffort: null },
            },
          };
        });
      }
    },

    setComposerText: (text, references = []) => {
      set((state) => {
        const key = resolveActiveComposerDraftKey(state);
        const current =
          state.composerDraftsByKey[key] ?? createEmptyComposerDraftForState(state, key);
        return {
          composerDraftsByKey: {
            ...state.composerDraftsByKey,
            [key]: {
              ...current,
              revision: current.revision + 1,
              updatedAt: nowIso(),
              text,
              references: references.map((reference) => ({ ...reference })),
            },
          },
        };
      });
      get().pruneComposerDrafts(undefined, Number.POSITIVE_INFINITY);
      persist(get);
    },

    addComposerAttachments: async (files) => {
      if (files.length === 0) return;
      const ownerKey = resolveActiveComposerDraftKey(get());
      let ownerGeneration = 1;
      set((state) => {
        const existing = state.composerDraftsByKey[ownerKey];
        const current = existing ?? createEmptyComposerDraftForState(state, ownerKey);
        ownerGeneration = Math.max(1, current.generation);
        const pendingCount = (state.composerAttachmentIngestionCountByKey[ownerKey] ?? 0) + 1;
        return {
          composerDraftsByKey: {
            ...state.composerDraftsByKey,
            [ownerKey]: {
              ...current,
              generation: ownerGeneration,
            },
          },
          composerAttachmentIngestionCountByKey: {
            ...state.composerAttachmentIngestionCountByKey,
            [ownerKey]: pendingCount,
          },
        };
      });
      const previousIngestion = RUNTIME.composerAttachmentIngestionTail ?? Promise.resolve();
      const ingestion = previousIngestion
        .catch(() => undefined)
        .then(async () => {
          const current = get().composerDraftsByKey[ownerKey];
          if (current?.generation !== ownerGeneration) return;
          const validationMessage = getComposerDraftAttachmentValidationMessage(
            get().composerDraftsByKey,
            ownerKey,
            files,
          );
          if (validationMessage) {
            throw new Error(validationMessage);
          }

          const attachments: ComposerDraftAttachment[] = [];
          try {
            for (const file of files) {
              attachments.push(await createComposerDraftAttachment(file));
            }
          } catch (error) {
            revokeComposerDraftAttachmentPreviews(attachments);
            throw error;
          }

          let accepted = false;
          set((state) => {
            const draft = state.composerDraftsByKey[ownerKey];
            if (draft?.generation !== ownerGeneration) return {};
            accepted = true;
            return {
              composerDraftsByKey: {
                ...state.composerDraftsByKey,
                [ownerKey]: {
                  ...draft,
                  revision: draft.revision + 1,
                  updatedAt: nowIso(),
                  attachments: [...draft.attachments, ...attachments],
                },
              },
            };
          });
          if (!accepted) {
            revokeComposerDraftAttachmentPreviews(attachments);
            return;
          }
          persist(get);
        });
      let trackedIngestion: Promise<void>;
      trackedIngestion = ingestion.finally(() => {
        set((state) => {
          const pendingCount = (state.composerAttachmentIngestionCountByKey[ownerKey] ?? 1) - 1;
          const nextPendingCounts = {
            ...state.composerAttachmentIngestionCountByKey,
          };
          if (pendingCount > 0) nextPendingCounts[ownerKey] = pendingCount;
          else delete nextPendingCounts[ownerKey];
          return { composerAttachmentIngestionCountByKey: nextPendingCounts };
        });
        if (RUNTIME.composerAttachmentIngestionTail === trackedIngestion) {
          RUNTIME.composerAttachmentIngestionTail = null;
        }
        get().pruneComposerDrafts(undefined, Number.POSITIVE_INFINITY);
      });
      RUNTIME.composerAttachmentIngestionTail = trackedIngestion;
      await trackedIngestion;
    },

    removeComposerAttachment: (index) => {
      let removed: ComposerDraftAttachment[] = [];
      set((state) => {
        const key = resolveActiveComposerDraftKey(state);
        const current = state.composerDraftsByKey[key];
        if (!current?.attachments[index]) return {};
        removed = [current.attachments[index]];
        return {
          composerDraftsByKey: {
            ...state.composerDraftsByKey,
            [key]: {
              ...current,
              revision: current.revision + 1,
              updatedAt: nowIso(),
              attachments: current.attachments.filter(
                (_attachment, currentIndex) => currentIndex !== index,
              ),
            },
          },
        };
      });
      revokeComposerDraftAttachmentPreviews(removed);
      get().pruneComposerDrafts(undefined, Number.POSITIVE_INFINITY);
      persist(get);
    },

    setComposerDraftModel: (provider, model) => {
      const normalizedModel = model.trim();
      if (!normalizedModel) return;
      set((state) => {
        const key = resolveActiveComposerDraftKey(state);
        const current =
          state.composerDraftsByKey[key] ?? createEmptyComposerDraftForState(state, key);
        if (current.provider === provider && current.model === normalizedModel) return {};
        return {
          composerDraftsByKey: {
            ...state.composerDraftsByKey,
            [key]: {
              ...current,
              revision: current.revision + 1,
              updatedAt: nowIso(),
              provider,
              model: normalizedModel,
              reasoningEffort: null,
            },
          },
        };
      });
      get().pruneComposerDrafts(undefined, Number.POSITIVE_INFINITY);
      persist(get);
    },

    setComposerDraftReasoningEffort: (effort) => {
      set((state) => {
        const key = resolveActiveComposerDraftKey(state);
        const current =
          state.composerDraftsByKey[key] ?? createEmptyComposerDraftForState(state, key);
        if (current.reasoningEffort === effort) return {};
        return {
          composerDraftsByKey: {
            ...state.composerDraftsByKey,
            [key]: {
              ...current,
              revision: current.revision + 1,
              updatedAt: nowIso(),
              reasoningEffort: effort,
            },
          },
        };
      });
      get().pruneComposerDrafts(undefined, Number.POSITIVE_INFINITY);
      persist(get);
    },

    clearComposerDraft: (owner) => {
      let cleared = false;
      let removedAttachments: ReturnType<typeof clearComposerDraftRevision>["removedAttachments"] =
        [];
      set((state) => {
        const result = clearComposerDraftRevision(state.composerDraftsByKey, owner);
        cleared = result.cleared;
        removedAttachments = result.removedAttachments;
        return result.cleared ? { composerDraftsByKey: result.drafts } : {};
      });
      if (cleared) {
        revokeComposerDraftAttachmentPreviews(removedAttachments);
        get().pruneComposerDrafts(undefined, Number.POSITIVE_INFINITY);
        persist(get);
      }
      return cleared;
    },

    discardComposerDraft: (key) => {
      const ownerKey = key ?? resolveActiveComposerDraftKey(get());
      const current = get().composerDraftsByKey[ownerKey];
      if (!current) return false;
      const owner = { key: ownerKey, revision: current.revision };
      return get().clearComposerDraft(owner);
    },

    pruneComposerDrafts: (nowMs, maxAgeMs) => {
      let removedAttachments: ReturnType<typeof pruneComposerDraftEntries>["removedAttachments"] =
        [];
      let changed = false;
      set((state) => {
        const result = pruneComposerDraftEntries(state.composerDraftsByKey, {
          nowMs,
          validThreadIds: new Set(state.threads.map((thread) => thread.id)),
          validProjectWorkspaceIds: new Set(
            state.workspaces
              .filter((workspace) => !isOneOffChatWorkspace(workspace))
              .map((workspace) => workspace.id),
          ),
          activeKey: resolveActiveComposerDraftKey(state),
          maxAgeMs,
          protectedKeys: new Set(
            Object.entries(state.composerAttachmentIngestionCountByKey)
              .filter(([, count]) => count > 0)
              .map(([key]) => key),
          ),
        });
        removedAttachments = result.removedAttachments;
        changed = result.removedKeys.length > 0;
        if (result.removedKeys.length === 0) return {};
        const composerDraftRevisionFloorByKey = {
          ...state.composerDraftRevisionFloorByKey,
        };
        for (const key of result.removedKeys) {
          const removedDraft = state.composerDraftsByKey[key];
          if (!removedDraft) continue;
          const currentFloor = composerDraftRevisionFloorByKey[key];
          composerDraftRevisionFloorByKey[key] = {
            revision: Math.max(currentFloor?.revision ?? 0, removedDraft.revision),
            generation: Math.max(currentFloor?.generation ?? 0, removedDraft.generation),
          };
        }
        return {
          composerDraftsByKey: result.drafts,
          composerDraftRevisionFloorByKey,
        };
      });
      revokeComposerDraftAttachmentPreviews(removedAttachments);
      if (changed) persist(get);
    },

    setInjectContext: (v) => set({ injectContext: v }),

    answerAsk: (threadId, requestId, answer) => {
      const interaction = get().interactionsByThread[threadId]?.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (
        interaction?.kind !== "ask" ||
        (interaction.status !== "pending" && interaction.status !== "failed")
      ) {
        return false;
      }
      updateInteraction(set, threadId, requestId, (current) => {
        if (current.kind !== "ask") return current;
        const { error: _error, ...rest } = current;
        return { ...rest, status: "responding", response: answer };
      });
      const sent = sendThread(get, threadId, (sessionId) => ({
        type: "ask_response",
        sessionId,
        requestId,
        answer,
      }));
      if (!sent) {
        updateInteraction(set, threadId, requestId, (current) => ({
          ...current,
          status: "failed",
          error: "The response could not be sent. Reconnect and retry.",
        }));
        return false;
      }
      appendThreadTranscript(threadId, "client", {
        type: "ask_response",
        sessionId: get().threadRuntimeById[threadId]?.sessionId,
        requestId,
        answer,
      });
      return true;
    },

    answerApproval: (threadId, requestId, approved) => {
      const interaction = get().interactionsByThread[threadId]?.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (
        interaction?.kind !== "approval" ||
        (interaction.status !== "pending" && interaction.status !== "failed")
      ) {
        return false;
      }
      updateInteraction(set, threadId, requestId, (current) => {
        if (current.kind !== "approval") return current;
        const { error: _error, ...rest } = current;
        return { ...rest, status: "responding", response: approved };
      });
      const sent = sendThread(get, threadId, (sessionId) => ({
        type: "approval_response",
        sessionId,
        requestId,
        approved,
      }));
      if (!sent) {
        updateInteraction(set, threadId, requestId, (current) => ({
          ...current,
          status: "failed",
          error: "The response could not be sent. Reconnect and retry.",
        }));
        return false;
      }
      appendThreadTranscript(threadId, "client", {
        type: "approval_response",
        sessionId: get().threadRuntimeById[threadId]?.sessionId,
        requestId,
        approved,
      });
      return true;
    },

    dismissPrompt: () => {
      const pending = findLatestVisibleSandboxInteraction(get());
      if (pending?.interaction.kind !== "approval") return;
      get().answerApproval(pending.threadId, pending.interaction.requestId, false);
    },

    retryInteractionResponse: (threadId, requestId) => {
      const interaction = get().interactionsByThread[threadId]?.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (interaction?.status !== "failed") return false;
      if (interaction.kind === "ask" && interaction.response !== undefined) {
        return get().answerAsk(threadId, requestId, interaction.response);
      }
      if (interaction.kind === "approval" && interaction.response !== undefined) {
        return get().answerApproval(threadId, requestId, interaction.response);
      }
      return false;
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
