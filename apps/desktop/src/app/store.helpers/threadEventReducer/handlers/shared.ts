import type { StoreGet, StoreSet } from "../../../store.helpers";
import type { ThreadEventReducerContext } from "../context";
import type { FeedProjectionModule } from "../feedProjection";
import type { MessagingModule } from "../messaging";

export type HandlerModuleContext = {
  ctx: ThreadEventReducerContext;
  pushFeedItem: FeedProjectionModule["pushFeedItem"];
  flushPendingContentForThread: FeedProjectionModule["flushPendingContentForThread"];
  flushOneQueuedThreadMessageIfReady: MessagingModule["flushOneQueuedThreadMessageIfReady"];
};

type HandlerDispatchArgs = {
  get: StoreGet;
  set: StoreSet;
  threadId: string;
};

export type HandlerDispatch = HandlerDispatchArgs;
