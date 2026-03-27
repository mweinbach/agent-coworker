import type { ServerEvent } from "../../lib/wsProtocol";
import {
  applyProjectedAgentMessageDelta,
  applyProjectedItemCompleted,
  applyProjectedItemStarted,
  applyProjectedReasoningDelta,
  projectedItemSchema,
  projectedTodosFromItem,
  type ProjectedItem,
} from "../../../../../src/shared/projectedItems";
import {
  mapModelStreamChunk,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
  type ModelStreamUpdate,
} from "../modelStream";
import { buildAttachmentDisplayText, buildAttachmentSignature } from "../attachmentInputs";
import {
  applyModelStreamUpdateToThreadFeed as applyModelStreamUpdateToThreadFeedCore,
  developerDiagnosticSystemLineFromServerEvent,
  hasMatchingStreamedReasoningText,
  reasoningInsertBeforeAssistantAfterStreamReplay,
  shouldSkipAssistantMessageAfterStreamReplay,
  shouldSuppressRawDebugLogLine,
  unhandledEventSystemLine,
  type ThreadModelStreamRuntime,
} from "../store.feedMapping";
import type { StoreGet, StoreSet } from "../store.helpers";
import type {
  ApprovalPrompt,
  AskPrompt,
  FeedItem,
  Notification,
  ThreadAgentSummary,
  ThreadBusyPolicy,
  ThreadTitleSource,
} from "../types";
import {
  RUNTIME,
  clearPendingThreadSteer,
  clearPendingThreadSteers,
  ensureThreadRuntime,
  getModelStreamRuntime,
  hasPendingThreadSteer,
  markPendingThreadSteerAccepted,
  prependPendingThreadMessage,
  prependPendingThreadMessageWithAttachments,
  queuePendingThreadMessage,
  rememberPendingThreadSteer,
  rekeyThreadRuntimeMaps,
  resetModelStreamRuntime,
  shiftPendingThreadMessage,
  shiftPendingThreadAttachments,
} from "./runtimeState";
import {
  buildSyntheticServerHelloFromJsonRpcThread,
  buildSyntheticSessionInfoFromJsonRpcThread,
  buildSyntheticSessionSettings,
  ensureWorkspaceJsonRpcSocket,
  findThreadIdForJsonRpcNotification,
  requestJsonRpc,
  registerWorkspaceJsonRpcLifecycle,
  registerWorkspaceJsonRpcRouter,
  respondToJsonRpcRequest,
  requestJsonRpcThreadRead,
  resumeJsonRpcThread,
  startJsonRpcThread,
  startJsonRpcTurn,
  steerJsonRpcTurn,
  type FileAttachmentInput,
  interruptJsonRpcTurn,
  unsubscribeJsonRpcThread,
} from "./jsonRpcSocket";

const MAX_FEED_ITEMS = 2000;
const JSONRPC_THREAD_EVENT_METHODS = new Set([
  "cowork/session/settings",
  "cowork/session/info",
  "cowork/session/configUpdated",
  "cowork/session/config",
  "cowork/session/usage",
  "cowork/session/steerAccepted",
  "cowork/session/turnUsage",
  "cowork/session/budgetWarning",
  "cowork/session/budgetExceeded",
  "cowork/session/agentList",
  "cowork/session/agentSpawned",
  "cowork/session/agentStatus",
  "cowork/session/agentWaitResult",
]);

type ThreadOutboundMessage =
  | { type: "cancel"; sessionId: string; includeSubagents?: boolean }
  | { type: "session_close"; sessionId: string }
  | { type: "set_session_title"; sessionId: string; title: string }
  | { type: "set_model"; sessionId: string; provider: string; model: string }
  | { type: "set_session_usage_budget"; sessionId: string; warnAtUsd?: number | null; stopAtUsd?: number | null }
  | { type: "set_config"; sessionId: string; config: Record<string, unknown> }
  | {
    type: "apply_session_defaults";
    sessionId: string;
    provider?: string;
    model?: string;
    enableMcp?: boolean;
    config?: Record<string, unknown>;
  }
  | { type: "ask_response"; sessionId: string; requestId: string; answer: string }
  | { type: "approval_response"; sessionId: string; requestId: string; approved: boolean };

function sortAgentSummaries(agents: ThreadAgentSummary[]): ThreadAgentSummary[] {
  return [...agents].sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    return left.title.localeCompare(right.title);
  });
}

function upsertAgentSummary(agents: ThreadAgentSummary[], nextAgent: ThreadAgentSummary): ThreadAgentSummary[] {
  const nextAgents = agents.filter((agent) => agent.agentId !== nextAgent.agentId);
  nextAgents.push(nextAgent);
  return sortAgentSummaries(nextAgents);
}

function occurrenceItemId(baseId: string, occurrence: number): string {
  return occurrence <= 1 ? baseId : `${baseId}:${occurrence}`;
}

type ThreadEventReducerDeps = {
  nowIso: () => string;
  makeId: () => string;
  persist: (get: StoreGet) => void;
  appendThreadTranscript: (threadId: string, direction: "server" | "client", payload: unknown) => void;
  pushNotification: (notifications: Notification[], entry: Notification) => Notification[];
  normalizeThreadTitleSource: (source: unknown, fallbackTitle: string) => ThreadTitleSource;
  shouldAdoptServerTitle: (opts: {
    currentSource: ThreadTitleSource;
    incomingTitle: string;
    incomingSource: ThreadTitleSource;
  }) => boolean;
};

