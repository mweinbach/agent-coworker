import { create } from "zustand";

import type {
  CoworkThread,
  ProjectedItem,
  SessionFeedItem,
  SessionSnapshotLike,
} from "./protocolTypes";
import {
  applyAgentDelta,
  applyProjectedCompletion,
  applyProjectedStart,
  applyReasoningDelta,
} from "./snapshotReducer";

export type MobileThreadSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAtLabel: string;
  cwd: string | null;
  projectName: string | null;
  feed: SessionFeedItem[];
  composerDraft: string;
  pendingPrompt: boolean;
  pendingServerRequest: PendingServerRequest | null;
};

export type MobileThreadFeedEntry = SessionFeedItem;

export type PendingServerRequest =
  | {
      requestId: string | number;
      kind: "ask";
      threadId: string;
      itemId: string;
      question: string;
      options: string[];
    }
  | {
      requestId: string | number;
      kind: "approval";
      threadId: string;
      itemId: string;
      command: string;
      reason: string;
      dangerous: boolean;
    };

type ThreadStoreState = {
  snapshots: Record<string, SessionSnapshotLike>;
  threads: MobileThreadSummary[];
  selectedThreadId: string | null;
  pendingRequests: Record<string, PendingServerRequest | null>;
  hydrate(snapshot: SessionSnapshotLike): void;
  appendStarted(threadId: string, item: ProjectedItem, ts: string): void;
  appendCompleted(threadId: string, item: ProjectedItem, ts: string): void;
  appendAgentDelta(threadId: string, itemId: string, delta: string, ts: string): void;
  appendReasoningDelta(
    threadId: string,
    itemId: string,
    mode: "reasoning" | "summary",
    delta: string,
    ts: string,
  ): void;
  currentFeed(threadId: string): SessionFeedItem[];
  seedThread(): void;
  getThread(threadId: string): MobileThreadSummary | null;
  getPendingRequest(threadId: string): PendingServerRequest | null;
  setPendingRequest(request: PendingServerRequest): void;
  clearPendingRequest(threadId: string): void;
  selectThread(threadId: string): void;
  setComposerDraft(threadId: string, text: string): void;
  submitComposer(threadId: string): void;
  appendOptimisticUserMessage(threadId: string, text: string, clientMessageId: string): void;
  interruptThread(threadId: string): void;
  clearAll(): void;
  syncRemoteThreads(remoteThreads: CoworkThread[]): void;
  clearPendingRequestsOnDisconnect(): void;
};

function ensureThreadSnapshot(
  threadId: string,
  existing?: SessionSnapshotLike,
): SessionSnapshotLike {
  return (
    existing ?? {
      sessionId: threadId,
      title: "Thread",
      titleSource: "manual",
      provider: "opencode",
      model: "mobile-scaffold",
      sessionKind: "primary",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      messageCount: 0,
      lastEventSeq: 0,
      feed: [],
      agents: [],
      todos: [],
      hasPendingAsk: false,
      hasPendingApproval: false,
    }
  );
}

function deriveProjectName(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? cwd) : cwd;
}

function buildThreadSummary(
  threadId: string,
  snapshot: SessionSnapshotLike,
  composerDraft = "",
  pendingServerRequest: PendingServerRequest | null = null,
  cwd: string | null = null,
): MobileThreadSummary {
  const previewSource = snapshot.feed.at(-1);
  return {
    id: threadId,
    title: snapshot.title,
    preview:
      previewSource && "text" in previewSource
        ? previewSource.text
        : previewSource && "line" in previewSource
          ? previewSource.line
          : "No activity yet.",
    updatedAtLabel: `${snapshot.feed.length} updates`,
    cwd,
    projectName: deriveProjectName(cwd),
    feed: snapshot.feed,
    composerDraft,
    pendingPrompt:
      snapshot.hasPendingAsk || snapshot.hasPendingApproval || pendingServerRequest !== null,
    pendingServerRequest,
  };
}

function updateThreadList(
  state: ThreadStoreState,
  threadId: string,
  snapshot: SessionSnapshotLike,
  composerDraft?: string,
): MobileThreadSummary[] {
  const existing = state.threads.find((thread) => thread.id === threadId);
  const next = buildThreadSummary(
    threadId,
    snapshot,
    composerDraft ?? existing?.composerDraft ?? "",
    state.pendingRequests[threadId] ?? existing?.pendingServerRequest ?? null,
    existing?.cwd ?? null,
  );
  const remaining = state.threads.filter((thread) => thread.id !== threadId);
  return [next, ...remaining];
}

