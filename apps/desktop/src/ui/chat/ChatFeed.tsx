import { AlertTriangleIcon, LoaderCircleIcon, MessageSquareIcon } from "lucide-react";
import { memo, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const SCROLL_BUTTON_BOTTOM_GAP_PX = 9;
/**
 * Progressive feed window: mount the newest N entries, then expand upward as the
 * user scrolls near the top. MessageScroller preserveScrollOnPrepend keeps the
 * viewport stable when older rows are prepended.
 */
const FEED_RENDER_WINDOW = 80;
const FEED_EXPAND_BATCH = 40;
/** Expand when within this many px of the top of the scrollable content. */
const FEED_NEAR_TOP_PX = 160;
/** Estimated height for unmounted older rows (scrollbar proportion only). */
const FEED_ESTIMATED_ROW_HEIGHT_PX = 120;

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

function dayKeyFromIso(iso: string | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDaySeparatorLabel(dayKey: string, now: Date = new Date()): string {
  const [y, m, d] = dayKey.split("-").map((part) => Number(part));
  if (!y || !m || !d) return dayKey;
  const date = new Date(y, m - 1, d);
  const todayKey = dayKeyFromIso(now.toISOString());
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayKeyFromIso(yesterday.toISOString());
  if (dayKey === todayKey) return "Today";
  if (dayKey === yesterdayKey) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function itemTimestamp(item: ChatRenderItem): string | undefined {
  if (item.kind === "activity-group") {
    return item.items[0]?.ts;
  }
  return item.item.ts;
}

type FeedListEntry =
  | { kind: "day-separator"; id: string; label: string }
  | { kind: "render"; item: ChatRenderItem };

function buildFeedListEntries(renderItems: ChatRenderItem[]): FeedListEntry[] {
  const entries: FeedListEntry[] = [];
  let previousDayKey: string | null = null;
  let sawAnyTimestamp = false;

  for (const item of renderItems) {
    const dayKey = dayKeyFromIso(itemTimestamp(item));
    if (dayKey) {
      sawAnyTimestamp = true;
      // Only insert between days — skip a leading separator for the first day.
      if (previousDayKey !== null && dayKey !== previousDayKey) {
        entries.push({
          kind: "day-separator",
          id: `day:${dayKey}`,
          label: formatDaySeparatorLabel(dayKey),
        });
      }
      previousDayKey = dayKey;
    }
    entries.push({ kind: "render", item });
  }

  // Only show separators when timestamps actually exist in the feed.
  if (!sawAnyTimestamp) {
    return renderItems.map((item) => ({ kind: "render" as const, item }));
  }
  return entries;
}

/**
 * Placeholder shown from the moment a turn is pending/running until the first
 * reasoning, tool, or assistant item lands, so the transcript never looks
 * frozen while the model is starting up. Styled to match the compact live
 * activity header it hands off to.
 */
function WorkingPlaceholderRow() {
  return (
    <div className="flex w-full items-center gap-1.5" data-slot="working-placeholder">
      <Marker variant="border" className="min-w-0 flex-1 pb-2.5 pt-1.5">
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

function DaySeparatorRow(props: { label: string }) {
  return (
    <div className="flex w-full items-center gap-3 py-1" data-slot="day-separator">
      <div className="h-px flex-1 bg-border/60" />
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function InitialTurnRestore({
  messageId,
  threadId,
  hydrating,
}: {
  messageId: string | null;
  threadId?: string | null;
  hydrating: boolean;
}) {
  const { scrollToMessage } = useMessageScroller();
  const visibility = useMessageScrollerVisibility();
  const visibilityRef = useRef(visibility);
  visibilityRef.current = visibility;
  // Only restore scroll once per thread open / hydrate cycle — not on every new user turn.
  const restoredForKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!messageId || hydrating) return;
    const restoreKey = `${threadId ?? "no-thread"}:${messageId}`;
    if (restoredForKeyRef.current === restoreKey) return;
    // First restore for this thread id, or first restore after hydrate completed.
    const threadKey = threadId ?? "no-thread";
    const alreadyRestoredThread = restoredForKeyRef.current?.startsWith(`${threadKey}:`);
    if (alreadyRestoredThread && restoredForKeyRef.current !== null) {
      // A later user turn while already open — let autoScroll own the viewport.
      return;
    }
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
        restoredForKeyRef.current = restoreKey;
        return;
      }
      scrollToMessage(messageId, {
        align: "start",
        behavior: "auto",
        scrollMargin: 64,
      });
      restoredForKeyRef.current = restoreKey;
    };

    void restoreAfterLayout();
    return () => {
      cancelled = true;
    };
  }, [hydrating, messageId, scrollToMessage, threadId]);

  return null;
}

export const ChatFeed = memo(function ChatFeed(props: {
  transcriptOnly: boolean;
  disconnected: boolean;
  visibleFeedLength: number;
  hydrating: boolean;
  renderItems: ChatRenderItem[];
  liveActivityGroupId: string | null;
  liveStartedAt: string | null;
  showWorkingPlaceholder: boolean;
  streamingAssistantMessageId?: string | null;
  citationUrlsByMessageId: Map<string, Map<number, string>>;
  citationSourcesByMessageId: Map<string, CitationSource[]>;
  desktopBasePath: string | null;

  composerOverlayHeight: number;
  sandboxApprovals: VisibleSandboxApproval[];
  onAnswerApproval: (threadId: string, requestId: string, approved: boolean) => boolean;
  selectedThreadId?: string | null;
  threadTitleById?: ReadonlyMap<string, string>;
  onSelectThread?: (threadId: string) => void;
  onRetryFailedTurn?: () => Promise<boolean>;
  retryFailedTurnDisabled?: boolean;
}) {
  const {
    transcriptOnly,
    disconnected,
    visibleFeedLength,
    hydrating,
    renderItems,
    liveActivityGroupId,
    liveStartedAt,
    showWorkingPlaceholder,
    streamingAssistantMessageId,
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
  const feedListEntries = useMemo(() => buildFeedListEntries(renderItems), [renderItems]);
  const feedThreadKey = selectedThreadId ?? "no-thread";
  // How many newest entries are mounted for this chat. Grows as the user
  // scrolls toward older history; derived reset when the chat id changes.
  const [feedWindow, setFeedWindow] = useState({
    threadKey: feedThreadKey,
    visibleCount: FEED_RENDER_WINDOW,
  });
  const visibleCount =
    feedWindow.threadKey === feedThreadKey ? feedWindow.visibleCount : FEED_RENDER_WINDOW;

  const windowedFeedEntries = useMemo(() => {
    if (feedListEntries.length <= visibleCount) {
      return { entries: feedListEntries, hiddenCount: 0 };
    }
    const hiddenCount = feedListEntries.length - visibleCount;
    return {
      entries: feedListEntries.slice(hiddenCount),
      hiddenCount,
    };
  }, [feedListEntries, visibleCount]);

  const expandOlderMessages = useCallback(() => {
    setFeedWindow((current) => {
      const baseCount =
        current.threadKey === feedThreadKey ? current.visibleCount : FEED_RENDER_WINDOW;
      if (baseCount >= feedListEntries.length) {
        return { threadKey: feedThreadKey, visibleCount: feedListEntries.length };
      }
      return {
        threadKey: feedThreadKey,
        visibleCount: Math.min(feedListEntries.length, baseCount + FEED_EXPAND_BATCH),
      };
    });
  }, [feedListEntries.length, feedThreadKey]);

  const showAllOlderMessages = useCallback(() => {
    setFeedWindow({ threadKey: feedThreadKey, visibleCount: feedListEntries.length });
  }, [feedListEntries.length, feedThreadKey]);

  const handleViewportScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (windowedFeedEntries.hiddenCount <= 0) return;
      const viewport = event.currentTarget;
      if (viewport.scrollTop <= FEED_NEAR_TOP_PX) {
        expandOlderMessages();
      }
    },
    [expandOlderMessages, windowedFeedEntries.hiddenCount],
  );

  return (
    <MessageScrollerProvider
      key={selectedThreadId ?? "no-thread"}
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={64}
    >
      <InitialTurnRestore
        messageId={lastUserTurnId}
        threadId={selectedThreadId}
        hydrating={hydrating}
      />
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport
          aria-label="Conversation messages"
          preserveScrollOnPrepend
          onScroll={handleViewportScroll}
        >
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3.5 px-4 py-5 pt-6">
            {transcriptOnly ? (
              <MessageScrollerItem messageId="status:transcript-only">
                <Card className="border-border/70 bg-muted/30">
                  <CardContent className="flex items-start gap-3 p-3">
                    <AlertTriangleIcon className="mt-0.5 size-4 text-primary" />
                    <div>
                      <div className="font-semibold">Transcript view</div>
                      <div className="text-sm text-muted-foreground">
                        Sending a message will continue in a new chat.
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </MessageScrollerItem>
            ) : null}

            {visibleFeedLength === 0 ? (
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
                    <EmptyTitle>
                      {hydrating
                        ? "Loading chat"
                        : disconnected
                          ? "Disconnected"
                          : "No messages yet"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {hydrating
                        ? "Restoring messages and reconnecting the session."
                        : disconnected
                          ? "Reconnect from the banner above to continue."
                          : "Send a message to start."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </MessageScrollerItem>
            ) : (
              <>
                {windowedFeedEntries.hiddenCount > 0 ? (
                  <MessageScrollerItem messageId="status:show-older">
                    <div
                      aria-hidden="true"
                      className="flex flex-col items-center gap-2 py-1"
                      data-slot="feed-window-spacer"
                      style={{
                        minHeight: Math.min(
                          windowedFeedEntries.hiddenCount * FEED_ESTIMATED_ROW_HEIGHT_PX,
                          2_400,
                        ),
                      }}
                    >
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={showAllOlderMessages}
                      >
                        Show {windowedFeedEntries.hiddenCount} older messages
                      </Button>
                    </div>
                  </MessageScrollerItem>
                ) : null}
                {windowedFeedEntries.entries.map((entry) => {
                  if (entry.kind === "day-separator") {
                    return (
                      <MessageScrollerItem key={entry.id} messageId={entry.id}>
                        <DaySeparatorRow label={entry.label} />
                      </MessageScrollerItem>
                    );
                  }

                  const item = entry.item;
                  const messageId = item.kind === "activity-group" ? item.id : item.item.id;
                  return (
                    <MessageScrollerItem
                      key={messageId}
                      messageId={messageId}
                      scrollAnchor={isVisibleUserTurn(item)}
                    >
                      {item.kind === "activity-group" ? (
                        <InlineErrorBoundary label="This activity couldn't be rendered.">
                          <ActivityGroupCard
                            items={item.items}
                            live={item.id === liveActivityGroupId}
                            liveStartedAt={liveStartedAt}
                            onRetry={
                              item.id === retryableActivityGroupId ? onRetryFailedTurn : undefined
                            }
                            retryDisabled={retryFailedTurnDisabled}
                          />
                        </InlineErrorBoundary>
                      ) : (
                        <InlineErrorBoundary
                          label={`This message couldn't be rendered (${item.item.kind}).`}
                        >
                          <FeedRow
                            item={item.item}
                            citationUrlsByIndex={citationUrlsByMessageId.get(item.item.id)}
                            citationSources={citationSourcesByMessageId.get(item.item.id)}
                            desktopBasePath={desktopBasePath}
                            isStreaming={
                              item.item.kind === "message" &&
                              item.item.role === "assistant" &&
                              item.item.id === streamingAssistantMessageId
                            }
                          />
                        </InlineErrorBoundary>
                      )}
                    </MessageScrollerItem>
                  );
                })}
              </>
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
});
