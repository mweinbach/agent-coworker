import { AgentSocket } from "../../lib/agentSocket";
import { VERSION } from "../../lib/version";
import type { ClientMessage, ServerEvent } from "../../lib/wsProtocol";
import {
  mapModelStreamChunk,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
  type ModelStreamUpdate,
} from "../modelStream";
import {
  applyModelStreamUpdateToThreadFeed as applyModelStreamUpdateToThreadFeedCore,
  developerDiagnosticSystemLineFromServerEvent,
  hasMatchingStreamedReasoningText,
  reasoningInsertBeforeAssistantAfterStreamReplay,
  shouldSkipAssistantMessageAfterStreamReplay,
  shouldSuppressRawDebugLogLine,
  unhandledEventSystemLine,
  type ThreadModelStreamRuntime,
} from "../store.feedMapping";
import type { StoreGet, StoreSet } from "../store.helpers";
import type {
  ApprovalPrompt,
  AskPrompt,
  FeedItem,
  Notification,
  ThreadAgentSummary,
  ThreadBusyPolicy,
  ThreadTitleSource,
} from "../types";
import {
  RUNTIME,
  clearPendingThreadSteer,
  clearPendingThreadSteers,
  ensureThreadRuntime,
  getModelStreamRuntime,
  hasPendingThreadSteer,
  markPendingThreadSteerAccepted,
  rememberPendingThreadSteer,
  rekeyThreadRuntimeMaps,
  resetModelStreamRuntime,
  shiftPendingThreadMessage,
} from "./runtimeState";

const MAX_FEED_ITEMS = 2000;

function sortAgentSummaries(agents: ThreadAgentSummary[]): ThreadAgentSummary[] {
  return [...agents].sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    return left.title.localeCompare(right.title);
  });
}

function upsertAgentSummary(agents: ThreadAgentSummary[], nextAgent: ThreadAgentSummary): ThreadAgentSummary[] {
  const nextAgents = agents.filter((agent) => agent.agentId !== nextAgent.agentId);
  nextAgents.push(nextAgent);
  return sortAgentSummaries(nextAgents);
}

type ThreadEventReducerDeps = {
  nowIso: () => string;
  makeId: () => string;
  persist: (get: StoreGet) => void;
  appendThreadTranscript: (threadId: string, direction: "server" | "client", payload: unknown) => void;
  pushNotification: (notifications: Notification[], entry: Notification) => Notification[];
  normalizeThreadTitleSource: (source: unknown, fallbackTitle: string) => ThreadTitleSource;
  shouldAdoptServerTitle: (opts: {
    currentSource: ThreadTitleSource;
    incomingTitle: string;
    incomingSource: ThreadTitleSource;
  }) => boolean;
};

