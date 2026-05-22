import { buildAttachmentSignature, buildUserInputDisplayText } from "../../attachmentInputs";
import type { StoreGet, StoreSet } from "../../store.helpers";
import type { FeedItem, ThreadBusyPolicy } from "../../types";
import {
  ensureWorkspaceJsonRpcSocket,
  type FileAttachmentInput,
  interruptJsonRpcTurn,
  requestJsonRpc,
  respondToJsonRpcRequest,
  startJsonRpcTurn,
  steerJsonRpcTurn,
  unsubscribeJsonRpcThread,
} from "../jsonRpcSocket";
import {
  clearPendingThreadSteer,
  hasPendingThreadSteer,
  prependPendingThreadMessage,
  prependPendingThreadMessageWithAttachments,
  queuePendingThreadMessage,
  RUNTIME,
  rememberPendingThreadSteer,
  shiftPendingThreadAttachments,
  shiftPendingThreadMessage,
} from "../runtimeState";
import { MAX_FEED_ITEMS, type ThreadOutboundMessage } from "../threadEventReducerContext";
import type { ThreadEventReducerContext } from "./context";
import type { FeedProjectionModule } from "./feedProjection";
import type { WorkspaceStateHelpers } from "./workspaceState";

export type MessagingModule = ReturnType<typeof createMessagingModule>;

