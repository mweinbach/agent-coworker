import {
  applyProjectedAgentMessageDelta,
  applyProjectedItemCompleted,
  applyProjectedItemStarted,
  applyProjectedReasoningDelta,
  type ProjectedItem,
  projectedItemSchema,
  projectedTodosFromItem,
} from "../../../../../../src/shared/projectedItems";
import type { ModelStreamUpdate } from "../../modelStream";
import {
  applyModelStreamUpdateToThreadFeed as applyModelStreamUpdateToThreadFeedCore,
  type ThreadModelStreamRuntime,
} from "../../store.feedMapping";
import type { StoreGet, StoreSet } from "../../store.helpers";
import type { FeedItem, SessionSnapshot } from "../../types";
import {
  clearPendingThreadSteer,
  getEffectiveThreadLastEventSeq,
  hasPendingThreadSteer,
  RUNTIME,
} from "../runtimeState";
import { MAX_FEED_ITEMS } from "../threadEventReducerContext";
import type { ThreadEventReducerContext } from "./context";
import type { WorkspaceStateHelpers } from "./workspaceState";

export type FeedProjectionModule = ReturnType<typeof createFeedProjectionModule>;

export function composeFeedItemUpdates(
  first: (item: FeedItem) => FeedItem,
  second: (item: FeedItem) => FeedItem,
): (item: FeedItem) => FeedItem {
  return (item) => second(first(item));
}

type PendingContentOperation =
  | {
      kind: "assistant-delta";
      itemId: string;
      chunks: string[];
      ts: string;
    }
  | {
      kind: "reasoning-delta";
      itemId: string;
      mode: "reasoning" | "summary";
      chunks: string[];
      ts: string;
    }
  | {
      kind: "item-update";
      itemId: string;
      updates: Array<(item: FeedItem) => FeedItem>;
    }
  | {
      kind: "insert-content";
      item: FeedItem;
      beforeItemId: string | null;
    };

export function latestTodosFromFeed(
  feed: FeedItem[],
): Extract<FeedItem, { kind: "todos" }>["todos"] | undefined {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const item = feed[index];
    if (item?.kind === "todos") return item.todos;
  }
  return undefined;
}

type PendingThreadContent = {
  eventSequenceIncrements: number;
  operations: PendingContentOperation[];
};

type PendingStoreContent = {
  get: StoreGet | null;
  set: StoreSet;
  threads: Map<string, PendingThreadContent>;
};

