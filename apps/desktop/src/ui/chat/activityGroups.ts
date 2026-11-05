import {
  confirmedRecoveredToolIds,
  effectiveToolState,
  isFailedToolState,
  type ActivityGroupSummary as SharedActivityGroupSummary,
  summarizeActivityTrace,
  unresolvedToolFailureIdsFromSummary,
} from "../../../../../src/shared/activityGroups";
import type { FeedItem } from "../../app/types";
import { formatToolCard } from "./toolCards/toolCardFormatting";

export type ActivityFeedItem = Extract<FeedItem, { kind: "reasoning" | "tool" }>;

export type ChatRenderItem =
  | { kind: "feed-item"; item: FeedItem }
  | {
      kind: "activity-group";
      id: string;
      items: ActivityFeedItem[];
      recoveredToolIds: string[];
    };

export type LiveFeedOwnership = {
  activityGroupId: string | null;
  assistantMessageId: string | null;
};

export type ActivityGroupSummary = SharedActivityGroupSummary<
  Extract<FeedItem, { kind: "reasoning" }>,
  Extract<FeedItem, { kind: "tool" }>
>;

type FeedItemRenderItem = Extract<ChatRenderItem, { kind: "feed-item" }>;
const feedItemWrapperCache = new WeakMap<FeedItem, FeedItemRenderItem>();
type ActivityGroupRenderItem = Extract<ChatRenderItem, { kind: "activity-group" }>;
const activityGroupCache = new WeakMap<ActivityFeedItem, ActivityGroupRenderItem>();
const assistantActivityCache = new WeakMap<
  Extract<FeedItem, { kind: "message" }>,
  Extract<FeedItem, { kind: "reasoning" }>
>();

function getFeedItemWrapper(item: FeedItem): FeedItemRenderItem {
  let cached = feedItemWrapperCache.get(item);
  if (!cached || cached.item !== item) {
    cached = { kind: "feed-item", item };
    feedItemWrapperCache.set(item, cached);
  }
  return cached;
}

function assistantAsActivityReasoning(
  item: Extract<FeedItem, { kind: "message" }>,
): Extract<FeedItem, { kind: "reasoning" }> {
  const cached = assistantActivityCache.get(item);
  if (cached) return cached;
  const reasoning: Extract<FeedItem, { kind: "reasoning" }> = {
    id: item.id,
    kind: "reasoning",
    mode: "summary",
    ts: item.ts,
    text: item.text,
  };
  assistantActivityCache.set(item, reasoning);
  return reasoning;
}

function reuseActivityGroup(group: ActivityGroupRenderItem): ActivityGroupRenderItem {
  const first = group.items[0];
  if (!first) return group;
  const cached = activityGroupCache.get(first);
  // Feed items are immutable. Retaining the group also retains its memoized
  // timeline and Markdown while a different message is streaming.
  if (
    cached?.id === group.id &&
    cached.items.length === group.items.length &&
    cached.items.every((item, index) => item === group.items[index]) &&
    cached.recoveredToolIds.length === group.recoveredToolIds.length &&
    cached.recoveredToolIds.every((id, index) => id === group.recoveredToolIds[index])
  ) {
    return cached;
  }
  activityGroupCache.set(first, group);
  return group;
}

function isCompactAssistantProgress(item: Extract<FeedItem, { kind: "message" }>): boolean {
  const text = item.text.trim();
  if (text.length === 0 || text.length > 200 || text.includes("\n")) return false;
  if (item.annotations && item.annotations.length > 0) return false;
  if (/cite|[【[]\d+(?::\d+)?†|https?:\/\/|\[[^\]]+\]\([^)]+\)/i.test(text)) {
    return false;
  }

  return /\blet me\b|\bi(?:['’]ll| will| am going to|['’]m going to)\b|^(?:(?:i['’]m|i am|we['’]re|we are)\s+)?(?:checking|searching|working|reviewing|inspecting|reading|fetching|looking|analyzing|analysing|investigating|running|gathering|loading|preparing|retrying|trying|waiting)\b/i.test(
    text,
  );
}

