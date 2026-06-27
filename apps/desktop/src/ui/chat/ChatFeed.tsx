import {
  AlertTriangleIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import type { SandboxApprovalPrompt } from "../../app/types";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility,
} from "../../components/ui/message-scroller";
import { InlineErrorBoundary } from "../CrashReportingErrorBoundary";
import { ActivityGroupCard } from "./ActivityGroupCard";
import type { ChatRenderItem } from "./activityGroups";
import { parseA2uiActionMessage } from "./chatLogic";
import { FeedRow } from "./FeedRow";
import { SandboxApprovalCard } from "./SandboxApprovalCard";

const SCROLL_BUTTON_BOTTOM_GAP_PX = 14;

export type VisibleSandboxApproval = {
  threadId: string;
  prompt: SandboxApprovalPrompt;
};

function isVisibleUserTurn(item: ChatRenderItem, a2uiEnabled: boolean): boolean {
  if (item.kind !== "feed-item" || item.item.kind !== "message" || item.item.role !== "user") {
    return false;
  }
  return a2uiEnabled || parseA2uiActionMessage(item.item.text) === null;
}

function lastVisibleUserTurnId(renderItems: ChatRenderItem[], a2uiEnabled: boolean): string | null {
  for (let index = renderItems.length - 1; index >= 0; index -= 1) {
    const item = renderItems[index];
    if (item && isVisibleUserTurn(item, a2uiEnabled)) {
      return item.kind === "feed-item" ? item.item.id : null;
    }
  }
  return null;
}

function InitialTurnRestore({ messageId }: { messageId: string | null }) {
  const { scrollToMessage } = useMessageScroller();
  const visibility = useMessageScrollerVisibility();
  const visibilityRef = useRef(visibility);
  visibilityRef.current = visibility;

  useEffect(() => {
    if (!messageId) return;
    let cancelled = false;

    const nextFrame = () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });

    const restoreAfterLayout = async () => {
      try {
        await document.fonts.ready;
      } catch {
        // Font readiness is only a layout hint; the frame checks below still apply.
      }
      await nextFrame();
      await nextFrame();
      if (cancelled) return;

      const currentVisibility = visibilityRef.current;
      if (
        currentVisibility.currentAnchorId === messageId ||
        currentVisibility.visibleMessageIds.includes(messageId)
      ) {
        return;
      }
      scrollToMessage(messageId, {
        align: "start",
        behavior: "auto",
        scrollMargin: 64,
      });
    };

    void restoreAfterLayout();
    return () => {
      cancelled = true;
    };
  }, [messageId, scrollToMessage]);

  return null;
}

export function ChatFeed(props: {
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
  sandboxApprovals: VisibleSandboxApproval[];
  onAnswerApproval: (threadId: string, requestId: string, approved: boolean) => void;
  selectedThreadId?: string | null;
  threadTitleById?: ReadonlyMap<string, string>;
  onSelectThread?: (threadId: string) => void;
}) {
  const {
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
    sandboxApprovals,
    onAnswerApproval,
    selectedThreadId,
    threadTitleById,
    onSelectThread,
  } = props;
  const lastUserTurnId = lastVisibleUserTurnId(renderItems, a2uiEnabled);

  return (
    <MessageScrollerProvider
      key={`${selectedThreadId ?? "no-thread"}:${hydrating ? "hydrating" : "ready"}`}
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={64}
    >
      <InitialTurnRestore messageId={lastUserTurnId} />
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="Conversation messages">
          <MessageScrollerContent className="mx-auto w-full max-w-[56rem] gap-3.5 px-4 py-5 pt-6">
            {transcriptOnly ? (
              <MessageScrollerItem messageId="status:transcript-only">
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
              </MessageScrollerItem>
            ) : null}

            {disconnected ? (
              <MessageScrollerItem messageId="status:disconnected">
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
              </MessageScrollerItem>
            ) : null}

            {sandboxApprovals.map(({ threadId, prompt }) => (
              <MessageScrollerItem
                key={`${threadId}:${prompt.requestId}`}
                messageId={`sandbox-approval:${threadId}:${prompt.requestId}`}
                className="order-2"
              >
                <SandboxApprovalCard
                  threadId={threadId}
                  prompt={prompt}
                  onAnswer={onAnswerApproval}
                  selectedThreadId={selectedThreadId}
                  threadTitle={threadTitleById?.get(threadId)}
                  onSelectThread={onSelectThread}
                />
              </MessageScrollerItem>
            ))}

            <MessageScrollerItem className="order-3">
              <div
                aria-hidden="true"
                className="shrink-0"
                data-slot="message-bar-reserved-space"
                style={{ height: composerOverlayHeight }}
              />
            </MessageScrollerItem>

            {visibleFeedLength === 0 && !disconnected ? (
              <MessageScrollerItem
                messageId={hydrating ? "status:hydrating" : "status:empty"}
                className="order-1"
              >
                <Empty className="min-h-72 border border-border/55 bg-background/24">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      {hydrating ? (
                        <LoaderCircleIcon className="animate-spin" />
                      ) : (
                        <MessageSquareIcon />
                      )}
                    </EmptyMedia>
                    <EmptyTitle>{hydrating ? "Loading thread" : "No messages yet"}</EmptyTitle>
                    <EmptyDescription>
                      {hydrating
                        ? "Restoring messages and reconnecting the session."
                        : "Send a message to start."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </MessageScrollerItem>
            ) : (
              renderItems.map((item) => {
                const messageId = item.kind === "activity-group" ? item.id : item.item.id;
                return (
                  <MessageScrollerItem
                    key={messageId}
                    messageId={messageId}
                    scrollAnchor={isVisibleUserTurn(item, a2uiEnabled)}
                    className="order-1"
                  >
                    {item.kind === "activity-group" ? (
                      <ActivityGroupCard
                        items={item.items}
                        live={item.id === liveActivityGroupId}
                        liveStartedAt={liveStartedAt}
                      />
                    ) : (
                      <InlineErrorBoundary
                        label={`This message couldn't be rendered (${item.item.kind}).`}
                      >
                        <FeedRow
                          item={item.item}
                          citationUrlsByIndex={citationUrlsByMessageId.get(item.item.id)}
                          citationSources={citationSourcesByMessageId.get(item.item.id)}
                          desktopBasePath={desktopBasePath}
                          isLatestUiSurface={item.item.id === latestUiSurfaceItemId}
                          a2uiEnabled={a2uiEnabled}
                        />
                      </InlineErrorBoundary>
                    )}
                  </MessageScrollerItem>
                );
              })
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton
          aria-label="Scroll to end"
          style={{ bottom: composerOverlayHeight + SCROLL_BUTTON_BOTTOM_GAP_PX }}
        />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
