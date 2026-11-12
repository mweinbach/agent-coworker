import {
  confirmedRecoveredToolIds,
  type ActivityGroupSummary as SharedActivityGroupSummary,
  summarizeActivityTrace,
  unresolvedToolFailureIdsFromSummary,
} from "../../../../../src/shared/activityGroups";
import { isHiddenRetryTurnMessage } from "../../../../../src/shared/chatRetry";
import { normalizeReasoningMarkdown } from "../../../../../src/shared/markdownPreview";
import type { SessionFeedItem } from "./protocolTypes";
import { formatToolCard } from "./toolCardFormatting";

export type ActivityFeedItem = Extract<SessionFeedItem, { kind: "reasoning" | "tool" }>;

export type ChatRenderItem =
  | { kind: "feed-item"; item: SessionFeedItem }
  | {
      kind: "activity-group";
      id: string;
      items: ActivityFeedItem[];
      recoveredToolIds: string[];
    };

export type ActivityGroupSummary = SharedActivityGroupSummary<
  Extract<SessionFeedItem, { kind: "reasoning" }>,
  Extract<SessionFeedItem, { kind: "tool" }>
>;

export function buildChatRenderItems(feed: SessionFeedItem[]): ChatRenderItem[] {
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
    if (isHiddenRetryTurnMessage(item)) {
      continue;
    }
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

export function latestRetryableActivityGroupId(renderItems: ChatRenderItem[]): string | null {
  for (let index = renderItems.length - 1; index >= 0; index -= 1) {
    const item = renderItems[index];
    if (!item) continue;
    if (item.kind === "activity-group") {
      if (summarizeActivityGroup(item.items, item.recoveredToolIds).status === "issue") {
        return item.id;
      }
      continue;
    }
    if (item.item.kind === "message" && item.item.role === "user") return null;
  }
  return null;
}

export function parseReasoningSections(text: string): Array<{ title: string; body: string }> {
  const normalized = normalizeReasoningMarkdown(text);
  if (!normalized) return [];

  const headingRegex =
    /(?:^|\n+)(?:#{1,6}\s+([^\n]+?)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__)[ \t]*(?=\n|$)/g;
  const matches: { title: string; index: number; length: number }[] = [];

  let match: RegExpExecArray | null = headingRegex.exec(normalized);
  while (match !== null) {
    matches.push({
      title: (match[1] ?? match[2] ?? match[3] ?? "").trim(),
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
