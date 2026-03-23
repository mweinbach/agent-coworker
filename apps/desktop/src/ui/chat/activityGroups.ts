import type { FeedItem, ToolFeedState } from "../../app/types";

import { formatToolCard } from "./toolCards/toolCardFormatting";

export type ActivityFeedItem = Extract<FeedItem, { kind: "reasoning" | "tool" }>;
export type ToolTraceItem = Extract<FeedItem, { kind: "tool" }> & { sourceIds: string[] };
export type ActivityTraceEntry =
  | { kind: "reasoning"; item: Extract<FeedItem, { kind: "reasoning" }> }
  | { kind: "tool"; item: ToolTraceItem };

export type ChatRenderItem =
  | { kind: "feed-item"; item: FeedItem }
  | { kind: "activity-group"; id: string; items: ActivityFeedItem[] };

export type ActivityGroupStatus = "approval" | "issue" | "running" | "done";

export type ActivityGroupSummary = {
  entries: ActivityTraceEntry[];
  preview: string;
  reasoningCount: number;
  status: ActivityGroupStatus;
  statusLabel: string;
  title: string;
  toolCount: number;
};

function truncate(text: string, max = 180): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function isStandaloneReasoningHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (/^\*\*[^*]+\*\*$/.test(trimmed)) return true;
  if (/^__[^_]+__$/.test(trimmed)) return true;
  return false;
}

function reasoningPreviewText(text: string, maxLines = 2): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  const previewLines = [...lines];
  while (previewLines.length > 1 && isStandaloneReasoningHeading(previewLines[0] ?? "")) {
    previewLines.shift();
  }

  const preview = previewLines.slice(0, maxLines).join(" ");
  return previewLines.length > maxLines ? `${preview}…` : preview;
}

function normalizedReasoningText(text: string): string {
  return text.trim();
}

function hasRenderableReasoningText(item: Extract<FeedItem, { kind: "reasoning" }>): boolean {
  return normalizedReasoningText(item.text).length > 0;
}

