import { create } from "zustand";

import type {
  CoworkThread,
  ProjectedItem,
  SessionFeedItem,
  SessionSnapshotLike,
  WorkspaceSummary,
} from "./protocolTypes";
import {
  applyAgentDelta,
  applyProjectedCompletion,
  applyProjectedStart,
  applyReasoningDelta,
} from "./snapshotReducer";
import {
  defaultThreadHomeUiState,
  normalizeHomeSectionOrder,
  type HomeSectionKey,
  type ThreadHomeSectionsOpen,
} from "./threadHomeModel";
import { saveThreadOfflineCache, type ThreadOfflineCache } from "./threadOfflineCache";

export type MobileThreadSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string | null;
  cwd: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceKind: WorkspaceSummary["workspaceKind"] | null;
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
  activeTurnStartedAt: Record<string, string | null>;
  expandedWorkspaceIds: Record<string, true>;
  sectionOrder: HomeSectionKey[];
  sectionsOpen: ThreadHomeSectionsOpen;
  showAllChats: boolean;
  expandedProjectThreadLists: Record<string, true>;
  projectThreadFetchLimits: Record<string, number>;
  projectThreadTotals: Record<string, number>;
  oneOffChatWorkspaceLoadLimit: number;
  homeLoadPending: {
    chats: boolean;
    projects: Record<string, boolean>;
  };
  hydrateOfflineCache(cache: ThreadOfflineCache): void;
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
  syncRemoteThreads(
    remoteThreads: CoworkThread[],
    workspaceByPath?: Map<string, WorkspaceSummary>,
  ): void;
  clearPendingRequestsOnDisconnect(): void;
  markTurnStarted(threadId: string, startedAt: string): void;
  markTurnCompleted(threadId: string): void;
  getActiveTurnStartedAt(threadId: string): string | null;
  expandWorkspace(workspaceId: string): void;
  toggleWorkspaceExpanded(workspaceId: string): void;
  toggleSectionOpen(section: HomeSectionKey): void;
  setSectionOrder(order: HomeSectionKey[]): void;
  toggleSectionOrder(): void;
  toggleShowAllChats(): void;
  toggleProjectThreadListExpanded(workspaceId: string): void;
  setProjectThreadTotals(totals: Record<string, number>): void;
  setProjectThreadFetchLimit(workspaceId: string, limit: number): void;
  setOneOffChatWorkspaceLoadLimit(limit: number): void;
  setHomeLoadPending(pending: {
    chats?: boolean;
    projectWorkspaceId?: string;
    projectPending?: boolean;
  }): void;
};

let threadCachePersistQueued = false;

function scheduleThreadCachePersist(getState: () => ThreadStoreState): void {
  if (threadCachePersistQueued) {
    return;
  }
  threadCachePersistQueued = true;
  queueMicrotask(() => {
    threadCachePersistQueued = false;
    const state = getState();
    void saveThreadOfflineCache({
      threads: state.threads,
      snapshots: state.snapshots,
      expandedWorkspaceIds: state.expandedWorkspaceIds,
      sectionOrder: state.sectionOrder,
      sectionsOpen: state.sectionsOpen,
      showAllChats: state.showAllChats,
      expandedProjectThreadLists: state.expandedProjectThreadLists,
      projectThreadFetchLimits: state.projectThreadFetchLimits,
      projectThreadTotals: state.projectThreadTotals,
      oneOffChatWorkspaceLoadLimit: state.oneOffChatWorkspaceLoadLimit,
    });
  });
}

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

function resolveThreadWorkspace(
  cwd: string | null,
  workspaceByPath?: Map<string, WorkspaceSummary>,
): Pick<MobileThreadSummary, "workspaceId" | "workspaceName" | "workspaceKind"> {
  if (!cwd || !workspaceByPath) {
    return {
      workspaceId: null,
      workspaceName: null,
      workspaceKind: null,
    };
  }
  const workspace = workspaceByPath.get(cwd);
  if (!workspace) {
    return {
      workspaceId: null,
      workspaceName: null,
      workspaceKind: null,
    };
  }
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceKind: workspace.workspaceKind ?? "project",
  };
}

