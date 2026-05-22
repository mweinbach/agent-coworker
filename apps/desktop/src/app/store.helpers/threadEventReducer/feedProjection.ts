import {
  applyProjectedAgentMessageDelta,
  applyProjectedItemCompleted,
  applyProjectedItemStarted,
  applyProjectedReasoningDelta,
  type ProjectedItem,
  projectedItemSchema,
  projectedTodosFromItem,
} from "../../../../../../src/shared/projectedItems";
import {
  type ProjectedUiSurface,
  recordSurfaceRevision,
  seedDockFromFeed,
} from "../../a2uiDockReducer";
import type { ModelStreamUpdate } from "../../modelStream";
import {
  applyModelStreamUpdateToThreadFeed as applyModelStreamUpdateToThreadFeedCore,
  type ThreadModelStreamRuntime,
} from "../../store.feedMapping";
import type { StoreGet, StoreSet } from "../../store.helpers";
import { createDefaultA2uiDock, type FeedItem, type SessionSnapshot } from "../../types";
import { clearPendingThreadSteer, hasPendingThreadSteer, RUNTIME } from "../runtimeState";
import { MAX_FEED_ITEMS } from "../threadEventReducerContext";
import type { ThreadEventReducerContext } from "./context";
import type { WorkspaceStateHelpers } from "./workspaceState";

export type FeedProjectionModule = ReturnType<typeof createFeedProjectionModule>;

export function createFeedProjectionModule(
  ctx: ThreadEventReducerContext,
  workspace: Pick<WorkspaceStateHelpers, "resetLiveModelStreamRuntime">,
) {
  const { deps } = ctx;
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
    if (item.type === "userMessage") {
      reconcileProjectedUserItem(set, threadId, item);
      return;
    }
    if (item.type === "uiSurface") {
      recordProjectedUiSurface(set, threadId, item);
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

  function applyProjectedCompleted(set: StoreSet, threadId: string, item: ProjectedItem) {
    if (item.type === "userMessage") {
      const cmid = typeof item.clientMessageId === "string" ? item.clientMessageId : null;
      if (cmid) {
        const seen = RUNTIME.optimisticUserMessageIds.get(threadId);
        if (seen?.has(cmid)) return;
      }
    }

    if (item.type === "uiSurface") {
      recordProjectedUiSurface(set, threadId, item);
    }

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

  function recordProjectedUiSurface(
    set: StoreSet,
    threadId: string,
    item: Extract<ProjectedItem, { type: "uiSurface" }>,
  ) {
    const ts = ctx.deps.nowIso();
    const projected: ProjectedUiSurface = {
      type: item.type,
      surfaceId: item.surfaceId,
      catalogId: item.catalogId,
      version: item.version,
      revision: item.revision,
      deleted: item.deleted,
      ...(item.theme !== undefined ? { theme: item.theme } : {}),
      ...(item.root !== undefined ? { root: item.root } : {}),
      ...(item.dataModel !== undefined ? { dataModel: item.dataModel } : {}),
      ...(item.changeKind ? { changeKind: item.changeKind } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    };
    set((s) => {
      const runtime = s.threadRuntimeById[threadId];
      if (!runtime) return {};
      const currentDock = runtime.a2uiDock ?? createDefaultA2uiDock();
      const nextDock = recordSurfaceRevision(currentDock, projected, ts);
      if (nextDock === runtime.a2uiDock) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...runtime, a2uiDock: nextDock },
        },
      };
    });
  }

  function applyProjectedReasoningDeltaToThread(
    set: StoreSet,
    threadId: string,
    itemId: string,
    mode: "reasoning" | "summary",
    delta: string,
  ) {
    updateThreadFeed(set, threadId, (feed) =>
      applyProjectedReasoningDelta(feed, itemId, mode, delta, ctx.deps.nowIso()),
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
      (feed) => applyProjectedAgentMessageDelta(feed, itemId, delta, ctx.deps.nowIso()),
      { touchLastMessageAt: true },
    );
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
        pushFeedItem(set, threadId, item);
      },
      insertFeedItemBefore: (beforeItemId, item) => {
        insertFeedItemBefore(set, threadId, beforeItemId, item);
      },
      updateFeedItem: (itemId, updateItem) => {
        updateFeedItem(set, threadId, itemId, updateItem);
      },
      onToolTerminal: () => {
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
    const optimisticIds = RUNTIME.optimisticUserMessageIds.get(threadId);
    if (!optimisticIds || optimisticIds.size === 0 || currentFeed.length === 0) {
      return false;
    }

    const hasSnapshotItemWithIdOrCmid = (cmid: string) => {
      return snapshotFeed.some((entry) => entry.id === cmid || entry.id.endsWith(`:${cmid}`));
    };

    return currentFeed.some(
      (item) =>
        item.kind === "message" &&
        item.role === "user" &&
        optimisticIds.has(item.id) &&
        !hasSnapshotItemWithIdOrCmid(item.id),
    );
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
  ) {
    set((s) => {
      const runtime = s.threadRuntimeById[threadId];
      const thread = s.threads.find((entry) => entry.id === threadId);
      if (!runtime || !thread) {
        return {};
      }
      const preserveCurrentFeed = shouldPreserveCurrentFeed(
        threadId,
        runtime.busy,
        thread.lastEventSeq,
        runtime.feed,
        snapshot,
      );
      const nextLastEventSeq = preserveCurrentFeed
        ? Math.max(normalizeEventSeq(thread.lastEventSeq), normalizeEventSeq(snapshot.lastEventSeq))
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
            a2uiDock: seedDockFromFeed(
              runtime.a2uiDock ?? createDefaultA2uiDock(),
              preserveCurrentFeed ? runtime.feed : snapshot.feed,
              ctx.deps.nowIso(),
            ),
            hydrating: false,
            transcriptOnly: false,
          },
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
  };
}
