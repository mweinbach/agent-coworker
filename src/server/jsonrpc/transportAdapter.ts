import { z } from "zod";

import type { SessionEvent } from "../protocol";
import type { PersistedThreadJournalEvent } from "../sessionDb";
import type { SessionBinding, StartServerSocket } from "../startServer/types";

import { dispatchJsonRpcMessage } from "./dispatchJsonRpcMessage";
import { createJsonRpcNotificationProjector } from "./notificationProjector";
import {
  buildJsonRpcErrorResponse,
  JSONRPC_ERROR_CODES,
  type JsonRpcLiteClientResponse,
  type JsonRpcLiteNotification,
  type JsonRpcLiteRequest,
} from "./protocol";
import {
  parseServerRequestReceipt,
  SERVER_REQUEST_RECEIPT_SCAN_LIMIT,
  type ServerRequestReceipt,
  ServerRequestReceiptLedger,
  type ServerRequestResponse,
  serverRequestResolvedPayload,
  serverRequestResponsesEqual,
} from "./serverRequestReceipts";

/** Schema for approval response payloads (command execution approval). */
const approvalResponseResultSchema = z
  .object({
    approved: z.boolean().optional(),
    decision: z.enum(["accept", "acceptForSession", "reject", "decline"]).optional(),
  })
  .refine((v) => v.approved !== undefined || v.decision !== undefined, {
    message: "Approval response must include 'approved' or 'decision'",
  });

/** Schema for ask response payloads (user-prompted answers). */
const askResponseResultSchema = z.union([
  z.object({ answer: z.string() }),
  z.object({ content: z.array(z.unknown()) }),
]);

export type JsonRpcThreadSubscriptionOptions = {
  initialActiveTurnId?: string | null;
  initialAgentText?: string | null;
  drainDisconnectedReplayBuffer?: boolean;
  pendingPromptEvents?: ReadonlyArray<
    Extract<SessionEvent, { type: "ask" }> | Extract<SessionEvent, { type: "approval" }>
  >;
  skipPendingPromptRequestIds?: ReadonlySet<string>;
};

