import type { SessionEvent } from "../../../../lib/wsProtocol";
import {
  mapModelStreamChunk,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
} from "../../../modelStream";
import type { ThreadModelStreamRuntime } from "../../../store.feedMapping";
import {
  hasMatchingStreamedReasoningText,
  reasoningInsertBeforeAssistantAfterStreamReplay,
  shouldSkipAssistantMessageAfterStreamReplay,
  shouldSuppressRawDebugLogLine,
} from "../../../store.feedMapping";
import type { FeedItem } from "../../../types";
import {
  clearPendingThreadSteer,
  clearPendingThreadSteers,
  hasPendingThreadSteer,
  RUNTIME,
} from "../../runtimeState";
import type { HandlerDispatch, HandlerModuleContext } from "./shared";

export function handleContentThreadEvent(
  module: HandlerModuleContext,
  dispatch: HandlerDispatch,
  evt: SessionEvent,
  stream: ThreadModelStreamRuntime,
): boolean {
  const {
    ctx,
    pushFeedItem,
    insertFeedItemBefore,
    applyModelStreamUpdateToThreadFeed,
    resetLiveModelStreamRuntime,
  } = module;
  const { get, set, threadId } = dispatch;
  const { deps } = ctx;

  if (evt.type === "model_stream_chunk") {
    if (shouldIgnoreNormalizedChunkForRawBackedTurn(stream.replay, evt)) {
      return true;
    }
    const mapped = mapModelStreamChunk(evt);
    if (mapped) applyModelStreamUpdateToThreadFeed(get, set, threadId, stream, mapped);
    return true;
  }

  if (evt.type === "model_stream_raw") {
    const updates = replayModelStreamRawEvent(stream.replay, evt);
    for (const update of updates) {
      applyModelStreamUpdateToThreadFeed(get, set, threadId, stream, update);
    }
    return true;
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
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt?.pendingTurnStart) return {};
      if (cmid && rt.pendingTurnStart.clientMessageId !== cmid) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            pendingTurnStart: null,
          },
        },
      };
    });
    if (cmid) {
      const seen = RUNTIME.optimisticUserMessageIds.get(threadId);
      if (seen?.has(cmid)) return true;
    }

    pushFeedItem(set, threadId, {
      id: cmid || ctx.deps.makeId(),
      kind: "message",
      role: "user",
      ts: ctx.deps.nowIso(),
      text: evt.text,
    });

    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              lastMessageAt: ctx.deps.nowIso(),
            }
          : t,
      ),
    }));
    void ctx.deps.persist(get);
    return true;
  }

  if (evt.type === "assistant_message") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt?.pendingTurnStart) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            pendingTurnStart: null,
          },
        },
      };
    });
    const existingFeed = get().threadRuntimeById[threadId]?.feed ?? [];
    if (shouldSkipAssistantMessageAfterStreamReplay(stream, evt.text, existingFeed)) return true;

    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "message",
      role: "assistant",
      ts: ctx.deps.nowIso(),
      text: evt.text,
    });

    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, lastMessageAt: ctx.deps.nowIso() } : t,
      ),
    }));
    void ctx.deps.persist(get);
    return true;
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
    return true;
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
    return true;
  }

  if (evt.type === "budget_warning" || evt.type === "budget_exceeded") {
    set((s) => ({
      notifications: ctx.deps.pushNotification(s.notifications, {
        id: ctx.deps.makeId(),
        ts: ctx.deps.nowIso(),
        kind: evt.type === "budget_exceeded" ? "error" : "info",
        title:
          evt.type === "budget_exceeded" ? "Session hard cap exceeded" : "Session budget warning",
        detail: evt.message,
      }),
    }));
    return true;
  }

  if (evt.type === "reasoning") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt?.pendingTurnStart) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            pendingTurnStart: null,
          },
        },
      };
    });
    if (hasMatchingStreamedReasoningText(stream, evt.text)) {
      return true;
    }

    const item: FeedItem = {
      id: ctx.deps.makeId(),
      kind: "reasoning",
      mode: evt.kind,
      ts: ctx.deps.nowIso(),
      text: evt.text,
    };
    const beforeAssistantId = reasoningInsertBeforeAssistantAfterStreamReplay(stream);
    if (beforeAssistantId) {
      insertFeedItemBefore(set, threadId, beforeAssistantId, item);
      return true;
    }

    pushFeedItem(set, threadId, item);
    return true;
  }

  if (evt.type === "todos") {
    set((s) => ({
      latestTodosByThreadId: { ...s.latestTodosByThreadId, [threadId]: evt.todos },
    }));
    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "todos",
      ts: ctx.deps.nowIso(),
      todos: evt.todos,
    });
    return true;
  }

  if (evt.type === "log") {
    if (shouldSuppressRawDebugLogLine(evt.line)) {
      return true;
    }
    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "log",
      ts: ctx.deps.nowIso(),
      line: evt.line,
    });
    return true;
  }

  if (evt.type === "error") {
    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "error",
      ts: ctx.deps.nowIso(),
      message: evt.message,
      code: evt.code,
      source: evt.source,
    });
    set((s) => ({
      notifications: ctx.deps.pushNotification(s.notifications, {
        id: ctx.deps.makeId(),
        ts: ctx.deps.nowIso(),
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
    return true;
  }

  return false;
}
