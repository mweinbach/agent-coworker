import type { ChatRenderItem } from "@/features/cowork/activityGroups";
import { ActivityGroupCard } from "./activity-group-card";
import { ThreadFeedItem } from "./thread-feed-item";

type ThreadRenderItemProps = {
  renderItem: ChatRenderItem;
  a2uiEnabled: boolean;
  showDebugMessages: boolean;
  live?: boolean;
  liveStartedAt?: string | null;
};

export function ThreadRenderItem({
  renderItem,
  a2uiEnabled,
  showDebugMessages,
  live,
  liveStartedAt,
}: ThreadRenderItemProps) {
  if (renderItem.kind === "activity-group") {
    return (
      <ActivityGroupCard items={renderItem.items} live={live} liveStartedAt={liveStartedAt} />
    );
  }

  return (
    <ThreadFeedItem
      item={renderItem.item}
      a2uiEnabled={a2uiEnabled}
      showDebugMessages={showDebugMessages}
    />
  );
}
