import type { ChatRenderItem } from "@/features/cowork/activityGroups";
import { ActivityGroupCard } from "./activity-group-card";
import { ThreadFeedItem } from "./thread-feed-item";

type ThreadRenderItemProps = {
  renderItem: ChatRenderItem;
  showDebugMessages: boolean;
  live?: boolean;
  liveStartedAt?: string | null;
};

export function ThreadRenderItem({
  renderItem,
  showDebugMessages,
  live,
  liveStartedAt,
}: ThreadRenderItemProps) {
  if (renderItem.kind === "activity-group") {
    return <ActivityGroupCard items={renderItem.items} live={live} liveStartedAt={liveStartedAt} />;
  }

  return <ThreadFeedItem item={renderItem.item} showDebugMessages={showDebugMessages} />;
}