function isUserFeedItem(item: ChatRenderItem): item is {
  kind: "feed-item";
  item: Extract<FeedItem, { kind: "message" }> & { role: "user" };
} {
  return item.kind === "feed-item" && item.item.kind === "message" && item.item.role === "user";
}

function isAssistantFeedItem(item: ChatRenderItem): item is {
  kind: "feed-item";
  item: Extract<FeedItem, { kind: "message" }> & { role: "assistant" };
} {
  return (
    item.kind === "feed-item" && item.item.kind === "message" && item.item.role === "assistant"
  );
}

/**
 * Merge genuine progress narration into adjacent activity without converting
 * substantive or cited assistant messages into lossy synthetic reasoning.
 */
function mergeTurnActivity(items: ChatRenderItem[]): ChatRenderItem[] {
  const out: ChatRenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const current = items[index];
    if (!current) {
      index += 1;
      continue;
    }

    if (isUserFeedItem(current)) {
      out.push(current);
      index += 1;
      continue;
    }

    const segment: ChatRenderItem[] = [];
    while (index < items.length) {
      const entry = items[index];
      if (!entry || isUserFeedItem(entry)) break;
      segment.push(entry);
      index += 1;
    }

    const lastAssistantIdx = segment.findLastIndex(isAssistantFeedItem);
    const mergedItems: ActivityFeedItem[] = [];
    let recoveredToolIds: string[] = [];
    let groupId: string | null = null;

    const flushMerged = () => {
      const first = mergedItems[0];
      if (!first) return;
      out.push({
        kind: "activity-group",
        id: groupId ?? `activity-${first.id}`,
        items: [...mergedItems],
        recoveredToolIds,
      });
      mergedItems.length = 0;
      groupId = null;
    };

    for (let j = 0; j < segment.length; j++) {
      const entry = segment[j];
      if (!entry) continue;

      if (entry.kind === "activity-group") {
        if (!groupId) groupId = entry.id;
        mergedItems.push(...entry.items);
        recoveredToolIds = entry.recoveredToolIds;
        continue;
      }

      if (isAssistantFeedItem(entry)) {
        const hasAdjacentActivity =
          segment[j - 1]?.kind === "activity-group" || segment[j + 1]?.kind === "activity-group";
        if (
          j === lastAssistantIdx ||
          !hasAdjacentActivity ||
          !isCompactAssistantProgress(entry.item)
        ) {
          flushMerged();
          out.push(entry);
          continue;
        }
        // Preserve the first real activity group's identity when its preceding
        // progress message becomes eligible for compaction mid-stream.
        mergedItems.push(assistantAsActivityReasoning(entry.item));
        continue;
      }

      // Errors / system / logs break the merge so they stay visible in place.
      flushMerged();
      out.push(entry);
    }

    flushMerged();
  }

  return out;
}

/** Compact label for collapsed activity headers (e.g. "Read ×2 · Todo Write"). */
export function formatActivityContentSummary(items: ActivityFeedItem[]): string | null {
  const toolItems = items.filter(
    (item): item is Extract<ActivityFeedItem, { kind: "tool" }> => item.kind === "tool",
  );
  if (toolItems.length === 0) {
    return items.some((item) => item.kind === "reasoning") ? "Thought" : null;
  }

  const counts = new Map<string, { title: string; count: number }>();
  for (const tool of toolItems) {
    const title = formatToolCard(tool.name, undefined, undefined, "output-available").title;
    const key = title.toLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { title, count: 1 });
    }
  }

  if (counts.size > 3) return `${toolItems.length} tools`;
  return [...counts.values()]
    .map(({ title, count }) => (count > 1 ? `${title} ×${count}` : title))
    .join(" · ");
}

export function buildChatRenderItems(feed: FeedItem[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let currentGroup: ActivityFeedItem[] = [];
  const recoveredToolIds = confirmedRecoveredToolIds(feed);

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    items.push({
      kind: "activity-group",
      id: `activity-${currentGroup[0].id}`,
      items: currentGroup,
      recoveredToolIds,
    });
    currentGroup = [];
  };

  for (const item of feed) {
    // Plan progress belongs in the context sidebar above Files. Todos are
    // state snapshots, not transcript content, so do not render duplicates.
    if (item.kind === "todos") continue;
    if (item.kind === "reasoning" || item.kind === "tool") {
      currentGroup.push(item);
      continue;
    }
    flushGroup();
    items.push(getFeedItemWrapper(item));
  }

  flushGroup();
  return mergeTurnActivity(items).map((item) =>
    item.kind === "activity-group" ? reuseActivityGroup(item) : item,
  );
}

