import type { SessionEvent } from "../../../../lib/wsProtocol";
import { unhandledEventSystemLine } from "../../../store.feedMapping";
import type { StoreGet, StoreSet } from "../../../store.helpers";
import { getModelStreamRuntime } from "../../runtimeState";
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
    set((s) => ({
      threads: s.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, lastEventSeq: Math.max(0, Math.floor((thread.lastEventSeq ?? 0) + 1)) }
          : thread,
      ),
    }));
    void ctx.deps.persist(get);

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
