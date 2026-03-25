import type { ProjectedItem, SessionFeedItem } from "./protocolTypes";
import {
  applyProjectedAgentMessageDelta,
  applyProjectedItemCompleted,
  applyProjectedItemStarted,
  applyProjectedReasoningDelta,
} from "../../../../../src/shared/projectedItems";

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