function buildThreadSummary(
  threadId: string,
  snapshot: SessionSnapshotLike,
  composerDraft = "",
  pendingServerRequest: PendingServerRequest | null = null,
  cwd: string | null = null,
  workspaceByPath?: Map<string, WorkspaceSummary>,
  fallbackPreview?: string,
): MobileThreadSummary {
  const previewSource = snapshot.feed.at(-1);
  const workspace = resolveThreadWorkspace(cwd, workspaceByPath);
  const preview =
    previewSource && "text" in previewSource && typeof previewSource.text === "string"
      ? previewSource.text
      : previewSource && "line" in previewSource && typeof previewSource.line === "string"
        ? previewSource.line
        : fallbackPreview || "No activity yet.";
  return {
    id: threadId,
    title: snapshot.title,
    preview,
    updatedAt: snapshot.updatedAt || null,
    cwd,
    ...workspace,
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
  workspaceByPath?: Map<string, WorkspaceSummary>,
): MobileThreadSummary[] {
  const existing = state.threads.find((thread) => thread.id === threadId);
  const next = buildThreadSummary(
    threadId,
    snapshot,
    composerDraft ?? existing?.composerDraft ?? "",
    state.pendingRequests[threadId] ?? existing?.pendingServerRequest ?? null,
    existing?.cwd ?? null,
    workspaceByPath,
  );
  const merged: MobileThreadSummary = existing
    ? {
        ...next,
        cwd: next.cwd ?? existing.cwd,
        workspaceId: next.workspaceId ?? existing.workspaceId,
        workspaceName: next.workspaceName ?? existing.workspaceName,
        workspaceKind: next.workspaceKind ?? existing.workspaceKind,
      }
    : next;
  const remaining = state.threads.filter((thread) => thread.id !== threadId);
  return [merged, ...remaining];
}

export const useThreadStore = create<ThreadStoreState>((set, get) => ({
  snapshots: {},
  threads: [],
  selectedThreadId: null,
  pendingRequests: {},
  activeTurnStartedAt: {},
  expandedWorkspaceIds: {},
  sectionOrder: defaultThreadHomeUiState().sectionOrder,
  sectionsOpen: defaultThreadHomeUiState().sectionsOpen,
  showAllChats: false,
  expandedProjectThreadLists: {},
  projectThreadFetchLimits: {},
  projectThreadTotals: {},
  oneOffChatWorkspaceLoadLimit: defaultThreadHomeUiState().oneOffChatWorkspaceLoadLimit,
  homeLoadPending: { chats: false, projects: {} },
  hydrateOfflineCache(cache) {
    set((state) => {
      const existingDraftThreads = state.threads.filter((thread) => thread.id.startsWith("draft-"));
      const existingDraftSnapshots = Object.fromEntries(
        Object.entries(state.snapshots).filter(([threadId]) => threadId.startsWith("draft-")),
      );
      const cachedThreads = cache.threads.map((thread) => ({
        ...thread,
        composerDraft: "",
        pendingPrompt: false,
        pendingServerRequest: null,
      }));
      const cachedIds = new Set(cachedThreads.map((thread) => thread.id));
      const cachedSnapshots = Object.fromEntries(
        Object.entries(cache.snapshots).filter(([threadId]) => cachedIds.has(threadId)),
      );
      return {
        snapshots: {
          ...existingDraftSnapshots,
          ...cachedSnapshots,
        },
        threads: [...existingDraftThreads, ...cachedThreads],
        selectedThreadId:
          state.selectedThreadId && [...existingDraftThreads, ...cachedThreads].some(
            (thread) => thread.id === state.selectedThreadId,
          )
            ? state.selectedThreadId
            : (cachedThreads[0]?.id ?? existingDraftThreads[0]?.id ?? null),
        pendingRequests: {},
        activeTurnStartedAt: {},
        expandedWorkspaceIds: {
          ...state.expandedWorkspaceIds,
          ...cache.expandedWorkspaceIds,
        },
        sectionOrder: normalizeHomeSectionOrder(cache.sectionOrder),
        sectionsOpen: cache.sectionsOpen,
        showAllChats: cache.showAllChats,
        expandedProjectThreadLists: cache.expandedProjectThreadLists,
        projectThreadFetchLimits: cache.projectThreadFetchLimits,
        projectThreadTotals: cache.projectThreadTotals,
        oneOffChatWorkspaceLoadLimit: cache.oneOffChatWorkspaceLoadLimit,
      };
    });
  },
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
    scheduleThreadCachePersist(get);
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
    scheduleThreadCachePersist(get);
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
    scheduleThreadCachePersist(get);
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
    scheduleThreadCachePersist(get);
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
    scheduleThreadCachePersist(get);
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
    scheduleThreadCachePersist(get);
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
        activeTurnStartedAt: {
          ...state.activeTurnStartedAt,
          [threadId]: null,
        },
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
    scheduleThreadCachePersist(get);
  },
  syncRemoteThreads(remoteThreads, workspaceByPath) {
    set((state) => {
      const remoteIds = new Set<string>();
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
        remoteIds.add(rt.id);
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
          updatedAt: rt.updatedAt || baseSnapshot.updatedAt,
          lastEventSeq: rt.lastEventSeq,
        };

        nextSnapshots[rt.id] = snapshot;

        if (state.pendingRequests[rt.id]) {
          nextPendingRequests[rt.id] = state.pendingRequests[rt.id];
        }

        const composerDraft = existingThread?.composerDraft ?? "";
        const pendingServerRequest =
          state.pendingRequests[rt.id] ?? existingThread?.pendingServerRequest ?? null;

        nextThreads.push(
          buildThreadSummary(
            rt.id,
            snapshot,
            composerDraft,
            pendingServerRequest,
            rt.cwd ?? null,
            workspaceByPath,
            rt.preview,
          ),
        );
      }

      // 3. Keep locally hydrated threads that fall outside the bounded remote fetch.
      for (const existingThread of state.threads) {
        if (existingThread.id.startsWith("draft-")) continue;
        if (remoteIds.has(existingThread.id)) continue;
        if (nextThreads.some((thread) => thread.id === existingThread.id)) continue;

        const existingSnapshot = state.snapshots[existingThread.id];
        if (!existingSnapshot) continue;

        nextSnapshots[existingThread.id] = existingSnapshot;
        if (state.pendingRequests[existingThread.id]) {
          nextPendingRequests[existingThread.id] = state.pendingRequests[existingThread.id];
        }
        nextThreads.push(existingThread);
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
        expandedWorkspaceIds: state.expandedWorkspaceIds,
        sectionOrder: state.sectionOrder,
        sectionsOpen: state.sectionsOpen,
        showAllChats: state.showAllChats,
        expandedProjectThreadLists: state.expandedProjectThreadLists,
        projectThreadFetchLimits: state.projectThreadFetchLimits,
        projectThreadTotals: state.projectThreadTotals,
        oneOffChatWorkspaceLoadLimit: state.oneOffChatWorkspaceLoadLimit,
        homeLoadPending: state.homeLoadPending,
      };
    });
    scheduleThreadCachePersist(get);
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
        activeTurnStartedAt: {},
        snapshots: nextSnapshots,
        threads: state.threads.map((thread) => ({
          ...thread,
          pendingPrompt: false,
          pendingServerRequest: null,
        })),
      };
    });
    scheduleThreadCachePersist(get);
  },
  markTurnStarted(threadId, startedAt) {
    set((state) => ({
      activeTurnStartedAt: {
        ...state.activeTurnStartedAt,
        [threadId]: startedAt,
      },
    }));
  },
  markTurnCompleted(threadId) {
    set((state) => ({
      activeTurnStartedAt: {
        ...state.activeTurnStartedAt,
        [threadId]: null,
      },
    }));
  },
  getActiveTurnStartedAt(threadId) {
    return get().activeTurnStartedAt[threadId] ?? null;
  },
  expandWorkspace(workspaceId) {
    set((state) => ({
      expandedWorkspaceIds: {
        ...state.expandedWorkspaceIds,
        [workspaceId]: true,
      },
    }));
    scheduleThreadCachePersist(get);
  },
  toggleWorkspaceExpanded(workspaceId) {
    set((state) => {
      const next = { ...state.expandedWorkspaceIds };
      if (next[workspaceId]) {
        delete next[workspaceId];
      } else {
        next[workspaceId] = true;
      }
      return { expandedWorkspaceIds: next };
    });
    scheduleThreadCachePersist(get);
  },
  toggleSectionOpen(section) {
    set((state) => ({
      sectionsOpen: {
        ...state.sectionsOpen,
        [section]: !state.sectionsOpen[section],
      },
    }));
    scheduleThreadCachePersist(get);
  },
  setSectionOrder(order) {
    set({ sectionOrder: normalizeHomeSectionOrder(order) });
    scheduleThreadCachePersist(get);
  },
  toggleSectionOrder() {
    set((state) => ({
      sectionOrder:
        normalizeHomeSectionOrder(state.sectionOrder)[0] === "chats"
          ? (["projects", "chats"] as HomeSectionKey[])
          : (["chats", "projects"] as HomeSectionKey[]),
    }));
    scheduleThreadCachePersist(get);
  },
  toggleShowAllChats() {
    set((state) => ({ showAllChats: !state.showAllChats }));
    scheduleThreadCachePersist(get);
  },
  toggleProjectThreadListExpanded(workspaceId) {
    set((state) => {
      const next = { ...state.expandedProjectThreadLists };
      if (next[workspaceId]) {
        delete next[workspaceId];
      } else {
        next[workspaceId] = true;
      }
      return { expandedProjectThreadLists: next };
    });
    scheduleThreadCachePersist(get);
  },
  setProjectThreadTotals(totals) {
    set((state) => ({
      projectThreadTotals: {
        ...state.projectThreadTotals,
        ...totals,
      },
    }));
    scheduleThreadCachePersist(get);
  },
  setProjectThreadFetchLimit(workspaceId, limit) {
    set((state) => ({
      projectThreadFetchLimits: {
        ...state.projectThreadFetchLimits,
        [workspaceId]: limit,
      },
    }));
    scheduleThreadCachePersist(get);
  },
  setOneOffChatWorkspaceLoadLimit(limit) {
    set({ oneOffChatWorkspaceLoadLimit: limit });
    scheduleThreadCachePersist(get);
  },
  setHomeLoadPending(pending) {
    set((state) => {
      const nextProjects = { ...state.homeLoadPending.projects };
      if (pending.projectWorkspaceId !== undefined && pending.projectPending !== undefined) {
        if (pending.projectPending) {
          nextProjects[pending.projectWorkspaceId] = true;
        } else {
          delete nextProjects[pending.projectWorkspaceId];
        }
      }
      return {
        homeLoadPending: {
          chats: pending.chats ?? state.homeLoadPending.chats,
          projects: nextProjects,
        },
      };
    });
  },
}));
