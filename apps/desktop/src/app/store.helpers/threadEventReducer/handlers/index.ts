import type { SessionEvent } from "../../../../lib/wsProtocol";
import { unhandledEventSystemLine } from "../../../store.feedMapping";
import type { StoreGet, StoreSet } from "../../../store.helpers";
import { getEffectiveThreadLastEventSeq, getModelStreamRuntime } from "../../runtimeState";
import type { ThreadEventReducerContext } from "../context";
import type { FeedProjectionModule } from "../feedProjection";
import type { MessagingModule } from "../messaging";
import type { WorkspaceStateHelpers } from "../workspaceState";
import { handleContentThreadEvent } from "./contentHandlers";
import { handleLifecycleThreadEvent } from "./lifecycleHandlers";
import type { HandlerModuleContext } from "./shared";

export function createHandlersModule(
  ctx: ThreadEventReducerContext,
  workspace: Pick<
    WorkspaceStateHelpers,
    "hasPendingWorkspaceDefaultApply" | "resetLiveModelStreamRuntime"
  >,
  feed: FeedProjectionModule,
  messaging: Pick<
    MessagingModule,
    "sendUserMessageToThread" | "flushOneQueuedThreadMessage" | "flushOneQueuedThreadMessageIfReady"
  >,
) {
  const moduleContext: HandlerModuleContext = {
    ctx,
    pushFeedItem: feed.pushFeedItem,
    insertFeedItemBefore: feed.insertFeedItemBefore,
    applyModelStreamUpdateToThreadFeed: feed.applyModelStreamUpdateToThreadFeed,
    flushPendingContentForThread: feed.flushPendingContentForThread,
    recordPendingThreadEvent: feed.recordPendingThreadEvent,
    sendUserMessageToThread: messaging.sendUserMessageToThread,
    flushOneQueuedThreadMessage: messaging.flushOneQueuedThreadMessage,
    flushOneQueuedThreadMessageIfReady: messaging.flushOneQueuedThreadMessageIfReady,
    hasPendingWorkspaceDefaultApply: workspace.hasPendingWorkspaceDefaultApply,
    resetLiveModelStreamRuntime: workspace.resetLiveModelStreamRuntime,
  };

  function handleThreadEvent(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    evt: SessionEvent,
    pendingFirstMessage?: string,
    pendingFirstMessageQueued = false,
  ) {
    if (evt.type !== "server_hello") {
      const activeSessionId = get().threadRuntimeById[threadId]?.sessionId;
      if (!activeSessionId || evt.sessionId !== activeSessionId) {
        return;
      }
    }

    ctx.deps.appendThreadTranscript(threadId, "server", evt);
    const batchedContentEvent =
      evt.type === "model_stream_chunk" || evt.type === "model_stream_raw";
    if (batchedContentEvent) {
      moduleContext.recordPendingThreadEvent(get, set, threadId);
    } else {
      moduleContext.flushPendingContentForThread(set, threadId);
      set((s) => {
        const nextLastEventSeq = getEffectiveThreadLastEventSeq(s, threadId) + 1;
        const runtime = s.threadRuntimeById[threadId];
        return {
          threads: s.threads.map((thread) =>
            thread.id === threadId ? { ...thread, lastEventSeq: nextLastEventSeq } : thread,
          ),
          ...(runtime
            ? {
                threadRuntimeById: {
                  ...s.threadRuntimeById,
                  [threadId]: { ...runtime, lastEventSeq: nextLastEventSeq },
                },
              }
            : {}),
        };
      });
      void ctx.deps.persist(get);
    }

    const dispatch = { get, set, threadId, pendingFirstMessage, pendingFirstMessageQueued };
    if (handleLifecycleThreadEvent(moduleContext, dispatch, evt)) {
      return;
    }

    const stream = getModelStreamRuntime(threadId);
    if (handleContentThreadEvent(moduleContext, dispatch, evt, stream)) {
      return;
    }

    moduleContext.pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "system",
      ts: ctx.deps.nowIso(),
      line: unhandledEventSystemLine(evt.type),
    });
  }

  return { handleThreadEvent };
}
