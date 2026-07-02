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
import { Marker, MarkerContent } from "../../components/ui/marker";
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
import { type ChatRenderItem, summarizeActivityGroup } from "./activityGroups";
import { FeedRow } from "./FeedRow";
import { SandboxApprovalCard } from "./SandboxApprovalCard";

const SCROLL_BUTTON_BOTTOM_GAP_PX = 14;

export type VisibleSandboxApproval = {
  threadId: string;
  prompt: SandboxApprovalPrompt;
};

function isVisibleUserTurn(item: ChatRenderItem): boolean {
  return item.kind === "feed-item" && item.item.kind === "message" && item.item.role === "user";
}

function lastVisibleUserTurnId(renderItems: ChatRenderItem[]): string | null {
  for (let index = renderItems.length - 1; index >= 0; index -= 1) {
    const item = renderItems[index];
    if (item && isVisibleUserTurn(item)) {
      return item.kind === "feed-item" ? item.item.id : null;
    }
  }
  return null;
}

function latestRetryableActivityGroupId(renderItems: ChatRenderItem[]): string | null {
  for (let index = renderItems.length - 1; index >= 0; index -= 1) {
    const item = renderItems[index];
    if (!item) continue;
    if (item.kind === "activity-group") {
      return summarizeActivityGroup(item.items).status === "issue" ? item.id : null;
    }
    if (item.item.kind === "message") return null;
  }
  return null;
}

/**
 * Placeholder shown from the moment a turn is pending/running until the first
 * reasoning, tool, or assistant item lands, so the transcript never looks
 * frozen while the model is starting up. Styled to match the compact live
 * activity header it hands off to.
 */
function WorkingPlaceholderRow() {
  return (
    <div className="flex w-full max-w-3xl items-center" data-slot="working-placeholder">
      <Marker variant="border" className="pb-2.5 pt-1.5">
        <MarkerContent className="font-mono tracking-tight">
          <span
            role="status"
            aria-live="polite"
            className="activity-thinking-shimmer inline-flex items-center"
          >
            Working
          </span>
        </MarkerContent>
      </Marker>
    </div>
  );
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
      if (currentVisibility.currentAnchorId === messageId) {
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
  showWorkingPlaceholder: boolean;
  citationUrlsByMessageId: Map<string, Map<number, string>>;
  citationSourcesByMessageId: Map<string, CitationSource[]>;
  desktopBasePath: string | null;

  composerOverlayHeight: number;
  sandboxApprovals: VisibleSandboxApproval[];
  onAnswerApproval: (threadId: string, requestId: string, approved: boolean) => void;
  selectedThreadId?: string | null;
  threadTitleById?: ReadonlyMap<string, string>;
  onSelectThread?: (threadId: string) => void;
  onRetryFailedTurn?: () => Promise<boolean>;
  retryFailedTurnDisabled?: boolean;
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
    showWorkingPlaceholder,
    citationUrlsByMessageId,
    citationSourcesByMessageId,
    desktopBasePath,
    composerOverlayHeight,
    sandboxApprovals,
    onAnswerApproval,
    selectedThreadId,
    threadTitleById,
    onSelectThread,
    onRetryFailedTurn,
    retryFailedTurnDisabled,
  } = props;
  const lastUserTurnId = lastVisibleUserTurnId(renderItems);
  const retryableActivityGroupId = latestRetryableActivityGroupId(renderItems);

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

            {visibleFeedLength === 0 && !disconnected ? (
              <MessageScrollerItem messageId={hydrating ? "status:hydrating" : "status:empty"}>
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
                    scrollAnchor={isVisibleUserTurn(item)}
                  >
                    {item.kind === "activity-group" ? (
                      <ActivityGroupCard
                        items={item.items}
                        live={item.id === liveActivityGroupId}
                        liveStartedAt={liveStartedAt}
                        onRetry={
                          item.id === retryableActivityGroupId ? onRetryFailedTurn : undefined
                        }
                        retryDisabled={retryFailedTurnDisabled}
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
                        />
                      </InlineErrorBoundary>
                    )}
                  </MessageScrollerItem>
                );
              })
            )}

            {showWorkingPlaceholder ? (
              <MessageScrollerItem messageId="status:working-placeholder">
                <WorkingPlaceholderRow />
              </MessageScrollerItem>
            ) : null}

            {sandboxApprovals.map(({ threadId, prompt }) => (
              <MessageScrollerItem
                key={`${threadId}:${prompt.requestId}`}
                messageId={`sandbox-approval:${threadId}:${prompt.requestId}`}
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

            <MessageScrollerItem>
              <div
                aria-hidden="true"
                className="shrink-0"
                data-slot="message-bar-reserved-space"
                style={{ height: composerOverlayHeight }}
              />
            </MessageScrollerItem>
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