// One visual live owner per busy turn: the latest top-level render item wins
// so activity cards and assistant bubbles are never simultaneously "live".
export function resolveLiveFeedOwnership(
  renderItems: ChatRenderItem[],
  busy: boolean,
): LiveFeedOwnership {
  if (!busy) {
    return { activityGroupId: null, assistantMessageId: null };
  }
  for (let i = renderItems.length - 1; i >= 0; i--) {
    const entry = renderItems[i];
    if (!entry) continue;
    if (entry.kind === "activity-group") {
      return { activityGroupId: entry.id, assistantMessageId: null };
    }
    if (entry.item.kind === "message" && entry.item.role === "assistant") {
      return { activityGroupId: null, assistantMessageId: entry.item.id };
    }
    if (entry.item.kind === "message" && entry.item.role === "user") {
      break;
    }
  }
  return { activityGroupId: null, assistantMessageId: null };
}

/**
 * True while a pending or running turn has produced no visible output yet —
 * the window where the transcript ends with the user's message and would
 * otherwise look frozen. Log/system lines are skipped because they are not
 * model output.
 */
export function shouldShowWorkingPlaceholder(opts: {
  busy: boolean;
  turnStartPending: boolean;
  renderItems: ChatRenderItem[];
}): boolean {
  if (!opts.busy && !opts.turnStartPending) return false;
  for (let i = opts.renderItems.length - 1; i >= 0; i--) {
    const entry = opts.renderItems[i];
    if (!entry) continue;
    if (entry.kind === "activity-group") return false;
    const item = entry.item;
    if (item.kind === "log" || item.kind === "system") continue;
    return item.kind === "message" && item.role === "user";
  }
  return false;
}

export function summarizeActivityGroup(
  items: ActivityFeedItem[],
  confirmedRecoveredIds: Iterable<string> = [],
): ActivityGroupSummary {
  return summarizeActivityTrace(
    items,
    confirmedRecoveredIds,
    (tool) => formatToolCard(tool.name, tool.args, tool.result, tool.state).subtitle,
  );
}

export function unresolvedToolFailureIds(
  items: ActivityFeedItem[],
  confirmedRecoveredIds: Iterable<string> = [],
): string[] {
  return unresolvedToolFailureIdsFromSummary(summarizeActivityGroup(items, confirmedRecoveredIds));
}

export function hasTrailingUnrecoveredToolFailure(summary: ActivityGroupSummary): boolean {
  if (summary.status !== "issue") return false;
  const recovered = new Set(summary.recoveredToolIds);
  let lastUnrecoveredIndex = -1;
  let lastAutonomousSuccessIndex = -1;
  for (let index = 0; index < summary.entries.length; index += 1) {
    const entry = summary.entries[index];
    if (entry?.kind !== "tool") continue;
    const state = effectiveToolState(entry.item);
    if (isFailedToolState(state) && !recovered.has(entry.item.id)) {
      lastUnrecoveredIndex = index;
    } else if (state === "output-available" && typeof entry.item.retryOf !== "string") {
      lastAutonomousSuccessIndex = index;
    }
  }
  return lastUnrecoveredIndex !== -1 && lastUnrecoveredIndex > lastAutonomousSuccessIndex;
}

export function latestRetryableActivityGroupId(renderItems: ChatRenderItem[]): string | null {
  for (let index = renderItems.length - 1; index >= 0; index -= 1) {
    const item = renderItems[index];
    if (!item) continue;
    if (item.kind === "activity-group") {
      try {
        const summary = summarizeActivityGroup(item.items, item.recoveredToolIds);
        if (hasTrailingUnrecoveredToolFailure(summary)) {
          return item.id;
        }
      } catch {
        // Rendering owns malformed-item isolation; retry discovery must not bypass that boundary.
      }
      continue;
    }
    if (item.item.kind === "message" && item.item.role === "user") return null;
  }
  return null;
}