export function createThreadEventReducer(deps: ThreadEventReducerDeps) {
  const jsonRpcRouterCleanupByWorkspace = new Map<string, () => void>();
  const jsonRpcLifecycleCleanupByWorkspace = new Map<string, () => void>();
  const jsonRpcReconnectThreadsByWorkspace = new Map<string, Set<string>>();
  const jsonRpcThreadConnectPromises = new Map<string, Promise<void>>();
  const threadStoreGettersByWorkspace = new Map<string, StoreGet>();
  const disposedWorkspaces = new Set<string>();
  function isWorkspaceDisposed(workspaceId: string): boolean {
    return disposedWorkspaces.has(workspaceId);
  }

  function reactivateWorkspaceThreadEventState(workspaceId: string) {
    disposedWorkspaces.delete(workspaceId);
  }

  function hasPendingWorkspaceDefaultApply(threadId: string): boolean {
    return Boolean(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId));
  }

  function resetLiveModelStreamRuntime(threadId: string) {
    resetModelStreamRuntime(threadId);
  }

  function workspaceIdForThread(get: StoreGet, threadId: string): string | null {
    return get().threads.find((thread) => thread.id === threadId)?.workspaceId ?? null;
  }

  function rememberThreadStoreGet(workspaceId: string, get: StoreGet) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    threadStoreGettersByWorkspace.set(workspaceId, get);
  }

  function trackedThreadIdsForWorkspace(workspaceId: string, getOverride?: StoreGet): string[] {
    const trackedThreadIds = new Set<string>(jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? []);
    const get = getOverride ?? threadStoreGettersByWorkspace.get(workspaceId);
    const threads = get?.().threads ?? [];
    for (const thread of threads) {
      if (thread.workspaceId === workspaceId) {
        trackedThreadIds.add(thread.id);
      }
    }
    return [...trackedThreadIds];
  }

  function trackedWorkspaceIds(): string[] {
    const workspaceIds = new Set<string>();
    for (const workspaceId of jsonRpcRouterCleanupByWorkspace.keys()) {
      workspaceIds.add(workspaceId);
    }
    for (const workspaceId of jsonRpcLifecycleCleanupByWorkspace.keys()) {
      workspaceIds.add(workspaceId);
    }
    for (const workspaceId of jsonRpcReconnectThreadsByWorkspace.keys()) {
      workspaceIds.add(workspaceId);
    }
    for (const workspaceId of threadStoreGettersByWorkspace.keys()) {
      workspaceIds.add(workspaceId);
    }
    return [...workspaceIds];
  }

  function rememberThreadForReconnect(workspaceId: string, threadId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    const threadIds = jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? new Set<string>();
    threadIds.add(threadId);
    jsonRpcReconnectThreadsByWorkspace.set(workspaceId, threadIds);
  }

  function forgetThreadForReconnect(workspaceId: string, threadId: string) {
    const threadIds = jsonRpcReconnectThreadsByWorkspace.get(workspaceId);
    if (!threadIds) return;
    threadIds.delete(threadId);
    if (threadIds.size === 0) {
      jsonRpcReconnectThreadsByWorkspace.delete(workspaceId);
    }
  }

  function connectedThreadIdsForWorkspace(get: StoreGet, workspaceId: string): string[] {
    return get().threads
      .filter((thread) => thread.workspaceId === workspaceId)
      .map((thread) => thread.id)
      .filter((threadId) => get().threadRuntimeById[threadId]?.connected);
  }

  function ensureWorkspaceJsonRpcRouter(get: StoreGet, set: StoreSet, workspaceId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    if (jsonRpcRouterCleanupByWorkspace.has(workspaceId)) {
      return;
    }
    const cleanup = registerWorkspaceJsonRpcRouter(workspaceId, (message) => {
      if (isWorkspaceDisposed(workspaceId)) {
        return;
      }
      if (message.kind === "request") {
        const threadId = findThreadIdForJsonRpcNotification(get, workspaceId, message.params?.threadId ?? message.params?.thread_id ?? null);
        if (!threadId) return;
        const sessionId =
          get().threadRuntimeById[threadId]?.sessionId
          ?? get().threads.find((thread) => thread.id === threadId)?.sessionId
          ?? message.params?.threadId
          ?? message.params?.thread_id
          ?? threadId;
        if (message.method === "item/tool/requestUserInput") {
          handleThreadEvent(get, set, threadId, {
            type: "ask",
            sessionId,
            requestId: String(message.id),
            question: String(message.params?.question ?? ""),
            options: Array.isArray(message.params?.options) ? message.params.options : undefined,
          });
          return;
        }
        if (message.method === "item/commandExecution/requestApproval") {
          handleThreadEvent(get, set, threadId, {
            type: "approval",
            sessionId,
            requestId: String(message.id),
            command: String(message.params?.command ?? ""),
            dangerous: message.params?.dangerous === true,
            reasonCode: message.params?.reason ?? "requires_manual_review",
          } as any);
        }
        return;
      }

      const params = message.params ?? {};
      const mappedThreadId = findThreadIdForJsonRpcNotification(
        get,
        workspaceId,
        params.threadId ?? params.thread_id ?? params.thread?.id ?? params.sessionId ?? null,
      );
      if (!mappedThreadId) return;
      const mappedSessionId =
        get().threadRuntimeById[mappedThreadId]?.sessionId
        ?? get().threads.find((thread) => thread.id === mappedThreadId)?.sessionId
        ?? params.threadId
        ?? params.thread_id
        ?? params.thread?.id
        ?? params.sessionId
        ?? mappedThreadId;

      if (JSONRPC_THREAD_EVENT_METHODS.has(message.method) && typeof params.type === "string") {
        handleThreadEvent(get, set, mappedThreadId, {
          ...(params as Record<string, unknown>),
          sessionId: typeof params.sessionId === "string" ? params.sessionId : mappedSessionId,
        } as ServerEvent);
        return;
      }

      if (message.method === "turn/started") {
        handleThreadEvent(get, set, mappedThreadId, {
          type: "session_busy",
          sessionId: mappedSessionId,
          busy: true,
          turnId: params.turn?.id,
          cause: "user_message",
        });
        return;
      }

      if (message.method === "turn/completed") {
        handleThreadEvent(get, set, mappedThreadId, {
          type: "session_busy",
          sessionId: mappedSessionId,
          busy: false,
          turnId: params.turn?.id,
          outcome:
            params.turn?.status === "interrupted"
              ? "cancelled"
              : params.turn?.status === "failed"
                ? "error"
                : "completed",
        });
        return;
      }

      if (message.method === "item/started") {
        const item = parseProjectedItem(params.item);
        if (!item) return;
        applyProjectedStarted(set, mappedThreadId, item);
        return;
      }

      if (message.method === "item/reasoning/delta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        if (!itemId) return;
        applyProjectedReasoningDeltaToThread(
          set,
          mappedThreadId,
          itemId,
          params.mode === "summary" ? "summary" : "reasoning",
          String(params.delta ?? ""),
        );
        return;
      }

      if (message.method === "item/agentMessage/delta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        if (!itemId) return;
        applyProjectedAssistantDeltaToThread(set, mappedThreadId, itemId, String(params.delta ?? ""));
        return;
      }

      if (message.method === "item/completed") {
        const item = parseProjectedItem(params.item);
        if (!item) return;
        applyProjectedCompleted(set, mappedThreadId, item);
        return;
      }
    });
    jsonRpcRouterCleanupByWorkspace.set(workspaceId, cleanup);
  }

  function markWorkspaceThreadsDisconnected(get: StoreGet, set: StoreSet, workspaceId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    const reconnectIds = new Set<string>([
      ...(jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? []),
      ...connectedThreadIdsForWorkspace(get, workspaceId),
    ]);
    if (reconnectIds.size === 0) {
      return;
    }

    jsonRpcReconnectThreadsByWorkspace.set(workspaceId, reconnectIds);
    RUNTIME.modelStreamByThread.forEach((_, threadId) => {
      if (reconnectIds.has(threadId)) {
        RUNTIME.modelStreamByThread.delete(threadId);
      }
    });
    for (const threadId of reconnectIds) {
      RUNTIME.pendingWorkspaceDefaultApplyByThread.delete(threadId);
    }

    set((s) => {
      let threadsChanged = false;
      let runtimeChanged = false;
      const nextThreads = s.threads.map((thread) => {
        if (thread.workspaceId !== workspaceId || !reconnectIds.has(thread.id)) {
          return thread;
        }
        if (thread.status !== "disconnected") {
          threadsChanged = true;
        }
        return { ...thread, status: "disconnected" as const };
      });
      const nextThreadRuntimeById = { ...s.threadRuntimeById };
      for (const threadId of reconnectIds) {
        const runtime = nextThreadRuntimeById[threadId];
        if (!runtime) continue;
        runtimeChanged = true;
        nextThreadRuntimeById[threadId] = {
          ...runtime,
          connected: false,
          busy: false,
          busySince: null,
          activeTurnId: null,
          pendingSteer: null,
        };
      }
      if (!threadsChanged && !runtimeChanged) {
        return {};
      }
      return {
        threads: nextThreads,
        threadRuntimeById: nextThreadRuntimeById,
      };
    });
    void deps.persist(get);
  }

  function reconnectWorkspaceThreads(get: StoreGet, set: StoreSet, workspaceId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    const reconnectIds = [...(jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? [])];
    if (reconnectIds.length === 0) {
      return;
    }
    for (const threadId of reconnectIds) {
      const thread = get().threads.find((entry) => entry.id === threadId && entry.workspaceId === workspaceId);
      const url = get().workspaceRuntimeById[workspaceId]?.serverUrl;
      if (!thread || !url || !thread.sessionId) {
        forgetThreadForReconnect(workspaceId, threadId);
        continue;
      }
      ensureThreadSocket(get, set, threadId, url);
    }
  }

  function ensureWorkspaceJsonRpcLifecycle(get: StoreGet, set: StoreSet, workspaceId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    if (jsonRpcLifecycleCleanupByWorkspace.has(workspaceId)) {
      return;
    }
    const cleanup = registerWorkspaceJsonRpcLifecycle(workspaceId, {
      onOpen: () => {
        reconnectWorkspaceThreads(get, set, workspaceId);
      },
      onClose: () => {
        markWorkspaceThreadsDisconnected(get, set, workspaceId);
      },
    });
    jsonRpcLifecycleCleanupByWorkspace.set(workspaceId, cleanup);
  }

  function migrateThreadIdentity(get: StoreGet, set: StoreSet, fromThreadId: string, toThreadId: string): string {
    if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) {
      return toThreadId;
    }

    const workspaceId = workspaceIdForThread(get, fromThreadId) ?? workspaceIdForThread(get, toThreadId);
    rekeyThreadRuntimeMaps(fromThreadId, toThreadId);
    if (workspaceId) {
      forgetThreadForReconnect(workspaceId, fromThreadId);
      rememberThreadForReconnect(workspaceId, toThreadId);
    }
    set((s) => {
      const existingThread = s.threads.find((thread) => thread.id === fromThreadId);
      const existingRuntime = s.threadRuntimeById[fromThreadId];
      const replacementThread = s.threads.find((thread) => thread.id === toThreadId);
      const replacementRuntime = s.threadRuntimeById[toThreadId];

      const nextThreads = replacementThread
        ? s.threads
            .filter((thread) => thread.id !== fromThreadId)
            .map((thread) =>
              thread.id === toThreadId && existingThread?.legacyTranscriptId && !thread.legacyTranscriptId
                ? { ...thread, legacyTranscriptId: existingThread.legacyTranscriptId }
                : thread,
            )
        : s.threads.map((thread) =>
            thread.id === fromThreadId
              ? {
                  ...thread,
                  id: toThreadId,
                  sessionId: toThreadId,
                  draft: false,
                  legacyTranscriptId:
                    thread.legacyTranscriptId
                    ?? (thread.id !== toThreadId ? thread.id : null),
                }
              : thread,
          );

      const nextThreadRuntimeById = { ...s.threadRuntimeById };
      if (existingRuntime) {
        delete nextThreadRuntimeById[fromThreadId];
        if (!replacementRuntime) {
          nextThreadRuntimeById[toThreadId] = {
            ...existingRuntime,
            sessionId: toThreadId,
          };
        }
      }

      const nextLatestTodosByThreadId = { ...s.latestTodosByThreadId };
      if (fromThreadId in nextLatestTodosByThreadId && !(toThreadId in nextLatestTodosByThreadId)) {
        nextLatestTodosByThreadId[toThreadId] = nextLatestTodosByThreadId[fromThreadId]!;
      }
      delete nextLatestTodosByThreadId[fromThreadId];

      return {
        threads: nextThreads,
        selectedThreadId: s.selectedThreadId === fromThreadId ? toThreadId : s.selectedThreadId,
        promptModal:
          s.promptModal && s.promptModal.threadId === fromThreadId
            ? { ...s.promptModal, threadId: toThreadId }
            : s.promptModal,
        threadRuntimeById: nextThreadRuntimeById,
        latestTodosByThreadId: nextLatestTodosByThreadId,
      };
    });

    return get().threads.find((thread) => thread.sessionId === toThreadId)?.id ?? toThreadId;
  }

  function pushFeedItem(set: StoreSet, threadId: string, item: FeedItem) {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      let nextFeed = [...rt.feed, item];
      if (nextFeed.length > MAX_FEED_ITEMS) {
        nextFeed = nextFeed.slice(nextFeed.length - MAX_FEED_ITEMS);
      }
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, feed: nextFeed },
        },
      };
    });
  }

  function surfaceJsonRpcTurnSendFailure(
    set: StoreSet,
    threadId: string,
    opts?: { clientMessageId?: string },
  ) {
    if (opts?.clientMessageId) {
      clearPendingThreadSteer(threadId, opts.clientMessageId);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt || rt.pendingSteer?.clientMessageId !== opts.clientMessageId) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              pendingSteer: null,
            },
          },
        };
      });
    }

    pushFeedItem(set, threadId, {
      id: deps.makeId(),
      kind: "error",
      ts: deps.nowIso(),
      message: "Not connected. Reconnect to continue.",
      code: "internal_error",
      source: "protocol",
    });
  }

  function updateFeedItem(set: StoreSet, threadId: string, itemId: string, update: (item: FeedItem) => FeedItem) {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            feed: rt.feed.map((item) => (item.id === itemId ? update(item) : item)),
          },
        },
      };
    });
  }

  function insertFeedItemBefore(set: StoreSet, threadId: string, beforeItemId: string, item: FeedItem) {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      const beforeIndex = rt.feed.findIndex((entry) => entry.id === beforeItemId);
      if (beforeIndex < 0) {
        let nextFeed = [...rt.feed, item];
        if (nextFeed.length > MAX_FEED_ITEMS) {
          nextFeed = nextFeed.slice(nextFeed.length - MAX_FEED_ITEMS);
        }
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...rt, feed: nextFeed },
          },
        };
      }

      const nextFeed = [...rt.feed];
      nextFeed.splice(beforeIndex, 0, item);
      const trimmedFeed =
        nextFeed.length > MAX_FEED_ITEMS ? nextFeed.slice(nextFeed.length - MAX_FEED_ITEMS) : nextFeed;
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, feed: trimmedFeed },
        },
      };
    });
  }

  function trimFeed(feed: FeedItem[]): FeedItem[] {
    return feed.length > MAX_FEED_ITEMS ? feed.slice(feed.length - MAX_FEED_ITEMS) : feed;
  }

  function updateThreadFeed(
    set: StoreSet,
    threadId: string,
    updater: (feed: FeedItem[]) => FeedItem[],
    opts: {
      touchLastMessageAt?: boolean;
      todos?: ReturnType<typeof projectedTodosFromItem>;
      errorNotification?: {
        message: string;
        code: string;
        source: string;
      };
    } = {},
  ) {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      const nextFeed = trimFeed(updater(rt.feed));
      const nextThreads = opts.touchLastMessageAt
        ? s.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, lastMessageAt: deps.nowIso() }
              : thread
          )
        : s.threads;
      const nextLatestTodosByThreadId = opts.todos
        ? { ...s.latestTodosByThreadId, [threadId]: opts.todos }
        : s.latestTodosByThreadId;
      const nextNotifications = opts.errorNotification
        ? deps.pushNotification(s.notifications, {
            id: deps.makeId(),
            ts: deps.nowIso(),
            kind: "error",
            title: "Agent error",
            detail: `${opts.errorNotification.source}/${opts.errorNotification.code}: ${opts.errorNotification.message}`,
          })
        : s.notifications;

      return {
        threads: nextThreads,
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, feed: nextFeed },
        },
        latestTodosByThreadId: nextLatestTodosByThreadId,
        notifications: nextNotifications,
      };
    });
  }

  function parseProjectedItem(value: unknown): ProjectedItem | null {
    const parsed = projectedItemSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  function reconcileProjectedUserItem(
    set: StoreSet,
    threadId: string,
    item: Extract<ProjectedItem, { type: "userMessage" }>,
  ) {
    resetLiveModelStreamRuntime(threadId);
    const cmid = typeof item.clientMessageId === "string" ? item.clientMessageId : null;
    if (cmid && hasPendingThreadSteer(threadId, cmid)) {
      clearPendingThreadSteer(threadId, cmid);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt || rt.pendingSteer?.clientMessageId !== cmid) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              pendingSteer: null,
            },
          },
        };
      });
    }
    if (cmid) {
      const seen = RUNTIME.optimisticUserMessageIds.get(threadId);
      if (seen && seen.has(cmid)) return;
    }

    updateThreadFeed(
      set,
      threadId,
      (feed) => applyProjectedItemStarted(feed, item, deps.nowIso()),
      { touchLastMessageAt: true },
    );
  }

  function applyProjectedStarted(set: StoreSet, threadId: string, item: ProjectedItem) {
    if (item.type === "userMessage") {
      reconcileProjectedUserItem(set, threadId, item);
      return;
    }
    updateThreadFeed(
      set,
      threadId,
      (feed) => applyProjectedItemStarted(feed, item, deps.nowIso()),
      {
        touchLastMessageAt: item.type === "agentMessage",
        todos: projectedTodosFromItem(item),
      },
    );
  }

  function applyProjectedCompleted(set: StoreSet, threadId: string, item: ProjectedItem) {
    if (item.type === "userMessage") {
      const cmid = typeof item.clientMessageId === "string" ? item.clientMessageId : null;
      if (cmid) {
        const seen = RUNTIME.optimisticUserMessageIds.get(threadId);
        if (seen && seen.has(cmid)) return;
      }
    }

    updateThreadFeed(
      set,
      threadId,
      (feed) => applyProjectedItemCompleted(feed, item, deps.nowIso()),
      {
        touchLastMessageAt: item.type === "agentMessage",
        todos: projectedTodosFromItem(item),
        errorNotification:
          item.type === "error"
            ? { message: item.message, code: item.code, source: item.source }
            : undefined,
      },
    );
  }

  function applyProjectedReasoningDeltaToThread(
    set: StoreSet,
    threadId: string,
    itemId: string,
    mode: "reasoning" | "summary",
    delta: string,
  ) {
    updateThreadFeed(
      set,
      threadId,
      (feed) => applyProjectedReasoningDelta(feed, itemId, mode, delta, deps.nowIso()),
    );
  }

  function applyProjectedAssistantDeltaToThread(
    set: StoreSet,
    threadId: string,
    itemId: string,
    delta: string,
  ) {
    updateThreadFeed(
      set,
      threadId,
      (feed) => applyProjectedAgentMessageDelta(feed, itemId, delta, deps.nowIso()),
      { touchLastMessageAt: true },
    );
  }

  function sendThread(get: StoreGet, threadId: string, build: (sessionId: string) => ThreadOutboundMessage): boolean {
    const workspaceId = workspaceIdForThread(get, threadId);
    if (!workspaceId) {
      return false;
    }
    const beginWorkspaceRequest = (run: () => Promise<unknown>): boolean => {
      if (!ensureWorkspaceJsonRpcSocket(get, undefined, workspaceId)) {
        return false;
      }
      void run().catch(() => {
        // Surface "not connected" through the caller's existing false-path/UI state
        // instead of leaking unhandled async rejections from fire-and-forget actions.
      });
      return true;
    };
    const sessionId = get().threadRuntimeById[threadId]?.sessionId ?? threadId;
    const message = build(sessionId);
    if (message.type === "cancel") {
      return beginWorkspaceRequest(() => interruptJsonRpcTurn(get, undefined, workspaceId, sessionId));
    }
    if (message.type === "session_close") {
      forgetThreadForReconnect(workspaceId, threadId);
      return beginWorkspaceRequest(() => unsubscribeJsonRpcThread(get, undefined, workspaceId, sessionId));
    }
    if (message.type === "set_session_title") {
      return beginWorkspaceRequest(() => requestJsonRpc(get, undefined, workspaceId, "cowork/session/title/set", {
        threadId: sessionId,
        title: message.title,
      }));
    }
    if (message.type === "set_model") {
      return beginWorkspaceRequest(() => requestJsonRpc(get, undefined, workspaceId, "cowork/session/model/set", {
        threadId: sessionId,
        provider: message.provider,
        model: message.model,
      }));
    }
    if (message.type === "set_session_usage_budget") {
      return beginWorkspaceRequest(() => requestJsonRpc(get, undefined, workspaceId, "cowork/session/usageBudget/set", {
        threadId: sessionId,
        ...(message.warnAtUsd !== undefined ? { warnAtUsd: message.warnAtUsd } : {}),
        ...(message.stopAtUsd !== undefined ? { stopAtUsd: message.stopAtUsd } : {}),
      }));
    }
    if (message.type === "set_config") {
      return beginWorkspaceRequest(() => requestJsonRpc(get, undefined, workspaceId, "cowork/session/config/set", {
        threadId: sessionId,
        config: message.config,
      }));
    }
    if (message.type === "apply_session_defaults") {
      return beginWorkspaceRequest(() => requestJsonRpc(get, undefined, workspaceId, "cowork/session/defaults/apply", {
        threadId: sessionId,
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        ...(message.provider !== undefined ? { provider: message.provider } : {}),
        ...(message.model !== undefined ? { model: message.model } : {}),
        ...(message.enableMcp !== undefined ? { enableMcp: message.enableMcp } : {}),
        ...(message.config !== undefined ? { config: message.config } : {}),
      }));
    }
    if (message.type === "ask_response") {
      return respondToJsonRpcRequest(workspaceId, message.requestId, { answer: message.answer });
    }
    if (message.type === "approval_response") {
      return respondToJsonRpcRequest(workspaceId, message.requestId, {
        decision: message.approved ? "accept" : "decline",
      });
    }
    return false;
  }

  function dispatchJsonRpcTurnStart(
    get: StoreGet,
    set: StoreSet,
    workspaceId: string,
    sessionId: string,
    text: string,
    threadId: string,
    clientMessageId: string,
    attachments?: FileAttachmentInput[],
  ) {
    void startJsonRpcTurn(get, set, workspaceId, sessionId, text, clientMessageId, attachments)
      .catch(() => {
        surfaceJsonRpcTurnSendFailure(set, threadId);
      });
  }

  function dispatchJsonRpcTurnSteer(
    get: StoreGet,
    set: StoreSet,
    workspaceId: string,
    sessionId: string,
    turnId: string,
    text: string,
    threadId: string,
    clientMessageId: string,
    attachments?: FileAttachmentInput[],
  ) {
    void steerJsonRpcTurn(get, set, workspaceId, sessionId, turnId, text, clientMessageId, attachments)
      .catch(() => {
        surfaceJsonRpcTurnSendFailure(set, threadId, { clientMessageId });
      });
  }

  // `true` means the reducer accepted the message locally; JSON-RPC failures
  // still surface asynchronously through the existing protocol-error path.
  function sendUserMessageToThread(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    text: string,
    busyPolicy: ThreadBusyPolicy = "reject",
    attachments?: FileAttachmentInput[],
  ): boolean {
    const trimmed = text.trim();
    const hasAttachments = attachments && attachments.length > 0;
    if (!trimmed && !hasAttachments) return false;
    const attachmentSignature = buildAttachmentSignature(attachments);
    const displayText = trimmed || buildAttachmentDisplayText(attachments);

    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return false;
    const workspaceId = thread.workspaceId;

    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId) return false;

    if (rt.busy) {
      if (busyPolicy === "queue") {
        queuePendingThreadMessage(threadId, trimmed, attachments);
        return true;
      }

      if (busyPolicy === "steer") {
        if (!rt.activeTurnId) return false;
        if (
          rt.pendingSteer?.status === "sending"
          && rt.pendingSteer.text.trim() === trimmed
          && (rt.pendingSteer.attachmentSignature ?? "") === attachmentSignature
        ) {
          return false;
        }

        const clientMessageId = deps.makeId();
        rememberPendingThreadSteer(threadId, {
          clientMessageId,
          text: trimmed,
          attachmentSignature,
          expectedTurnId: rt.activeTurnId,
          accepted: false,
        });
        set((s) => {
          const nextRt = s.threadRuntimeById[threadId];
          if (!nextRt) return {};
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [threadId]: {
                ...nextRt,
                pendingSteer: {
                  clientMessageId,
                  text: trimmed,
                  attachmentSignature,
                  status: "sending",
                },
              },
            },
          };
        });

        deps.appendThreadTranscript(threadId, "client", {
          type: "steer_message",
          sessionId: rt.sessionId,
          expectedTurnId: rt.activeTurnId,
          text: displayText,
          clientMessageId,
        });

        dispatchJsonRpcTurnSteer(get, set, workspaceId, rt.sessionId, rt.activeTurnId, trimmed, threadId, clientMessageId, attachments);
        return true;
      }

      return false;
    }

    const clientMessageId = deps.makeId();
    const optimisticSeen = RUNTIME.optimisticUserMessageIds.get(threadId) ?? new Set<string>();
    optimisticSeen.add(clientMessageId);
    RUNTIME.optimisticUserMessageIds.set(threadId, optimisticSeen);

    pushFeedItem(set, threadId, {
      id: clientMessageId,
      kind: "message",
      role: "user",
      ts: deps.nowIso(),
      text: displayText,
    });

    deps.appendThreadTranscript(threadId, "client", {
      type: "user_message",
      sessionId: rt.sessionId,
      text: displayText,
      clientMessageId,
    });

    dispatchJsonRpcTurnStart(get, set, workspaceId, rt.sessionId, trimmed, threadId, clientMessageId, attachments);
    return true;
  }

  function flushOneQueuedThreadMessage(get: StoreGet, set: StoreSet, threadId: string) {
    if (hasPendingWorkspaceDefaultApply(threadId)) {
      return false;
    }
    const next = shiftPendingThreadMessage(threadId);
    if (next === undefined) return false;
    const queuedAttachments = shiftPendingThreadAttachments(threadId);
    const accepted = sendUserMessageToThread(get, set, threadId, next, undefined, queuedAttachments);
    if (!accepted) {
      prependPendingThreadMessageWithAttachments(threadId, next, queuedAttachments);
    }
    return accepted;
  }

  function flushOneQueuedThreadMessageIfReady(get: StoreGet, set: StoreSet, threadId: string) {
    if (get().threadRuntimeById[threadId]?.busy || hasPendingWorkspaceDefaultApply(threadId)) {
      return false;
    }
    return flushOneQueuedThreadMessage(get, set, threadId);
  }

  function applyModelStreamUpdateToThreadFeed(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    stream: ThreadModelStreamRuntime,
    update: ModelStreamUpdate,
  ) {
    applyModelStreamUpdateToThreadFeedCore(stream, update, {
      makeId: deps.makeId,
      nowIso: deps.nowIso,
      pushFeedItem: (item) => {
        pushFeedItem(set, threadId, item);
      },
      updateFeedItem: (itemId, updateItem) => {
        updateFeedItem(set, threadId, itemId, updateItem);
      },
      onToolTerminal: () => {
        const thread = get().threads.find((t) => t.id === threadId);
        if (thread) {
          void get().refreshWorkspaceFiles(thread.workspaceId);
        }
      },
    });
  }

  function normalizeEventSeq(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  function snapshotMissesCurrentOptimisticUserItems(
    threadId: string,
    currentFeed: FeedItem[],
    snapshotFeed: FeedItem[],
  ): boolean {
    const optimisticIds = RUNTIME.optimisticUserMessageIds.get(threadId);
    if (!optimisticIds || optimisticIds.size === 0 || currentFeed.length === 0) {
      return false;
    }

    const snapshotFeedIds = new Set(snapshotFeed.map((item) => item.id));
    return currentFeed.some((item) =>
      item.kind === "message"
      && item.role === "user"
      && optimisticIds.has(item.id)
      && !snapshotFeedIds.has(item.id),
    );
  }

  function shouldPreserveCurrentFeed(
    threadId: string,
    runtimeBusy: boolean,
    threadLastEventSeq: number,
    currentFeed: FeedItem[],
    snapshot: any,
  ): boolean {
    if (currentFeed.length === 0) {
      return false;
    }

    const snapshotFeed = Array.isArray(snapshot.feed) ? snapshot.feed : [];
    if (snapshotMissesCurrentOptimisticUserItems(threadId, currentFeed, snapshotFeed)) {
      return true;
    }

    if (!runtimeBusy) {
      return false;
    }

    return normalizeEventSeq(snapshot.lastEventSeq) < normalizeEventSeq(threadLastEventSeq);
  }

  function applyJsonRpcThreadSnapshot(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    snapshot: any,
  ) {
    set((s) => {
      const runtime = s.threadRuntimeById[threadId];
      const thread = s.threads.find((entry) => entry.id === threadId);
      if (!runtime || !thread) {
        return {};
      }
      const preserveCurrentFeed = shouldPreserveCurrentFeed(threadId, runtime.busy, thread.lastEventSeq, runtime.feed, snapshot);
      const nextLastEventSeq = preserveCurrentFeed
        ? Math.max(normalizeEventSeq(thread.lastEventSeq), normalizeEventSeq(snapshot.lastEventSeq))
        : normalizeEventSeq(snapshot.lastEventSeq);
      const nextMessageCount = preserveCurrentFeed
        ? Math.max(thread.messageCount ?? 0, normalizeEventSeq(snapshot.messageCount))
        : normalizeEventSeq(snapshot.messageCount);
      const nextLastMessageAt = preserveCurrentFeed && typeof thread.lastMessageAt === "string" && thread.lastMessageAt > snapshot.updatedAt
        ? thread.lastMessageAt
        : snapshot.updatedAt;
      return {
        threads: s.threads.map((entry) =>
          entry.id === threadId
            ? {
                ...entry,
                title: snapshot.title,
                titleSource: deps.normalizeThreadTitleSource(snapshot.titleSource, snapshot.title),
                lastMessageAt: nextLastMessageAt,
                sessionId: snapshot.sessionId,
                messageCount: nextMessageCount,
                lastEventSeq: nextLastEventSeq,
              }
            : entry,
        ),
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...runtime,
            sessionId: snapshot.sessionId,
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
            feed: preserveCurrentFeed ? runtime.feed : snapshot.feed,
            hydrating: false,
            transcriptOnly: false,
          },
        },
      };
    });
  }

  function handleThreadEvent(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    evt: ServerEvent,
    pendingFirstMessage?: string,
    pendingFirstMessageQueued = false,
  ) {
    if (evt.type !== "server_hello") {
      const activeSessionId = get().threadRuntimeById[threadId]?.sessionId;
      if (!activeSessionId || evt.sessionId !== activeSessionId) {
        return;
      }
    }

    deps.appendThreadTranscript(threadId, "server", evt);
    set((s) => ({
      threads: s.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, lastEventSeq: Math.max(0, Math.floor((thread.lastEventSeq ?? 0) + 1)) }
          : thread,
      ),
    }));
    void deps.persist(get);
    const stream = getModelStreamRuntime(threadId);

    if (evt.type === "server_hello") {
      resetLiveModelStreamRuntime(threadId);
      const resumedBusy = evt.isResume ? Boolean(evt.busy) : false;
      const prevRt = get().threadRuntimeById[threadId];
      const draftModelSelection =
        prevRt?.draftComposerProvider != null
        && typeof prevRt.draftComposerModel === "string"
        && prevRt.draftComposerModel.trim()
          ? { provider: prevRt.draftComposerProvider, model: prevRt.draftComposerModel.trim() }
          : null;
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        const sessionKind = evt.sessionKind ?? "root";
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              connected: true,
              sessionId: evt.sessionId,
              config: evt.config,
              sessionKind,
              parentSessionId: evt.parentSessionId ?? null,
              role: evt.role ?? null,
              mode: evt.mode ?? null,
              depth: typeof evt.depth === "number" ? evt.depth : 0,
              nickname: evt.nickname ?? null,
              requestedModel: evt.requestedModel ?? null,
              effectiveModel: evt.effectiveModel ?? null,
              requestedReasoningEffort: evt.requestedReasoningEffort ?? null,
              effectiveReasoningEffort: evt.effectiveReasoningEffort ?? null,
              executionState: evt.executionState ?? null,
              lastMessagePreview: evt.lastMessagePreview ?? null,
              agents: sessionKind === "agent" ? [] : (evt.isResume ? rt.agents : []),
              busy: resumedBusy,
              busySince: resumedBusy ? rt.busySince ?? deps.nowIso() : null,
              activeTurnId: resumedBusy ? (evt.turnId ?? null) : null,
              pendingSteer: resumedBusy ? rt.pendingSteer : null,
              transcriptOnly: false,
              draftComposerProvider: null,
              draftComposerModel: null,
            },
          },
          threads: s.threads.map((t) =>
            t.id === threadId ? { ...t, status: "active", sessionId: evt.sessionId, draft: false } : t,
          ),
        };
      });
      deps.persist(get);
      if (!resumedBusy) {
        clearPendingThreadSteers(threadId);
      }

      void get().applyWorkspaceDefaultsToThread(
        threadId,
        evt.isResume ? "auto-resume" : "auto",
        draftModelSelection,
        { allowBeforeHydration: !evt.isResume },
      );
      let acceptedPendingFirstMessage = false;
      if (pendingFirstMessage && pendingFirstMessage.trim()) {
        if (resumedBusy) {
          if (!pendingFirstMessageQueued) {
            prependPendingThreadMessage(threadId, pendingFirstMessage);
          }
        } else if (hasPendingWorkspaceDefaultApply(threadId)) {
          if (!pendingFirstMessageQueued) {
            prependPendingThreadMessage(threadId, pendingFirstMessage);
          }
        } else {
          if (pendingFirstMessageQueued) {
            acceptedPendingFirstMessage = flushOneQueuedThreadMessageIfReady(get, set, threadId);
          } else {
            const firstMsgAttachments = shiftPendingThreadAttachments(threadId);
            acceptedPendingFirstMessage = sendUserMessageToThread(get, set, threadId, pendingFirstMessage, undefined, firstMsgAttachments);
          }
        }
      }

      if (!resumedBusy && !acceptedPendingFirstMessage) {
        flushOneQueuedThreadMessageIfReady(get, set, threadId);
      }
      return;
    }

    if (evt.type === "observability_status") {
      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "system",
        ts: deps.nowIso(),
        line: developerDiagnosticSystemLineFromServerEvent(evt),
      });
      return;
    }

    if (evt.type === "session_settings") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...rt, enableMcp: evt.enableMcp },
          },
        };
      });
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
      if (pendingApply && !pendingApply.inFlight) {
        void get().applyWorkspaceDefaultsToThread(
          threadId,
          pendingApply.mode,
          pendingApply.draftModelSelection,
        );
        flushOneQueuedThreadMessageIfReady(get, set, threadId);
      }
      return;
    }

    if (evt.type === "session_busy") {
      resetLiveModelStreamRuntime(threadId);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              busy: evt.busy,
              busySince: evt.busy ? rt.busySince ?? deps.nowIso() : null,
              activeTurnId: evt.busy ? (evt.turnId ?? rt.activeTurnId) : null,
              pendingSteer: evt.busy ? rt.pendingSteer : null,
            },
          },
        };
      });
      if (!evt.busy) {
        const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
        if (pendingApply && !pendingApply.inFlight) {
          void get().applyWorkspaceDefaultsToThread(
            threadId,
            pendingApply.mode,
            pendingApply.draftModelSelection,
          );
        }
      }
      if (!evt.busy) {
        clearPendingThreadSteers(threadId);
        flushOneQueuedThreadMessageIfReady(get, set, threadId);
      }
      return;
    }

    if (evt.type === "steer_accepted") {
      if (typeof evt.clientMessageId === "string") {
        markPendingThreadSteerAccepted(threadId, evt.clientMessageId);
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          const pendingSteer = rt?.pendingSteer;
          if (!rt || !pendingSteer || pendingSteer.clientMessageId !== evt.clientMessageId) return {};
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [threadId]: {
                ...rt,
                pendingSteer: {
                  ...pendingSteer,
                  status: "accepted",
                },
              },
            },
          };
        });
      }
      const activeThreadId = get().selectedThreadId;
      const composerText = get().composerText.trim();
      if (activeThreadId === threadId && composerText.length > 0 && composerText === evt.text.trim()) {
        set({ composerText: "" });
      }
      return;
    }

    if (evt.type === "config_updated") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...rt, config: evt.config },
          },
        };
      });
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
      if (pendingApply && !pendingApply.inFlight) {
        void get().applyWorkspaceDefaultsToThread(
          threadId,
          pendingApply.mode,
          pendingApply.draftModelSelection,
        );
      }
      return;
    }

    if (evt.type === "session_config") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...rt, sessionConfig: evt.config },
          },
        };
      });
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
      if (pendingApply && !pendingApply.inFlight) {
        void get().applyWorkspaceDefaultsToThread(
          threadId,
          pendingApply.mode,
          pendingApply.draftModelSelection,
        );
        flushOneQueuedThreadMessageIfReady(get, set, threadId);
      }
      return;
    }

    if (evt.type === "session_info") {
      let titleChanged = false;
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        const nextConfig = rt?.config
          ? {
              ...rt.config,
              provider: rt.config.provider ?? evt.provider,
              model: rt.config.model ?? evt.model,
            }
          : rt?.config ?? null;
        const incomingTitle = evt.title.trim();
        const incomingSource = deps.normalizeThreadTitleSource(evt.titleSource, incomingTitle || evt.title);
        const nextThreads = s.threads.map((t) => {
          if (t.id !== threadId) return t;
          const currentSource = deps.normalizeThreadTitleSource(t.titleSource, t.title);
          if (!deps.shouldAdoptServerTitle({
            currentSource,
            incomingTitle,
            incomingSource,
          })) {
            return t;
          }

          const nextTitle = incomingTitle || t.title;
          if (nextTitle === t.title && currentSource === incomingSource) {
            return t;
          }

          titleChanged = true;
          return {
            ...t,
            title: nextTitle,
            titleSource: incomingSource,
          };
        });
        return {
          threads: nextThreads,
          ...(rt
            ? {
                threadRuntimeById: {
                  ...s.threadRuntimeById,
                  [threadId]: {
                    ...rt,
                    config: nextConfig,
                    sessionKind: evt.sessionKind ?? rt.sessionKind,
                    parentSessionId: evt.parentSessionId ?? rt.parentSessionId,
                    role: evt.role ?? rt.role,
                    mode: evt.mode ?? rt.mode,
                    depth: typeof evt.depth === "number" ? evt.depth : rt.depth,
                    nickname: evt.nickname ?? rt.nickname,
                    requestedModel: evt.requestedModel ?? rt.requestedModel,
                    effectiveModel: evt.effectiveModel ?? rt.effectiveModel,
                    requestedReasoningEffort: evt.requestedReasoningEffort ?? rt.requestedReasoningEffort,
                    effectiveReasoningEffort: evt.effectiveReasoningEffort ?? rt.effectiveReasoningEffort,
                    executionState: evt.executionState ?? rt.executionState,
                    lastMessagePreview: evt.lastMessagePreview ?? rt.lastMessagePreview,
                    agents: (evt.sessionKind ?? rt.sessionKind) === "agent" ? [] : rt.agents,
                  },
                },
              }
            : {}),
        };
      });
      if (titleChanged) {
        void deps.persist(get);
      }
      return;
    }

    if (evt.type === "session_backup_state" || evt.type === "harness_context") {
      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "system",
        ts: deps.nowIso(),
        line: developerDiagnosticSystemLineFromServerEvent(evt),
      });
      return;
    }

    if (evt.type === "agent_list") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              agents: sortAgentSummaries(evt.agents),
            },
          },
        };
      });
      return;
    }

    if (evt.type === "agent_spawned" || evt.type === "agent_status") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              agents: upsertAgentSummary(rt.agents, evt.agent),
            },
          },
        };
      });
      return;
    }

    if (evt.type === "agent_wait_result") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        let nextAgents = rt.agents;
        for (const agent of evt.agents) {
          nextAgents = upsertAgentSummary(nextAgents, agent);
        }
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              agents: nextAgents,
            },
          },
        };
      });
      return;
    }

    if (evt.type === "ask") {
      const prompt: AskPrompt = { requestId: evt.requestId, question: evt.question, options: evt.options };
      set(() => ({ promptModal: { kind: "ask", threadId, prompt } }));
      return;
    }

    if (evt.type === "approval") {
      const prompt: ApprovalPrompt = {
        requestId: evt.requestId,
        command: evt.command,
        dangerous: evt.dangerous,
        reasonCode: evt.reasonCode,
      };
      set(() => ({ promptModal: { kind: "approval", threadId, prompt } }));
      return;
    }

    if (evt.type === "model_stream_chunk") {
      if (shouldIgnoreNormalizedChunkForRawBackedTurn(stream.replay, evt)) {
        return;
      }
      const mapped = mapModelStreamChunk(evt);
      if (mapped) applyModelStreamUpdateToThreadFeed(get, set, threadId, stream, mapped);
      return;
    }

    if (evt.type === "model_stream_raw") {
      const updates = replayModelStreamRawEvent(stream.replay, evt);
      for (const update of updates) {
        applyModelStreamUpdateToThreadFeed(get, set, threadId, stream, update);
      }
      return;
    }

    if (evt.type === "user_message") {
      resetLiveModelStreamRuntime(threadId);
      const cmid = typeof evt.clientMessageId === "string" ? evt.clientMessageId : null;
      if (cmid && hasPendingThreadSteer(threadId, cmid)) {
        clearPendingThreadSteer(threadId, cmid);
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          if (!rt || rt.pendingSteer?.clientMessageId !== cmid) return {};
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [threadId]: {
                ...rt,
                pendingSteer: null,
              },
            },
          };
        });
      }
      if (cmid) {
        const seen = RUNTIME.optimisticUserMessageIds.get(threadId);
        if (seen && seen.has(cmid)) return;
      }

      pushFeedItem(set, threadId, {
        id: cmid || deps.makeId(),
        kind: "message",
        role: "user",
        ts: deps.nowIso(),
        text: evt.text,
      });

      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                lastMessageAt: deps.nowIso(),
              }
            : t,
        ),
      }));
      void deps.persist(get);
      return;
    }

    if (evt.type === "assistant_message") {
      const existingFeed = get().threadRuntimeById[threadId]?.feed ?? [];
      if (shouldSkipAssistantMessageAfterStreamReplay(stream, evt.text, existingFeed)) return;

      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "message",
        role: "assistant",
        ts: deps.nowIso(),
        text: evt.text,
      });

      set((s) => ({
        threads: s.threads.map((t) => (t.id === threadId ? { ...t, lastMessageAt: deps.nowIso() } : t)),
      }));
      void deps.persist(get);
      return;
    }

    if (evt.type === "turn_usage") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              lastTurnUsage: {
                turnId: evt.turnId,
                usage: evt.usage,
              },
            },
          },
        };
      });
      return;
    }

    if (evt.type === "session_usage") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              sessionUsage: evt.usage,
            },
          },
        };
      });
      return;
    }

    if (evt.type === "budget_warning" || evt.type === "budget_exceeded") {
      set((s) => ({
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
          kind: evt.type === "budget_exceeded" ? "error" : "info",
          title: evt.type === "budget_exceeded" ? "Session hard cap exceeded" : "Session budget warning",
          detail: evt.message,
        }),
      }));
      return;
    }

    if (evt.type === "reasoning") {
      if (hasMatchingStreamedReasoningText(stream, evt.text)) {
        return;
      }

      const item: FeedItem = {
        id: deps.makeId(),
        kind: "reasoning",
        mode: evt.kind,
        ts: deps.nowIso(),
        text: evt.text,
      };
      const beforeAssistantId = reasoningInsertBeforeAssistantAfterStreamReplay(stream);
      if (beforeAssistantId) {
        insertFeedItemBefore(set, threadId, beforeAssistantId, item);
        return;
      }

      pushFeedItem(set, threadId, item);
      return;
    }

    if (evt.type === "todos") {
      set((s) => ({
        latestTodosByThreadId: { ...s.latestTodosByThreadId, [threadId]: evt.todos },
      }));
      pushFeedItem(set, threadId, { id: deps.makeId(), kind: "todos", ts: deps.nowIso(), todos: evt.todos });
      return;
    }

    if (evt.type === "log") {
      if (shouldSuppressRawDebugLogLine(evt.line)) {
        return;
      }
      pushFeedItem(set, threadId, { id: deps.makeId(), kind: "log", ts: deps.nowIso(), line: evt.line });
      return;
    }

    if (evt.type === "error") {
      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "error",
        ts: deps.nowIso(),
        message: evt.message,
        code: evt.code,
        source: evt.source,
      });
      set((s) => ({
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
          kind: "error",
          title: "Agent error",
          detail: `${evt.source}/${evt.code}: ${evt.message}`,
        }),
      }));
      if (evt.code === "validation_failed") {
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          if (!rt?.pendingSteer) return {};
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [threadId]: {
                ...rt,
                pendingSteer: null,
              },
            },
          };
        });
        clearPendingThreadSteers(threadId);
      }
      return;
    }

    pushFeedItem(set, threadId, {
      id: deps.makeId(),
      kind: "system",
      ts: deps.nowIso(),
      line: unhandledEventSystemLine(evt.type),
    });
  }

  function ensureThreadSocket(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    url: string,
    pendingFirstMessage?: string,
    pendingFirstMessageQueued = false,
  ) {
    const workspaceId = workspaceIdForThread(get, threadId);
    if (!workspaceId) {
      return;
    }
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    rememberThreadStoreGet(workspaceId, get);

    const existingConnect = jsonRpcThreadConnectPromises.get(threadId);
    if (existingConnect) {
      return;
    }

    ensureThreadRuntime(get, set, threadId);
    ensureWorkspaceJsonRpcRouter(get, set, workspaceId);
    ensureWorkspaceJsonRpcLifecycle(get, set, workspaceId);
    if (!ensureWorkspaceJsonRpcSocket(get, set, workspaceId)) return;

    const existingSessionId =
      get().threadRuntimeById[threadId]?.sessionId
      ?? get().threads.find((thread) => thread.id === threadId)?.sessionId
      ?? null;

    set((s) => ({
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [threadId]: { ...s.threadRuntimeById[threadId], wsUrl: url },
      },
    }));

    const connectKeys = new Set([threadId]);
    let connectPromise!: Promise<void>;
    connectPromise = (async () => {
      if (isWorkspaceDisposed(workspaceId)) {
        return;
      }
      let activeThreadId = threadId;
      try {
        const result = existingSessionId
          ? await resumeJsonRpcThread(get, set, workspaceId, existingSessionId)
          : await startJsonRpcThread(get, set, workspaceId);
        if (isWorkspaceDisposed(workspaceId)) {
          return;
        }
        const thread = (result as any)?.thread;
        if (!thread) return;

        if (!existingSessionId && activeThreadId !== thread.id) {
          activeThreadId = migrateThreadIdentity(get, set, activeThreadId, thread.id);
          connectKeys.add(activeThreadId);
          jsonRpcThreadConnectPromises.set(activeThreadId, connectPromise);
        }

        rememberThreadForReconnect(workspaceId, activeThreadId);
        if (isWorkspaceDisposed(workspaceId)) {
          return;
        }
        handleThreadEvent(
          get,
          set,
          activeThreadId,
          buildSyntheticServerHelloFromJsonRpcThread(thread, existingSessionId ? { isResume: true } : undefined) as any,
          pendingFirstMessage,
          pendingFirstMessageQueued,
        );
        const runtime = get().threadRuntimeById[activeThreadId];
        handleThreadEvent(
          get,
          set,
          activeThreadId,
          {
            ...buildSyntheticSessionSettings(runtime, get().workspaces.find((workspace) => workspace.id === workspaceId)),
            sessionId: thread.id,
          } as any,
        );
        handleThreadEvent(
          get,
          set,
          activeThreadId,
          { ...buildSyntheticSessionInfoFromJsonRpcThread(thread), sessionId: thread.id } as any,
        );
        const snapshot = await requestJsonRpcThreadRead(get, set, workspaceId, thread.id);
        if (isWorkspaceDisposed(workspaceId)) {
          return;
        }
        if (snapshot) {
          applyJsonRpcThreadSnapshot(get, set, activeThreadId, snapshot);
        }
      } catch {
        if (isWorkspaceDisposed(workspaceId)) {
          return;
        }
        forgetThreadForReconnect(workspaceId, activeThreadId);
        set((s) => {
          const runtime = s.threadRuntimeById[activeThreadId];
          if (!runtime) {
            return {};
          }
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [activeThreadId]: {
                ...runtime,
                connected: false,
                busy: false,
                busySince: null,
                activeTurnId: null,
                pendingSteer: null,
              },
            },
            threads: s.threads.map((thread) =>
              thread.id === activeThreadId ? { ...thread, status: "disconnected" } : thread,
            ),
          };
        });
      }
    })().finally(() => {
      for (const connectKey of connectKeys) {
        if (jsonRpcThreadConnectPromises.get(connectKey) === connectPromise) {
          jsonRpcThreadConnectPromises.delete(connectKey);
        }
      }
    });

    jsonRpcThreadConnectPromises.set(threadId, connectPromise);
  }

  function disposeWorkspaceThreadEventState(workspaceId: string, getOverride?: StoreGet) {
    disposedWorkspaces.add(workspaceId);
    const routerCleanup = jsonRpcRouterCleanupByWorkspace.get(workspaceId);
    routerCleanup?.();
    jsonRpcRouterCleanupByWorkspace.delete(workspaceId);
    const lifecycleCleanup = jsonRpcLifecycleCleanupByWorkspace.get(workspaceId);
    lifecycleCleanup?.();
    jsonRpcLifecycleCleanupByWorkspace.delete(workspaceId);
    for (const threadId of trackedThreadIdsForWorkspace(workspaceId, getOverride)) {
      jsonRpcThreadConnectPromises.delete(threadId);
      resetLiveModelStreamRuntime(threadId);
    }
    jsonRpcReconnectThreadsByWorkspace.delete(workspaceId);
    threadStoreGettersByWorkspace.delete(workspaceId);
  }

  function disposeAllThreadEventState() {
    for (const workspaceId of trackedWorkspaceIds()) {
      disposeWorkspaceThreadEventState(workspaceId);
    }
  }

  return {
    disposeWorkspaceThreadEventState,
    reactivateWorkspaceThreadEventState,
    disposeAllThreadEventState,
    ensureThreadSocket,
    sendThread,
    sendUserMessageToThread,
    __internal: {
      getWorkspaceStateSnapshot: (workspaceId: string) => ({
        isDisposed: isWorkspaceDisposed(workspaceId),
        hasRouterCleanup: jsonRpcRouterCleanupByWorkspace.has(workspaceId),
        hasLifecycleCleanup: jsonRpcLifecycleCleanupByWorkspace.has(workspaceId),
        reconnectThreadIds: [...(jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? [])],
      }),
      reset: (workspaceId?: string) => {
        if (workspaceId) {
          disposeWorkspaceThreadEventState(workspaceId);
          disposedWorkspaces.delete(workspaceId);
          return;
        }
        disposeAllThreadEventState();
        jsonRpcThreadConnectPromises.clear();
        threadStoreGettersByWorkspace.clear();
        disposedWorkspaces.clear();
      },
    },
  };
}
