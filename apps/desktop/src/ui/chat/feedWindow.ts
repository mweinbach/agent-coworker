import type { FeedItem } from "../../app/types";

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
