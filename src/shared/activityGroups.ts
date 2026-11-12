/**
 * Pure activity-group helpers shared by the desktop and mobile chat feeds.
 *
 * Both apps group consecutive reasoning/tool feed items into a collapsible
 * "thought process" card. The grouping of render items, tool-card copy and
 * live-ownership rules stay app-specific; this module owns the trace
 * de-duplication, tool-state normalization, retry-recovery bookkeeping and
 * status/elapsed summaries that must behave identically on both clients.
 * Functions are generic over each app's feed item type so app-local types
 * flow through unchanged.
 */
import { buildMarkdownPreviewText, normalizeReasoningMarkdown } from "./markdownPreview";
import { isTerminalToolState, type ToolFeedState } from "./toolFeedState";

type ReasoningActivityItem = {
  id: string;
  kind: "reasoning";
  mode: "reasoning" | "summary";
  ts: string;
  text: string;
};

type ToolActivityItem = {
  id: string;
  kind: "tool";
  ts: string;
  name: string;
  state: ToolFeedState;
  args?: unknown;
  result?: unknown;
  retryOf?: string;
  approval?: unknown;
  completedAt?: unknown;
};

type ActivityItem = ReasoningActivityItem | ToolActivityItem;

type ReasoningOf<A extends ActivityItem> = Extract<A, { kind: "reasoning" }>;
type ToolOf<A extends ActivityItem> = Extract<A, { kind: "tool" }>;

type ToolTraceItem<T extends ToolActivityItem> = T & { sourceIds: string[] };

type ActivityTraceEntry<R extends ReasoningActivityItem, T extends ToolActivityItem> =
  | { kind: "reasoning"; item: R }
  | { kind: "tool"; item: ToolTraceItem<T> };

type ActivityGroupStatus = "approval" | "issue" | "running" | "done";

