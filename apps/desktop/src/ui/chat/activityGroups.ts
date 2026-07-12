import { isTerminalToolState } from "../../app/toolFeedState";
import type { FeedItem, ToolFeedState } from "../../app/types";

import { buildMarkdownPreviewText } from "./markdownPreview";
import { formatToolCard } from "./toolCards/toolCardFormatting";

export type ActivityFeedItem = Extract<FeedItem, { kind: "reasoning" | "tool" }>;
type ToolTraceItem = Extract<FeedItem, { kind: "tool" }> & { sourceIds: string[] };
type ActivityTraceEntry =
  | { kind: "reasoning"; item: Extract<FeedItem, { kind: "reasoning" }> }
  | { kind: "tool"; item: ToolTraceItem };

export type ChatRenderItem =
  | { kind: "feed-item"; item: FeedItem }
  | {
      kind: "activity-group";
      id: string;
      items: ActivityFeedItem[];
      recoveredToolIds: string[];
    };

type ActivityGroupStatus = "approval" | "issue" | "running" | "done";

export type ActivityGroupSummary = {
  elapsedLabel: string | null;
  entries: ActivityTraceEntry[];
  preview: string;
  reasoningCount: number;
  recoveredToolIds: string[];
  status: ActivityGroupStatus;
  statusLabel: string;
  title: string;
  toolCount: number;
};

function normalizedReasoningText(text: string): string {
  return text.trim();
}

