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
};

function ThreadRenderItemComponent({
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

export const ThreadRenderItem = memo(
  ThreadRenderItemComponent,
  (previous, next) =>
    previous.revision === next.revision &&
    previous.showDebugMessages === next.showDebugMessages &&
    previous.live === next.live &&
    previous.liveStartedAt === next.liveStartedAt,
);
