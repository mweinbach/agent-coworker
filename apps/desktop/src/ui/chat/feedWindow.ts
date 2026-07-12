import type { FeedItem } from "../../app/types";
import { filterFeedForDeveloperMode } from "./chatLogic";
import { isHiddenRetryTurnMessage } from "./chatRetry";
import { normalizeFeedForToolCards } from "./toolCards/legacyToolLogs";

export type FeedDerivationWindowState = {
  feedLength: number;
  visibleCount: number;
};

export function prepareFeedDerivationFeed(feed: FeedItem[], developerMode: boolean): FeedItem[] {
  return filterFeedForDeveloperMode(
    normalizeFeedForToolCards(feed, developerMode),
    developerMode,
  ).filter((item) => item.kind !== "todos" && !isHiddenRetryTurnMessage(item));
}

export function resolveFeedDerivationVisibleCount(
  state: FeedDerivationWindowState | undefined,
  feedLength: number,
  defaultVisibleCount: number,
): number {
  if (!state) return defaultVisibleCount;
  const appendedCount = Math.max(0, feedLength - state.feedLength);
  return Math.min(feedLength, state.visibleCount + appendedCount);
}

export function selectFeedDerivationWindow(
  feed: FeedItem[],
  visibleCount: number,
): { feed: FeedItem[]; hiddenCount: number } {
  const boundedVisibleCount = Math.max(1, Math.floor(visibleCount));
  if (feed.length <= boundedVisibleCount) {
    return { feed, hiddenCount: 0 };
  }
  const hiddenCount = feed.length - boundedVisibleCount;
  return { feed: feed.slice(hiddenCount), hiddenCount };
}
