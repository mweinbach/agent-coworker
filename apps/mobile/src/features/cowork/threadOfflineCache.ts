import { z } from "zod";

import { hasComposerContent, sameComposerAttachments } from "./composer-policy";
import {
  claimOfflineDraftRecovery,
  clearUnpairedThreadCache,
  getOfflineCacheScope,
  loadFromOfflineCache,
  loadLegacyThreadCache,
  markLegacyDraftsRecovered,
  saveToOfflineCache,
} from "./offlineCacheStorage";
import {
  type SessionSnapshotLike,
  sessionFeedItemSchema,
  sessionSnapshotSchema,
} from "./protocolTypes";
import {
  defaultThreadHomeUiState,
  type HomeSectionKey,
  normalizeHomeSectionOrder,
} from "./threadHomeModel";
import type { MobileThreadSummary } from "./threadStore";

const THREAD_OFFLINE_CACHE_KEY = "threadSnapshots";
const THREAD_OFFLINE_CACHE_VERSION = 4;
const MAX_CACHED_THREADS = 100;
const MAX_CACHED_FEED_ITEMS = 200;

export type ThreadOfflineCache = {
  version: typeof THREAD_OFFLINE_CACHE_VERSION;
  cachedAt: string;
  threads: MobileThreadSummary[];
  snapshots: Record<string, SessionSnapshotLike>;
  expandedWorkspaceIds: Record<string, true>;
  sectionOrder: HomeSectionKey[];
  showAllChats: boolean;
  expandedProjectThreadLists: Record<string, true>;
  projectThreadFetchLimits: Record<string, number>;
  projectThreadTotals: Record<string, number>;
  oneOffChatWorkspaceLoadLimit: number;
};

type ThreadOfflineCacheInput = Omit<ThreadOfflineCache, "version" | "cachedAt">;
const attachmentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file"),
    filename: z.string(),
    contentBase64: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal("uploadedFile"),
    filename: z.string(),
    path: z.string(),
    mimeType: z.string(),
  }),
]);
const attachmentsSchema = z.array(attachmentSchema).catch([]);
const submissionSchema = z.object({
  clientMessageId: z.string().min(1),
  text: z.string(),
  attachments: attachmentsSchema,
  status: z.enum(["submitting", "failed"]),
  error: z.string().nullable().catch(null),
});
const feedSchema = z
  .array(z.unknown())
  .catch([])
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = sessionFeedItemSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );
const cachedThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  preview: z.string().catch(""),
  updatedAt: z.string().nullable().catch(null),
  cwd: z.string().nullable().catch(null),
  workspaceId: z.string().nullable().catch(null),
  workspaceName: z.string().nullable().catch(null),
  workspaceKind: z.enum(["project", "oneOffChat"]).nullable().catch(null),
  feed: feedSchema,
  composerDraft: z.string().catch(""),
  composerAttachments: attachmentsSchema,
  composerSubmission: submissionSchema.nullable().catch(null),
});
const trueMapSchema = z.record(z.string(), z.literal(true)).catch({});
const countMapSchema = z.record(z.string(), z.number().int().nonnegative()).catch({});