type CreateJsonRpcTransportAdapterDeps = {
  maxPendingRequests: number;
  loadThreadBinding: (threadId: string) => SessionBinding | null;
  getThreadBinding: (threadId: string) => SessionBinding | null | undefined;
  addBindingSink: (
    binding: SessionBinding,
    sinkId: string,
    sink: (event: SessionEvent) => void,
  ) => void;
  removeBindingSink: (binding: SessionBinding, sinkId: string) => void;
  countLiveConnectionSinks: (binding: SessionBinding) => number;
  listThreadJournalEvents: (
    threadId: string,
    opts: { afterSeq?: number; limit?: number },
  ) => PersistedThreadJournalEvent[];
  getThreadJournalTailSeq: (threadId: string) => number;
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
  getThreadJournalTailSeq,
  enqueueThreadJournalEvent,
  shouldSendNotification,
  sendJsonRpc,
  extractTextInput,
}: CreateJsonRpcTransportAdapterDeps) {
  const subscriptionsByConnectionId = new Map<string, Map<string, { sinkId: string }>>();
  const resolvedServerRequests = new ServerRequestReceiptLedger();

  const ensureConnectionSubscriptions = (connectionId: string) => {
    const existing = subscriptionsByConnectionId.get(connectionId);
    if (existing) return existing;
    const created = new Map<string, { sinkId: string }>();
    subscriptionsByConnectionId.set(connectionId, created);
    return created;
  };

  const maybeBeginDisconnectedReplayBuffer = (binding: SessionBinding | null | undefined) => {
    if (!binding?.runtime || binding.socket || countLiveConnectionSinks(binding) !== 0) {
      return;
    }
    binding.runtime.replay.beginDisconnectedReplayBuffer();
  };

  const emitServerRequestResolved = (ws: StartServerSocket, receipt: ServerRequestReceipt) => {
    sendJsonRpc(ws, {
      method: "serverRequest/resolved",
      params: serverRequestResolvedPayload(receipt),
    });
  };

  const loadRecentServerRequestReceipts = (threadId: string): ServerRequestReceipt[] => {
    const tailSeq = getThreadJournalTailSeq(threadId);
    const afterSeq = Math.max(0, tailSeq - SERVER_REQUEST_RECEIPT_SCAN_LIMIT);
    resolvedServerRequests.hydrate(
      listThreadJournalEvents(threadId, {
        afterSeq,
        limit: SERVER_REQUEST_RECEIPT_SCAN_LIMIT,
      }),
    );
    return resolvedServerRequests.listForThread(threadId);
  };

  const findResolvedServerRequest = (
    ws: StartServerSocket,
    requestId: string,
  ): ServerRequestReceipt | null => {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return null;
    const subscriptions = subscriptionsByConnectionId.get(connectionId);
    if (!subscriptions) return null;
    for (const threadId of subscriptions.keys()) {
      const receipt = resolvedServerRequests.get(threadId, requestId);
      if (receipt) return receipt;
    }
    return null;
  };

  const parseServerRequestResponse = (
    type: "ask" | "approval",
    result: unknown,
  ):
    | { ok: true; response: ServerRequestResponse }
    | { ok: false; message: string; emptyAsk: boolean } => {
    if (type === "approval") {
      const parsed = approvalResponseResultSchema.safeParse(result);
      if (!parsed.success) {
        return {
          ok: false,
          message: `Invalid approval response: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          emptyAsk: false,
        };
      }
      const { approved, decision } = parsed.data;
      return {
        ok: true,
        response: {
          kind: "approval",
          approved: approved === true || decision === "accept" || decision === "acceptForSession",
        },
      };
    }

    const parsed = askResponseResultSchema.safeParse(result);
    if (!parsed.success) {
      return {
        ok: false,
        message: `Invalid ask response: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        emptyAsk: false,
      };
    }
    const answer =
      "answer" in parsed.data ? parsed.data.answer : extractTextInput(parsed.data.content);
    if (answer.trim().length === 0) {
      return {
        ok: false,
        message: "Ask response cannot be empty",
        emptyAsk: true,
      };
    }
    return {
      ok: true,
      response: { kind: "ask", answer },
    };
  };

  const sendInteractionResponseError = (
    ws: StartServerSocket,
    id: string | number,
    opts: {
      code: number;
      message: string;
      category: string;
      requestId: string;
      threadId?: string;
    },
  ) => {
    sendJsonRpc(
      ws,
      buildJsonRpcErrorResponse(id, {
        code: opts.code,
        message: opts.message,
        data: {
          category: opts.category,
          requestId: opts.requestId,
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
        },
      }),
    );
  };

  const persistServerRequestReceipt = async (receipt: ServerRequestReceipt): Promise<void> => {
    resolvedServerRequests.remember(receipt);
    await enqueueThreadJournalEvent({
      threadId: receipt.threadId,
      ts: receipt.resolvedAt,
      eventType: "serverRequest/resolved",
      turnId: getThreadBinding(receipt.threadId)?.runtime?.turns.activeTurnId ?? null,
      itemId: null,
      requestId: receipt.requestId,
      payload: serverRequestResolvedPayload(receipt),
    }).catch(() => {
      // The bounded in-memory ledger still protects this server process. Journal
      // health reports the persistence failure for cross-process reconnects.
    });
  };

  const replayJournal = (ws: StartServerSocket, threadId: string, afterSeq = 0, limit?: number) => {
    const replayedRequestIds = new Set<string>();
    const journalEvents =
      limit === undefined
        ? listThreadJournalEvents(threadId, { afterSeq })
        : listThreadJournalEvents(threadId, { afterSeq, limit });
    for (const event of journalEvents) {
      if (event.eventType === "serverRequest/resolved") {
        if (event.requestId) {
          ws.data.rpc?.pendingServerRequests.delete(event.requestId);
        }
        const receipt = parseServerRequestReceipt(event);
        if (receipt) {
          resolvedServerRequests.remember(receipt);
        }
      }
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
      if (event.eventType.startsWith("internal/")) {
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
    if (!binding?.runtime) {
      return null;
    }

    const subscriptions = ensureConnectionSubscriptions(connectionId);
    if (subscriptions.has(threadId)) {
      return binding;
    }

    const shouldReplayBufferedEvents =
      opts?.drainDisconnectedReplayBuffer ||
      (!binding.socket && countLiveConnectionSinks(binding) === 0);
    const sinkId = `jsonrpc:${connectionId}:${threadId}`;
    const projector = createJsonRpcNotificationProjector({
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
      for (const event of binding.runtime.replay.drainDisconnectedReplayEvents()) {
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
    for (const receipt of loadRecentServerRequestReceipts(threadId)) {
      ws.data.rpc?.pendingServerRequests.delete(receipt.requestId);
      emitServerRequestResolved(ws, receipt);
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
      return existingBinding?.session ? ("notSubscribed" as const) : ("notLoaded" as const);
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

  const routeResponse = async (ws: StartServerSocket, message: JsonRpcLiteClientResponse) => {
    const pending = ws.data.rpc?.pendingServerRequests.get(message.id);
    const priorReceipt = pending ? null : findResolvedServerRequest(ws, String(message.id));
    if (!pending && !priorReceipt) {
      sendInteractionResponseError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: `Unknown server request id: ${String(message.id)}`,
        category: "interaction_response_not_found",
        requestId: String(message.id),
      });
      return;
    }

    const type = pending?.type ?? priorReceipt?.response.kind;
    if (!type) return;
    const parsedResponse = parseServerRequestResponse(type, message.result);
    if (!parsedResponse.ok) {
      if (parsedResponse.emptyAsk && pending) {
        getThreadBinding(pending.threadId)?.runtime?.lifecycle.handleAskResponse(
          pending.requestId,
          "",
        );
        return;
      }
      sendInteractionResponseError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.invalidParams,
        message: parsedResponse.message,
        category: "interaction_response_invalid",
        requestId: pending?.requestId ?? priorReceipt?.requestId ?? String(message.id),
        threadId: pending?.threadId ?? priorReceipt?.threadId,
      });
      return;
    }

    if (priorReceipt) {
      if (!serverRequestResponsesEqual(priorReceipt.response, parsedResponse.response)) {
        sendInteractionResponseError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Conflicting response for resolved interaction: ${priorReceipt.requestId}`,
          category: "interaction_response_conflict",
          requestId: priorReceipt.requestId,
          threadId: priorReceipt.threadId,
        });
        return;
      }
      emitServerRequestResolved(ws, priorReceipt);
      return;
    }

    if (!pending) return;
    const runtime = getThreadBinding(pending.threadId)?.runtime;
    let accepted = runtime === null || runtime === undefined;
    if (runtime && parsedResponse.response.kind === "approval") {
      accepted = runtime.lifecycle.handleApprovalResponse(
        pending.requestId,
        parsedResponse.response.approved,
      );
    } else if (runtime && parsedResponse.response.kind === "ask") {
      accepted = runtime.lifecycle.handleAskResponse(
        pending.requestId,
        parsedResponse.response.answer,
      );
    }

    if (!accepted) {
      const concurrentlyResolved = resolvedServerRequests.get(pending.threadId, pending.requestId);
      if (
        concurrentlyResolved &&
        serverRequestResponsesEqual(concurrentlyResolved.response, parsedResponse.response)
      ) {
        ws.data.rpc?.pendingServerRequests.delete(message.id);
        emitServerRequestResolved(ws, concurrentlyResolved);
        return;
      }
      sendInteractionResponseError(ws, message.id, {
        code: concurrentlyResolved
          ? JSONRPC_ERROR_CODES.invalidParams
          : JSONRPC_ERROR_CODES.invalidRequest,
        message: concurrentlyResolved
          ? `Conflicting response for resolved interaction: ${pending.requestId}`
          : `Interaction request is no longer pending: ${pending.requestId}`,
        category: concurrentlyResolved
          ? "interaction_response_conflict"
          : "interaction_response_not_pending",
        requestId: pending.requestId,
        threadId: pending.threadId,
      });
      if (!concurrentlyResolved) {
        ws.data.rpc?.pendingServerRequests.delete(message.id);
      }
      return;
    }

    const receipt: ServerRequestReceipt = {
      threadId: pending.threadId,
      requestId: pending.requestId,
      response: parsedResponse.response,
      resolvedAt: new Date().toISOString(),
    };
    ws.data.rpc?.pendingServerRequests.delete(message.id);
    await persistServerRequestReceipt(receipt);
    emitServerRequestResolved(ws, receipt);
  };

  const handleMessage = (
    ws: StartServerSocket,
    message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
    routeRequest: (ws: StartServerSocket, message: JsonRpcLiteRequest) => Promise<void>,
  ) => {
    const rpcState = ws.data.rpc;
    if (
      rpcState &&
      "id" in message &&
      "method" in message &&
      message.method !== "initialize" &&
      message.method !== "initialized" &&
      rpcState.pendingRequestCount >= rpcState.maxPendingRequests
    ) {
      sendJsonRpc(
        ws,
        buildJsonRpcErrorResponse(message.id, {
          code: JSONRPC_ERROR_CODES.serverOverloaded,
          message: "Server overloaded; retry later.",
        }),
      );
      return;
    }

    dispatchJsonRpcMessage({
      ws,
      message,
      transportType: ws.data.transportType ?? (ws.data.protocolMode === "h3" ? "h3" : "websocket"),
      send: sendJsonRpc,
      onRequest: (request) => {
        if (ws.data.rpc) {
          ws.data.rpc.pendingRequestCount += 1;
        }
        void routeRequest(ws, request)
          .catch((reason) => {
            const detail =
              reason instanceof Error
                ? reason.message
                : typeof reason === "string"
                  ? reason
                  : "Internal error";
            sendJsonRpc(
              ws,
              buildJsonRpcErrorResponse(request.id, {
                code: JSONRPC_ERROR_CODES.internalError,
                message: detail,
              }),
            );
          })
          .finally(() => {
            if (ws.data.rpc) {
              ws.data.rpc.pendingRequestCount = Math.max(0, ws.data.rpc.pendingRequestCount - 1);
            }
          });
      },
      onResponse: (response) => {
        void routeResponse(ws, response);
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
        toolRetryLineage: false,
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
