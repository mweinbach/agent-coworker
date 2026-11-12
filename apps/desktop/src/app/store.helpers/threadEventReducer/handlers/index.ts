import type { SessionEvent } from "../../../../lib/wsProtocol";
import { unhandledEventSystemLine } from "../../../store.feedMapping";
import type { StoreGet, StoreSet } from "../../../store.helpers";
import { getEffectiveThreadLastEventSeq } from "../../runtimeState";
import type { ThreadEventReducerContext } from "../context";
import type { FeedProjectionModule } from "../feedProjection";
import type { MessagingModule } from "../messaging";
import { handleContentThreadEvent } from "./contentHandlers";
import { handleLifecycleThreadEvent } from "./lifecycleHandlers";
import type { HandlerModuleContext } from "./shared";

export function createHandlersModule(
  ctx: ThreadEventReducerContext,
  feed: FeedProjectionModule,
  messaging: Pick<MessagingModule, "flushOneQueuedThreadMessageIfReady">,
) {
  const moduleContext: HandlerModuleContext = {
    ctx,
    pushFeedItem: feed.pushFeedItem,
    flushPendingContentForThread: feed.flushPendingContentForThread,
    flushOneQueuedThreadMessageIfReady: messaging.flushOneQueuedThreadMessageIfReady,
  };

  function handleThreadEvent(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    evt: SessionEvent,
    options?: { recordEventSequence?: boolean },
  ) {
    if (evt.type !== "server_hello") {
      const activeSessionId = get().threadRuntimeById[threadId]?.sessionId;
      if (!activeSessionId || evt.sessionId !== activeSessionId) {
        return;
      }
    }

    ctx.deps.appendThreadTranscript(threadId, "server", evt);
    moduleContext.flushPendingContentForThread(set, threadId);
    // Reconstructed reconnect metadata is not another persisted server event.
    // Counting it would make the following authoritative snapshot look stale.
    if (options?.recordEventSequence !== false) {
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

    const dispatch = { get, set, threadId };
    if (handleLifecycleThreadEvent(moduleContext, dispatch, evt)) {
      return;
    }

    if (handleContentThreadEvent(moduleContext, dispatch, evt)) {
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