export const useThreadStore = create<ThreadStoreState>((set, get) => ({
  snapshots: {},
  threads: [],
  selectedThreadId: null,
  pendingRequests: {},
  hydrate(snapshot) {
    set((state) => {
      const existingSnapshot = state.snapshots[snapshot.sessionId];
      const mergedSnapshot = {
        ...snapshot,
        feed:
          snapshot.feed.length === 0 && existingSnapshot ? existingSnapshot.feed : snapshot.feed,
        todos:
          snapshot.todos.length === 0 && existingSnapshot ? existingSnapshot.todos : snapshot.todos,
        agents:
          snapshot.agents.length === 0 && existingSnapshot
            ? existingSnapshot.agents
            : snapshot.agents,
      };
      return {
        snapshots: {
          ...state.snapshots,
          [snapshot.sessionId]: mergedSnapshot,
        },
        threads: updateThreadList(state, snapshot.sessionId, mergedSnapshot),
        selectedThreadId: state.selectedThreadId ?? snapshot.sessionId,
      };
    });
  },
  appendStarted(threadId, item, ts) {
    set((state) => {
      const snapshot = ensureThreadSnapshot(threadId, state.snapshots[threadId]);
      const nextState = applyProjectedStart(
        { feed: snapshot.feed, lastEventSeq: snapshot.lastEventSeq },
        item,
        ts,
        snapshot.lastEventSeq + 1,
      );
      const nextSnapshot = {
        ...snapshot,
        feed: nextState.feed,
        lastEventSeq: nextState.lastEventSeq,
      };
      return {
        snapshots: {
          ...state.snapshots,
          [threadId]: nextSnapshot,
        },
        threads: updateThreadList(state, threadId, nextSnapshot),
      };
    });
  },
  appendCompleted(threadId, item, ts) {
    set((state) => {
      const snapshot = ensureThreadSnapshot(threadId, state.snapshots[threadId]);
      const nextState = applyProjectedCompletion(
        { feed: snapshot.feed, lastEventSeq: snapshot.lastEventSeq },
        item,
        ts,
        snapshot.lastEventSeq + 1,
      );
      const nextSnapshot = {
        ...snapshot,
        feed: nextState.feed,
        lastEventSeq: nextState.lastEventSeq,
      };
      return {
        snapshots: {
          ...state.snapshots,
          [threadId]: nextSnapshot,
        },
        threads: updateThreadList(state, threadId, nextSnapshot),
      };
    });
  },
  appendAgentDelta(threadId, itemId, delta, ts) {
    set((state) => {
      const snapshot = ensureThreadSnapshot(threadId, state.snapshots[threadId]);
      const nextState = applyAgentDelta(
        { feed: snapshot.feed, lastEventSeq: snapshot.lastEventSeq },
        itemId,
        delta,
        ts,
        snapshot.lastEventSeq + 1,
      );
      const nextSnapshot = {
        ...snapshot,
        feed: nextState.feed,
        lastEventSeq: nextState.lastEventSeq,
      };
      return {
        snapshots: {
          ...state.snapshots,
          [threadId]: nextSnapshot,
        },
        threads: updateThreadList(state, threadId, nextSnapshot),
      };
    });
  },
  appendReasoningDelta(threadId, itemId, mode, delta, ts) {
    set((state) => {
      const snapshot = ensureThreadSnapshot(threadId, state.snapshots[threadId]);
      const nextState = applyReasoningDelta(
        { feed: snapshot.feed, lastEventSeq: snapshot.lastEventSeq },
        itemId,
        mode,
        delta,
        ts,
        snapshot.lastEventSeq + 1,
      );
      const nextSnapshot = {
        ...snapshot,
        feed: nextState.feed,
        lastEventSeq: nextState.lastEventSeq,
      };
      return {
        snapshots: {
          ...state.snapshots,
          [threadId]: nextSnapshot,
        },
        threads: updateThreadList(state, threadId, nextSnapshot),
      };
    });
  },
  currentFeed(threadId) {
    return get().snapshots[threadId]?.feed ?? [];
  },
  seedThread() {
    const threadId = `draft-${(globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()}`;
    const snapshot = ensureThreadSnapshot(threadId);
    const nextSnapshot: SessionSnapshotLike = {
      ...snapshot,
      title: "New mobile draft",
      feed: [
        {
          id: `${threadId}:welcome`,
          kind: "system",
          ts: new Date().toISOString(),
          line: "Draft thread created on mobile scaffold.",
        },
      ],
      messageCount: 1,
      updatedAt: new Date().toISOString(),
    };
    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [threadId]: nextSnapshot,
      },
      threads: updateThreadList(state, threadId, nextSnapshot),
      selectedThreadId: threadId,
    }));
  },
  getThread(threadId) {
    return get().threads.find((entry) => entry.id === threadId) ?? null;
  },
  getPendingRequest(threadId) {
    return get().pendingRequests[threadId] ?? null;
  },
  setPendingRequest(request) {
    set((state) => ({
      pendingRequests: {
        ...state.pendingRequests,
        [request.threadId]: request,
      },
      threads: state.threads.map((thread) =>
        thread.id === request.threadId
          ? { ...thread, pendingPrompt: true, pendingServerRequest: request }
          : thread,
      ),
    }));
  },
  clearPendingRequest(threadId) {
    set((state) => ({
      pendingRequests: {
        ...state.pendingRequests,
        [threadId]: null,
      },
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              pendingPrompt:
                state.snapshots[threadId]?.hasPendingAsk ||
                state.snapshots[threadId]?.hasPendingApproval ||
                false,
              pendingServerRequest: null,
            }
          : thread,
      ),
    }));
  },
  selectThread(threadId) {
    set({ selectedThreadId: threadId });
  },
  setComposerDraft(threadId, text) {
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId ? { ...thread, composerDraft: text } : thread,
      ),
      selectedThreadId: threadId,
    }));
  },
  submitComposer(threadId) {
    const state = get();
    const thread = state.threads.find((entry) => entry.id === threadId);
    const draft = thread?.composerDraft.trim() ?? "";
    if (!draft) {
      return;
    }
    const userItem: SessionFeedItem = {
      id: `${threadId}:user:${Date.now()}`,
      kind: "message",
      role: "user",
      ts: new Date().toISOString(),
      text: draft,
    };
    set((current) => {
      const snapshot = ensureThreadSnapshot(threadId, current.snapshots[threadId]);
      const nextSnapshot = {
        ...snapshot,
        feed: [...snapshot.feed, userItem],
      };
      return {
        snapshots: {
          ...current.snapshots,
          [threadId]: nextSnapshot,
        },
        threads: updateThreadList(current, threadId, nextSnapshot, ""),
      };
    });
  },
  appendOptimisticUserMessage(threadId, text, clientMessageId) {
    const userItem: SessionFeedItem = {
      id: clientMessageId,
      kind: "message",
      role: "user",
      ts: new Date().toISOString(),
      text,
    };
    set((current) => {
      const snapshot = ensureThreadSnapshot(threadId, current.snapshots[threadId]);
      const nextSnapshot = {
        ...snapshot,
        feed: [...snapshot.feed, userItem],
      };
      return {
        snapshots: {
          ...current.snapshots,
          [threadId]: nextSnapshot,
        },
        threads: updateThreadList(current, threadId, nextSnapshot),
      };
    });
  },
  interruptThread(threadId) {
    set((state) => {
      const snapshot = ensureThreadSnapshot(threadId, state.snapshots[threadId]);
      const nextSnapshot = {
        ...snapshot,
        feed: [
          ...snapshot.feed,
          {
            id: `${threadId}:interrupt:${Date.now()}`,
            kind: "system",
            ts: new Date().toISOString(),
            line: "Interrupt requested from the mobile scaffold.",
          } satisfies SessionFeedItem,
        ],
      };
      return {
        snapshots: {
          ...state.snapshots,
          [threadId]: nextSnapshot,
        },
        threads: updateThreadList(state, threadId, nextSnapshot),
      };
    });
  },
  clearAll() {
    set((state) => {
      const nextThreads = state.threads.filter((t) => t.id.startsWith("draft-"));
      const nextSnapshots: Record<string, SessionSnapshotLike> = {};
      const nextPendingRequests: Record<string, PendingServerRequest | null> = {};

      for (const t of nextThreads) {
        if (state.snapshots[t.id]) {
          nextSnapshots[t.id] = state.snapshots[t.id];
        }
        if (state.pendingRequests[t.id]) {
          nextPendingRequests[t.id] = state.pendingRequests[t.id];
        }
      }

      const nextSelectedThreadId =
        state.selectedThreadId && nextThreads.some((t) => t.id === state.selectedThreadId)
          ? state.selectedThreadId
          : (nextThreads[0]?.id ?? null);

      return {
        snapshots: nextSnapshots,
        threads: nextThreads,
        selectedThreadId: nextSelectedThreadId,
        pendingRequests: nextPendingRequests,
      };
    });
  },
  syncRemoteThreads(remoteThreads) {
    set((state) => {
      const nextSnapshots: Record<string, SessionSnapshotLike> = {};
      const nextPendingRequests: Record<string, PendingServerRequest | null> = {};
      const nextThreads: MobileThreadSummary[] = [];

      // 1. Preserve local draft threads
      const localDraftThreads = state.threads.filter((t) => t.id.startsWith("draft-"));
      for (const t of localDraftThreads) {
        nextThreads.push(t);
        if (state.snapshots[t.id]) {
          nextSnapshots[t.id] = state.snapshots[t.id];
        }
        if (state.pendingRequests[t.id]) {
          nextPendingRequests[t.id] = state.pendingRequests[t.id];
        }
      }

      // 2. Process remote threads returned by the server
      for (const rt of remoteThreads) {
        const existingSnapshot = state.snapshots[rt.id];
        const existingThread = state.threads.find((t) => t.id === rt.id);

        const now = new Date().toISOString();
        const baseSnapshot = existingSnapshot ?? {
          sessionId: rt.id,
          title: rt.title,
          titleSource: "manual",
          provider: "opencode",
          model: "remote-session",
          sessionKind: "primary",
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          lastEventSeq: rt.lastEventSeq,
          feed: [],
          agents: [],
          todos: [],
          hasPendingAsk: false,
          hasPendingApproval: false,
        };

        const snapshot: SessionSnapshotLike = {
          ...baseSnapshot,
          title: rt.title,
          lastEventSeq: rt.lastEventSeq,
        };

        nextSnapshots[rt.id] = snapshot;

        if (state.pendingRequests[rt.id]) {
          nextPendingRequests[rt.id] = state.pendingRequests[rt.id];
        }

        const composerDraft = existingThread?.composerDraft ?? "";
        const pendingServerRequest =
          state.pendingRequests[rt.id] ?? existingThread?.pendingServerRequest ?? null;

        const previewSource = snapshot.feed.at(-1);
        const threadSummary: MobileThreadSummary = {
          id: rt.id,
          title: snapshot.title,
          preview:
            previewSource && "text" in previewSource
              ? previewSource.text
              : previewSource && "line" in previewSource
                ? previewSource.line
                : rt.preview || "No activity yet.",
          updatedAtLabel: `${snapshot.feed.length} updates`,
          cwd: rt.cwd ?? null,
          projectName: deriveProjectName(rt.cwd ?? null),
          feed: snapshot.feed,
          composerDraft,
          pendingPrompt:
            snapshot.hasPendingAsk || snapshot.hasPendingApproval || pendingServerRequest !== null,
          pendingServerRequest,
        };

        nextThreads.push(threadSummary);
      }

      const allNextIds = new Set(nextThreads.map((t) => t.id));
      const nextSelectedThreadId =
        state.selectedThreadId && allNextIds.has(state.selectedThreadId)
          ? state.selectedThreadId
          : (nextThreads[0]?.id ?? null);

      return {
        snapshots: nextSnapshots,
        threads: nextThreads,
        selectedThreadId: nextSelectedThreadId,
        pendingRequests: nextPendingRequests,
      };
    });
  },
  clearPendingRequestsOnDisconnect() {
    set((state) => {
      const nextSnapshots = { ...state.snapshots };
      for (const id of Object.keys(nextSnapshots)) {
        const snap = nextSnapshots[id];
        if (snap) {
          nextSnapshots[id] = {
            ...snap,
            hasPendingAsk: false,
            hasPendingApproval: false,
          };
        }
      }
      return {
        pendingRequests: {},
        snapshots: nextSnapshots,
        threads: state.threads.map((thread) => ({
          ...thread,
          pendingPrompt: false,
          pendingServerRequest: null,
        })),
      };
    });
  },
}));