export function createFeedProjectionModule(
  ctx: ThreadEventReducerContext,
  workspace: Pick<WorkspaceStateHelpers, "resetLiveModelStreamRuntime">,
) {
  /**
   * All high-frequency content paths share one queue. A frame publishes once per
   * Zustand store, even when multiple items or threads receive interleaved
   * deltas. Structural and terminal events can synchronously extract one thread
   * without disturbing pending content for other threads.
   */
  const pendingContentByStore = new Map<StoreSet, PendingStoreContent>();
  let contentFlushScheduled = false;

  function scheduleContentFlush() {
    if (contentFlushScheduled) return;
    contentFlushScheduled = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => flushPendingContent());
    } else {
      setTimeout(() => flushPendingContent(), 0);
    }
  }

  function mergeWithLastOperation(
    current: PendingContentOperation | undefined,
    next: PendingContentOperation,
  ): boolean {
    if (
      !current ||
      current.kind === "insert-content" ||
      next.kind === "insert-content" ||
      current.itemId !== next.itemId ||
      current.kind !== next.kind
    ) {
      return false;
    }
    switch (current.kind) {
      case "assistant-delta": {
        if (next.kind !== "assistant-delta") return false;
        current.chunks.push(...next.chunks);
        return true;
      }
      case "reasoning-delta": {
        if (next.kind !== "reasoning-delta") return false;
        current.chunks.push(...next.chunks);
        current.mode = next.mode;
        return true;
      }
      case "item-update": {
        if (next.kind !== "item-update") return false;
        current.updates.push(...next.updates);
        return true;
      }
      default: {
        const exhaustive: never = current;
        return exhaustive;
      }
    }
  }

  function pendingThreadContent(
    set: StoreSet,
    threadId: string,
    get: StoreGet | null = null,
  ): PendingThreadContent {
    let storeBatch = pendingContentByStore.get(set);
    if (!storeBatch) {
      storeBatch = { get, set, threads: new Map() };
      pendingContentByStore.set(set, storeBatch);
    } else if (get) {
      storeBatch.get = get;
    }
    let threadBatch = storeBatch.threads.get(threadId);
    if (!threadBatch) {
      threadBatch = { eventSequenceIncrements: 0, operations: [] };
      storeBatch.threads.set(threadId, threadBatch);
    }
    return threadBatch;
  }

  function queueContentOperation(
    set: StoreSet,
    threadId: string,
    operation: PendingContentOperation,
  ) {
    const pending = pendingThreadContent(set, threadId);
    const last = pending.operations[pending.operations.length - 1];
    if (!mergeWithLastOperation(last, operation)) {
      pending.operations.push(operation);
    }
    scheduleContentFlush();
  }

  function applyPendingContentOperations(
    initialFeed: FeedItem[],
    operations: PendingContentOperation[],
  ): FeedItem[] {
    let feed = initialFeed;
    for (const operation of operations) {
      switch (operation.kind) {
        case "assistant-delta": {
          const combined = operation.chunks.join("");
          if (combined) {
            feed = applyProjectedAgentMessageDelta(feed, operation.itemId, combined, operation.ts);
          }
          break;
        }
        case "reasoning-delta": {
          const combined = operation.chunks.join("");
          if (combined) {
            feed = applyProjectedReasoningDelta(
              feed,
              operation.itemId,
              operation.mode,
              combined,
              operation.ts,
            );
          }
          break;
        }
        case "item-update": {
          const index = feed.findIndex((item) => item.id === operation.itemId);
          const current = index >= 0 ? feed[index] : undefined;
          if (!current) break;
          let updated = current;
          for (const update of operation.updates) {
            updated = update(updated);
          }
          if (updated !== current) {
            feed = [...feed];
            feed[index] = updated;
          }
          break;
        }
        case "insert-content": {
          if (feed.some((item) => item.id === operation.item.id)) break;
          const beforeIndex = operation.beforeItemId
            ? feed.findIndex((item) => item.id === operation.beforeItemId)
            : -1;
          if (beforeIndex < 0) {
            feed = [...feed, operation.item];
          } else {
            feed = [...feed];
            feed.splice(beforeIndex, 0, operation.item);
          }
          break;
        }
        default: {
          const exhaustive: never = operation;
          return exhaustive;
        }
      }
    }
    return trimFeed(feed);
  }

  function publishPendingStoreContent(batch: PendingStoreContent) {
    batch.set((state) => {
      let nextRuntimeById = state.threadRuntimeById;
      let runtimeChanged = false;

      for (const [threadId, pending] of batch.threads) {
        const runtime = state.threadRuntimeById[threadId];
        if (!runtime) continue;
        const nextFeed =
          pending.operations.length > 0
            ? applyPendingContentOperations(runtime.feed, pending.operations)
            : runtime.feed;
        const nextLastEventSeq =
          pending.eventSequenceIncrements > 0
            ? getEffectiveThreadLastEventSeq(state, threadId) + pending.eventSequenceIncrements
            : runtime.lastEventSeq;
        if (nextFeed === runtime.feed && nextLastEventSeq === runtime.lastEventSeq) {
          continue;
        }
        if (!runtimeChanged) {
          nextRuntimeById = { ...state.threadRuntimeById };
          runtimeChanged = true;
        }
        nextRuntimeById[threadId] = {
          ...runtime,
          feed: nextFeed,
          lastEventSeq: nextLastEventSeq,
        };
      }

      return runtimeChanged ? { threadRuntimeById: nextRuntimeById } : {};
    });
    if (batch.get) {
      void ctx.deps.persist(batch.get);
    }
  }

  function flushPendingContent() {
    contentFlushScheduled = false;
    const batches = [...pendingContentByStore.values()];
    pendingContentByStore.clear();
    for (const batch of batches) {
      publishPendingStoreContent(batch);
    }
  }

  /** Ensure content is committed before a structural or terminal mutation. */
  function flushPendingContentForThread(set: StoreSet, threadId: string) {
    const storeBatch = pendingContentByStore.get(set);
    const threadBatch = storeBatch?.threads.get(threadId);
    if (!storeBatch || !threadBatch) return;
    storeBatch.threads.delete(threadId);
    if (storeBatch.threads.size === 0) {
      pendingContentByStore.delete(set);
    }
    if (pendingContentByStore.size === 0) {
      contentFlushScheduled = false;
    }
    publishPendingStoreContent({
      get: storeBatch.get,
      set,
      threads: new Map([[threadId, threadBatch]]),
    });
  }

  function recordPendingThreadEvent(get: StoreGet, set: StoreSet, threadId: string) {
    const pending = pendingThreadContent(set, threadId, get);
    pending.eventSequenceIncrements += 1;
    scheduleContentFlush();
  }

  function pushFeedItem(set: StoreSet, threadId: string, item: FeedItem) {
    flushPendingContentForThread(set, threadId);
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

  function updateFeedItem(
    set: StoreSet,
    threadId: string,
    itemId: string,
    update: (item: FeedItem) => FeedItem,
  ) {
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

  function insertFeedItemBefore(
    set: StoreSet,
    threadId: string,
    beforeItemId: string,
    item: FeedItem,
  ) {
    flushPendingContentForThread(set, threadId);
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
        nextFeed.length > MAX_FEED_ITEMS
          ? nextFeed.slice(nextFeed.length - MAX_FEED_ITEMS)
          : nextFeed;
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
            thread.id === threadId ? { ...thread, lastMessageAt: ctx.deps.nowIso() } : thread,
          )
        : s.threads;
      const nextLatestTodosByThreadId = opts.todos
        ? { ...s.latestTodosByThreadId, [threadId]: opts.todos }
        : s.latestTodosByThreadId;
      const nextNotifications = opts.errorNotification
        ? ctx.deps.pushNotification(s.notifications, {
            id: ctx.deps.makeId(),
            ts: ctx.deps.nowIso(),
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
    workspace.resetLiveModelStreamRuntime(threadId);
    const cmid = typeof item.clientMessageId === "string" ? item.clientMessageId : null;
    const trackedSteer = cmid ? RUNTIME.pendingThreadSteers.get(threadId)?.get(cmid) : undefined;
    const steerRequestMatches =
      !item.steerRequestId ||
      !trackedSteer?.steerRequestId ||
      item.steerRequestId === trackedSteer.steerRequestId;
    if (cmid && hasPendingThreadSteer(threadId, cmid) && steerRequestMatches) {
      clearPendingThreadSteer(threadId, cmid);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (
          !rt ||
          rt.pendingSteer?.clientMessageId !== cmid ||
          (item.steerRequestId &&
            rt.pendingSteer.steerRequestId &&
            item.steerRequestId !== rt.pendingSteer.steerRequestId)
        ) {
          return {};
        }
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
      if (seen?.has(cmid)) return;
    }

    updateThreadFeed(
      set,
      threadId,
      (feed) => applyProjectedItemStarted(feed, item, ctx.deps.nowIso()),
      { touchLastMessageAt: true },
    );
  }

  function applyProjectedStarted(set: StoreSet, threadId: string, item: ProjectedItem) {
    flushPendingContentForThread(set, threadId);
    if (item.type === "userMessage") {
      reconcileProjectedUserItem(set, threadId, item);
      return;
    }
    updateThreadFeed(
      set,
      threadId,
      (feed) => applyProjectedItemStarted(feed, item, ctx.deps.nowIso()),
      {
        touchLastMessageAt: item.type === "agentMessage",
        todos: projectedTodosFromItem(item),
      },
    );
  }

  function applyProjectedCompleted(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    item: ProjectedItem,
  ) {
    if (item.type === "userMessage") {
      const cmid = typeof item.clientMessageId === "string" ? item.clientMessageId : null;
      if (cmid) {
        const seen = RUNTIME.optimisticUserMessageIds.get(threadId);
        if (seen?.has(cmid)) return;
      }
    }
    if (item.type === "error" && (item.steerRequestId || item.clientMessageId)) {
      const pendingSteer = get().threadRuntimeById[threadId]?.pendingSteer;
      const matchesSteerRequest =
        Boolean(item.steerRequestId) && item.steerRequestId === pendingSteer?.steerRequestId;
      const matchesClientMessage =
        Boolean(item.clientMessageId) && item.clientMessageId === pendingSteer?.clientMessageId;
      if (pendingSteer && (matchesSteerRequest || matchesClientMessage)) {
        if (pendingSteer.submissionId) {
          get().failComposerSubmission(pendingSteer.submissionId, new Error(item.message));
        }
        clearPendingThreadSteer(threadId, pendingSteer.clientMessageId);
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          if (!rt || rt.pendingSteer?.clientMessageId !== pendingSteer.clientMessageId) return {};
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
    }

    // Flush coalesced token deltas before applying the final projected item so
    // a late rAF cannot append after the completed snapshot replaces text, and so
    // non-message completions keep feed ordering stable relative to prior deltas.
    flushPendingContentForThread(set, threadId);

    updateThreadFeed(
      set,
      threadId,
      (feed) => applyProjectedItemCompleted(feed, item, ctx.deps.nowIso()),
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
    queueContentOperation(set, threadId, {
      kind: "reasoning-delta",
      itemId,
      mode,
      chunks: [delta],
      ts: ctx.deps.nowIso(),
    });
  }

  function applyProjectedAssistantDeltaToThread(
    set: StoreSet,
    threadId: string,
    itemId: string,
    delta: string,
  ) {
    // Do not touch threads[].lastMessageAt on intermediate token deltas —
    // that forces sidebar re-renders at stream rate. Started/completed still update.
    // Coalesce all content kinds and threads into one store write per frame.
    queueContentOperation(set, threadId, {
      kind: "assistant-delta",
      itemId,
      chunks: [delta],
      ts: ctx.deps.nowIso(),
    });
  }

  function applyModelStreamUpdateToThreadFeed(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    stream: ThreadModelStreamRuntime,
    update: ModelStreamUpdate,
  ) {
    applyModelStreamUpdateToThreadFeedCore(stream, update, {
      makeId: ctx.deps.makeId,
      nowIso: ctx.deps.nowIso,
      pushFeedItem: (item) => {
        if (item.kind === "reasoning" || (item.kind === "message" && item.role === "assistant")) {
          queueContentOperation(set, threadId, {
            kind: "insert-content",
            item,
            beforeItemId: null,
          });
          return;
        }
        flushPendingContentForThread(set, threadId);
        pushFeedItem(set, threadId, item);
      },
      insertFeedItemBefore: (beforeItemId, item) => {
        if (item.kind === "reasoning") {
          queueContentOperation(set, threadId, {
            kind: "insert-content",
            item,
            beforeItemId,
          });
          return;
        }
        flushPendingContentForThread(set, threadId);
        insertFeedItemBefore(set, threadId, beforeItemId, item);
      },
      updateFeedItem: (itemId, updateItem) => {
        queueContentOperation(set, threadId, {
          kind: "item-update",
          itemId,
          updates: [updateItem],
        });
      },
      flushPendingContent: () => {
        flushPendingContentForThread(set, threadId);
      },
      onToolTerminal: () => {
        flushPendingContentForThread(set, threadId);
        const thread = get().threads.find((t) => t.id === threadId);
        if (thread) {
          set((state) => ({
            workspaceExplorerRefreshById: {
              ...state.workspaceExplorerRefreshById,
              [thread.workspaceId]:
                (state.workspaceExplorerRefreshById[thread.workspaceId] ?? 0) + 1,
            },
          }));
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
    return getMissingOptimisticUserItems(threadId, currentFeed, snapshotFeed).length > 0;
  }

  function getMissingOptimisticUserItems(
    threadId: string,
    currentFeed: FeedItem[],
    snapshotFeed: FeedItem[],
  ): FeedItem[] {
    const optimisticIds = RUNTIME.optimisticUserMessageIds.get(threadId);
    if (!optimisticIds || optimisticIds.size === 0 || currentFeed.length === 0) {
      return [];
    }

    const hasSnapshotItemWithIdOrCmid = (cmid: string) => {
      return snapshotFeed.some((entry) => entry.id === cmid || entry.id.endsWith(`:${cmid}`));
    };

    return currentFeed.filter(
      (item) =>
        item.kind === "message" &&
        item.role === "user" &&
        optimisticIds.has(item.id) &&
        !hasSnapshotItemWithIdOrCmid(item.id),
    );
  }

  function mergeSnapshotFeedWithMissingOptimisticUserItems(
    threadId: string,
    currentFeed: FeedItem[],
    snapshotFeed: FeedItem[],
  ): FeedItem[] {
    const missingOptimisticItems = getMissingOptimisticUserItems(
      threadId,
      currentFeed,
      snapshotFeed,
    );
    if (missingOptimisticItems.length === 0) {
      return snapshotFeed;
    }
    const nextFeed = [...snapshotFeed, ...missingOptimisticItems];
    return nextFeed.length > MAX_FEED_ITEMS
      ? nextFeed.slice(nextFeed.length - MAX_FEED_ITEMS)
      : nextFeed;
  }

  function shouldPreserveCurrentFeed(
    threadId: string,
    runtimeBusy: boolean,
    threadLastEventSeq: number,
    currentFeed: FeedItem[],
    snapshot: { feed?: unknown; lastEventSeq?: unknown },
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
    _get: StoreGet,
    set: StoreSet,
    threadId: string,
    snapshot: SessionSnapshot,
    opts?: { forceFeed?: boolean },
  ) {
    flushPendingContentForThread(set, threadId);
    set((s) => {
      const runtime = s.threadRuntimeById[threadId];
      const thread = s.threads.find((entry) => entry.id === threadId);
      if (!runtime || !thread) {
        return {};
      }
      const currentLastEventSeq = getEffectiveThreadLastEventSeq(s, threadId);
      const preserveCurrentFeed =
        opts?.forceFeed === true
          ? false
          : shouldPreserveCurrentFeed(
              threadId,
              runtime.busy,
              currentLastEventSeq,
              runtime.feed,
              snapshot,
            );
      const nextLastEventSeq = preserveCurrentFeed
        ? Math.max(currentLastEventSeq, normalizeEventSeq(snapshot.lastEventSeq))
        : normalizeEventSeq(snapshot.lastEventSeq);
      const nextMessageCount = preserveCurrentFeed
        ? Math.max(thread.messageCount ?? 0, normalizeEventSeq(snapshot.messageCount))
        : normalizeEventSeq(snapshot.messageCount);
      const nextLastMessageAt =
        preserveCurrentFeed &&
        typeof thread.lastMessageAt === "string" &&
        thread.lastMessageAt > snapshot.updatedAt
          ? thread.lastMessageAt
          : snapshot.updatedAt;
      const nextFeed = preserveCurrentFeed
        ? runtime.feed
        : opts?.forceFeed === true
          ? mergeSnapshotFeedWithMissingOptimisticUserItems(threadId, runtime.feed, snapshot.feed)
          : snapshot.feed;
      const restoredTodos = latestTodosFromFeed(nextFeed) ?? snapshot.todos;
      return {
        threads: s.threads.map((entry) =>
          entry.id === threadId
            ? {
                ...entry,
                title: snapshot.title,
                titleSource: ctx.deps.normalizeThreadTitleSource(
                  snapshot.titleSource,
                  snapshot.title,
                ),
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
            lastEventSeq: nextLastEventSeq,
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
            feed: nextFeed,
            hydrating: false,
            transcriptOnly: false,
          },
        },
        latestTodosByThreadId: {
          ...s.latestTodosByThreadId,
          [threadId]: restoredTodos,
        },
      };
    });
  }

  return {
    pushFeedItem,
    updateFeedItem,
    insertFeedItemBefore,
    parseProjectedItem,
    applyProjectedStarted,
    applyProjectedCompleted,
    applyProjectedReasoningDeltaToThread,
    applyProjectedAssistantDeltaToThread,
    applyModelStreamUpdateToThreadFeed,
    applyJsonRpcThreadSnapshot,
    flushPendingContentForThread,
    recordPendingThreadEvent,
  };
}
