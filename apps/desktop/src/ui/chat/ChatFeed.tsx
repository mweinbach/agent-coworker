import {
  AlertTriangleIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  RotateCcwIcon,
} from "lucide-react";
import type { RefObject } from "react";
import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "../../components/ai-elements/conversation";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { ActivityGroupCard } from "./ActivityGroupCard";
import type { ChatRenderItem } from "./activityGroups";
import { FeedRow } from "./FeedRow";

export function ChatFeed(props: {
  feedRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  transcriptOnly: boolean;
  disconnected: boolean;
  onReconnect: () => void;
  visibleFeedLength: number;
  hydrating: boolean;
  renderItems: ChatRenderItem[];
  liveActivityGroupId: string | null;
  liveStartedAt: string | null;
  citationUrlsByMessageId: Map<string, Map<number, string>>;
  citationSourcesByMessageId: Map<string, CitationSource[]>;
  desktopBasePath: string | null;
  latestUiSurfaceItemId: string | null;
  a2uiEnabled: boolean;
  composerOverlayHeight: number;
}) {
  const {
    feedRef,
    onScroll,
    transcriptOnly,
    disconnected,
    onReconnect,
    visibleFeedLength,
    hydrating,
    renderItems,
    liveActivityGroupId,
    liveStartedAt,
    citationUrlsByMessageId,
    citationSourcesByMessageId,
    desktopBasePath,
    latestUiSurfaceItemId,
    a2uiEnabled,
    composerOverlayHeight,
  } = props;

  return (
    <Conversation className="min-h-0" ref={feedRef} onScroll={onScroll}>
      <ConversationContent className="pt-6">
        {transcriptOnly ? (
          <Card className="max-w-3xl border-border/70 bg-muted/30">
            <CardContent className="flex items-start gap-3 p-3">
              <AlertTriangleIcon className="mt-0.5 size-4 text-primary" />
              <div>
                <div className="font-semibold">Transcript view</div>
                <div className="text-sm text-muted-foreground">
                  Sending a message will continue in a new thread.
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {disconnected ? (
          <Card className="max-w-3xl border-border/70 bg-muted/30">
            <CardContent className="flex items-center justify-between gap-3 p-3">
              <div>
                <div className="font-semibold">Disconnected</div>
                <div className="text-sm text-muted-foreground">
                  Reconnect to continue this thread.
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onReconnect}>
                <RotateCcwIcon data-icon="inline-start" />
                Reconnect
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {visibleFeedLength === 0 ? (
          hydrating ? (
            <ConversationEmptyState
              icon={<LoaderCircleIcon className="size-6 animate-spin" />}
              title="Loading thread"
              description="Restoring messages and reconnecting the session."
            />
          ) : (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <MessageSquareIcon className="size-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Send a message to start.</p>
            </div>
          )
        ) : (
          renderItems.map((item) =>
            item.kind === "activity-group" ? (
              <ActivityGroupCard
                key={item.id}
                items={item.items}
                live={item.id === liveActivityGroupId}
                liveStartedAt={liveStartedAt}
              />
            ) : (
              <FeedRow
                key={item.item.id}
                item={item.item}
                citationUrlsByIndex={citationUrlsByMessageId.get(item.item.id)}
                citationSources={citationSourcesByMessageId.get(item.item.id)}
                desktopBasePath={desktopBasePath}
                isLatestUiSurface={item.item.id === latestUiSurfaceItemId}
                a2uiEnabled={a2uiEnabled}
              />
            ),
          )
        )}
        <div
          aria-hidden="true"
          className="shrink-0"
          data-slot="message-bar-reserved-space"
          style={{ height: composerOverlayHeight }}
        />
      </ConversationContent>
    </Conversation>
  );
}
