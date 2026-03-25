import type { ProjectedItem, SessionFeedItem } from "./protocolTypes";

export type MobileFeedState = {
  feed: SessionFeedItem[];
  lastEventSeq: number;
};

const sessionErrorCodes = [
  "invalid_json",
  "invalid_payload",
  "missing_type",
  "unknown_type",
  "unknown_session",
  "busy",
  "validation_failed",
  "permission_denied",
  "provider_error",
  "backup_error",
  "observability_error",
  "internal_error",
] as const;

const sessionErrorSources = [
  "tool",
  "provider",
  "session",
  "jsonrpc",
  "backup",
  "observability",
  "permissions",
] as const;

type SessionErrorCode = (typeof sessionErrorCodes)[number];
type SessionErrorSource = (typeof sessionErrorSources)[number];

export function createMobileFeedState(
  feed: SessionFeedItem[] = [],
  lastEventSeq = 0,
): MobileFeedState {
  return {
    feed,
    lastEventSeq,
  };
}

function userMessageText(content: Array<{ type: "text"; text: string }>): string {
  return content
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function existingTsOr(ts: string, existing?: SessionFeedItem): string {
  return existing?.ts ?? ts;
}

function normalizeErrorCode(code: string): SessionErrorCode {
  return sessionErrorCodes.includes(code as SessionErrorCode)
    ? (code as SessionErrorCode)
    : "internal_error";
}

function normalizeErrorSource(source: string): SessionErrorSource {
  return sessionErrorSources.includes(source as SessionErrorSource)
    ? (source as SessionErrorSource)
    : "session";
}

function toFeedItem(
  item: ProjectedItem,
  ts: string,
  existing?: SessionFeedItem,
): SessionFeedItem {
  switch (item.type) {
    case "userMessage":
      return {
        id: item.id,
        kind: "message",
        role: "user",
        ts: existingTsOr(ts, existing),
        text: userMessageText(item.content),
      };
    case "agentMessage":
      return {
        id: item.id,
        kind: "message",
        role: "assistant",
        ts: existingTsOr(ts, existing),
        text: item.text,
        ...(item.annotations ? { annotations: item.annotations } : {}),
      };
    case "reasoning":
      return {
        id: item.id,
        kind: "reasoning",
        mode: item.mode,
        ts: existingTsOr(ts, existing),
        text: item.text,
      };
    case "toolCall":
      return {
        id: item.id,
        kind: "tool",
        ts: existingTsOr(ts, existing),
        name: item.toolName,
        state: item.state,
        ...(item.args !== undefined ? { args: item.args } : {}),
        ...(item.result !== undefined ? { result: item.result } : {}),
        ...(item.approval ? { approval: item.approval } : {}),
      };
    case "system":
      return {
        id: item.id,
        kind: "system",
        ts: existingTsOr(ts, existing),
        line: item.line,
      };
    case "log":
      return {
        id: item.id,
        kind: "log",
        ts: existingTsOr(ts, existing),
        line: item.line,
      };
    case "todos":
      return {
        id: item.id,
        kind: "todos",
        ts: existingTsOr(ts, existing),
        todos: item.todos,
      };
    case "error":
      return {
        id: item.id,
        kind: "error",
        ts: existingTsOr(ts, existing),
        message: item.message,
        code: normalizeErrorCode(item.code),
        source: normalizeErrorSource(item.source),
      };
  }
}

function upsertFeedItem(feed: SessionFeedItem[], item: ProjectedItem, ts: string): SessionFeedItem[] {
  const index = feed.findIndex((entry) => entry.id === item.id);
  const existing = index >= 0 ? feed[index] : undefined;
  const next = toFeedItem(item, ts, existing);
  if (index < 0) {
    return [...feed, next];
  }
  const updated = [...feed];
  updated[index] = next;
  return updated;
}

function applyProjectedItemStarted(
  feed: SessionFeedItem[],
  item: ProjectedItem,
  ts: string,
): SessionFeedItem[] {
  return upsertFeedItem(feed, item, ts);
}

function applyProjectedItemCompleted(
  feed: SessionFeedItem[],
  item: ProjectedItem,
  ts: string,
): SessionFeedItem[] {
  return upsertFeedItem(feed, item, ts);
}

function applyProjectedAgentMessageDelta(
  feed: SessionFeedItem[],
  itemId: string,
  delta: string,
  ts: string,
): SessionFeedItem[] {
  const index = feed.findIndex((item) => item.id === itemId);
  if (index < 0) {
    return [
      ...feed,
      {
        id: itemId,
        kind: "message",
        role: "assistant",
        ts,
        text: delta,
      },
    ];
  }
  const existing = feed[index];
  if (!existing || existing.kind !== "message" || existing.role !== "assistant") {
    return feed;
  }
  const updated = [...feed];
  updated[index] = {
    ...existing,
    text: `${existing.text}${delta}`,
  };
  return updated;
}

function applyProjectedReasoningDelta(
  feed: SessionFeedItem[],
  itemId: string,
  mode: "reasoning" | "summary",
  delta: string,
  ts: string,
): SessionFeedItem[] {
  const index = feed.findIndex((item) => item.id === itemId);
  if (index < 0) {
    return [
      ...feed,
      {
        id: itemId,
        kind: "reasoning",
        mode,
        ts,
        text: delta,
      },
    ];
  }
  const existing = feed[index];
  if (!existing || existing.kind !== "reasoning") {
    return feed;
  }
  const updated = [...feed];
  updated[index] = {
    ...existing,
    mode,
    text: `${existing.text}${delta}`,
  };
  return updated;
}

export function applyProjectedStart(
  state: MobileFeedState,
  item: ProjectedItem,
  ts: string,
  eventSeq: number,
): MobileFeedState {
  return {
    feed: applyProjectedItemStarted(state.feed as never, item as never, ts) as SessionFeedItem[],
    lastEventSeq: Math.max(state.lastEventSeq, eventSeq),
  };
}

export function applyProjectedCompletion(
  state: MobileFeedState,
  item: ProjectedItem,
  ts: string,
  eventSeq: number,
): MobileFeedState {
  return {
    feed: applyProjectedItemCompleted(state.feed as never, item as never, ts) as SessionFeedItem[],
    lastEventSeq: Math.max(state.lastEventSeq, eventSeq),
  };
}

export function applyAgentDelta(
  state: MobileFeedState,
  itemId: string,
  delta: string,
  ts: string,
  eventSeq: number,
): MobileFeedState {
  return {
    feed: applyProjectedAgentMessageDelta(state.feed as never, itemId, delta, ts) as SessionFeedItem[],
    lastEventSeq: Math.max(state.lastEventSeq, eventSeq),
  };
}

export function applyReasoningDelta(
  state: MobileFeedState,
  itemId: string,
  mode: "reasoning" | "summary",
  delta: string,
  ts: string,
  eventSeq: number,
): MobileFeedState {
  return {
    feed: applyProjectedReasoningDelta(state.feed as never, itemId, mode, delta, ts) as SessionFeedItem[],
    lastEventSeq: Math.max(state.lastEventSeq, eventSeq),
  };
}
