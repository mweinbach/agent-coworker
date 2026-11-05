import type { StoreGet } from "../../store.helpers";
import type { ThreadEventReducerDeps } from "../threadEventReducerContext";
import { createThreadEventReducerContext } from "./context";
import { createFeedProjectionModule } from "./feedProjection";
import { createHandlersModule } from "./handlers";
import { createJsonRpcWorkspaceModule } from "./jsonRpcWorkspace";
import { createMessagingModule } from "./messaging";
import { createSocketModule } from "./socket";
import { createWorkspaceStateHelpers } from "./workspaceState";

export function createThreadEventReducer(deps: ThreadEventReducerDeps) {
  const ctx = createThreadEventReducerContext(deps);
  const workspace = createWorkspaceStateHelpers(ctx);

  const feed = createFeedProjectionModule(ctx);
  const messaging = createMessagingModule(ctx, workspace, feed);

  const forwardRefs = {
    handleThreadEvent: null as ReturnType<typeof createHandlersModule>["handleThreadEvent"] | null,
    ensureThreadSocket: null as ReturnType<typeof createSocketModule>["ensureThreadSocket"] | null,
  };
  const handleThreadEventForward: ReturnType<typeof createHandlersModule>["handleThreadEvent"] = (
    ...args
  ) => {
    if (!forwardRefs.handleThreadEvent) {
      throw new Error("Thread event handler is not initialized.");
    }
    return forwardRefs.handleThreadEvent(...args);
  };
  const ensureThreadSocketForward: ReturnType<typeof createSocketModule>["ensureThreadSocket"] = (
    ...args
  ) => {
    if (!forwardRefs.ensureThreadSocket) {
      throw new Error("Thread socket manager is not initialized.");
    }
    return forwardRefs.ensureThreadSocket(...args);
  };

  const jsonRpc = createJsonRpcWorkspaceModule(
    ctx,
    workspace,
    feed,
    {
      handleThreadEvent: handleThreadEventForward,
    },
    {
      ensureThreadSocket: ensureThreadSocketForward,
    },
  );

  const handlers = createHandlersModule(ctx, feed, messaging);
  forwardRefs.handleThreadEvent = handlers.handleThreadEvent;

  const socket = createSocketModule(ctx, workspace, jsonRpc, feed, messaging, handlers);
  forwardRefs.ensureThreadSocket = socket.ensureThreadSocket;

  const {
    disposeWorkspaceThreadEventState: disposeWorkspaceThreadEventStateInternal,
    disposeAllThreadEventState: disposeAllThreadEventStateInternal,
    reactivateWorkspaceThreadEventState,
    isWorkspaceDisposed,
  } = workspace;

  function disposeWorkspaceThreadEventState(workspaceId: string, getOverride?: StoreGet) {
    disposeWorkspaceThreadEventStateInternal(
      workspaceId,
      getOverride,
      feed.discardPendingContentForThread,
    );
  }

  function disposeAllThreadEventState() {
    disposeAllThreadEventStateInternal(feed.discardPendingContentForThread);
    feed.discardAllPendingContent();
  }

  return {
    disposeWorkspaceThreadEventState,
    reactivateWorkspaceThreadEventState,
    disposeAllThreadEventState,
    ensureThreadSocket: socket.ensureThreadSocket,
    markWorkspaceThreadsDisconnected: jsonRpc.markWorkspaceThreadsDisconnected,
    sendThread: messaging.sendThread,
    sendUserMessageToThread: messaging.sendUserMessageToThread,
    flushOneQueuedThreadMessageIfReady: messaging.flushOneQueuedThreadMessageIfReady,
    __internal: {
      getWorkspaceStateSnapshot: (workspaceId: string) => ({
        isDisposed: isWorkspaceDisposed(workspaceId),
        hasRouterCleanup: ctx.jsonRpcRouterCleanupByWorkspace.has(workspaceId),
        hasLifecycleCleanup: ctx.jsonRpcLifecycleCleanupByWorkspace.has(workspaceId),
        reconnectThreadIds: [...(ctx.jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? [])],
      }),
      reset: (workspaceId?: string) => {
        if (workspaceId) {
          disposeWorkspaceThreadEventState(workspaceId);
          ctx.disposedWorkspaces.delete(workspaceId);
          return;
        }
        disposeAllThreadEventState();
        ctx.jsonRpcThreadConnectPromises.clear();
        ctx.threadStoreGettersByWorkspace.clear();
        ctx.disposedWorkspaces.clear();
      },
    },
  };
}
