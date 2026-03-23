import type { ServerEvent } from "../protocol";
import type { PersistedThreadJournalEvent } from "../sessionDb";
import type { SessionBinding, StartServerSocket } from "../startServer/types";

import { dispatchJsonRpcMessage } from "./dispatchJsonRpcMessage";
import { createJsonRpcEventProjector } from "./eventProjector";
import {
  buildJsonRpcErrorResponse,
  JSONRPC_ERROR_CODES,
  type JsonRpcLiteClientResponse,
  type JsonRpcLiteNotification,
  type JsonRpcLiteRequest,
} from "./protocol";

export type JsonRpcThreadSubscriptionOptions = {
  initialActiveTurnId?: string | null;
  initialAgentText?: string | null;
  drainDisconnectedReplayBuffer?: boolean;
  pendingPromptEvents?: ReadonlyArray<
    Extract<ServerEvent, { type: "ask" }>
    | Extract<ServerEvent, { type: "approval" }>
  >;
  skipPendingPromptRequestIds?: ReadonlySet<string>;
};

type CreateJsonRpcTransportAdapterDeps = {
  maxPendingRequests: number;
  loadThreadBinding: (threadId: string) => SessionBinding | null;
  getThreadBinding: (threadId: string) => SessionBinding | null | undefined;
  addBindingSink: (binding: SessionBinding, sinkId: string, sink: (event: ServerEvent) => void) => void;
  removeBindingSink: (binding: SessionBinding, sinkId: string) => void;
  countLiveConnectionSinks: (binding: SessionBinding) => number;
  listThreadJournalEvents: (
    threadId: string,
    opts: { afterSeq?: number; limit?: number },
  ) => PersistedThreadJournalEvent[];
  enqueueThreadJournalEvent: (event: Omit<PersistedThreadJournalEvent, "seq">) => Promise<unknown>;
  shouldSendNotification: (ws: StartServerSocket, method: string) => boolean;
  sendJsonRpc: (ws: StartServerSocket, payload: unknown) => void;
  extractTextInput: (input: unknown) => string;
};

