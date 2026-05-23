import type { SessionEvent } from "../../../lib/wsProtocol";
import type { StoreGet, StoreSet } from "../../store.helpers";
import {
  findThreadIdForJsonRpcNotification,
  registerWorkspaceJsonRpcLifecycle,
  registerWorkspaceJsonRpcRouter,
} from "../jsonRpcSocket";
import { RUNTIME, rekeyThreadRuntimeMaps } from "../runtimeState";
import {
  JSONRPC_THREAD_EVENT_METHODS,
  type JsonRpcMessageParams,
} from "../threadEventReducerContext";
import type { ThreadEventReducerContext } from "./context";
import type { FeedProjectionModule } from "./feedProjection";
import type { WorkspaceStateHelpers } from "./workspaceState";

export type JsonRpcWorkspaceModule = ReturnType<typeof createJsonRpcWorkspaceModule>;

export function createJsonRpcWorkspaceModule(
  ctx: ThreadEventReducerContext,
  workspace: WorkspaceStateHelpers,
  feed: Pick<
    FeedProjectionModule,
    | "parseProjectedItem"
    | "applyProjectedStarted"
    | "applyProjectedCompleted"
    | "applyProjectedReasoningDeltaToThread"
    | "applyProjectedAssistantDeltaToThread"
  >,
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
  socket: {
    ensureThreadSocket: (
      get: StoreGet,
      set: StoreSet,
      threadId: string,
      url: string,
      pendingFirstMessage?: string,
      pendingFirstMessageQueued?: boolean,
      pendingFirstMessageAttachments?: import("../jsonRpcSocket").FileAttachmentInput[],
    ) => void;
  },
) {
  const {
    isWorkspaceDisposed,
    forgetThreadForReconnect,
    rememberThreadForReconnect,
    connectedThreadIdsForWorkspace,
    workspaceIdForThread,
  } = workspace;
  const {
    parseProjectedItem,
    applyProjectedStarted,
    applyProjectedCompleted,
    applyProjectedReasoningDeltaToThread,
    applyProjectedAssistantDeltaToThread,
  } = feed;
  const { handleThreadEvent } = handlers;
  const { ensureThreadSocket } = socket;
  const {
    jsonRpcRouterCleanupByWorkspace,
    jsonRpcLifecycleCleanupByWorkspace,
    jsonRpcReconnectThreadsByWorkspace,
  } = ctx;
  function ensureWorkspaceJsonRpcRouter(get: StoreGet, set: StoreSet, workspaceId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    if (jsonRpcRouterCleanupByWorkspace.has(workspaceId)) {
      return;
    }
    const cleanup = registerWorkspaceJsonRpcRouter(workspaceId, (message) => {
      if (isWorkspaceDisposed(workspaceId)) {
        return;
      }
      if (message.kind === "request") {
        const requestParams = (message.params ?? {}) as JsonRpcMessageParams;
        const threadId = findThreadIdForJsonRpcNotification(
          get,
          workspaceId,
          requestParams.threadId ?? requestParams.thread_id ?? null,
        );
        if (!threadId) return;
        const sessionId =
          get().threadRuntimeById[threadId]?.sessionId ??
          get().threads.find((thread) => thread.id === threadId)?.sessionId ??
          requestParams.threadId ??
          requestParams.thread_id ??
          threadId;
        if (message.method === "item/tool/requestUserInput") {
          handleThreadEvent(get, set, threadId, {
            type: "ask",
            sessionId,
            requestId: String(message.id),
            question: String(requestParams.question ?? ""),
            options: Array.isArray(requestParams.options)
              ? requestParams.options.filter((entry): entry is string => typeof entry === "string")
              : undefined,
          });
          return;
        }
        if (message.method === "item/commandExecution/requestApproval") {
          handleThreadEvent(get, set, threadId, {
            type: "approval",
            sessionId,
            requestId: String(message.id),
            command: String(requestParams.command ?? ""),
            dangerous: requestParams.dangerous === true,
            reasonCode: requestParams.reason ?? "requires_manual_review",
          } as SessionEvent);
        }
        return;
      }

      const params = (message.params ?? {}) as JsonRpcMessageParams;
      const mappedThreadId = findThreadIdForJsonRpcNotification(
        get,
        workspaceId,
        params.threadId ?? params.thread_id ?? params.thread?.id ?? params.sessionId ?? null,
      );
      if (!mappedThreadId) return;
      const mappedSessionId =
        get().threadRuntimeById[mappedThreadId]?.sessionId ??
        get().threads.find((thread) => thread.id === mappedThreadId)?.sessionId ??
        params.threadId ??
        params.thread_id ??
        params.thread?.id ??
        params.sessionId ??
        mappedThreadId;

      if (JSONRPC_THREAD_EVENT_METHODS.has(message.method) && typeof params.type === "string") {
        handleThreadEvent(get, set, mappedThreadId, {
          ...(params as Record<string, unknown>),
          sessionId: typeof params.sessionId === "string" ? params.sessionId : mappedSessionId,
        } as SessionEvent);
        return;
      }

      if (message.method === "turn/started") {
        handleThreadEvent(get, set, mappedThreadId, {
          type: "session_busy",
          sessionId: mappedSessionId,
          busy: true,
          turnId: params.turn?.id,
          cause: "user_message",
        });
        return;
      }

      if (message.method === "turn/completed") {
        handleThreadEvent(get, set, mappedThreadId, {
          type: "session_busy",
          sessionId: mappedSessionId,
          busy: false,
          turnId: params.turn?.id,
          outcome:
            params.turn?.status === "interrupted"
              ? "cancelled"
              : params.turn?.status === "failed"
                ? "error"
                : "completed",
        });
        return;
      }

      if (message.method === "item/started") {
        const item = parseProjectedItem(params.item);
        if (!item) return;
        applyProjectedStarted(set, mappedThreadId, item);
        return;
      }

      if (message.method === "item/reasoning/delta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        if (!itemId) return;
        applyProjectedReasoningDeltaToThread(
          set,
          mappedThreadId,
          itemId,
          params.mode === "summary" ? "summary" : "reasoning",
          String(params.delta ?? ""),
        );
        return;
      }

      if (message.method === "item/agentMessage/delta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        if (!itemId) return;
        applyProjectedAssistantDeltaToThread(
          set,
          mappedThreadId,
          itemId,
          String(params.delta ?? ""),
        );
        return;
      }

      if (message.method === "item/completed") {
        const item = parseProjectedItem(params.item);
        if (!item) return;
        applyProjectedCompleted(set, mappedThreadId, item);
        return;
      }
    });
    jsonRpcRouterCleanupByWorkspace.set(workspaceId, cleanup);
  }

  function markWorkspaceThreadsDisconnected(get: StoreGet, set: StoreSet, workspaceId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    const reconnectIds = new Set<string>([
      ...(jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? []),
      ...connectedThreadIdsForWorkspace(get, workspaceId),
    ]);
    if (reconnectIds.size === 0) {
      return;
    }

    jsonRpcReconnectThreadsByWorkspace.set(workspaceId, reconnectIds);
    RUNTIME.modelStreamByThread.forEach((_, threadId) => {
      if (reconnectIds.has(threadId)) {
        RUNTIME.modelStreamByThread.delete(threadId);
      }
    });
    for (const threadId of reconnectIds) {
      RUNTIME.pendingWorkspaceDefaultApplyByThread.delete(threadId);
    }

    set((s) => {
      let threadsChanged = false;
      let runtimeChanged = false;
      const nextThreads = s.threads.map((thread) => {
        if (thread.workspaceId !== workspaceId || !reconnectIds.has(thread.id)) {
          return thread;
        }
        if (thread.status !== "disconnected") {
          threadsChanged = true;
        }
        return { ...thread, status: "disconnected" as const };
      });
      const nextThreadRuntimeById = { ...s.threadRuntimeById };
      for (const threadId of reconnectIds) {
        const runtime = nextThreadRuntimeById[threadId];
        if (!runtime) continue;
        runtimeChanged = true;
        nextThreadRuntimeById[threadId] = {
          ...runtime,
          connected: false,
          busy: false,
          busySince: null,
          activeTurnId: null,
          pendingSteer: null,
        };
      }
      if (!threadsChanged && !runtimeChanged) {
        return {};
      }
      return {
        threads: nextThreads,
        threadRuntimeById: nextThreadRuntimeById,
      };
    });
    void ctx.deps.persist(get);
  }

  function reconnectWorkspaceThreads(get: StoreGet, set: StoreSet, workspaceId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    const reconnectIds = [...(jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? [])];
    if (reconnectIds.length === 0) {
      return;
    }
    for (const threadId of reconnectIds) {
      const thread = get().threads.find(
        (entry) => entry.id === threadId && entry.workspaceId === workspaceId,
      );
      const url = get().workspaceRuntimeById[workspaceId]?.serverUrl;
      if (!thread || !url || !thread.sessionId) {
        forgetThreadForReconnect(workspaceId, threadId);
        continue;
      }
      ensureThreadSocket(get, set, threadId, url);
    }
  }

  function ensureWorkspaceJsonRpcLifecycle(get: StoreGet, set: StoreSet, workspaceId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    if (jsonRpcLifecycleCleanupByWorkspace.has(workspaceId)) {
      return;
    }
    const cleanup = registerWorkspaceJsonRpcLifecycle(workspaceId, {
      onOpen: () => {
        reconnectWorkspaceThreads(get, set, workspaceId);
      },
      onClose: () => {
        markWorkspaceThreadsDisconnected(get, set, workspaceId);
      },
    });
    jsonRpcLifecycleCleanupByWorkspace.set(workspaceId, cleanup);
  }

  function migrateThreadIdentity(
    get: StoreGet,
    set: StoreSet,
    fromThreadId: string,
    toThreadId: string,
  ): string {
    if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) {
      return toThreadId;
    }

    const workspaceId =
      workspaceIdForThread(get, fromThreadId) ?? workspaceIdForThread(get, toThreadId);
    rekeyThreadRuntimeMaps(fromThreadId, toThreadId);
    if (workspaceId) {
      forgetThreadForReconnect(workspaceId, fromThreadId);
      rememberThreadForReconnect(workspaceId, toThreadId);
    }
    set((s) => {
      const existingThread = s.threads.find((thread) => thread.id === fromThreadId);
      const existingRuntime = s.threadRuntimeById[fromThreadId];
      const replacementThread = s.threads.find((thread) => thread.id === toThreadId);
      const replacementRuntime = s.threadRuntimeById[toThreadId];

      const nextThreads = replacementThread
        ? s.threads
            .filter((thread) => thread.id !== fromThreadId)
            .map((thread) =>
              thread.id === toThreadId &&
              existingThread?.legacyTranscriptId &&
              !thread.legacyTranscriptId
                ? { ...thread, legacyTranscriptId: existingThread.legacyTranscriptId }
                : thread,
            )
        : s.threads.map((thread) =>
            thread.id === fromThreadId
              ? {
                  ...thread,
                  id: toThreadId,
                  sessionId: toThreadId,
                  draft: false,
                  legacyTranscriptId:
                    thread.legacyTranscriptId ?? (thread.id !== toThreadId ? thread.id : null),
                }
              : thread,
          );

      const nextThreadRuntimeById = { ...s.threadRuntimeById };
      if (existingRuntime) {
        delete nextThreadRuntimeById[fromThreadId];
        if (!replacementRuntime) {
          nextThreadRuntimeById[toThreadId] = {
            ...existingRuntime,
            sessionId: toThreadId,
          };
        }
      }

      const nextLatestTodosByThreadId = { ...s.latestTodosByThreadId };
      if (fromThreadId in nextLatestTodosByThreadId && !(toThreadId in nextLatestTodosByThreadId)) {
        const nextTodos = nextLatestTodosByThreadId[fromThreadId];
        if (nextTodos) {
          nextLatestTodosByThreadId[toThreadId] = nextTodos;
        }
      }
      delete nextLatestTodosByThreadId[fromThreadId];

      return {
        threads: nextThreads,
        selectedThreadId: s.selectedThreadId === fromThreadId ? toThreadId : s.selectedThreadId,
        promptModal:
          s.promptModal && s.promptModal.threadId === fromThreadId
            ? { ...s.promptModal, threadId: toThreadId }
            : s.promptModal,
        threadRuntimeById: nextThreadRuntimeById,
        latestTodosByThreadId: nextLatestTodosByThreadId,
      };
    });

    return get().threads.find((thread) => thread.sessionId === toThreadId)?.id ?? toThreadId;
  }

  return {
    ensureWorkspaceJsonRpcRouter,
    ensureWorkspaceJsonRpcLifecycle,
    markWorkspaceThreadsDisconnected,
    reconnectWorkspaceThreads,
    migrateThreadIdentity,
  };
}
