import type { SessionEvent } from "../../../lib/wsProtocol";
import {
  mapModelStreamChunk,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
} from "../../modelStream";
import {
  developerDiagnosticSystemLineFromSessionEvent,
  hasMatchingStreamedReasoningText,
  reasoningInsertBeforeAssistantAfterStreamReplay,
  shouldSkipAssistantMessageAfterStreamReplay,
  shouldSuppressRawDebugLogLine,
  unhandledEventSystemLine,
  upsertAgentSummary,
} from "../../store.feedMapping";
import {
  clearPendingThreadSteer,
  clearPendingThreadSteers,
  getModelStreamRuntime,
  hasPendingThreadSteer,
  markPendingThreadSteerAccepted,
  prependPendingThreadMessage,
  RUNTIME,
  shiftPendingThreadAttachments,
} from "../runtimeState";
import type { StoreGet, StoreSet } from "../../store.helpers";
import {
  type ApprovalPrompt,
  type AskPrompt,
  type FeedItem,
} from "../../types";
import { sortAgentSummaries } from "../threadEventReducerContext";
import type { ThreadEventReducerContext } from "./context";
import type { FeedProjectionModule } from "./feedProjection";
import type { MessagingModule } from "./messaging";
import type { WorkspaceStateHelpers } from "./workspaceState";