export function createMessagingModule(
  ctx: ThreadEventReducerContext,
  workspace: Pick<
    WorkspaceStateHelpers,
    "workspaceIdForThread" | "forgetThreadForReconnect" | "hasPendingWorkspaceDefaultApply"
  >,
  feed: Pick<FeedProjectionModule, "pushFeedItem">,
) {
  const { deps } = ctx;
  const { pushFeedItem } = feed;
  const { workspaceIdForThread, forgetThreadForReconnect, hasPendingWorkspaceDefaultApply } =
    workspace;
  function surfaceJsonRpcTurnSendFailure(
    set: StoreSet,
    threadId: string,
    opts?: { clientMessageId?: string; pendingTurnStartClientMessageId?: string },
  ) {
    if (opts?.clientMessageId) {
      clearPendingThreadSteer(threadId, opts.clientMessageId);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt || rt.pendingSteer?.clientMessageId !== opts.clientMessageId) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              pendingSteer: null,
            },
          },
        };
      });
    }

    if (opts?.pendingTurnStartClientMessageId) {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt || rt.pendingTurnStart?.clientMessageId !== opts.pendingTurnStartClientMessageId)
          return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              pendingTurnStart: null,
            },
          },
        };
      });
    }

    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "error",
      ts: ctx.deps.nowIso(),
      message: "Not connected. Reconnect to continue.",
      code: "internal_error",
      source: "protocol",
    });
  }

  function surfaceJsonRpcThreadStartFailure(
    set: StoreSet,
    threadId: string,
    attemptedText?: string,
    attemptedAttachments?: FileAttachmentInput[],
    error?: unknown,
  ) {
    const displayText = buildUserInputDisplayText(
      attemptedText?.trim() ?? "",
      attemptedAttachments,
    );

    if (displayText) {
      const attemptedItem: FeedItem = {
        id: ctx.deps.makeId(),
        kind: "message",
        role: "user",
        ts: ctx.deps.nowIso(),
        text: displayText,
      };
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        const alreadyVisible = rt.feed.some(
          (item) => item.kind === "message" && item.role === "user" && item.text === displayText,
        );
        if (alreadyVisible) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              feed: [...rt.feed, attemptedItem].slice(-MAX_FEED_ITEMS),
            },
          },
        };
      });
    }

    surfaceJsonRpcTurnSendFailure(set, threadId);
    set((s) => ({
      notifications: ctx.deps.pushNotification(s.notifications, {
        id: ctx.deps.makeId(),
        ts: ctx.deps.nowIso(),
        kind: "error",
        title: "Unable to start chat",
        detail: error instanceof Error ? error.message : String(error ?? "Connection failed."),
      }),
    }));
  }
  function sendThread(
    get: StoreGet,
    threadId: string,
    build: (sessionId: string) => ThreadOutboundMessage,
  ): boolean {
    const workspaceId = workspaceIdForThread(get, threadId);
    if (!workspaceId) {
      return false;
    }
    const beginWorkspaceRequest = (run: () => Promise<unknown>): boolean => {
      if (!ensureWorkspaceJsonRpcSocket(get, undefined, workspaceId)) {
        return false;
      }
      void run().catch(() => {
        // Surface "not connected" through the caller's existing false-path/UI state
        // instead of leaking unhandled async rejections from fire-and-forget actions.
      });
      return true;
    };
    const sessionId = get().threadRuntimeById[threadId]?.sessionId ?? threadId;
    const message = build(sessionId);
    if (message.type === "cancel") {
      return beginWorkspaceRequest(() =>
        interruptJsonRpcTurn(get, undefined, workspaceId, sessionId),
      );
    }
    if (message.type === "session_close") {
      forgetThreadForReconnect(workspaceId, threadId);
      return beginWorkspaceRequest(() =>
        unsubscribeJsonRpcThread(get, undefined, workspaceId, sessionId),
      );
    }
    if (message.type === "set_session_title") {
      return beginWorkspaceRequest(() =>
        requestJsonRpc(get, undefined, workspaceId, "cowork/session/title/set", {
          threadId: sessionId,
          title: message.title,
        }),
      );
    }
    if (message.type === "set_model") {
      return beginWorkspaceRequest(() =>
        requestJsonRpc(get, undefined, workspaceId, "cowork/session/model/set", {
          threadId: sessionId,
          provider: message.provider,
          model: message.model,
        }),
      );
    }
    if (message.type === "set_session_usage_budget") {
      return beginWorkspaceRequest(() =>
        requestJsonRpc(get, undefined, workspaceId, "cowork/session/usageBudget/set", {
          threadId: sessionId,
          ...(message.warnAtUsd !== undefined ? { warnAtUsd: message.warnAtUsd } : {}),
          ...(message.stopAtUsd !== undefined ? { stopAtUsd: message.stopAtUsd } : {}),
        }),
      );
    }
    if (message.type === "set_config") {
      return beginWorkspaceRequest(() =>
        requestJsonRpc(get, undefined, workspaceId, "cowork/session/config/set", {
          threadId: sessionId,
          config: message.config,
        }),
      );
    }
    if (message.type === "apply_session_defaults") {
      return beginWorkspaceRequest(() =>
        requestJsonRpc(get, undefined, workspaceId, "cowork/session/defaults/apply", {
          threadId: sessionId,
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          ...(message.provider !== undefined ? { provider: message.provider } : {}),
          ...(message.model !== undefined ? { model: message.model } : {}),
          ...(message.enableMcp !== undefined ? { enableMcp: message.enableMcp } : {}),
          ...(message.config !== undefined ? { config: message.config } : {}),
        }),
      );
    }
    if (message.type === "ask_response") {
      return respondToJsonRpcRequest(workspaceId, message.requestId, { answer: message.answer });
    }
    if (message.type === "approval_response") {
      return respondToJsonRpcRequest(workspaceId, message.requestId, {
        decision: message.approved ? "accept" : "decline",
      });
    }
    return false;
  }

  function dispatchJsonRpcTurnStart(
    get: StoreGet,
    set: StoreSet,
    workspaceId: string,
    sessionId: string,
    text: string,
    threadId: string,
    clientMessageId: string,
    attachments?: FileAttachmentInput[],
  ) {
    void startJsonRpcTurn(
      get,
      set,
      workspaceId,
      sessionId,
      text,
      clientMessageId,
      attachments,
    ).catch(() => {
      surfaceJsonRpcTurnSendFailure(set, threadId, {
        pendingTurnStartClientMessageId: clientMessageId,
      });
    });
  }

  function dispatchJsonRpcTurnSteer(
    get: StoreGet,
    set: StoreSet,
    workspaceId: string,
    sessionId: string,
    turnId: string,
    text: string,
    threadId: string,
    clientMessageId: string,
    attachments?: FileAttachmentInput[],
  ) {
    void steerJsonRpcTurn(
      get,
      set,
      workspaceId,
      sessionId,
      turnId,
      text,
      clientMessageId,
      attachments,
    ).catch(() => {
      surfaceJsonRpcTurnSendFailure(set, threadId, { clientMessageId });
    });
  }

  // `true` means the reducer accepted the message locally; JSON-RPC failures
  // still surface asynchronously through the existing protocol-error path.
  function sendUserMessageToThread(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    text: string,
    busyPolicy: ThreadBusyPolicy = "reject",
    attachments?: FileAttachmentInput[],
  ): boolean {
    const trimmed = text.trim();
    const hasAttachments = attachments && attachments.length > 0;
    if (!trimmed && !hasAttachments) return false;
    const attachmentSignature = buildAttachmentSignature(attachments);
    const displayText = buildUserInputDisplayText(trimmed, attachments);

    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return false;
    const workspaceId = thread.workspaceId;

    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId) return false;
    if (rt.pendingTurnStart?.status === "sending") return false;

    if (rt.busy) {
      if (busyPolicy === "queue") {
        queuePendingThreadMessage(threadId, trimmed, attachments);
        return true;
      }

      if (busyPolicy === "steer") {
        if (!rt.activeTurnId) return false;
        if (
          rt.pendingSteer?.status === "sending" &&
          rt.pendingSteer.text.trim() === trimmed &&
          (rt.pendingSteer.attachmentSignature ?? "") === attachmentSignature
        ) {
          return false;
        }

        const clientMessageId = ctx.deps.makeId();
        rememberPendingThreadSteer(threadId, {
          clientMessageId,
          text: trimmed,
          attachmentSignature,
          expectedTurnId: rt.activeTurnId,
          accepted: false,
        });
        set((s) => {
          const nextRt = s.threadRuntimeById[threadId];
          if (!nextRt) return {};
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [threadId]: {
                ...nextRt,
                pendingSteer: {
                  clientMessageId,
                  text: trimmed,
                  attachmentSignature,
                  status: "sending",
                },
              },
            },
          };
        });

        ctx.deps.appendThreadTranscript(threadId, "client", {
          type: "steer_message",
          sessionId: rt.sessionId,
          expectedTurnId: rt.activeTurnId,
          text: displayText,
          clientMessageId,
        });

        dispatchJsonRpcTurnSteer(
          get,
          set,
          workspaceId,
          rt.sessionId,
          rt.activeTurnId,
          trimmed,
          threadId,
          clientMessageId,
          attachments,
        );
        return true;
      }

      return false;
    }

    const clientMessageId = ctx.deps.makeId();
    const optimisticSeen = RUNTIME.optimisticUserMessageIds.get(threadId) ?? new Set<string>();
    optimisticSeen.add(clientMessageId);
    RUNTIME.optimisticUserMessageIds.set(threadId, optimisticSeen);

    set((s) => {
      const nextRt = s.threadRuntimeById[threadId];
      if (!nextRt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...nextRt,
            pendingTurnStart: {
              clientMessageId,
              text: trimmed,
              attachmentSignature,
              status: "sending",
            },
          },
        },
      };
    });

    pushFeedItem(set, threadId, {
      id: clientMessageId,
      kind: "message",
      role: "user",
      ts: ctx.deps.nowIso(),
      text: displayText,
    });

    ctx.deps.appendThreadTranscript(threadId, "client", {
      type: "user_message",
      sessionId: rt.sessionId,
      text: displayText,
      clientMessageId,
    });

    dispatchJsonRpcTurnStart(
      get,
      set,
      workspaceId,
      rt.sessionId,
      trimmed,
      threadId,
      clientMessageId,
      attachments,
    );
    return true;
  }

  function flushOneQueuedThreadMessage(get: StoreGet, set: StoreSet, threadId: string) {
    if (hasPendingWorkspaceDefaultApply(threadId)) {
      return false;
    }
    const next = shiftPendingThreadMessage(threadId);
    if (next === undefined) return false;
    const queuedAttachments = shiftPendingThreadAttachments(threadId);
    const accepted = sendUserMessageToThread(
      get,
      set,
      threadId,
      next,
      undefined,
      queuedAttachments,
    );
    if (!accepted) {
      prependPendingThreadMessageWithAttachments(threadId, next, queuedAttachments);
    }
    return accepted;
  }

  function flushOneQueuedThreadMessageIfReady(get: StoreGet, set: StoreSet, threadId: string) {
    if (get().threadRuntimeById[threadId]?.busy || hasPendingWorkspaceDefaultApply(threadId)) {
      return false;
    }
    return flushOneQueuedThreadMessage(get, set, threadId);
  }

  return {
    sendThread,
    dispatchJsonRpcTurnStart,
    dispatchJsonRpcTurnSteer,
    sendUserMessageToThread,
    flushOneQueuedThreadMessage,
    flushOneQueuedThreadMessageIfReady,
    surfaceJsonRpcTurnSendFailure,
    surfaceJsonRpcThreadStartFailure,
  };
}