export function createJsonRpcTransportAdapter({
  maxPendingRequests,
  loadThreadBinding,
  getThreadBinding,
  addBindingSink,
  removeBindingSink,
  countLiveConnectionSinks,
  listThreadJournalEvents,
  enqueueThreadJournalEvent,
  shouldSendNotification,
  sendJsonRpc,
  extractTextInput,
}: CreateJsonRpcTransportAdapterDeps) {
  const subscriptionsByConnectionId = new Map<string, Map<string, { sinkId: string }>>();

  const ensureConnectionSubscriptions = (connectionId: string) => {
    const existing = subscriptionsByConnectionId.get(connectionId);
    if (existing) return existing;
    const created = new Map<string, { sinkId: string }>();
    subscriptionsByConnectionId.set(connectionId, created);
    return created;
  };

  const maybeBeginDisconnectedReplayBuffer = (binding: SessionBinding | null | undefined) => {
    if (!binding?.session || binding.socket || countLiveConnectionSinks(binding) !== 0) {
      return;
    }
    binding.session.beginDisconnectedReplayBuffer();
  };

  const emitServerRequestResolved = (
    ws: StartServerSocket,
    threadId: string,
    requestId: string,
  ) => {
    sendJsonRpc(ws, {
      method: "serverRequest/resolved",
      params: {
        threadId,
        requestId,
      },
    });
  };

  const replayJournal = (
    ws: StartServerSocket,
    threadId: string,
    afterSeq = 0,
    limit?: number,
  ) => {
    const replayedRequestIds = new Set<string>();
    const journalEvents = limit === undefined
      ? listThreadJournalEvents(threadId, { afterSeq })
      : listThreadJournalEvents(threadId, { afterSeq, limit });
    for (const event of journalEvents) {
      if (event.eventType.startsWith("request:")) {
        const method = event.eventType.slice("request:".length);
        if (event.requestId) {
          replayedRequestIds.add(event.requestId);
          ws.data.rpc?.pendingServerRequests.set(event.requestId, {
            threadId,
            type: method === "item/commandExecution/requestApproval" ? "approval" : "ask",
            requestId: event.requestId,
          });
        }
        sendJsonRpc(ws, {
          id: event.requestId ?? `${threadId}:${event.seq}`,
          method,
          params: event.payload,
        });
        continue;
      }
      if (!shouldSendNotification(ws, event.eventType)) {
        continue;
      }
      sendJsonRpc(ws, {
        method: event.eventType,
        params: event.payload,
      });
    }
    return replayedRequestIds;
  };

  const subscribeThread = (
    ws: StartServerSocket,
    threadId: string,
    opts?: JsonRpcThreadSubscriptionOptions,
  ): SessionBinding | null => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) {
      return null;
    }

    const binding = loadThreadBinding(threadId);
    if (!binding?.session) {
      return null;
    }

    const subscriptions = ensureConnectionSubscriptions(connectionId);
    if (subscriptions.has(threadId)) {
      return binding;
    }

    const shouldReplayBufferedEvents =
      opts?.drainDisconnectedReplayBuffer || (!binding.socket && countLiveConnectionSinks(binding) === 0);
    const sinkId = `jsonrpc:${connectionId}:${threadId}`;
    const projector = createJsonRpcEventProjector({
      threadId,
      send: (message) => sendJsonRpc(ws, message),
      shouldSendNotification: (method) => shouldSendNotification(ws, method),
      ...(opts?.initialActiveTurnId
        ? {
            initialActiveTurnId: opts.initialActiveTurnId,
            initialAgentText: opts.initialAgentText ?? "",
          }
        : {}),
      onServerRequest: (request) => {
        ws.data.rpc?.pendingServerRequests.set(request.id, {
          threadId: request.threadId,
          type: request.type,
          requestId: request.id,
        });
        sendJsonRpc(ws, {
          id: request.id,
          method: request.method,
          params: request.params,
        });
      },
    });

    addBindingSink(binding, sinkId, (event) => projector.handle(event));
    subscriptions.set(threadId, { sinkId });

    const replayedPromptRequestIds = new Set(opts?.skipPendingPromptRequestIds ?? []);
    if (shouldReplayBufferedEvents) {
      for (const event of binding.session.drainDisconnectedReplayEvents()) {
        if (event.type === "ask" || event.type === "approval") {
          replayedPromptRequestIds.add(event.requestId);
        }
        projector.handle(event);
      }
    }
    for (const event of opts?.pendingPromptEvents ?? []) {
      if (replayedPromptRequestIds.has(event.requestId)) {
        continue;
      }
      projector.handle(event);
    }
    return binding;
  };

  const unsubscribeThread = (ws: StartServerSocket, threadId: string) => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) {
      return "notSubscribed" as const;
    }
    const subscriptions = subscriptionsByConnectionId.get(connectionId);
    const subscription = subscriptions?.get(threadId);
    if (!subscription) {
      const existingBinding = getThreadBinding(threadId);
      return existingBinding?.session ? "notSubscribed" as const : "notLoaded" as const;
    }

    const binding = getThreadBinding(threadId);
    if (binding) {
      removeBindingSink(binding, subscription.sinkId);
      maybeBeginDisconnectedReplayBuffer(binding);
    }
    subscriptions?.delete(threadId);
    if (subscriptions && subscriptions.size === 0) {
      subscriptionsByConnectionId.delete(connectionId);
    }
    return "unsubscribed" as const;
  };

  const closeConnection = (ws: StartServerSocket) => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) {
      return;
    }
    const subscriptions = subscriptionsByConnectionId.get(connectionId);
    if (!subscriptions) {
      return;
    }
    for (const [threadId, subscription] of subscriptions) {
      const binding = getThreadBinding(threadId);
      if (!binding) continue;
      removeBindingSink(binding, subscription.sinkId);
      maybeBeginDisconnectedReplayBuffer(binding);
    }
    subscriptionsByConnectionId.delete(connectionId);
  };

  const routeResponse = (
    ws: StartServerSocket,
    message: JsonRpcLiteClientResponse,
  ) => {
    const pending = ws.data.rpc?.pendingServerRequests.get(message.id);
    if (!pending) {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(message.id, {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: `Unknown server request id: ${String(message.id)}`,
      }));
      return;
    }

    const binding = getThreadBinding(pending.threadId);
    const session = binding?.session;
    if (!session) {
      ws.data.rpc?.pendingServerRequests.delete(message.id);
      emitServerRequestResolved(ws, pending.threadId, pending.requestId);
      return;
    }

    emitServerRequestResolved(ws, pending.threadId, pending.requestId);

    if (pending.type === "approval") {
      const result = message.result as Record<string, unknown> | undefined;
      const decision = typeof result?.decision === "string" ? result.decision : undefined;
      const approved =
        result?.approved === true
        || decision === "accept"
        || decision === "acceptForSession";
      session.handleApprovalResponse(pending.requestId, approved);
    } else {
      const result = message.result as Record<string, unknown> | undefined;
      const answer =
        typeof result?.answer === "string"
          ? result.answer
          : Array.isArray(result?.content)
            ? extractTextInput(result.content)
            : "";
      session.handleAskResponse(pending.requestId, answer);
    }

    ws.data.rpc?.pendingServerRequests.delete(message.id);
    void enqueueThreadJournalEvent({
      threadId: pending.threadId,
      ts: new Date().toISOString(),
      eventType: "serverRequest/resolved",
      turnId: session.activeTurnId ?? null,
      itemId: null,
      requestId: pending.requestId,
      payload: {
        threadId: pending.threadId,
        requestId: pending.requestId,
      },
    }).catch(() => {
      // Best-effort journal persistence.
    });
  };

  const handleMessage = (
    ws: StartServerSocket,
    message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
    routeRequest: (ws: StartServerSocket, message: JsonRpcLiteRequest) => Promise<void>,
  ) => {
    const rpcState = ws.data.rpc;
    if (
      rpcState
      && "id" in message
      && "method" in message
      && message.method !== "initialize"
      && message.method !== "initialized"
      && rpcState.pendingRequestCount >= rpcState.maxPendingRequests
    ) {
      sendJsonRpc(ws, buildJsonRpcErrorResponse(message.id, {
        code: JSONRPC_ERROR_CODES.serverOverloaded,
        message: "Server overloaded; retry later.",
      }));
      return;
    }

    dispatchJsonRpcMessage({
      ws,
      message,
      onRequest: (request) => {
        if (ws.data.rpc) {
          ws.data.rpc.pendingRequestCount += 1;
        }
        void routeRequest(ws, request)
          .catch((reason) => {
            const detail = reason instanceof Error
              ? reason.message
              : typeof reason === "string"
                ? reason
                : "Internal error";
            sendJsonRpc(ws, buildJsonRpcErrorResponse(request.id, {
              code: JSONRPC_ERROR_CODES.internalError,
              message: detail,
            }));
          })
          .finally(() => {
            if (ws.data.rpc) {
              ws.data.rpc.pendingRequestCount = Math.max(0, ws.data.rpc.pendingRequestCount - 1);
            }
          });
      },
      onResponse: (response) => {
        routeResponse(ws, response);
      },
    });
  };

  const openConnection = (ws: StartServerSocket) => {
    ws.data.rpc = {
      initializeRequestReceived: false,
      initializedNotificationReceived: false,
      pendingRequestCount: 0,
      maxPendingRequests,
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [],
      },
      pendingServerRequests: new Map(),
    };
  };

  return {
    openConnection,
    closeConnection,
    handleMessage,
    subscribeThread,
    unsubscribeThread,
    replayJournal,
  };
}