function hasRenderableReasoningText(item: Extract<FeedItem, { kind: "reasoning" }>): boolean {
  return normalizedReasoningText(item.text).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effectiveToolState(item: Extract<FeedItem, { kind: "tool" }>): ToolFeedState {
  if (item.result !== undefined && isRecord(item.result)) {
    if (item.result.denied === true) return "output-denied";
    if ("error" in item.result || item.result.ok === false) return "output-error";
  }
  if (
    item.name.toLowerCase() === "skill" &&
    typeof item.result === "string" &&
    /\bnot found\b/i.test(item.result)
  ) {
    return "output-error";
  }
  if (isTerminalToolState(item.state) || item.result === undefined) return item.state;
  return "output-available";
}

function normalizeToolActivityItem(
  item: Extract<FeedItem, { kind: "tool" }>,
): Extract<FeedItem, { kind: "tool" }> {
  const state = effectiveToolState(item);
  return state === item.state ? item : { ...item, state };
}

function shouldMergeToolTraceItems(
  previous: ToolTraceItem,
  next: Extract<FeedItem, { kind: "tool" }>,
): boolean {
  return previous.sourceIds.includes(next.id);
}

function buildActivityTraceEntries(items: ActivityFeedItem[]): ActivityTraceEntry[] {
  const entries: ActivityTraceEntry[] = [];
  const firstBlankReasoning = items.find(
    (item): item is Extract<FeedItem, { kind: "reasoning" }> =>
      item.kind === "reasoning" && !hasRenderableReasoningText(item),
  );

  for (const item of items) {
    const previous = entries[entries.length - 1];
    if (item.kind === "reasoning") {
      if (!hasRenderableReasoningText(item)) {
        continue;
      }
      if (
        previous?.kind === "reasoning" &&
        previous.item.mode === item.mode &&
        normalizedReasoningText(previous.item.text) === normalizedReasoningText(item.text)
      ) {
        continue;
      }
      entries.push({ kind: "reasoning", item });
      continue;
    }

    const toolItem = normalizeToolActivityItem(item);

    if (previous?.kind === "tool" && shouldMergeToolTraceItems(previous.item, toolItem)) {
      entries[entries.length - 1] = {
        kind: "tool",
        item: {
          ...previous.item,
          name: toolItem.name,
          state: toolItem.state,
          args: toolItem.args ?? previous.item.args,
          result: toolItem.result ?? previous.item.result,
          retryOf: toolItem.retryOf ?? previous.item.retryOf,
          approval: toolItem.approval ?? previous.item.approval,
          completedAt: toolItem.completedAt ?? previous.item.completedAt,
          sourceIds: previous.item.sourceIds,
        },
      };
      continue;
    }

    entries.push({ kind: "tool", item: { ...toolItem, sourceIds: [toolItem.id] } });
  }

  if (entries.length === 0 && firstBlankReasoning) {
    return [{ kind: "reasoning", item: firstBlankReasoning }];
  }

  return entries;
}

function deriveStatus(
  toolItems: ToolTraceItem[],
  recoveredToolIds: ReadonlySet<string>,
): ActivityGroupStatus {
  if (
    toolItems.some((item) => {
      const state = effectiveToolState(item);
      return (
        (state === "output-error" || state === "output-denied") && !recoveredToolIds.has(item.id)
      );
    })
  ) {
    return "issue";
  }
  const states = new Set<ToolFeedState>(toolItems.map((item) => effectiveToolState(item)));
  if (states.has("approval-requested")) return "approval";
  if (states.has("input-streaming") || states.has("input-available")) return "running";
  return "done";
}

function statusLabel(status: ActivityGroupStatus, toolCount: number): string {
  if (status === "approval") return "Needs review";
  if (status === "issue") return "Issue";
  if (status === "running") return "Working";
  if (toolCount > 0) return "Done";
  return "Summary";
}

export function activityTimestampMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function formatActivityElapsedMs(durationMs: number): string {
  const totalSeconds = durationMs > 0 ? Math.max(1, Math.floor(durationMs / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function activityElapsedLabel(items: ActivityFeedItem[]): string | null {
  const timestamps: number[] = [];
  for (const item of items) {
    const startedAt = activityTimestampMs(item.ts);
    if (startedAt !== null) timestamps.push(startedAt);
    const completedAt =
      item.kind === "tool" && item.completedAt ? activityTimestampMs(item.completedAt) : null;
    if (completedAt !== null) timestamps.push(completedAt);
  }
  if (timestamps.length < 2) return null;
  const startedAt = Math.min(...timestamps);
  const endedAt = Math.max(...timestamps);
  return formatActivityElapsedMs(endedAt - startedAt);
}

export function firstActivityTimestampMs(items: ActivityFeedItem[]): number | null {
  const timestamps = items.map((item) => activityTimestampMs(item.ts)).filter((ms) => ms !== null);
  if (timestamps.length === 0) return null;
  return Math.min(...timestamps);
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

  for (let i = 0; i < feed.length; i++) {
    const item = feed[i];
    if (!item) continue;
    // Plan progress belongs in the context sidebar above Files. Todos are
    // state snapshots, not transcript content, so do not render duplicates.
    if (item.kind === "todos") {
      continue;
    }
    if (item.kind === "reasoning") {
      currentGroup.push(item);
      continue;
    }
    if (item.kind === "tool") {
      currentGroup.push(item);
      continue;
    }
    flushGroup();
    items.push({ kind: "feed-item", item });
  }

  flushGroup();
  return items;
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
  const entries = buildActivityTraceEntries(items);
  const hasPendingReasoning =
    entries.length === 1 &&
    entries[0]?.kind === "reasoning" &&
    !hasRenderableReasoningText(entries[0].item);
  const reasoningItems = entries
    .filter(
      (entry): entry is Extract<ActivityTraceEntry, { kind: "reasoning" }> =>
        entry.kind === "reasoning",
    )
    .map((entry) => entry.item);
  const toolItems = entries
    .filter(
      (entry): entry is Extract<ActivityTraceEntry, { kind: "tool" }> => entry.kind === "tool",
    )
    .map((entry) => entry.item);
  const primaryReasoning =
    [...reasoningItems].reverse().find((item) => item.mode === "summary") ??
    reasoningItems[reasoningItems.length - 1];
  const latestTool = toolItems[toolItems.length - 1];
  const preview = hasPendingReasoning
    ? "Thinking..."
    : primaryReasoning?.text
      ? buildMarkdownPreviewText(primaryReasoning.text, 2)
      : latestTool
        ? formatToolCard(latestTool.name, latestTool.args, latestTool.result, latestTool.state)
            .subtitle
        : "Reasoning and tool activity";
  const recoveredToolIds = new Set(confirmedRecoveredIds);
  for (const retryOf of toolItems
    .filter(
      (item) => typeof item.retryOf === "string" && effectiveToolState(item) === "output-available",
    )
    .map((item) => item.retryOf as string)) {
    recoveredToolIds.add(retryOf);
  }
  let recoveryChanged = true;
  while (recoveryChanged) {
    recoveryChanged = false;
    for (const item of toolItems) {
      const state = effectiveToolState(item);
      if (
        recoveredToolIds.has(item.id) ||
        typeof item.retryOf !== "string" ||
        !recoveredToolIds.has(item.retryOf) ||
        (state !== "output-error" && state !== "output-denied")
      ) {
        continue;
      }
      recoveredToolIds.add(item.id);
      recoveryChanged = true;
    }
  }
  const status = hasPendingReasoning ? "running" : deriveStatus(toolItems, recoveredToolIds);

  return {
    elapsedLabel: activityElapsedLabel(items),
    entries,
    preview,
    reasoningCount: reasoningItems.length,
    recoveredToolIds: [...recoveredToolIds],
    status,
    statusLabel: statusLabel(status, toolItems.length),
    title: "Thought process",
    toolCount: toolItems.length,
  };
}

export function unresolvedToolFailureIds(
  items: ActivityFeedItem[],
  confirmedRecoveredIds: Iterable<string> = [],
): string[] {
  const summary = summarizeActivityGroup(items, confirmedRecoveredIds);
  const recovered = new Set(summary.recoveredToolIds);
  return summary.entries
    .filter(
      (entry): entry is Extract<ActivityTraceEntry, { kind: "tool" }> => entry.kind === "tool",
    )
    .map((entry) => entry.item)
    .filter((item) => {
      const state = effectiveToolState(item);
      return (state === "output-error" || state === "output-denied") && !recovered.has(item.id);
    })
    .map((item) => item.id);
}

export function confirmedRecoveredToolIds(feed: FeedItem[]): string[] {
  const toolById = new Map<string, Extract<FeedItem, { kind: "tool" }>>();
  for (const item of feed) {
    if (item.kind === "tool") {
      toolById.set(item.id, item);
    }
  }

  const recovered = new Set<string>();
  for (const item of toolById.values()) {
    if (
      typeof item.retryOf !== "string" ||
      item.retryOf === item.id ||
      effectiveToolState(item) !== "output-available"
    ) {
      continue;
    }
    const visited = new Set<string>();
    let targetId: string | undefined = item.retryOf;
    while (targetId && !visited.has(targetId)) {
      visited.add(targetId);
      const target = toolById.get(targetId);
      if (!target) break;
      const targetState = effectiveToolState(target);
      if (targetState !== "output-error" && targetState !== "output-denied") break;
      recovered.add(target.id);
      targetId = target.retryOf;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of toolById.values()) {
      const state = effectiveToolState(item);
      if (
        recovered.has(item.id) ||
        typeof item.retryOf !== "string" ||
        !recovered.has(item.retryOf) ||
        (state !== "output-error" && state !== "output-denied")
      ) {
        continue;
      }
      recovered.add(item.id);
      changed = true;
    }
  }
  return [...recovered];
}

export function latestRetryableActivityGroupId(renderItems: ChatRenderItem[]): string | null {
  for (let index = renderItems.length - 1; index >= 0; index -= 1) {
    const item = renderItems[index];
    if (!item) continue;
    if (item.kind === "activity-group") {
      try {
        if (summarizeActivityGroup(item.items, item.recoveredToolIds).status === "issue") {
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
