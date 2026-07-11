import { memo } from "react";

import type { ChatRenderItem } from "@/features/cowork/activityGroups";
import { ActivityGroupCard } from "./activity-group-card";
import { ThreadFeedItem } from "./thread-feed-item";

type ThreadRenderItemProps = {
  renderItem: ChatRenderItem;
  showDebugMessages: boolean;
  live?: boolean;
  liveStartedAt?: string | null;
  revision: string;
  onRetryToolCalls?: (toolItemIds: string[]) => Promise<void>;
  retryDisabled?: boolean;
};

function ThreadRenderItemComponent({
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

export const ThreadRenderItem = memo(
  ThreadRenderItemComponent,
  (previous, next) =>
    previous.revision === next.revision &&
    previous.showDebugMessages === next.showDebugMessages &&
    previous.live === next.live &&
    previous.liveStartedAt === next.liveStartedAt &&
    previous.onRetryToolCalls === next.onRetryToolCalls &&
    previous.retryDisabled === next.retryDisabled,
);