export function createThreadEventReducer(deps: ThreadEventReducerDeps) {
  function migrateThreadIdentity(get: StoreGet, set: StoreSet, fromThreadId: string, toThreadId: string): string {
    if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) {
      return toThreadId;
    }

    rekeyThreadRuntimeMaps(fromThreadId, toThreadId);
    set((s) => {
      const existingThread = s.threads.find((thread) => thread.id === fromThreadId);
      const existingRuntime = s.threadRuntimeById[fromThreadId];
      const replacementThread = s.threads.find((thread) => thread.id === toThreadId);
      const replacementRuntime = s.threadRuntimeById[toThreadId];

      const nextThreads = replacementThread
        ? s.threads
            .filter((thread) => thread.id !== fromThreadId)
            .map((thread) =>
              thread.id === toThreadId && existingThread?.legacyTranscriptId && !thread.legacyTranscriptId
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
                    thread.legacyTranscriptId
                    ?? (thread.id !== toThreadId ? thread.id : null),
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
        nextLatestTodosByThreadId[toThreadId] = nextLatestTodosByThreadId[fromThreadId]!;
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

  function pushFeedItem(set: StoreSet, threadId: string, item: FeedItem) {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      let nextFeed = [...rt.feed, item];
      if (nextFeed.length > MAX_FEED_ITEMS) {
        nextFeed = nextFeed.slice(nextFeed.length - MAX_FEED_ITEMS);
      }
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, feed: nextFeed },
        },
      };
    });
  }

  function updateFeedItem(set: StoreSet, threadId: string, itemId: string, update: (item: FeedItem) => FeedItem) {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            feed: rt.feed.map((item) => (item.id === itemId ? update(item) : item)),
          },
        },
      };
    });
  }

  function insertFeedItemBefore(set: StoreSet, threadId: string, beforeItemId: string, item: FeedItem) {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      const beforeIndex = rt.feed.findIndex((entry) => entry.id === beforeItemId);
      if (beforeIndex < 0) {
        let nextFeed = [...rt.feed, item];
        if (nextFeed.length > MAX_FEED_ITEMS) {
          nextFeed = nextFeed.slice(nextFeed.length - MAX_FEED_ITEMS);
        }
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...rt, feed: nextFeed },
          },
        };
      }

      const nextFeed = [...rt.feed];
      nextFeed.splice(beforeIndex, 0, item);
      const trimmedFeed =
        nextFeed.length > MAX_FEED_ITEMS ? nextFeed.slice(nextFeed.length - MAX_FEED_ITEMS) : nextFeed;
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, feed: trimmedFeed },
        },
      };
    });
  }

  function sendThread(get: StoreGet, threadId: string, build: (sessionId: string) => ClientMessage): boolean {
    const sock = RUNTIME.threadSockets.get(threadId);
    const sessionId = get().threadRuntimeById[threadId]?.sessionId;
    if (!sock || !sessionId) return false;
    return sock.send(build(sessionId));
  }

  function sendUserMessageToThread(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    text: string,
    busyPolicy: ThreadBusyPolicy = "reject",
  ): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;

    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return false;

    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId) return false;

    if (rt.busy) {
      if (busyPolicy === "queue") {
        RUNTIME.pendingThreadMessages.set(threadId, [
          ...(RUNTIME.pendingThreadMessages.get(threadId) ?? []),
          trimmed,
        ]);
        return true;
      }

      if (busyPolicy === "steer") {
        if (!rt.activeTurnId) return false;
        if (rt.pendingSteer?.status === "sending" && rt.pendingSteer.text.trim() === trimmed) {
          return false;
        }

        const clientMessageId = deps.makeId();
        rememberPendingThreadSteer(threadId, {
          clientMessageId,
          text: trimmed,
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
                  status: "sending",
                },
              },
            },
          };
        });

        deps.appendThreadTranscript(threadId, "client", {
          type: "steer_message",
          sessionId: rt.sessionId,
          expectedTurnId: rt.activeTurnId,
          text: trimmed,
          clientMessageId,
        });

        const ok = sendThread(get, threadId, (sessionId) => ({
          type: "steer_message",
          sessionId,
          expectedTurnId: rt.activeTurnId!,
          text: trimmed,
          clientMessageId,
        }));

        if (!ok) {
          clearPendingThreadSteer(threadId, clientMessageId);
          set((s) => {
            const nextRt = s.threadRuntimeById[threadId];
            if (!nextRt || nextRt.pendingSteer?.clientMessageId !== clientMessageId) return {};
            return {
              threadRuntimeById: {
                ...s.threadRuntimeById,
                [threadId]: {
                  ...nextRt,
                  pendingSteer: null,
                },
              },
            };
          });
          pushFeedItem(set, threadId, {
            id: deps.makeId(),
            kind: "error",
            ts: deps.nowIso(),
            message: "Not connected. Reconnect to continue.",
            code: "internal_error",
            source: "protocol",
          });
        }

        return ok;
      }

      return false;
    }

    const clientMessageId = deps.makeId();
    const optimisticSeen = RUNTIME.optimisticUserMessageIds.get(threadId) ?? new Set<string>();
    optimisticSeen.add(clientMessageId);
    RUNTIME.optimisticUserMessageIds.set(threadId, optimisticSeen);

    pushFeedItem(set, threadId, {
      id: clientMessageId,
      kind: "message",
      role: "user",
      ts: deps.nowIso(),
      text: trimmed,
    });

    deps.appendThreadTranscript(threadId, "client", {
      type: "user_message",
      sessionId: rt.sessionId,
      text: trimmed,
      clientMessageId,
    });

    const ok = sendThread(get, threadId, (sessionId) => ({
      type: "user_message",
      sessionId,
      text: trimmed,
      clientMessageId,
    }));

    if (!ok) {
      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "error",
        ts: deps.nowIso(),
        message: "Not connected. Reconnect to continue.",
        code: "internal_error",
        source: "protocol",
      });
      return false;
    }

    return true;
  }

  function flushOneQueuedThreadMessage(get: StoreGet, set: StoreSet, threadId: string) {
    const next = shiftPendingThreadMessage(threadId);
    if (!next) return false;
    const ok = sendUserMessageToThread(get, set, threadId, next);
    if (!ok) {
      RUNTIME.pendingThreadMessages.set(threadId, [
        next,
        ...(RUNTIME.pendingThreadMessages.get(threadId) ?? []),
      ]);
    }
    return ok;
  }

  function applyModelStreamUpdateToThreadFeed(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    stream: ThreadModelStreamRuntime,
    update: ModelStreamUpdate,
  ) {
    applyModelStreamUpdateToThreadFeedCore(stream, update, {
      makeId: deps.makeId,
      nowIso: deps.nowIso,
      pushFeedItem: (item) => {
        pushFeedItem(set, threadId, item);
      },
      updateFeedItem: (itemId, updateItem) => {
        updateFeedItem(set, threadId, itemId, updateItem);
      },
      onToolTerminal: () => {
        const thread = get().threads.find((t) => t.id === threadId);
        if (thread) {
          void get().refreshWorkspaceFiles(thread.workspaceId);
        }
      },
    });
  }

  function handleThreadEvent(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    evt: ServerEvent,
    pendingFirstMessage?: string,
    pendingFirstMessageQueued = false,
  ) {
    if (evt.type !== "server_hello") {
      const activeSessionId = get().threadRuntimeById[threadId]?.sessionId;
      if (!activeSessionId || evt.sessionId !== activeSessionId) {
        return;
      }
    }

    deps.appendThreadTranscript(threadId, "server", evt);
    set((s) => ({
      threads: s.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, lastEventSeq: Math.max(0, Math.floor((thread.lastEventSeq ?? 0) + 1)) }
          : thread,
      ),
    }));
    void deps.persist(get);
    const stream = getModelStreamRuntime(threadId);

    if (evt.type === "server_hello") {
      resetModelStreamRuntime(threadId);
      const resumedBusy = evt.isResume ? Boolean(evt.busy) : false;
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
              agents: sessionKind === "agent" ? [] : (evt.isResume ? rt.agents : []),
              busy: resumedBusy,
              busySince: resumedBusy ? rt.busySince ?? deps.nowIso() : null,
              activeTurnId: resumedBusy ? (evt.turnId ?? null) : null,
              pendingSteer: resumedBusy ? rt.pendingSteer : null,
              transcriptOnly: false,
            },
          },
          threads: s.threads.map((t) =>
            t.id === threadId ? { ...t, status: "active", sessionId: evt.sessionId, draft: false } : t,
          ),
        };
      });
      deps.persist(get);
      if (!resumedBusy) {
        clearPendingThreadSteers(threadId);
      }

      void get().applyWorkspaceDefaultsToThread(threadId, evt.isResume ? "auto-resume" : "auto");
      RUNTIME.threadSockets.get(threadId)?.send({
        type: "get_session_usage",
        sessionId: evt.sessionId,
      });
      if ((evt.sessionKind ?? "root") !== "agent") {
        RUNTIME.threadSockets.get(threadId)?.send({
          type: "agent_list_get",
          sessionId: evt.sessionId,
        });
      }

      let sentPendingFirstMessage = false;
      if (pendingFirstMessage && pendingFirstMessage.trim()) {
        if (resumedBusy) {
          if (!pendingFirstMessageQueued) {
            RUNTIME.pendingThreadMessages.set(threadId, [
              pendingFirstMessage.trim(),
              ...(RUNTIME.pendingThreadMessages.get(threadId) ?? []),
            ]);
          }
        } else {
          sentPendingFirstMessage = pendingFirstMessageQueued
            ? flushOneQueuedThreadMessage(get, set, threadId)
            : sendUserMessageToThread(get, set, threadId, pendingFirstMessage);
        }
      }

      if (!resumedBusy && !sentPendingFirstMessage) {
        flushOneQueuedThreadMessage(get, set, threadId);
      }
      return;
    }

    if (evt.type === "observability_status") {
      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "system",
        ts: deps.nowIso(),
        line: developerDiagnosticSystemLineFromServerEvent(evt),
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
      return;
    }

    if (evt.type === "session_busy") {
      resetModelStreamRuntime(threadId);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              busy: evt.busy,
              busySince: evt.busy ? rt.busySince ?? deps.nowIso() : null,
              activeTurnId: evt.busy ? (evt.turnId ?? rt.activeTurnId) : null,
              pendingSteer: evt.busy ? rt.pendingSteer : null,
            },
          },
        };
      });
      if (!evt.busy && RUNTIME.pendingWorkspaceDefaultApplyThreadIds.has(threadId)) {
        const pendingMode = RUNTIME.pendingWorkspaceDefaultApplyModeByThread.get(threadId) ?? "auto";
        void get().applyWorkspaceDefaultsToThread(threadId, pendingMode);
      }
      if (!evt.busy) {
        clearPendingThreadSteers(threadId);
        flushOneQueuedThreadMessage(get, set, threadId);
      }
      return;
    }

    if (evt.type === "steer_accepted") {
      if (typeof evt.clientMessageId === "string") {
        markPendingThreadSteerAccepted(threadId, evt.clientMessageId);
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          const pendingSteer = rt?.pendingSteer;
          if (!rt || !pendingSteer || pendingSteer.clientMessageId !== evt.clientMessageId) return {};
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
      if (activeThreadId === threadId && composerText.length > 0 && composerText === evt.text.trim()) {
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
      return;
    }

    if (evt.type === "session_info") {
      let titleChanged = false;
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        const nextConfig = rt?.config
          ? {
              ...rt.config,
              provider: evt.provider,
              model: evt.model,
            }
          : rt?.config ?? null;
        const incomingTitle = evt.title.trim();
        const incomingSource = deps.normalizeThreadTitleSource(evt.titleSource, incomingTitle || evt.title);
        const nextThreads = s.threads.map((t) => {
          if (t.id !== threadId) return t;
          const currentSource = deps.normalizeThreadTitleSource(t.titleSource, t.title);
          if (!deps.shouldAdoptServerTitle({
            currentSource,
            incomingTitle,
            incomingSource,
          })) {
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
                    requestedReasoningEffort: evt.requestedReasoningEffort ?? rt.requestedReasoningEffort,
                    effectiveReasoningEffort: evt.effectiveReasoningEffort ?? rt.effectiveReasoningEffort,
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
        void deps.persist(get);
      }
      return;
    }

    if (evt.type === "session_backup_state" || evt.type === "harness_context") {
      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "system",
        ts: deps.nowIso(),
        line: developerDiagnosticSystemLineFromServerEvent(evt),
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
      const prompt: AskPrompt = { requestId: evt.requestId, question: evt.question, options: evt.options };
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
      resetModelStreamRuntime(threadId);
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
      if (cmid) {
        const seen = RUNTIME.optimisticUserMessageIds.get(threadId);
        if (seen && seen.has(cmid)) return;
      }

      pushFeedItem(set, threadId, {
        id: cmid || deps.makeId(),
        kind: "message",
        role: "user",
        ts: deps.nowIso(),
        text: evt.text,
      });

      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                lastMessageAt: deps.nowIso(),
              }
            : t,
        ),
      }));
      void deps.persist(get);
      return;
    }

    if (evt.type === "assistant_message") {
      const existingFeed = get().threadRuntimeById[threadId]?.feed ?? [];
      if (shouldSkipAssistantMessageAfterStreamReplay(stream, evt.text, existingFeed)) return;

      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "message",
        role: "assistant",
        ts: deps.nowIso(),
        text: evt.text,
      });

      set((s) => ({
        threads: s.threads.map((t) => (t.id === threadId ? { ...t, lastMessageAt: deps.nowIso() } : t)),
      }));
      void deps.persist(get);
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
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
          kind: evt.type === "budget_exceeded" ? "error" : "info",
          title: evt.type === "budget_exceeded" ? "Session hard cap exceeded" : "Session budget warning",
          detail: evt.message,
        }),
      }));
      return;
    }

    if (evt.type === "reasoning") {
      if (hasMatchingStreamedReasoningText(stream, evt.text)) {
        return;
      }

      const item: FeedItem = {
        id: deps.makeId(),
        kind: "reasoning",
        mode: evt.kind,
        ts: deps.nowIso(),
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
      pushFeedItem(set, threadId, { id: deps.makeId(), kind: "todos", ts: deps.nowIso(), todos: evt.todos });
      return;
    }

    if (evt.type === "log") {
      if (shouldSuppressRawDebugLogLine(evt.line)) {
        return;
      }
      pushFeedItem(set, threadId, { id: deps.makeId(), kind: "log", ts: deps.nowIso(), line: evt.line });
      return;
    }

    if (evt.type === "error") {
      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "error",
        ts: deps.nowIso(),
        message: evt.message,
        code: evt.code,
        source: evt.source,
      });
      set((s) => ({
        notifications: deps.pushNotification(s.notifications, {
          id: deps.makeId(),
          ts: deps.nowIso(),
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
      id: deps.makeId(),
      kind: "system",
      ts: deps.nowIso(),
      line: unhandledEventSystemLine(evt.type),
    });
  }

  function ensureThreadSocket(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    url: string,
    pendingFirstMessage?: string,
    pendingFirstMessageQueued = false,
  ) {
    if (RUNTIME.threadSockets.has(threadId)) return;

    ensureThreadRuntime(get, set, threadId);
    const persistedThreadSessionId = get().threads.find((thread) => thread.id === threadId)?.sessionId ?? undefined;
    const resumeSessionId = get().threadRuntimeById[threadId]?.sessionId ?? persistedThreadSessionId ?? undefined;
    let activeThreadId = threadId;

    const socket = new AgentSocket({
      url,
      resumeSessionId,
      client: "desktop",
      version: VERSION,
      autoReconnect: true,
      onEvent: (evt) => {
        if (evt.type === "server_hello" && activeThreadId !== evt.sessionId) {
          activeThreadId = migrateThreadIdentity(get, set, activeThreadId, evt.sessionId);
        }
        handleThreadEvent(get, set, activeThreadId, evt, pendingFirstMessage, pendingFirstMessageQueued);
      },
      onClose: () => {
        RUNTIME.threadSockets.delete(activeThreadId);
        RUNTIME.modelStreamByThread.delete(activeThreadId);
        RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(activeThreadId);
        RUNTIME.pendingWorkspaceDefaultApplyModeByThread.delete(activeThreadId);
        set((s) => {
          const rt = s.threadRuntimeById[activeThreadId];
          if (!rt) return {};
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [activeThreadId]: {
                ...rt,
                connected: false,
                busy: false,
                busySince: null,
                activeTurnId: null,
                pendingSteer: rt.pendingSteer,
              },
            },
            threads: s.threads.map((t) => (t.id === activeThreadId ? { ...t, status: "disconnected" } : t)),
          };
        });
        void deps.persist(get);
      },
    });

    RUNTIME.threadSockets.set(threadId, socket);
    socket.connect();

    set((s) => ({
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [threadId]: { ...s.threadRuntimeById[threadId], wsUrl: url },
      },
    }));
  }

  return {
    ensureThreadSocket,
    sendThread,
    sendUserMessageToThread,
  };
}
