import { buildMarkdownPreviewText } from "./markdownPreview";
import type { SessionFeedItem } from "./protocolTypes";
import { formatToolCard } from "./toolCardFormatting";
import { isTerminalToolState, type ToolFeedState } from "./toolFeedState";

export type ActivityFeedItem = Extract<SessionFeedItem, { kind: "reasoning" | "tool" }>;
export type ToolTraceItem = Extract<SessionFeedItem, { kind: "tool" }> & { sourceIds: string[] };
export type ActivityTraceEntry =
  | { kind: "reasoning"; item: Extract<SessionFeedItem, { kind: "reasoning" }> }
  | { kind: "tool"; item: ToolTraceItem };

export type ChatRenderItem =
  | { kind: "feed-item"; item: SessionFeedItem }
  | { kind: "activity-group"; id: string; items: ActivityFeedItem[] };

export type ActivityGroupStatus = "approval" | "issue" | "running" | "done";

export type ActivityGroupSummary = {
  elapsedLabel: string | null;
  entries: ActivityTraceEntry[];
  preview: string;
  reasoningCount: number;
  status: ActivityGroupStatus;
  statusLabel: string;
  title: string;
  toolCount: number;
};

function normalizedReasoningText(text: string): string {
  return text.trim();
}

function hasRenderableReasoningText(
  item: Extract<SessionFeedItem, { kind: "reasoning" }>,
): boolean {
  return normalizedReasoningText(item.text).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effectiveToolState(item: Extract<SessionFeedItem, { kind: "tool" }>): ToolFeedState {
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
  item: Extract<SessionFeedItem, { kind: "tool" }>,
): Extract<SessionFeedItem, { kind: "tool" }> {
  const state = effectiveToolState(item);
  return state === item.state ? item : { ...item, state };
}

function shouldMergeToolTraceItems(
  previous: ToolTraceItem,
  next: Extract<SessionFeedItem, { kind: "tool" }>,
): boolean {
  return previous.sourceIds.includes(next.id);
}

function buildActivityTraceEntries(items: ActivityFeedItem[]): ActivityTraceEntry[] {
  const entries: ActivityTraceEntry[] = [];
  const firstBlankReasoning = items.find(
    (item): item is Extract<SessionFeedItem, { kind: "reasoning" }> =>
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

function deriveStatus(toolItems: ToolTraceItem[]): ActivityGroupStatus {
  const states = new Set<ToolFeedState>(toolItems.map((item) => effectiveToolState(item)));
  if (states.has("output-error") || states.has("output-denied")) return "issue";
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
      item.kind === "tool" && typeof item.completedAt === "string"
        ? activityTimestampMs(item.completedAt)
        : null;
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

export function buildChatRenderItems(feed: SessionFeedItem[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let currentGroup: ActivityFeedItem[] = [];

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    items.push({
      kind: "activity-group",
      id: `activity-${currentGroup[0].id}`,
      items: currentGroup,
    });
    currentGroup = [];
  };

  for (let i = 0; i < feed.length; i++) {
    const item = feed[i];
    if (!item) continue;
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

export function summarizeActivityGroup(items: ActivityFeedItem[]): ActivityGroupSummary {
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
  const status = hasPendingReasoning ? "running" : deriveStatus(toolItems);

  return {
    elapsedLabel: activityElapsedLabel(items),
    entries,
    preview,
    reasoningCount: reasoningItems.length,
    status,
    statusLabel: statusLabel(status, toolItems.length),
    title: "Thought process",
    toolCount: toolItems.length,
  };
}

export function parseReasoningSections(text: string): Array<{ title: string; body: string }> {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const headingRegex = /(?:^|\n+)(?:#+\s+|\*\*|__)([^*#\n_]+?)(?:\*\*|__)?\s*(?:\n+|$)/g;
  const matches: { title: string; index: number; length: number }[] = [];

  let match: RegExpExecArray | null = headingRegex.exec(normalized);
  while (match !== null) {
    matches.push({
      title: match[1].trim(),
      index: match.index,
      length: match[0].length,
    });
    match = headingRegex.exec(normalized);
  }

  if (matches.length === 0) {
    return [{ title: "", body: normalized }];
  }

  const sections: Array<{ title: string; body: string }> = [];
  for (let i = 0; i < matches.length; i++) {
    const currentMatch = matches[i];
    const nextMatch = matches[i + 1];

    const contentStart = currentMatch.index + currentMatch.length;
    const contentEnd = nextMatch ? nextMatch.index : normalized.length;
    const body = normalized.slice(contentStart, contentEnd).trim();

    sections.push({
      title: currentMatch.title,
      body,
    });
  }

  if (matches[0].index > 0) {
    const leadingBody = normalized.slice(0, matches[0].index).trim();
    if (leadingBody) {
      sections.unshift({ title: "", body: leadingBody });
    }
  }

  return sections;
}