export function createHandlersModule(
  ctx: ThreadEventReducerContext,
  workspace: Pick<
    WorkspaceStateHelpers,
    "hasPendingWorkspaceDefaultApply" | "resetLiveModelStreamRuntime"
  >,
  feed: FeedProjectionModule,
  messaging: Pick<
    MessagingModule,
    | "sendUserMessageToThread"
    | "flushOneQueuedThreadMessage"
    | "flushOneQueuedThreadMessageIfReady"
  >,
) {
  const { deps } = ctx;
  const {
    pushFeedItem,
    insertFeedItemBefore,
    applyModelStreamUpdateToThreadFeed,
  } = feed;
  const {
    sendUserMessageToThread,
    flushOneQueuedThreadMessage,
    flushOneQueuedThreadMessageIfReady,
  } = messaging;
  const { hasPendingWorkspaceDefaultApply, resetLiveModelStreamRuntime } = workspace;
  function handleThreadEvent(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    evt: SessionEvent,
    pendingFirstMessage?: string,
    pendingFirstMessageQueued = false,
  ) {
    if (evt.type !== "server_hello") {
      const activeSessionId = get().threadRuntimeById[threadId]?.sessionId;
      if (!activeSessionId || evt.sessionId !== activeSessionId) {
        return;
      }
    }

    ctx.deps.appendThreadTranscript(threadId, "server", evt);
    set((s) => ({
      threads: s.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, lastEventSeq: Math.max(0, Math.floor((thread.lastEventSeq ?? 0) + 1)) }
          : thread,
      ),
    }));
    void ctx.deps.persist(get);
    const stream = getModelStreamRuntime(threadId);

    if (evt.type === "server_hello") {
      resetLiveModelStreamRuntime(threadId);
      const resumedBusy = evt.isResume ? Boolean(evt.busy) : false;
      const prevRt = get().threadRuntimeById[threadId];
      const draftModelSelection =
        prevRt?.draftComposerProvider != null &&
        typeof prevRt.draftComposerModel === "string" &&
        prevRt.draftComposerModel.trim()
          ? { provider: prevRt.draftComposerProvider, model: prevRt.draftComposerModel.trim() }
          : null;
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        const sessionKind = evt.sessionKind ?? "root";
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              connected: true,
              sessionId: evt.sessionId,
              config: evt.config,
              sessionKind,
              parentSessionId: evt.parentSessionId ?? null,
              role: evt.role ?? null,
              mode: evt.mode ?? null,
              depth: typeof evt.depth === "number" ? evt.depth : 0,
              nickname: evt.nickname ?? null,
              requestedModel: evt.requestedModel ?? null,
              effectiveModel: evt.effectiveModel ?? null,
              requestedReasoningEffort: evt.requestedReasoningEffort ?? null,
              effectiveReasoningEffort: evt.effectiveReasoningEffort ?? null,
              executionState: evt.executionState ?? null,
              lastMessagePreview: evt.lastMessagePreview ?? null,
              agents: sessionKind === "agent" ? [] : evt.isResume ? rt.agents : [],
              busy: resumedBusy,
              busySince: resumedBusy ? (rt.busySince ?? ctx.deps.nowIso()) : null,
              activeTurnId: resumedBusy ? (evt.turnId ?? null) : null,
              pendingSteer: resumedBusy ? rt.pendingSteer : null,
              transcriptOnly: false,
              draftComposerProvider: null,
              draftComposerModel: null,
            },
          },
          threads: s.threads.map((t) =>
            t.id === threadId
              ? { ...t, status: "active", sessionId: evt.sessionId, draft: false }
              : t,
          ),
        };
      });
      ctx.deps.persist(get);
      if (!resumedBusy) {
        clearPendingThreadSteers(threadId);
      }

      void get().applyWorkspaceDefaultsToThread(
        threadId,
        evt.isResume ? "auto-resume" : "auto",
        draftModelSelection,
        { allowBeforeHydration: !evt.isResume },
      );
      let acceptedPendingFirstMessage = false;
      if (pendingFirstMessage?.trim()) {
        if (resumedBusy) {
          if (!pendingFirstMessageQueued) {
            prependPendingThreadMessage(threadId, pendingFirstMessage);
          }
        } else if (hasPendingWorkspaceDefaultApply(threadId)) {
          if (!pendingFirstMessageQueued) {
            prependPendingThreadMessage(threadId, pendingFirstMessage);
          }
        } else {
          if (pendingFirstMessageQueued) {
            acceptedPendingFirstMessage = flushOneQueuedThreadMessageIfReady(get, set, threadId);
          } else {
            const firstMsgAttachments = shiftPendingThreadAttachments(threadId);
            acceptedPendingFirstMessage = sendUserMessageToThread(
              get,
              set,
              threadId,
              pendingFirstMessage,
              undefined,
              firstMsgAttachments,
            );
          }
        }
      }

      if (!resumedBusy && !acceptedPendingFirstMessage) {
        flushOneQueuedThreadMessageIfReady(get, set, threadId);
      }
      return;
    }

    if (evt.type === "observability_status") {
      pushFeedItem(set, threadId, {
        id: ctx.deps.makeId(),
        kind: "system",
        ts: ctx.deps.nowIso(),
        line: developerDiagnosticSystemLineFromSessionEvent(evt),
      });
      return;
    }

    if (evt.type === "session_settings") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...rt, enableMcp: evt.enableMcp },
          },
        };
      });
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
      if (pendingApply && !pendingApply.inFlight) {
        void get().applyWorkspaceDefaultsToThread(
          threadId,
          pendingApply.mode,
          pendingApply.draftModelSelection,
        );
        flushOneQueuedThreadMessageIfReady(get, set, threadId);
      }
      return;
    }

    if (evt.type === "session_busy") {
      resetLiveModelStreamRuntime(threadId);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              busy: evt.busy,
              busySince: evt.busy ? (rt.busySince ?? ctx.deps.nowIso()) : null,
              activeTurnId: evt.busy ? (evt.turnId ?? rt.activeTurnId) : null,
              pendingTurnStart: null,
              pendingSteer: evt.busy ? rt.pendingSteer : null,
            },
          },
        };
      });
      if (!evt.busy) {
        const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
        if (pendingApply && !pendingApply.inFlight) {
          void get().applyWorkspaceDefaultsToThread(
            threadId,
            pendingApply.mode,
            pendingApply.draftModelSelection,
          );
        }
      }
      if (!evt.busy) {
        clearPendingThreadSteers(threadId);
        flushOneQueuedThreadMessageIfReady(get, set, threadId);
      }
      return;
    }

    if (evt.type === "steer_accepted") {
      if (typeof evt.clientMessageId === "string") {
        markPendingThreadSteerAccepted(threadId, evt.clientMessageId);
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          const pendingSteer = rt?.pendingSteer;
          if (!rt || !pendingSteer || pendingSteer.clientMessageId !== evt.clientMessageId)
            return {};
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [threadId]: {
                ...rt,
                pendingSteer: {
                  ...pendingSteer,
                  status: "accepted",
                },
              },
            },
          };
        });
      }
      const activeThreadId = get().selectedThreadId;
      const composerText = get().composerText.trim();
      if (
        activeThreadId === threadId &&
        composerText.length > 0 &&
        composerText === evt.text.trim()
      ) {
        set({ composerText: "" });
      }
      return;
    }

    if (evt.type === "config_updated") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...rt, config: evt.config },
          },
        };
      });
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
      if (pendingApply && !pendingApply.inFlight) {
        void get().applyWorkspaceDefaultsToThread(
          threadId,
          pendingApply.mode,
          pendingApply.draftModelSelection,
        );
      }
      return;
    }

    if (evt.type === "session_config") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...rt, sessionConfig: evt.config },
          },
        };
      });
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
      if (pendingApply && !pendingApply.inFlight) {
        void get().applyWorkspaceDefaultsToThread(
          threadId,
          pendingApply.mode,
          pendingApply.draftModelSelection,
        );
        flushOneQueuedThreadMessageIfReady(get, set, threadId);
      }
      return;
    }

    if (evt.type === "session_info") {
      let titleChanged = false;
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        const nextConfig = rt?.config
          ? {
              ...rt.config,
              provider: rt.config.provider ?? evt.provider,
              model: rt.config.model ?? evt.model,
            }
          : (rt?.config ?? null);
        const incomingTitle = evt.title.trim();
        const incomingSource = ctx.deps.normalizeThreadTitleSource(
          evt.titleSource,
          incomingTitle || evt.title,
        );
        const nextThreads = s.threads.map((t) => {
          if (t.id !== threadId) return t;
          const currentSource = ctx.deps.normalizeThreadTitleSource(t.titleSource, t.title);
          if (
            !ctx.deps.shouldAdoptServerTitle({
              currentSource,
              incomingTitle,
              incomingSource,
            })
          ) {
            return t;
          }

          const nextTitle = incomingTitle || t.title;
          if (nextTitle === t.title && currentSource === incomingSource) {
            return t;
          }

          titleChanged = true;
          return {
            ...t,
            title: nextTitle,
            titleSource: incomingSource,
          };
        });
        return {
          threads: nextThreads,
          ...(rt
            ? {
                threadRuntimeById: {
                  ...s.threadRuntimeById,
                  [threadId]: {
                    ...rt,
                    config: nextConfig,
                    sessionKind: evt.sessionKind ?? rt.sessionKind,
                    parentSessionId: evt.parentSessionId ?? rt.parentSessionId,
                    role: evt.role ?? rt.role,
                    mode: evt.mode ?? rt.mode,
                    depth: typeof evt.depth === "number" ? evt.depth : rt.depth,
                    nickname: evt.nickname ?? rt.nickname,
                    requestedModel: evt.requestedModel ?? rt.requestedModel,
                    effectiveModel: evt.effectiveModel ?? rt.effectiveModel,
                    requestedReasoningEffort:
                      evt.requestedReasoningEffort ?? rt.requestedReasoningEffort,
                    effectiveReasoningEffort:
                      evt.effectiveReasoningEffort ?? rt.effectiveReasoningEffort,
                    executionState: evt.executionState ?? rt.executionState,
                    lastMessagePreview: evt.lastMessagePreview ?? rt.lastMessagePreview,
                    agents: (evt.sessionKind ?? rt.sessionKind) === "agent" ? [] : rt.agents,
                  },
                },
              }
            : {}),
        };
      });
      if (titleChanged) {
        void ctx.deps.persist(get);
      }
      return;
    }

    if (evt.type === "session_backup_state" || evt.type === "harness_context") {
      pushFeedItem(set, threadId, {
        id: ctx.deps.makeId(),
        kind: "system",
        ts: ctx.deps.nowIso(),
        line: developerDiagnosticSystemLineFromSessionEvent(evt),
      });
      return;
    }

    if (evt.type === "agent_list") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              agents: sortAgentSummaries(evt.agents),
            },
          },
        };
      });
      return;
    }

    if (evt.type === "agent_spawned" || evt.type === "agent_status") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              agents: upsertAgentSummary(rt.agents, evt.agent),
            },
          },
        };
      });
      return;
    }

    if (evt.type === "agent_wait_result") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        let nextAgents = rt.agents;
        for (const agent of evt.agents) {
          nextAgents = upsertAgentSummary(nextAgents, agent);
        }
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              agents: nextAgents,
            },
          },
        };
      });
      return;
    }

    if (evt.type === "ask") {
      const prompt: AskPrompt = {
        requestId: evt.requestId,
        question: evt.question,
        options: evt.options,
      };
      set(() => ({ promptModal: { kind: "ask", threadId, prompt } }));
      return;
    }

    if (evt.type === "approval") {
      const prompt: ApprovalPrompt = {
        requestId: evt.requestId,
        command: evt.command,
        dangerous: evt.dangerous,
        reasonCode: evt.reasonCode,
      };
      set(() => ({ promptModal: { kind: "approval", threadId, prompt } }));
      return;
    }

    if (evt.type === "model_stream_chunk") {
      if (shouldIgnoreNormalizedChunkForRawBackedTurn(stream.replay, evt)) {
        return;
      }
      const mapped = mapModelStreamChunk(evt);
      if (mapped) applyModelStreamUpdateToThreadFeed(get, set, threadId, stream, mapped);
      return;
    }

    if (evt.type === "model_stream_raw") {
      const updates = replayModelStreamRawEvent(stream.replay, evt);
      for (const update of updates) {
        applyModelStreamUpdateToThreadFeed(get, set, threadId, stream, update);
      }
      return;
    }

    if (evt.type === "user_message") {
      resetLiveModelStreamRuntime(threadId);
      const cmid = typeof evt.clientMessageId === "string" ? evt.clientMessageId : null;
      if (cmid && hasPendingThreadSteer(threadId, cmid)) {
        clearPendingThreadSteer(threadId, cmid);
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          if (!rt || rt.pendingSteer?.clientMessageId !== cmid) return {};
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
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt?.pendingTurnStart) return {};
        if (cmid && rt.pendingTurnStart.clientMessageId !== cmid) return {};
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
      if (cmid) {
        const seen = RUNTIME.optimisticUserMessageIds.get(threadId);
        if (seen?.has(cmid)) return;
      }

      pushFeedItem(set, threadId, {
        id: cmid || ctx.deps.makeId(),
        kind: "message",
        role: "user",
        ts: ctx.deps.nowIso(),
        text: evt.text,
      });

      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                lastMessageAt: ctx.deps.nowIso(),
              }
            : t,
        ),
      }));
      void ctx.deps.persist(get);
      return;
    }

    if (evt.type === "assistant_message") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt?.pendingTurnStart) return {};
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
      const existingFeed = get().threadRuntimeById[threadId]?.feed ?? [];
      if (shouldSkipAssistantMessageAfterStreamReplay(stream, evt.text, existingFeed)) return;

      pushFeedItem(set, threadId, {
        id: ctx.deps.makeId(),
        kind: "message",
        role: "assistant",
        ts: ctx.deps.nowIso(),
        text: evt.text,
      });

      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, lastMessageAt: ctx.deps.nowIso() } : t,
        ),
      }));
      void ctx.deps.persist(get);
      return;
    }

    if (evt.type === "turn_usage") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              lastTurnUsage: {
                turnId: evt.turnId,
                usage: evt.usage,
              },
            },
          },
        };
      });
      return;
    }

    if (evt.type === "session_usage") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              sessionUsage: evt.usage,
            },
          },
        };
      });
      return;
    }

    if (evt.type === "budget_warning" || evt.type === "budget_exceeded") {
      set((s) => ({
        notifications: ctx.deps.pushNotification(s.notifications, {
          id: ctx.deps.makeId(),
          ts: ctx.deps.nowIso(),
          kind: evt.type === "budget_exceeded" ? "error" : "info",
          title:
            evt.type === "budget_exceeded" ? "Session hard cap exceeded" : "Session budget warning",
          detail: evt.message,
        }),
      }));
      return;
    }

    if (evt.type === "reasoning") {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt?.pendingTurnStart) return {};
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
      if (hasMatchingStreamedReasoningText(stream, evt.text)) {
        return;
      }

      const item: FeedItem = {
        id: ctx.deps.makeId(),
        kind: "reasoning",
        mode: evt.kind,
        ts: ctx.deps.nowIso(),
        text: evt.text,
      };
      const beforeAssistantId = reasoningInsertBeforeAssistantAfterStreamReplay(stream);
      if (beforeAssistantId) {
        insertFeedItemBefore(set, threadId, beforeAssistantId, item);
        return;
      }

      pushFeedItem(set, threadId, item);
      return;
    }

    if (evt.type === "todos") {
      set((s) => ({
        latestTodosByThreadId: { ...s.latestTodosByThreadId, [threadId]: evt.todos },
      }));
      pushFeedItem(set, threadId, {
        id: ctx.deps.makeId(),
        kind: "todos",
        ts: ctx.deps.nowIso(),
        todos: evt.todos,
      });
      return;
    }

    if (evt.type === "log") {
      if (shouldSuppressRawDebugLogLine(evt.line)) {
        return;
      }
      pushFeedItem(set, threadId, {
        id: ctx.deps.makeId(),
        kind: "log",
        ts: ctx.deps.nowIso(),
        line: evt.line,
      });
      return;
    }

    if (evt.type === "error") {
      pushFeedItem(set, threadId, {
        id: ctx.deps.makeId(),
        kind: "error",
        ts: ctx.deps.nowIso(),
        message: evt.message,
        code: evt.code,
        source: evt.source,
      });
      set((s) => ({
        notifications: ctx.deps.pushNotification(s.notifications, {
          id: ctx.deps.makeId(),
          ts: ctx.deps.nowIso(),
          kind: "error",
          title: "Agent error",
          detail: `${evt.source}/${evt.code}: ${evt.message}`,
        }),
      }));
      if (evt.code === "validation_failed") {
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          if (!rt?.pendingSteer) return {};
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
        clearPendingThreadSteers(threadId);
      }
      return;
    }

    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "system",
      ts: ctx.deps.nowIso(),
      line: unhandledEventSystemLine(evt.type),
    });
  }

  return { handleThreadEvent };
}
