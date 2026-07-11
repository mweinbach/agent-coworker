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
    | "flushPendingContentForThread"
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
    flushPendingContentForThread,
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
          const category =
            requestParams.category === "filesystem" || requestParams.category === "network"
              ? requestParams.category
              : undefined;
          handleThreadEvent(get, set, threadId, {
            type: "approval",
            sessionId,
            requestId: String(message.id),
            command: String(requestParams.command ?? ""),
            dangerous: requestParams.dangerous === true,
            reasonCode: requestParams.reason ?? "requires_manual_review",
            ...(typeof requestParams.detail === "string" ? { detail: requestParams.detail } : {}),
            ...(category ? { category } : {}),
          } as SessionEvent);
        }
        return;
      }

      if (message.kind === "response") {
        const errorData =
          message.error?.data &&
          typeof message.error.data === "object" &&
          !Array.isArray(message.error.data)
            ? (message.error.data as Record<string, unknown>)
            : null;
        const category = typeof errorData?.category === "string" ? errorData.category : null;
        if (message.error && !category?.startsWith("interaction_response_")) {
          return;
        }
        const requestId =
          typeof errorData?.requestId === "string" ? errorData.requestId : String(message.id);
        const responseThreadId =
          typeof errorData?.threadId === "string"
            ? findThreadIdForJsonRpcNotification(get, workspaceId, errorData.threadId)
            : null;
        set((state) => {
          const candidateThreadIds = responseThreadId
            ? [responseThreadId]
            : state.threads
                .filter((thread) => thread.workspaceId === workspaceId)
                .map((thread) => thread.id);
          for (const threadId of candidateThreadIds) {
            const existing = state.interactionsByThread[threadId];
            if (!existing) continue;
            const interactionIndex = existing.findIndex(
              (interaction) =>
                interaction.requestId === requestId &&
                (interaction.status === "responding" || interaction.status === "failed"),
            );
            if (interactionIndex < 0) continue;
            const interactions = existing.map((interaction, index) => {
              if (index !== interactionIndex) return interaction;
              if (message.error) {
                return {
                  ...interaction,
                  status: "failed" as const,
                  error: message.error.message,
                };
              }
              const { error: _error, ...rest } = interaction;
              return { ...rest, status: "resolved" as const };
            });
            return {
              interactionsByThread: {
                ...state.interactionsByThread,
                [threadId]: interactions,
              },
            };
          }
          return {};
        });
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

      if (message.method === "serverRequest/resolved") {
        const requestId = typeof params.requestId === "string" ? params.requestId : null;
        if (!requestId) return;
        flushPendingContentForThread(set, mappedThreadId);
        set((s) => {
          const existing = s.interactionsByThread[mappedThreadId];
          if (!existing) return {};
          let changed = false;
          const interactions = existing.map((interaction) => {
            if (interaction.requestId !== requestId || interaction.status === "resolved") {
              return interaction;
            }
            changed = true;
            const { error: _error, ...rest } = interaction;
            return { ...rest, status: "resolved" as const };
          });
          if (!changed) return {};
          return {
            interactionsByThread: {
              ...s.interactionsByThread,
              [mappedThreadId]: interactions,
            },
          };
        });
        return;
      }

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
      let interactionsChanged = false;
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
      const nextInteractionsByThread = { ...s.interactionsByThread };
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
          pendingTurnStart: null,
          pendingSteer: null,
        };
        const interactions = nextInteractionsByThread[threadId];
        if (interactions?.some((interaction) => interaction.status === "responding")) {
          interactionsChanged = true;
          nextInteractionsByThread[threadId] = interactions.map((interaction) =>
            interaction.status === "responding"
              ? {
                  ...interaction,
                  status: "failed" as const,
                  error: "Connection closed before the response was confirmed.",
                }
              : interaction,
          );
        }
      }
      if (!threadsChanged && !runtimeChanged && !interactionsChanged) {
        return {};
      }
      return {
        threads: nextThreads,
        threadRuntimeById: nextThreadRuntimeById,
        interactionsByThread: nextInteractionsByThread,
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
      onReconnecting: () => {
        markWorkspaceThreadsDisconnected(get, set, workspaceId);
      },
      onReconnectExhausted: () => {
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
    flushPendingContentForThread(set, fromThreadId);
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

      const nextInteractionsByThread = { ...s.interactionsByThread };
      if (fromThreadId in nextInteractionsByThread) {
        const migrated = nextInteractionsByThread[fromThreadId];
        delete nextInteractionsByThread[fromThreadId];
        if (migrated) {
          const existing = nextInteractionsByThread[toThreadId] ?? [];
          const seenRequestIds = new Set(existing.map((interaction) => interaction.requestId));
          nextInteractionsByThread[toThreadId] = [
            ...existing,
            ...migrated.filter((interaction) => !seenRequestIds.has(interaction.requestId)),
          ].sort((left, right) => left.receivedSequence - right.receivedSequence);
        }
      }

      return {
        threads: nextThreads,
        selectedThreadId: s.selectedThreadId === fromThreadId ? toThreadId : s.selectedThreadId,
        interactionsByThread: nextInteractionsByThread,
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
