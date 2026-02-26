import { AgentSocket } from "../../lib/agentSocket";
import type { ClientMessage, ServerEvent } from "../../lib/wsProtocol";
import { mapModelStreamChunk, type ModelStreamUpdate } from "../modelStream";
import {
  applyModelStreamUpdateToThreadFeed as applyModelStreamUpdateToThreadFeedCore,
  shouldSuppressRawDebugLogLine,
  type ThreadModelStreamRuntime,
} from "../store.feedMapping";
import type { StoreGet, StoreSet } from "../store.helpers";
import type { ApprovalPrompt, AskPrompt, FeedItem, Notification, ThreadTitleSource } from "../types";
import {
  RUNTIME,
  drainPendingThreadMessages,
  ensureThreadRuntime,
  getModelStreamRuntime,
  resetModelStreamRuntime,
} from "./runtimeState";

const MAX_FEED_ITEMS = 2000;

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

  function sendThread(get: StoreGet, threadId: string, build: (sessionId: string) => ClientMessage): boolean {
    const sock = RUNTIME.threadSockets.get(threadId);
    const sessionId = get().threadRuntimeById[threadId]?.sessionId;
    if (!sock || !sessionId) return false;
    return sock.send(build(sessionId));
  }

  function sendUserMessageToThread(get: StoreGet, set: StoreSet, threadId: string, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;

    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return false;

    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId || rt.busy) return false;

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
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        const resumedBusy = evt.isResume ? Boolean(evt.busy) : false;
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              connected: true,
              sessionId: evt.sessionId,
              config: evt.config,
              busy: resumedBusy,
              busySince: resumedBusy ? rt.busySince ?? deps.nowIso() : null,
              transcriptOnly: false,
            },
          },
          threads: s.threads.map((t) =>
            t.id === threadId ? { ...t, status: "active", sessionId: evt.sessionId } : t,
          ),
        };
      });
      deps.persist(get);

      void get().applyWorkspaceDefaultsToThread(threadId);

      if (pendingFirstMessage && pendingFirstMessage.trim()) {
        sendUserMessageToThread(get, set, threadId, pendingFirstMessage);
      }

      const queued = drainPendingThreadMessages(threadId);
      for (const msg of queued) {
        sendUserMessageToThread(get, set, threadId, msg);
      }
      return;
    }

    if (evt.type === "observability_status") {
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
            [threadId]: { ...rt, busy: evt.busy, busySince: evt.busy ? rt.busySince ?? deps.nowIso() : null },
          },
        };
      });
      if (!evt.busy && RUNTIME.pendingWorkspaceDefaultApplyThreadIds.has(threadId)) {
        void get().applyWorkspaceDefaultsToThread(threadId);
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
                  [threadId]: { ...rt, config: nextConfig },
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
      const mapped = mapModelStreamChunk(evt);
      if (mapped) applyModelStreamUpdateToThreadFeed(get, set, threadId, stream, mapped);
      return;
    }

    if (evt.type === "user_message") {
      resetModelStreamRuntime(threadId);
      const cmid = typeof evt.clientMessageId === "string" ? evt.clientMessageId : null;
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
      if (stream.lastAssistantTurnId) {
        const streamed = (stream.assistantTextByTurn.get(stream.lastAssistantTurnId) ?? "").trim();
        if (streamed && streamed === evt.text.trim()) {
          return;
        }
      }

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

    if (evt.type === "reasoning") {
      if (stream.lastReasoningTurnId && stream.reasoningTurns.has(stream.lastReasoningTurnId)) {
        return;
      }

      pushFeedItem(set, threadId, {
        id: deps.makeId(),
        kind: "reasoning",
        mode: evt.kind,
        ts: deps.nowIso(),
        text: evt.text,
      });
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
      return;
    }

    pushFeedItem(set, threadId, {
      id: deps.makeId(),
      kind: "system",
      ts: deps.nowIso(),
      line: `Unhandled event: ${evt.type}`,
    });
  }

  function ensureThreadSocket(
    get: StoreGet,
    set: StoreSet,
    threadId: string,
    url: string,
    pendingFirstMessage?: string,
  ) {
    if (RUNTIME.threadSockets.has(threadId)) return;

    ensureThreadRuntime(get, set, threadId);
    const persistedThreadSessionId = get().threads.find((thread) => thread.id === threadId)?.sessionId ?? undefined;
    const resumeSessionId = get().threadRuntimeById[threadId]?.sessionId ?? persistedThreadSessionId ?? undefined;

    const socket = new AgentSocket({
      url,
      resumeSessionId,
      client: "desktop",
      version: "0.1.0",
      onEvent: (evt) => handleThreadEvent(get, set, threadId, evt, pendingFirstMessage),
      onClose: () => {
        RUNTIME.threadSockets.delete(threadId);
        RUNTIME.modelStreamByThread.delete(threadId);
        RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(threadId);
        set((s) => {
          const rt = s.threadRuntimeById[threadId];
          if (!rt) return {};
          return {
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [threadId]: {
                ...rt,
                connected: false,
                busy: false,
                busySince: null,
              },
            },
            threads: s.threads.map((t) => (t.id === threadId ? { ...t, status: "disconnected" } : t)),
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
