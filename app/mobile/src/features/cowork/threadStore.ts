import { create } from "zustand";

import type { ProjectedItem, SessionFeedItem, SessionSnapshotLike } from "./protocolTypes";
import { applyProjectedCompletion, applyProjectedStart } from "./snapshotReducer";

export type MobileThreadSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAtLabel: string;
  feed: SessionFeedItem[];
  composerDraft: string;
  pendingPrompt: boolean;
};

export type MobileThreadFeedEntry = SessionFeedItem;

type ThreadStoreState = {
  snapshots: Record<string, SessionSnapshotLike>;
  threads: MobileThreadSummary[];
  selectedThreadId: string | null;
  hydrate(snapshot: SessionSnapshotLike): void;
  appendStarted(threadId: string, item: ProjectedItem, ts: string): void;
  appendCompleted(threadId: string, item: ProjectedItem, ts: string): void;
  currentFeed(threadId: string): SessionFeedItem[];
  seedThread(): void;
  getThread(threadId: string): MobileThreadSummary | null;
  setComposerDraft(threadId: string, text: string): void;
  submitComposer(threadId: string): void;
  interruptThread(threadId: string): void;
};

function ensureThreadSnapshot(threadId: string, existing?: SessionSnapshotLike): SessionSnapshotLike {
  return existing ?? {
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
  };
}

function buildThreadSummary(
  threadId: string,
  snapshot: SessionSnapshotLike,
  composerDraft = "",
): MobileThreadSummary {
  const previewSource = snapshot.feed.at(-1);
  return {
    id: threadId,
    title: snapshot.title,
    preview: previewSource && "text" in previewSource
      ? previewSource.text
      : previewSource && "line" in previewSource
        ? previewSource.line
        : "No activity yet.",
    updatedAtLabel: `${snapshot.feed.length} updates`,
    feed: snapshot.feed,
    composerDraft,
    pendingPrompt: snapshot.hasPendingAsk || snapshot.hasPendingApproval,
  };
}

function updateThreadList(
  state: ThreadStoreState,
  threadId: string,
  snapshot: SessionSnapshotLike,
  composerDraft?: string,
): MobileThreadSummary[] {
  const existing = state.threads.find((thread) => thread.id === threadId);
  const next = buildThreadSummary(threadId, snapshot, composerDraft ?? existing?.composerDraft ?? "");
  const remaining = state.threads.filter((thread) => thread.id !== threadId);
  return [next, ...remaining];
}

export const useThreadStore = create<ThreadStoreState>((set, get) => ({
  snapshots: {},
  threads: [],
  selectedThreadId: null,
  hydrate(snapshot) {
    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [snapshot.sessionId]: snapshot,
      },
      threads: updateThreadList(state, snapshot.sessionId, snapshot),
      selectedThreadId: state.selectedThreadId ?? snapshot.sessionId,
    }));
  },
  appendStarted(threadId, item, ts) {
    set((state) => {
      const snapshot = ensureThreadSnapshot(threadId, state.snapshots[threadId]);
      const nextSnapshot = {
        ...snapshot,
        feed: applyProjectedStart({ feed: snapshot.feed, lastEventSeq: snapshot.lastEventSeq }, item, ts, snapshot.lastEventSeq + 1).feed,
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
      const nextSnapshot = {
        ...snapshot,
        feed: applyProjectedCompletion(
          { feed: snapshot.feed, lastEventSeq: snapshot.lastEventSeq },
          item,
          ts,
          snapshot.lastEventSeq + 1,
        ).feed,
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
    const threadId = `draft-${Date.now()}`;
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
  setComposerDraft(threadId, text) {
    set((state) => ({
      threads: state.threads.map((thread) => (
        thread.id === threadId
          ? { ...thread, composerDraft: text }
          : thread
      )),
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
    const assistantItem: SessionFeedItem = {
      id: `${threadId}:assistant:${Date.now()}`,
      kind: "message",
      role: "assistant",
      ts: new Date().toISOString(),
      text: "Scaffold response: mobile JSON-RPC transport will send this draft once the secure channel is wired.",
    };
    set((current) => {
      const snapshot = ensureThreadSnapshot(threadId, current.snapshots[threadId]);
      const nextSnapshot = {
        ...snapshot,
        feed: [...snapshot.feed, userItem, assistantItem],
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
}));
