import { loadFromOfflineCache, saveToOfflineCache } from "./offlineCache";
import type { SessionSnapshotLike } from "./protocolTypes";
import type { MobileThreadSummary } from "./threadStore";

export const THREAD_OFFLINE_CACHE_KEY = "threadSnapshots";
const THREAD_OFFLINE_CACHE_VERSION = 1;

export type ThreadOfflineCache = {
  version: typeof THREAD_OFFLINE_CACHE_VERSION;
  cachedAt: string;
  threads: MobileThreadSummary[];
  snapshots: Record<string, SessionSnapshotLike>;
  expandedWorkspaceIds: Record<string, true>;
};

type ThreadOfflineCacheInput = Pick<
  ThreadOfflineCache,
  "threads" | "snapshots" | "expandedWorkspaceIds"
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

  await saveToOfflineCache(THREAD_OFFLINE_CACHE_KEY, {
    version: THREAD_OFFLINE_CACHE_VERSION,
    cachedAt: new Date().toISOString(),
    threads,
    snapshots,
    expandedWorkspaceIds: input.expandedWorkspaceIds,
  } satisfies ThreadOfflineCache);
}

export async function loadThreadOfflineCache(): Promise<ThreadOfflineCache | null> {
  const cached = await loadFromOfflineCache<ThreadOfflineCache>(THREAD_OFFLINE_CACHE_KEY);
  if (!cached || cached.version !== THREAD_OFFLINE_CACHE_VERSION) {
    return null;
  }
  return {
    ...cached,
    threads: sanitizeThreads(cached.threads),
    snapshots: Object.fromEntries(
      Object.entries(cached.snapshots ?? {}).map(([threadId, snapshot]) => [
        threadId,
        {
          ...snapshot,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      ]),
    ),
    expandedWorkspaceIds: cached.expandedWorkspaceIds ?? {},
  };
}
