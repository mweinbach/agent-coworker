import type { ChatRenderItem } from "@/features/cowork/activityGroups";
import { ActivityGroupCard } from "./activity-group-card";
import { ThreadFeedItem } from "./thread-feed-item";

type ThreadRenderItemProps = {
  renderItem: ChatRenderItem;
  showDebugMessages: boolean;
  live?: boolean;
  liveStartedAt?: string | null;
  onRetryToolCalls?: (toolItemIds: string[]) => Promise<void>;
  retryDisabled?: boolean;
};

export function ThreadRenderItem({
  renderItem,
  showDebugMessages,
  live,
  liveStartedAt,
  onRetryToolCalls,
  retryDisabled,
}: ThreadRenderItemProps) {
  if (renderItem.kind === "activity-group") {
    return (
      <ActivityGroupCard
        items={renderItem.items}
        recoveredToolIds={renderItem.recoveredToolIds}
        live={live}
        liveStartedAt={liveStartedAt}
        onRetry={onRetryToolCalls}
        retryDisabled={retryDisabled}
      />
    );
  }

  return <ThreadFeedItem item={renderItem.item} showDebugMessages={showDebugMessages} />;
}
