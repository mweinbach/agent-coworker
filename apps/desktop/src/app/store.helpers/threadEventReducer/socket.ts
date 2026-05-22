import type { SessionEvent } from "../../../lib/wsProtocol";
import type { StoreGet, StoreSet } from "../../store.helpers";
import {
  buildSyntheticServerHelloFromJsonRpcThread,
  buildSyntheticSessionInfoFromJsonRpcThread,
  buildSyntheticSessionSettings,
  ensureWorkspaceJsonRpcSocket,
  type FileAttachmentInput,
  requestJsonRpcThreadRead,
  resumeJsonRpcThread,
  startJsonRpcThread,
} from "../jsonRpcSocket";
import { ensureThreadRuntime } from "../runtimeState";
import type { JsonRpcThreadStart } from "../threadEventReducerContext";
import type { ThreadEventReducerContext } from "./context";
import type { FeedProjectionModule } from "./feedProjection";
import type { JsonRpcWorkspaceModule } from "./jsonRpcWorkspace";
import type { MessagingModule } from "./messaging";
import type { WorkspaceStateHelpers } from "./workspaceState";

export function createSocketModule(
  ctx: ThreadEventReducerContext,
  workspace: Pick<
    WorkspaceStateHelpers,
    | "isWorkspaceDisposed"
    | "rememberThreadStoreGet"
    | "rememberThreadForReconnect"
    | "forgetThreadForReconnect"
    | "workspaceIdForThread"
  >,
  jsonRpc: Pick<
    JsonRpcWorkspaceModule,
    "ensureWorkspaceJsonRpcRouter" | "ensureWorkspaceJsonRpcLifecycle" | "migrateThreadIdentity"
  >,
  feed: Pick<FeedProjectionModule, "applyJsonRpcThreadSnapshot">,
  messaging: Pick<MessagingModule, "surfaceJsonRpcThreadStartFailure">,
  handlers: {
    handleThreadEvent: (
      get: StoreGet,
      set: StoreSet,
      threadId: string,
      evt: SessionEvent,
      pendingFirstMessage?: string,
      pendingFirstMessageQueued?: boolean,
    ) => void;
  },
) {
  const { jsonRpcThreadConnectPromises } = ctx;
  const {
    isWorkspaceDisposed,
    rememberThreadStoreGet,
    rememberThreadForReconnect,
    forgetThreadForReconnect,
    workspaceIdForThread,
  } = workspace;
  const { ensureWorkspaceJsonRpcRouter, ensureWorkspaceJsonRpcLifecycle, migrateThreadIdentity } =
    jsonRpc;
  const { applyJsonRpcThreadSnapshot } = feed;
  const { surfaceJsonRpcThreadStartFailure } = messaging;
  const { handleThreadEvent } = handlers;
  function ensureThreadSocket(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    url: string,
    pendingFirstMessage?: string,
    pendingFirstMessageQueued = false,
    pendingFirstMessageAttachments?: FileAttachmentInput[],
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
      get().threadRuntimeById[threadId]?.sessionId ??
      get().threads.find((thread) => thread.id === threadId)?.sessionId ??
      null;

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
        const thread = (result as { thread?: JsonRpcThreadStart } | null)?.thread;
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
          buildSyntheticServerHelloFromJsonRpcThread(
            thread,
            existingSessionId ? { isResume: true } : undefined,
          ) as SessionEvent,
          pendingFirstMessage,
          pendingFirstMessageQueued,
        );
        const runtime = get().threadRuntimeById[activeThreadId];
        handleThreadEvent(get, set, activeThreadId, {
          ...buildSyntheticSessionSettings(
            runtime,
            get().workspaces.find((workspace) => workspace.id === workspaceId),
          ),
          sessionId: thread.id,
        } as SessionEvent);
        handleThreadEvent(get, set, activeThreadId, {
          ...buildSyntheticSessionInfoFromJsonRpcThread(thread),
          sessionId: thread.id,
        } as SessionEvent);
        const snapshot = await requestJsonRpcThreadRead(get, set, workspaceId, thread.id);
        if (isWorkspaceDisposed(workspaceId)) {
          return;
        }
        if (snapshot) {
          applyJsonRpcThreadSnapshot(get, set, activeThreadId, snapshot);
        }
      } catch (error) {
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
        surfaceJsonRpcThreadStartFailure(
          set,
          activeThreadId,
          pendingFirstMessage,
          pendingFirstMessageAttachments,
          error,
        );
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

  return { ensureThreadSocket };
}