export type ActivityGroupSummary<R extends ReasoningActivityItem, T extends ToolActivityItem> = {
  elapsedLabel: string | null;
  entries: ActivityTraceEntry<R, T>[];
  preview: string;
  reasoningCount: number;
  recoveredToolIds: string[];
  status: ActivityGroupStatus;
  statusLabel: string;
  title: string;
  toolCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReasoningActivity<A extends ActivityItem>(item: A): item is ReasoningOf<A> {
  return item.kind === "reasoning";
}

function isToolActivity(item: { kind: string }): item is ToolActivityItem {
  return item.kind === "tool";
}

function hasRenderableReasoningText(item: ReasoningActivityItem): boolean {
  return normalizeReasoningMarkdown(item.text).length > 0;
}

export function effectiveToolState(item: ToolActivityItem): ToolFeedState {
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

export function isFailedToolState(state: ToolFeedState): boolean {
  return state === "output-error" || state === "output-denied";
}

function normalizeToolActivityItem<T extends ToolActivityItem>(item: T): T {
  const state = effectiveToolState(item);
  return state === item.state ? item : { ...item, state };
}

function buildActivityTraceEntries<A extends ActivityItem>(
  items: readonly A[],
): ActivityTraceEntry<ReasoningOf<A>, ToolOf<A>>[] {
  const entries: ActivityTraceEntry<ReasoningOf<A>, ToolOf<A>>[] = [];
  const firstBlankReasoning = items.find(
    (item): item is ReasoningOf<A> =>
      isReasoningActivity(item) && !hasRenderableReasoningText(item),
  );

  for (const item of items) {
    const previous = entries[entries.length - 1];
    if (isReasoningActivity(item)) {
      if (!hasRenderableReasoningText(item)) {
        continue;
      }
      if (
        previous?.kind === "reasoning" &&
        previous.item.mode === item.mode &&
        normalizeReasoningMarkdown(previous.item.text) === normalizeReasoningMarkdown(item.text)
      ) {
        continue;
      }
      entries.push({ kind: "reasoning", item });
      continue;
    }

    const toolItem = normalizeToolActivityItem(item as ToolOf<A>);

    if (previous?.kind === "tool" && previous.item.sourceIds.includes(toolItem.id)) {
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

function propagateRecoveredToolIds(
  tools: Iterable<ToolActivityItem>,
  recovered: Set<string>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of tools) {
      if (
        recovered.has(item.id) ||
        typeof item.retryOf !== "string" ||
        !recovered.has(item.retryOf) ||
        !isFailedToolState(effectiveToolState(item))
      ) {
        continue;
      }
      recovered.add(item.id);
      changed = true;
    }
  }
}

/**
 * Failed tool ids (across the whole feed) that a later successful retry has
 * recovered, following `retryOf` chains through intermediate failed retries.
 */
export function confirmedRecoveredToolIds(feed: ReadonlyArray<{ kind: string }>): string[] {
  const toolById = new Map<string, ToolActivityItem>();
  for (const item of feed) {
    if (isToolActivity(item)) {
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
      if (!target || !isFailedToolState(effectiveToolState(target))) break;
      recovered.add(target.id);
      targetId = target.retryOf;
    }
  }
  propagateRecoveredToolIds(toolById.values(), recovered);
  return [...recovered];
}

function deriveStatus(
  toolItems: readonly ToolActivityItem[],
  recoveredToolIds: ReadonlySet<string>,
): ActivityGroupStatus {
  if (
    toolItems.some(
      (item) => isFailedToolState(effectiveToolState(item)) && !recoveredToolIds.has(item.id),
    )
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
  return toolCount > 0 ? "Done" : "Summary";
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

function activityElapsedLabel(items: readonly ActivityItem[]): string | null {
  const timestamps: number[] = [];
  for (const item of items) {
    const startedAt = activityTimestampMs(item.ts);
    if (startedAt !== null) timestamps.push(startedAt);
    const completedAt =
      item.kind === "tool" && typeof item.completedAt === "string"
        ? activityTimestampMs(item.completedAt)
        : null;
    if (completedAt !== null) timestamps.push(completedAt);
  }
  if (timestamps.length < 2) return null;
  return formatActivityElapsedMs(Math.max(...timestamps) - Math.min(...timestamps));
}

export function firstActivityTimestampMs(items: ReadonlyArray<{ ts: string }>): number | null {
  const timestamps = items
    .map((item) => activityTimestampMs(item.ts))
    .filter((ms): ms is number => ms !== null);
  return timestamps.length === 0 ? null : Math.min(...timestamps);
}

/**
 * Summarize one activity group. `formatToolSubtitle` supplies the app's
 * tool-card copy for the collapsed preview when no reasoning text exists.
 */
export function summarizeActivityTrace<A extends ActivityItem>(
  items: readonly A[],
  confirmedRecoveredIds: Iterable<string>,
  formatToolSubtitle: (tool: ToolTraceItem<ToolOf<A>>) => string,
): ActivityGroupSummary<ReasoningOf<A>, ToolOf<A>> {
  const entries = buildActivityTraceEntries(items);
  const hasPendingReasoning =
    entries.length === 1 &&
    entries[0]?.kind === "reasoning" &&
    !hasRenderableReasoningText(entries[0].item);
  const reasoningItems: ReasoningOf<A>[] = [];
  const toolItems: ToolTraceItem<ToolOf<A>>[] = [];
  for (const entry of entries) {
    if (entry.kind === "reasoning") reasoningItems.push(entry.item);
    else toolItems.push(entry.item);
  }
  const primaryReasoning =
    [...reasoningItems].reverse().find((item) => item.mode === "summary") ??
    reasoningItems[reasoningItems.length - 1];
  const latestTool = toolItems[toolItems.length - 1];
  const preview = hasPendingReasoning
    ? "Thinking..."
    : primaryReasoning?.text
      ? buildMarkdownPreviewText(normalizeReasoningMarkdown(primaryReasoning.text), 2)
      : latestTool
        ? formatToolSubtitle(latestTool)
        : "Reasoning and tool activity";
  const recoveredToolIds = new Set(confirmedRecoveredIds);
  for (const item of toolItems) {
    if (typeof item.retryOf === "string" && effectiveToolState(item) === "output-available") {
      recoveredToolIds.add(item.retryOf);
    }
  }
  propagateRecoveredToolIds(toolItems, recoveredToolIds);
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

/** Tool ids in a summarized group that failed and were not recovered by a retry. */
export function unresolvedToolFailureIdsFromSummary(
  summary: Pick<
    ActivityGroupSummary<ReasoningActivityItem, ToolActivityItem>,
    "entries" | "recoveredToolIds"
  >,
): string[] {
  const recovered = new Set(summary.recoveredToolIds);
  const ids: string[] = [];
  for (const entry of summary.entries) {
    if (
      entry.kind === "tool" &&
      isFailedToolState(effectiveToolState(entry.item)) &&
      !recovered.has(entry.item.id)
    ) {
      ids.push(entry.item.id);
    }
  }
  return ids;
}
