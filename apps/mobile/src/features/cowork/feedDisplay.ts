import type { SessionFeedItem } from "./protocolTypes";

export function filterFeedForDisplay(
  feed: SessionFeedItem[],
  showDebugMessages: boolean,
): SessionFeedItem[] {
  if (showDebugMessages) return feed;
  return feed.filter((item) => item.kind !== "system" && item.kind !== "log");
}
