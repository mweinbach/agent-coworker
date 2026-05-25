import { loadFromOfflineCache, saveToOfflineCache } from "./offlineCache";
import type { SessionSnapshotLike } from "./protocolTypes";
import type { MobileThreadSummary } from "./threadStore";
import {
  defaultThreadHomeUiState,
  normalizeHomeSectionOrder,
  ONE_OFF_CHAT_WORKSPACE_PAGE_SIZE,
  type HomeSectionKey,
  type ThreadHomeSectionsOpen,
} from "./threadHomeModel";

export const THREAD_OFFLINE_CACHE_KEY = "threadSnapshots";
const THREAD_OFFLINE_CACHE_VERSION = 2;

export type ThreadOfflineCache = {
  version: typeof THREAD_OFFLINE_CACHE_VERSION;
  cachedAt: string;
  threads: MobileThreadSummary[];
  snapshots: Record<string, SessionSnapshotLike>;
  expandedWorkspaceIds: Record<string, true>;
  sectionOrder: HomeSectionKey[];
  sectionsOpen: ThreadHomeSectionsOpen;
  showAllChats: boolean;
  expandedProjectThreadLists: Record<string, true>;
  projectThreadFetchLimits: Record<string, number>;
  projectThreadTotals: Record<string, number>;
  oneOffChatWorkspaceLoadLimit: number;
};

type ThreadOfflineCacheInput = Pick<
  ThreadOfflineCache,
  | "threads"
  | "snapshots"
  | "expandedWorkspaceIds"
  | "sectionOrder"
  | "sectionsOpen"
  | "showAllChats"
  | "expandedProjectThreadLists"
  | "projectThreadFetchLimits"
  | "projectThreadTotals"
  | "oneOffChatWorkspaceLoadLimit"
>;

function sanitizeThreads(threads: MobileThreadSummary[]): MobileThreadSummary[] {
  return threads
    .filter((thread) => !thread.id.startsWith("draft-"))
    .map((thread) => ({
      ...thread,
      composerDraft: "",
      pendingPrompt: false,
      pendingServerRequest: null,
    }));
}

function normalizeCache(cache: Partial<ThreadOfflineCache>): ThreadOfflineCache {
  const defaults = defaultThreadHomeUiState();
  return {
    version: THREAD_OFFLINE_CACHE_VERSION,
    cachedAt: cache.cachedAt ?? new Date().toISOString(),
    threads: sanitizeThreads(cache.threads ?? []),
    snapshots: cache.snapshots ?? {},
    expandedWorkspaceIds: cache.expandedWorkspaceIds ?? {},
    sectionOrder: normalizeHomeSectionOrder(cache.sectionOrder),
    sectionsOpen: {
      chats: cache.sectionsOpen?.chats ?? defaults.sectionsOpen.chats,
      projects: cache.sectionsOpen?.projects ?? defaults.sectionsOpen.projects,
    },
    showAllChats: cache.showAllChats ?? defaults.showAllChats,
    expandedProjectThreadLists: cache.expandedProjectThreadLists ?? {},
    projectThreadFetchLimits: cache.projectThreadFetchLimits ?? {},
    projectThreadTotals: cache.projectThreadTotals ?? {},
    oneOffChatWorkspaceLoadLimit:
      cache.oneOffChatWorkspaceLoadLimit ?? ONE_OFF_CHAT_WORKSPACE_PAGE_SIZE,
  };
}

export async function saveThreadOfflineCache(input: ThreadOfflineCacheInput): Promise<void> {
  const threads = sanitizeThreads(input.threads);
  const allowedThreadIds = new Set(threads.map((thread) => thread.id));
  const snapshots: Record<string, SessionSnapshotLike> = {};
  for (const [threadId, snapshot] of Object.entries(input.snapshots)) {
    if (allowedThreadIds.has(threadId)) {
      snapshots[threadId] = {
        ...snapshot,
        hasPendingAsk: false,
        hasPendingApproval: false,
      };
    }
  }

  await saveToOfflineCache(
    THREAD_OFFLINE_CACHE_KEY,
    normalizeCache({
      cachedAt: new Date().toISOString(),
      threads,
      snapshots,
      expandedWorkspaceIds: input.expandedWorkspaceIds,
      sectionOrder: input.sectionOrder,
      sectionsOpen: input.sectionsOpen,
      showAllChats: input.showAllChats,
      expandedProjectThreadLists: input.expandedProjectThreadLists,
      projectThreadFetchLimits: input.projectThreadFetchLimits,
      projectThreadTotals: input.projectThreadTotals,
      oneOffChatWorkspaceLoadLimit: input.oneOffChatWorkspaceLoadLimit,
    }),
  );
}

export async function loadThreadOfflineCache(): Promise<ThreadOfflineCache | null> {
  const cached = await loadFromOfflineCache<
    Partial<Omit<ThreadOfflineCache, "version">> & { version?: number }
  >(THREAD_OFFLINE_CACHE_KEY);
  if (!cached) {
    return null;
  }

  if (cached.version === 1) {
    return normalizeCache({
      ...cached,
      version: THREAD_OFFLINE_CACHE_VERSION,
    });
  }

  if (cached.version !== THREAD_OFFLINE_CACHE_VERSION) {
    return null;
  }

  const normalized = normalizeCache(cached as Partial<ThreadOfflineCache>);
  return {
    ...normalized,
    snapshots: Object.fromEntries(
      Object.entries(normalized.snapshots ?? {}).map(([threadId, snapshot]) => [
        threadId,
        {
          ...snapshot,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      ]),
    ),
  };
}