function sanitizeThread(thread: MobileThreadSummary): MobileThreadSummary {
  return {
    ...thread,
    composerSubmission: thread.composerSubmission
      ? {
          ...thread.composerSubmission,
          status: "failed",
          error: thread.composerSubmission.error ?? "Sending was interrupted. Retry to continue.",
        }
      : null,
    pendingPrompt: false,
    pendingServerRequest: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCache(value: unknown): ThreadOfflineCache | null {
  if (
    !isRecord(value) ||
    ![1, 2, 3, THREAD_OFFLINE_CACHE_VERSION].includes(value.version as number)
  )
    return null;
  const defaults = defaultThreadHomeUiState();
  const threads = (Array.isArray(value.threads) ? value.threads : []).flatMap((row) => {
    const parsed = cachedThreadSchema.safeParse(row);
    return parsed.success
      ? [sanitizeThread({ ...parsed.data, pendingPrompt: false, pendingServerRequest: null })]
      : [];
  });
  const snapshots: Record<string, SessionSnapshotLike> = {};
  const rawSnapshots = isRecord(value.snapshots) ? value.snapshots : {};
  for (const thread of threads) {
    const raw = rawSnapshots[thread.id];
    if (!isRecord(raw)) continue;
    const parsed = sessionSnapshotSchema.safeParse({ ...raw, feed: feedSchema.parse(raw.feed) });
    if (!parsed.success || parsed.data.sessionId !== thread.id) continue;
    const snapshot = { ...parsed.data, hasPendingAsk: false, hasPendingApproval: false };
    snapshots[thread.id] = snapshot;
    if (snapshot.feed.length > 0) thread.feed = snapshot.feed;
  }
  return {
    version: THREAD_OFFLINE_CACHE_VERSION,
    cachedAt: typeof value.cachedAt === "string" ? value.cachedAt : new Date().toISOString(),
    threads,
    snapshots,
    expandedWorkspaceIds: trueMapSchema.parse(value.expandedWorkspaceIds),
    sectionOrder: normalizeHomeSectionOrder(
      Array.isArray(value.sectionOrder) ? value.sectionOrder : undefined,
    ),
    showAllChats:
      typeof value.showAllChats === "boolean" ? value.showAllChats : defaults.showAllChats,
    expandedProjectThreadLists: trueMapSchema.parse(value.expandedProjectThreadLists),
    projectThreadFetchLimits: countMapSchema.parse(value.projectThreadFetchLimits),
    projectThreadTotals: countMapSchema.parse(value.projectThreadTotals),
    oneOffChatWorkspaceLoadLimit: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .catch(defaults.oneOffChatWorkspaceLoadLimit)
      .parse(value.oneOffChatWorkspaceLoadLimit),
  };
}

export async function saveThreadOfflineCache(
  input: ThreadOfflineCacheInput,
  desktopId = getOfflineCacheScope().desktopId,
): Promise<void> {
  const threads = input.threads
    .filter(
      (thread, index) =>
        index < MAX_CACHED_THREADS ||
        hasComposerContent(thread.composerDraft, thread.composerAttachments ?? []) ||
        thread.composerSubmission !== null,
    )
    .map(sanitizeThread);
  const snapshots: Record<string, SessionSnapshotLike> = {};
  for (const thread of threads) {
    const snapshot = input.snapshots[thread.id];
    if (snapshot) {
      snapshots[thread.id] = {
        ...snapshot,
        feed: snapshot.feed.slice(-MAX_CACHED_FEED_ITEMS),
        hasPendingAsk: false,
        hasPendingApproval: false,
      };
      thread.feed = [];
    } else {
      thread.feed = thread.feed.slice(-MAX_CACHED_FEED_ITEMS);
    }
  }
  const saved = await saveToOfflineCache(
    THREAD_OFFLINE_CACHE_KEY,
    {
      ...defaultThreadHomeUiState(),
      ...input,
      version: THREAD_OFFLINE_CACHE_VERSION,
      cachedAt: new Date().toISOString(),
      threads,
      snapshots,
    },
    desktopId,
  );
  if (!saved) throw new Error("Could not save offline conversations on this device.");
}

function recoverUnownedDrafts(
  cache: ThreadOfflineCache,
  preserveTitles: boolean,
): MobileThreadSummary[] {
  // Unowned caches cannot attribute transcripts or uploaded-file paths to a desktop.
  return cache.threads
    .filter(
      (thread) =>
        hasComposerContent(thread.composerDraft, thread.composerAttachments ?? []) ||
        thread.composerSubmission !== null,
    )
    .flatMap((thread): MobileThreadSummary[] => {
      const submission = thread.composerSubmission;
      const attachments = thread.composerAttachments ?? [];
      const drafts = [{ text: thread.composerDraft, attachments }];
      if (
        submission &&
        (submission.text !== thread.composerDraft ||
          !sameComposerAttachments(submission.attachments, attachments))
      ) {
        drafts.push({ text: submission.text, attachments: submission.attachments });
      }
      return drafts
        .filter((draft) => hasComposerContent(draft.text, draft.attachments))
        .map(({ text, attachments }, index) => {
          const needsReattachment = attachments.some(
            (attachment) => attachment.type === "uploadedFile",
          );
          return {
            ...thread,
            id: `${thread.id.startsWith("draft-") ? thread.id : `draft-recovered-${thread.id}`}${index ? "-pending" : ""}`,
            title: needsReattachment
              ? "Recovered draft — reattach files"
              : preserveTitles
                ? thread.title
                : "Recovered draft",
            composerDraft: text,
            composerAttachments: attachments.filter((attachment) => attachment.type === "file"),
            composerSubmission: null,
            feed: [],
            cwd: null,
            workspaceId: null,
            workspaceName: null,
            workspaceKind: null,
            preview: "Recovered unsent draft.",
          };
        });
    });
}

function mergeRecoveredDrafts(
  existing: MobileThreadSummary[],
  recovered: MobileThreadSummary[],
): MobileThreadSummary[] {
  const threads = [...existing];
  for (const draft of recovered) {
    let id = draft.id;
    let suffix = 0;
    let duplicate = false;
    for (;;) {
      const occupied = threads.find((thread) => thread.id === id);
      if (!occupied) break;
      if (
        occupied.composerDraft === draft.composerDraft &&
        sameComposerAttachments(occupied.composerAttachments ?? [], draft.composerAttachments ?? [])
      ) {
        duplicate = true;
        break;
      }
      id = `${draft.id}-recovered-${++suffix}`;
    }
    if (!duplicate) threads.push({ ...draft, id });
  }
  return threads;
}

export async function loadThreadOfflineCache(
  desktopId = getOfflineCacheScope().desktopId,
): Promise<ThreadOfflineCache | null> {
  const cached = normalizeCache(await loadFromOfflineCache(THREAD_OFFLINE_CACHE_KEY, desktopId));
  if (cached && desktopId === null) return cached;

  const unpaired =
    desktopId === null
      ? null
      : normalizeCache(await loadFromOfflineCache(THREAD_OFFLINE_CACHE_KEY, null));
  const source = unpaired ?? (cached ? null : normalizeCache(await loadLegacyThreadCache()));
  if (!source) return cached;
  const drafts = recoverUnownedDrafts(source, unpaired !== null);
  if (unpaired && drafts.length === 0) return cached;
  if (desktopId !== null && !(await claimOfflineDraftRecovery(desktopId))) return cached;

  const recovered: ThreadOfflineCache = {
    ...source,
    ...defaultThreadHomeUiState(),
    ...cached,
    threads: mergeRecoveredDrafts(cached?.threads ?? [], drafts),
    snapshots: cached?.snapshots ?? {},
  };
  await saveThreadOfflineCache(recovered, desktopId);
  await markLegacyDraftsRecovered();
  if (unpaired) await clearUnpairedThreadCache();
  return recovered;
}