const genericToolSubtitles = new Set([
  "Capturing input…",
  "Running…",
  "Waiting for approval",
  "Completed",
  "Completed successfully",
  "Completed with warnings",
  "Denied",
  "Finished with an issue",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function isTerminalToolState(state: ToolFeedState): boolean {
  return state === "output-available" || state === "output-error" || state === "output-denied";
}

function toolValueSignature(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolTraceSubtitle(item: Extract<FeedItem, { kind: "tool" }>): string {
  return formatToolCard(item.name, item.args, item.result, item.state).subtitle;
}

function isGenericToolSubtitle(subtitle: string): boolean {
  if (genericToolSubtitles.has(subtitle)) return true;
  const segments = subtitle.split(" • ");
  const tail = segments[segments.length - 1] ?? subtitle;
  return genericToolSubtitles.has(tail);
}

function toolTraceInfoScore(item: Extract<FeedItem, { kind: "tool" }>): number {
  const subtitle = toolTraceSubtitle(item);
  let score = 0;

  if (item.args !== undefined) score += 1;
  if (item.result !== undefined) score += 1;
  if (!isGenericToolSubtitle(subtitle)) score += 2;

  return score;
}

function toolMergeKey(name: string, args: unknown): string | null {
  if (!isRecord(args)) return null;

  const base = name.toLowerCase();
  if (base === "bash") {
    const command = getRecordValue(args, ["command", "cmd"]);
    return typeof command === "string" ? `command:${command}` : null;
  }
  if (base === "read" || base === "write" || base === "edit") {
    const filePath = getRecordValue(args, ["filePath", "path"]);
    return typeof filePath === "string" ? `path:${filePath}` : null;
  }
  if (base === "grep") {
    const path = getRecordValue(args, ["path"]);
    const pattern = getRecordValue(args, ["pattern"]);
    const pathPart = typeof path === "string" ? path : "";
    const patternPart = typeof pattern === "string" ? pattern : "";
    return pathPart || patternPart ? `${pathPart}::${patternPart}` : null;
  }
  if (base === "glob") {
    const cwd = getRecordValue(args, ["cwd", "path"]);
    const pattern = getRecordValue(args, ["pattern"]);
    const cwdPart = typeof cwd === "string" ? cwd : "";
    const patternPart = typeof pattern === "string" ? pattern : "";
    return cwdPart || patternPart ? `${cwdPart}::${patternPart}` : null;
  }
  if (base === "todowrite") {
    const count = getRecordValue(args, ["count"]);
    if (count !== undefined) return `count:${String(count)}`;
    const todos = getRecordValue(args, ["todos"]);
    if (Array.isArray(todos)) return `count:${String(todos.length)}`;
    return null;
  }
  if (base === "spawnagent") {
    const role = getRecordValue(args, ["role"]);
    return typeof role === "string" ? `role:${role}` : null;
  }
  if (base === "ask") {
    const question = getRecordValue(args, ["question"]);
    return typeof question === "string" ? `question:${question}` : null;
  }

  const common = getRecordValue(args, ["query", "command", "filePath", "path", "url", "pattern", "input"]);
  return typeof common === "string" ? common : null;
}

function isCompactToolSummaryResult(result: unknown): boolean {
  if (!isRecord(result)) return false;
  return ["count", "chars", "ok", "exitCode", "provider"].some((key) => key in result);
}

function shouldMergeToolTraceItems(previous: ToolTraceItem, next: Extract<FeedItem, { kind: "tool" }>): boolean {
  if (previous.name !== next.name) return false;
  if (!isTerminalToolState(previous.state)) return true;

  const previousArgs = toolValueSignature(previous.args);
  const nextArgs = toolValueSignature(next.args);
  const previousResult = toolValueSignature(previous.result);
  const nextResult = toolValueSignature(next.result);
  const argsCompatible = previousArgs === null || nextArgs === null || previousArgs === nextArgs;
  const resultCompatible = previousResult === null || nextResult === null || previousResult === nextResult;
  const approvalsCompatible =
    previous.approval === undefined ||
    next.approval === undefined ||
    previous.approval.approvalId === next.approval.approvalId;

  if (previousArgs !== null && nextArgs !== null && previousArgs === nextArgs && previousResult !== null && nextResult !== null && previousResult === nextResult) {
    return true;
  }

  const previousSubtitle = toolTraceSubtitle(previous);
  const nextSubtitle = toolTraceSubtitle(next);
  const previousIsGeneric = isGenericToolSubtitle(previousSubtitle);
  const nextIsMoreInformative = toolTraceInfoScore(next) > toolTraceInfoScore(previous) && !isGenericToolSubtitle(nextSubtitle);
  const previousMergeKey = toolMergeKey(previous.name, previous.args);
  const nextMergeKey = toolMergeKey(next.name, next.args);
  const mergeKeysCompatible = previousMergeKey === null || nextMergeKey === null || previousMergeKey === nextMergeKey;

  if (previousIsGeneric && nextIsMoreInformative && argsCompatible && approvalsCompatible) {
    return true;
  }

  if (
    mergeKeysCompatible &&
    typeof previous.result === "string" &&
    isCompactToolSummaryResult(next.result) &&
    approvalsCompatible
  ) {
    return true;
  }

  return argsCompatible && resultCompatible && approvalsCompatible;
}

function mergeToolTraceItems(toolItems: Extract<FeedItem, { kind: "tool" }>[]): ToolTraceItem[] {
  const traceItems: ToolTraceItem[] = [];

  for (const item of toolItems) {
    const previous = traceItems[traceItems.length - 1];
    if (previous && shouldMergeToolTraceItems(previous, item)) {
      traceItems[traceItems.length - 1] = {
        ...previous,
        ts: item.ts,
        state: item.state,
        args: item.args ?? previous.args,
        result: item.result ?? previous.result,
        approval: item.approval ?? previous.approval,
        sourceIds: [...previous.sourceIds, item.id],
      };
      continue;
    }

    traceItems.push({ ...item, sourceIds: [item.id] });
  }

  return traceItems;
}

function buildActivityTraceEntries(items: ActivityFeedItem[]): ActivityTraceEntry[] {
  const entries: ActivityTraceEntry[] = [];

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

    if (previous?.kind === "tool" && shouldMergeToolTraceItems(previous.item, item)) {
      entries[entries.length - 1] = {
        kind: "tool",
        item: {
          ...previous.item,
          ts: item.ts,
          state: item.state,
          args: item.args ?? previous.item.args,
          result: item.result ?? previous.item.result,
          approval: item.approval ?? previous.item.approval,
          sourceIds: [...previous.item.sourceIds, item.id],
        },
      };
      continue;
    }

    entries.push({ kind: "tool", item: { ...item, sourceIds: [item.id] } });
  }

  return entries;
}

function deriveStatus(toolItems: ToolTraceItem[]): ActivityGroupStatus {
  const states = new Set<ToolFeedState>(toolItems.map((item) => item.state));
  if (states.has("approval-requested")) return "approval";
  if (states.has("output-error") || states.has("output-denied")) return "issue";
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

export function buildChatRenderItems(feed: FeedItem[]): ChatRenderItem[] {
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

  for (const item of feed) {
    if (item.kind === "todos") {
      continue;
    }
    if (item.kind === "reasoning") {
      if (!hasRenderableReasoningText(item)) {
        continue;
      }
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
  const reasoningItems = entries
    .filter((entry): entry is Extract<ActivityTraceEntry, { kind: "reasoning" }> => entry.kind === "reasoning")
    .map((entry) => entry.item);
  const toolItems = entries
    .filter((entry): entry is Extract<ActivityTraceEntry, { kind: "tool" }> => entry.kind === "tool")
    .map((entry) => entry.item);
  const primaryReasoning =
    [...reasoningItems].reverse().find((item) => item.mode === "summary") ??
    reasoningItems[reasoningItems.length - 1];
  const latestTool = toolItems[toolItems.length - 1];
  const preview =
    primaryReasoning?.text
      ? truncate(reasoningPreviewText(primaryReasoning.text, 2))
      : latestTool
        ? formatToolCard(latestTool.name, latestTool.args, latestTool.result, latestTool.state).subtitle
        : "Reasoning and tool activity";
  const status = deriveStatus(toolItems);

  return {
    entries,
    preview,
    reasoningCount: reasoningItems.length,
    status,
    statusLabel: statusLabel(status, toolItems.length),
    title: "Thought process",
    toolCount: toolItems.length,
  };
}
