import {
  applyProjectedAgentMessageDelta as applySharedAgentMessageDelta,
  applyProjectedItemCompleted as applySharedProjectedItemCompleted,
  applyProjectedItemStarted as applySharedProjectedItemStarted,
  applyProjectedReasoningDelta as applySharedReasoningDelta,
} from "../../../../../src/shared/projectedItems";
import type { SessionFeedItem as CanonicalSessionFeedItem } from "../../../../../src/shared/sessionSnapshot";
import type { ProjectedItem, SessionFeedItem } from "./protocolTypes";

export type MobileFeedState = {
  feed: SessionFeedItem[];
  lastEventSeq: number;
};

export function createMobileFeedState(
  feed: SessionFeedItem[] = [],
  lastEventSeq = 0,
): MobileFeedState {
  return {
    feed,
    lastEventSeq,
  };
}

function asCanonicalFeed(feed: SessionFeedItem[]): CanonicalSessionFeedItem[] {
  return feed as CanonicalSessionFeedItem[];
}

function preserveMobileOptimisticFields(
  feed: SessionFeedItem[],
  item: ProjectedItem,
): SessionFeedItem[] {
  if (item.type !== "userMessage" || !item.clientMessageId) {
    return feed;
  }
  const index = feed.findIndex(
    (entry) =>
      entry.id === item.id ||
      (entry.kind === "message" &&
        entry.role === "user" &&
        "clientMessageId" in entry &&
        entry.clientMessageId === item.clientMessageId),
  );
  const existing = index >= 0 ? feed[index] : undefined;
  if (existing?.kind !== "message" || existing.role !== "user") {
    return feed;
  }
  if ("clientMessageId" in existing && existing.clientMessageId === item.clientMessageId) {
    return feed;
  }
  const updated = [...feed];
  updated[index] = {
    ...existing,
    clientMessageId: item.clientMessageId,
  };
  return updated;
}

function applySharedProjectedStart(
  feed: SessionFeedItem[],
  ts: string,
  item: ProjectedItem,
): SessionFeedItem[] {
  const nextFeed = applySharedProjectedItemStarted(
    asCanonicalFeed(feed),
    item,
    ts,
  ) as SessionFeedItem[];
  return preserveMobileOptimisticFields(nextFeed, item);
}

function applySharedProjectedCompletion(
  feed: SessionFeedItem[],
  ts: string,
  item: ProjectedItem,
): SessionFeedItem[] {
  const nextFeed = applySharedProjectedItemCompleted(
    asCanonicalFeed(feed),
    item,
    ts,
  ) as SessionFeedItem[];
  return preserveMobileOptimisticFields(nextFeed, item);
}

export function applyProjectedStart(
  state: MobileFeedState,
  item: ProjectedItem,
  ts: string,
  eventSeq: number,
): MobileFeedState {
  return {
    feed: applySharedProjectedStart(state.feed, ts, item),
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
    feed: applySharedProjectedCompletion(state.feed, ts, item),
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
    feed: applySharedAgentMessageDelta(
      asCanonicalFeed(state.feed),
      itemId,
      delta,
      ts,
    ) as SessionFeedItem[],
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
    feed: applySharedReasoningDelta(
      asCanonicalFeed(state.feed),
      itemId,
      mode,
      delta,
      ts,
    ) as SessionFeedItem[],
    lastEventSeq: Math.max(state.lastEventSeq, eventSeq),
  };
}
