import type { StoreGet, StoreSet } from "../../../store.helpers";
import type { ThreadEventReducerContext } from "../context";
import type { FeedProjectionModule } from "../feedProjection";
import type { MessagingModule } from "../messaging";
import type { WorkspaceStateHelpers } from "../workspaceState";

export type HandlerModuleContext = {
  ctx: ThreadEventReducerContext;
  pushFeedItem: FeedProjectionModule["pushFeedItem"];
  insertFeedItemBefore: FeedProjectionModule["insertFeedItemBefore"];
  applyModelStreamUpdateToThreadFeed: FeedProjectionModule["applyModelStreamUpdateToThreadFeed"];
  sendUserMessageToThread: MessagingModule["sendUserMessageToThread"];
  flushOneQueuedThreadMessage: MessagingModule["flushOneQueuedThreadMessage"];
  flushOneQueuedThreadMessageIfReady: MessagingModule["flushOneQueuedThreadMessageIfReady"];
  hasPendingWorkspaceDefaultApply: WorkspaceStateHelpers["hasPendingWorkspaceDefaultApply"];
  resetLiveModelStreamRuntime: WorkspaceStateHelpers["resetLiveModelStreamRuntime"];
};

export type HandlerDispatchArgs = {
  get: StoreGet;
  set: StoreSet;
  threadId: string;
  pendingFirstMessage?: string;
  pendingFirstMessageQueued?: boolean;
};

export type HandlerDispatch = HandlerDispatchArgs;
