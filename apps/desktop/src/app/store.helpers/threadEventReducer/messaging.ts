import { parseLmStudioUnreachableError } from "../../../lib/lmStudioLocalError";
import type { TurnReference } from "../../../lib/wsProtocol";
import { buildAttachmentSignature, buildUserInputDisplayText } from "../../attachmentInputs";
import { type ComposerDraftRevision, composerDraftKeyForThread } from "../../composerDrafts";
import { findComposerSubmissionById } from "../../composerSubmission";
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
  markPendingThreadSteerAccepted,
  prependPendingThreadMessageWithAttachments,
  queuePendingThreadMessage,
  RUNTIME,
  rememberPendingThreadSteer,
  shiftPendingThreadAttachments,
  shiftPendingThreadMessage,
  shiftPendingThreadReferences,
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
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    attemptedText?: string,
    attemptedAttachments?: FileAttachmentInput[],
    error?: unknown,
  ) {
    const submission = get().composerSubmissionsByKey[composerDraftKeyForThread(threadId)];
    if (submission) get().failComposerSubmission(submission.id, error);
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
    // A queued first message may have set an optimistic pendingTurnStart; clear
    // it so the composer does not stay stuck in the "Sending" state.
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt?.pendingTurnStart) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, pendingTurnStart: null },
        },
      };
    });
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
    options?: { onSettled?: (error?: unknown) => void },
  ): boolean {
    const workspaceId = workspaceIdForThread(get, threadId);
    if (!workspaceId) {
      return false;
    }
    const beginWorkspaceRequest = (run: () => Promise<unknown>): boolean => {
      if (!ensureWorkspaceJsonRpcSocket(get, undefined, workspaceId)) {
        return false;
      }
      void run()
        .then(() => options?.onSettled?.())
        .catch((error) => {
          options?.onSettled?.(error);
          // Callers without a lifecycle callback surface connection errors
          // through their existing false-path/UI state.
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
    references?: TurnReference[],
    draftSubmission?: ComposerDraftRevision,
    retryToolItemIds?: string[],
  ) {
    void startJsonRpcTurn(
      get,
      set,
      workspaceId,
      sessionId,
      text,
      clientMessageId,
      attachments,
      references,
      retryToolItemIds,
    )
      .then(() => {
        if (draftSubmission) get().completeComposerSubmission(draftSubmission);
      })
      .catch((error) => {
        if (draftSubmission?.submissionId) {
          get().failComposerSubmission(draftSubmission.submissionId, error);
        }
        const lmStudio = parseLmStudioUnreachableError(error);
        if (lmStudio) {
          // The server rejected the turn before it reached the session, so the
          // send is retry-safe: keep the optimistic bubble, unblock the
          // composer, and open the start-LM-Studio modal holding the retry
          // payload (same clientMessageId dedups the re-send).
          set((s) => {
            const rt = s.threadRuntimeById[threadId];
            const pendingCleared =
              rt && rt.pendingTurnStart?.clientMessageId === clientMessageId
                ? {
                    threadRuntimeById: {
                      ...s.threadRuntimeById,
                      [threadId]: { ...rt, pendingTurnStart: null },
                    },
                  }
                : {};
            return {
              ...pendingCleared,
              lmStudioStartModal: {
                threadId,
                workspaceId,
                baseUrl: lmStudio.baseUrl,
                installed: lmStudio.installed,
                canAutoStart: lmStudio.canAutoStart,
                phase: "prompt",
                retry: {
                  text,
                  clientMessageId,
                  attachments,
                  references,
                  draftSubmission,
                  retryToolItemIds,
                },
              },
            };
          });
          return;
        }
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
    references?: TurnReference[],
    draftSubmission?: ComposerDraftRevision,
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
      references,
    )
      .then((result) => {
        markPendingThreadSteerAccepted(threadId, clientMessageId, result.steerRequestId);
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          if (!rt || rt.pendingSteer?.clientMessageId !== clientMessageId) return {};
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [threadId]: {
                ...rt,
                pendingSteer: {
                  ...rt.pendingSteer,
                  steerRequestId: result.steerRequestId,
                  status: "accepted",
                },
              },
            },
          };
        });
        if (draftSubmission?.submissionId) {
          const submission = findComposerSubmissionById(
            get().composerSubmissionsByKey,
            draftSubmission.submissionId,
          );
          if (submission?.phase === "sending") {
            get().completeComposerSubmission(draftSubmission);
          }
        } else if (draftSubmission) {
          get().clearComposerDraft(draftSubmission);
        }
      })
      .catch((error) => {
        if (draftSubmission?.submissionId) {
          get().failComposerSubmission(draftSubmission.submissionId, error);
        }
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
    references?: TurnReference[],
    presetClientMessageId?: string,
    draftSubmission?: ComposerDraftRevision,
    retryToolItemIds?: string[],
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
    // A pending turn start blocks new sends, except when it is the optimistic
    // placeholder for this very message (queued at new-chat send time).
    if (
      rt.pendingTurnStart?.status === "sending" &&
      rt.pendingTurnStart.clientMessageId !== presetClientMessageId
    ) {
      return false;
    }

    if (rt.busy) {
      if (busyPolicy === "queue") {
        queuePendingThreadMessage(
          threadId,
          trimmed,
          attachments,
          references,
          presetClientMessageId,
          draftSubmission,
        );
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

        const clientMessageId = presetClientMessageId ?? ctx.deps.makeId();
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
                  ...(draftSubmission?.submissionId
                    ? { submissionId: draftSubmission.submissionId }
                    : {}),
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
          references,
          draftSubmission,
        );
        return true;
      }

      return false;
    }

    const clientMessageId = presetClientMessageId ?? ctx.deps.makeId();
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

    const alreadyInFeed = rt.feed.some((item) => item.id === clientMessageId);
    if (!alreadyInFeed) {
      pushFeedItem(set, threadId, {
        id: clientMessageId,
        kind: "message",
        role: "user",
        ts: ctx.deps.nowIso(),
        text: displayText,
        ...(retryToolItemIds && retryToolItemIds.length > 0
          ? {
              annotations: [
                {
                  type: "cowork.toolRetryTurn",
                  version: 1,
                  targetItemIds: [...retryToolItemIds],
                },
              ],
            }
          : {}),
      });
    }

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
      references,
      draftSubmission,
      retryToolItemIds,
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
    const queuedReferences = shiftPendingThreadReferences(threadId);
    const accepted = sendUserMessageToThread(
      get,
      set,
      threadId,
      next.text,
      undefined,
      queuedAttachments,
      queuedReferences,
      next.clientMessageId,
      next.draftSubmission,
    );
    if (!accepted) {
      prependPendingThreadMessageWithAttachments(
        threadId,
        next.text,
        queuedAttachments,
        queuedReferences,
        next.clientMessageId,
        next.draftSubmission,
      );
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
