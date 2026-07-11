import {
  AlertTriangleIcon,
  ArrowDownIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import type { ChatInteraction } from "../../app/types";
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
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../../components/ui/message-scroller";
import { InlineErrorBoundary } from "../CrashReportingErrorBoundary";
import { recordDesktopRenderMetric } from "../renderDiagnostics";
import { ActivityGroupCard } from "./ActivityGroupCard";
import {
  type ChatRenderItem,
  latestRetryableActivityGroupId,
  unresolvedToolFailureIds,
} from "./activityGroups";
import { FeedRow } from "./FeedRow";
import { InteractionCard } from "./InteractionCard";
import {
  captureScrollAnchor,
  countNewIds,
  isNearScrollEnd,
  restoreScrollAnchor,
  type ScrollAnchorPosition,
  scrollViewportToEnd,
} from "./scrollOwnership";

const SCROLL_BUTTON_BOTTOM_GAP_PX = 9;
/** Expand when within this many px of the top of the scrollable content. */
const FEED_NEAR_TOP_PX = 160;
/** Estimated height for unmounted older rows (scrollbar proportion only). */
const FEED_ESTIMATED_ROW_HEIGHT_PX = 120;

export type VisibleInteraction = {
  threadId: string;
  interaction: ChatInteraction;
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

type TranscriptScrollMode = "anchored" | "detached" | "following";

type TranscriptScrollSnapshot = {
  itemIds: string[];
  mode: TranscriptScrollMode;
  newMessageCount: number;
  position: ScrollAnchorPosition | null;
};

const TRANSCRIPT_RESTORE_OFFSET_PX = 64;
const DETACH_KEYS = new Set(["ArrowUp", "Home", "PageUp"]);

function TranscriptScroller(props: {
  bottomOffset: number;
  children: ReactNode;
  hydrating: boolean;
  itemIds: string[];
  lastUserTurnId: string | null;
  memory: Map<string, TranscriptScrollSnapshot>;
  onViewportScroll: (event: UIEvent<HTMLDivElement>) => void;
  threadId: string;
}) {
  const {
    bottomOffset,
    children,
    hydrating,
    itemIds,
    lastUserTurnId,
    memory,
    onViewportScroll,
    threadId,
  } = props;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const initialSnapshot = memory.get(threadId);
  const initialNewMessageCount =
    initialSnapshot?.mode === "detached"
      ? initialSnapshot.newMessageCount + countNewIds(initialSnapshot.itemIds, itemIds)
      : 0;
  const [mode, setMode] = useState<TranscriptScrollMode>(
    () => initialSnapshot?.mode ?? "following",
  );
  const [newMessageCount, setNewMessageCount] = useState(initialNewMessageCount);
  const modeRef = useRef(mode);
  const newMessageCountRef = useRef(initialNewMessageCount);
  const restoredRef = useRef(false);
  const previousItemIdsRef = useRef(itemIds);
  const currentItemIdsRef = useRef(itemIds);
  const previousLastUserTurnIdRef = useRef(lastUserTurnId);
  const programmaticScrollRef = useRef(false);
  const clearProgrammaticFrameRef = useRef<number | null>(null);
  modeRef.current = mode;
  currentItemIdsRef.current = itemIds;

  const setScrollMode = useCallback((nextMode: TranscriptScrollMode) => {
    if (modeRef.current === nextMode) return;
    modeRef.current = nextMode;
    setMode(nextMode);
  }, []);

  const setUnreadCount = useCallback((nextCount: number) => {
    if (newMessageCountRef.current === nextCount) return;
    newMessageCountRef.current = nextCount;
    setNewMessageCount(nextCount);
  }, []);

  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current = true;
    if (clearProgrammaticFrameRef.current !== null) {
      window.cancelAnimationFrame(clearProgrammaticFrameRef.current);
    }
    clearProgrammaticFrameRef.current = window.requestAnimationFrame(() => {
      clearProgrammaticFrameRef.current = null;
      programmaticScrollRef.current = false;
    });
  }, []);

  const persistSnapshot = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || !restoredRef.current) return;
    memory.set(threadId, {
      itemIds: [...currentItemIdsRef.current],
      mode: modeRef.current,
      newMessageCount: newMessageCountRef.current,
      position: captureScrollAnchor(viewport, content),
    });
  }, [memory, threadId]);

  const restorePosition = useCallback(
    (position: ScrollAnchorPosition): boolean => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return false;
      markProgrammaticScroll();
      return restoreScrollAnchor(viewport, content, position);
    },
    [markProgrammaticScroll],
  );

  const jumpToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    markProgrammaticScroll();
    scrollViewportToEnd(viewport);
    setScrollMode("following");
    setUnreadCount(0);
    persistSnapshot();
  }, [markProgrammaticScroll, persistSnapshot, setScrollMode, setUnreadCount]);

  useLayoutEffect(() => {
    if (hydrating || restoredRef.current) return;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const saved = memory.get(threadId);
    let restored = false;
    if (saved?.position) {
      restored = restorePosition(saved.position);
      if (restored) setScrollMode(saved.mode);
    }
    if (!restored && lastUserTurnId) {
      restored = restorePosition({
        anchorId: lastUserTurnId,
        offset: TRANSCRIPT_RESTORE_OFFSET_PX,
      });
      if (restored) {
        setScrollMode(isNearScrollEnd(viewport) ? "following" : "anchored");
      }
    }
    if (!restored) {
      markProgrammaticScroll();
      scrollViewportToEnd(viewport);
      setScrollMode("following");
    }
    restoredRef.current = true;
    persistSnapshot();

    // The shadcn primitive applies its default position in a parent layout
    // effect. Reapply in the same browser task so the owned position wins
    // before paint without a hydration-completion jump.
    queueMicrotask(() => {
      const current = memory.get(threadId)?.position;
      if (current) restorePosition(current);
    });
  }, [
    hydrating,
    lastUserTurnId,
    markProgrammaticScroll,
    memory,
    persistSnapshot,
    restorePosition,
    setScrollMode,
    threadId,
  ]);

  useLayoutEffect(() => {
    return () => {
      persistSnapshot();
      if (clearProgrammaticFrameRef.current !== null) {
        window.cancelAnimationFrame(clearProgrammaticFrameRef.current);
      }
    };
  }, [persistSnapshot]);

  useLayoutEffect(() => {
    if (
      hydrating ||
      itemIds.length === 0 ||
      !restoredRef.current ||
      modeRef.current === "following"
    ) {
      return;
    }
    const saved = memory.get(threadId)?.position;
    if (!saved) return;
    restorePosition(saved);
    persistSnapshot();
  }, [hydrating, itemIds, memory, persistSnapshot, restorePosition, threadId]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (!restoredRef.current || hydrating) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        if (modeRef.current === "following") {
          markProgrammaticScroll();
          scrollViewportToEnd(viewport);
        } else {
          const saved = memory.get(threadId)?.position;
          if (saved) restorePosition(saved);
        }
        persistSnapshot();
      });
    });
    observer.observe(content);
    return () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      observer.disconnect();
    };
  }, [hydrating, markProgrammaticScroll, memory, persistSnapshot, restorePosition, threadId]);

  useLayoutEffect(() => {
    const previousIds = previousItemIdsRef.current;
    const addedCount = countNewIds(previousIds, itemIds);
    previousItemIdsRef.current = itemIds;
    if (addedCount > 0 && modeRef.current === "detached") {
      setUnreadCount(newMessageCountRef.current + addedCount);
      persistSnapshot();
    }

    const previousLastUserTurnId = previousLastUserTurnIdRef.current;
    previousLastUserTurnIdRef.current = lastUserTurnId;
    if (
      restoredRef.current &&
      modeRef.current === "anchored" &&
      lastUserTurnId &&
      previousLastUserTurnId !== lastUserTurnId
    ) {
      restorePosition({
        anchorId: lastUserTurnId,
        offset: TRANSCRIPT_RESTORE_OFFSET_PX,
      });
      persistSnapshot();
    }
  }, [itemIds, lastUserTurnId, persistSnapshot, restorePosition, setUnreadCount]);

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const viewport = event.currentTarget;
      if (isNearScrollEnd(viewport)) {
        if (!programmaticScrollRef.current || modeRef.current === "following") {
          setScrollMode("following");
          setUnreadCount(0);
        }
      } else if (!programmaticScrollRef.current && modeRef.current === "following") {
        setScrollMode("detached");
      }
      persistSnapshot();
      onViewportScroll(event);
    },
    [onViewportScroll, persistSnapshot, setScrollMode, setUnreadCount],
  );

  const detachFromTail = useCallback(() => {
    programmaticScrollRef.current = false;
    if (clearProgrammaticFrameRef.current !== null) {
      window.cancelAnimationFrame(clearProgrammaticFrameRef.current);
      clearProgrammaticFrameRef.current = null;
    }
    setScrollMode("detached");
  }, [setScrollMode]);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) {
        detachFromTail();
      }
    },
    [detachFromTail],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (DETACH_KEYS.has(event.key)) detachFromTail();
    },
    [detachFromTail],
  );

  const handleTouchMove = useCallback(() => {
    detachFromTail();
  }, [detachFromTail]);

  return (
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport
        ref={viewportRef}
        aria-label="Conversation messages"
        className="[overflow-anchor:none]"
        data-scroll-mode={mode}
        preserveScrollOnPrepend={false}
        onKeyDown={handleKeyDown}
        onScroll={handleScroll}
        onTouchMove={handleTouchMove}
        onWheel={handleWheel}
      >
        <MessageScrollerContent
          ref={contentRef}
          className="mx-auto w-full max-w-3xl gap-3.5 px-4 py-5 pt-6"
        >
          {children}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      {mode === "detached" ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="absolute inset-s-1/2 z-10 -translate-x-1/2 gap-2 border border-border bg-background text-foreground shadow-md hover:bg-muted rtl:translate-x-1/2"
          style={{ bottom: bottomOffset + SCROLL_BUTTON_BOTTOM_GAP_PX }}
          aria-label={
            newMessageCount > 0
              ? `${newMessageCount} new ${newMessageCount === 1 ? "message" : "messages"}. Jump to latest`
              : "Jump to latest"
          }
          aria-live="polite"
          onClick={jumpToLatest}
        >
          <ArrowDownIcon data-icon="inline-start" />
          <span>
            {newMessageCount > 0
              ? `${newMessageCount} new ${newMessageCount === 1 ? "message" : "messages"}`
              : "Jump to latest"}
          </span>
          {newMessageCount > 0 ? (
            <span className="text-muted-foreground">Jump to latest</span>
          ) : null}
        </Button>
      ) : null}
    </MessageScroller>
  );
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

  bottomOffset: number;
  interactions: VisibleInteraction[];
  onAnswerAsk: (threadId: string, requestId: string, answer: string) => boolean;
  onAnswerApproval: (threadId: string, requestId: string, approved: boolean) => boolean;
  onRetryInteraction: (threadId: string, requestId: string) => boolean;
  selectedThreadId?: string | null;
  threadTitleById?: ReadonlyMap<string, string>;
  onSelectThread?: (threadId: string) => void;
  onRetryFailedTurn?: (toolItemIds: string[]) => Promise<boolean>;
  retryFailedTurnDisabled?: boolean;
  retryUnavailableReason?: string;
  hiddenFeedItemCount?: number;
  onExpandOlderFeed?: () => void;
  onShowAllOlderFeed?: () => void;
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
    bottomOffset,
    interactions,
    onAnswerAsk,
    onAnswerApproval,
    onRetryInteraction,
    selectedThreadId,
    threadTitleById,
    onSelectThread,
    onRetryFailedTurn,
    retryFailedTurnDisabled,
    retryUnavailableReason,
    hiddenFeedItemCount = 0,
    onExpandOlderFeed = () => {},
    onShowAllOlderFeed = () => {},
  } = props;
  recordDesktopRenderMetric("chat-feed", selectedThreadId ?? undefined);
  const lastUserTurnId = lastVisibleUserTurnId(renderItems);
  const retryableActivityGroupId = latestRetryableActivityGroupId(renderItems);
  const feedListEntries = useMemo(() => buildFeedListEntries(renderItems), [renderItems]);
  const scrollMemoryRef = useRef(new Map<string, TranscriptScrollSnapshot>());
  const scrollItemIds = useMemo(
    () => [
      ...renderItems.map((item) => (item.kind === "activity-group" ? item.id : item.item.id)),
      ...interactions.map(
        ({ threadId, interaction }) => `interaction:${threadId}:${interaction.requestId}`,
      ),
    ],
    [interactions, renderItems],
  );
  const threadId = selectedThreadId ?? "no-thread";

  const handleViewportScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (hiddenFeedItemCount <= 0) return;
      const viewport = event.currentTarget;
      if (viewport.scrollTop <= FEED_NEAR_TOP_PX) {
        onExpandOlderFeed();
      }
    },
    [hiddenFeedItemCount, onExpandOlderFeed],
  );

  return (
    <MessageScrollerProvider key={threadId} autoScroll={false} defaultScrollPosition="start">
      <TranscriptScroller
        bottomOffset={bottomOffset}
        hydrating={hydrating}
        itemIds={scrollItemIds}
        lastUserTurnId={lastUserTurnId}
        memory={scrollMemoryRef.current}
        onViewportScroll={handleViewportScroll}
        threadId={threadId}
      >
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
                  {hydrating ? "Loading chat" : disconnected ? "Disconnected" : "No messages yet"}
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
            {hiddenFeedItemCount > 0 ? (
              <MessageScrollerItem messageId="status:show-older">
                <div
                  aria-hidden="true"
                  className="flex flex-col items-center gap-2 py-1"
                  data-slot="feed-window-spacer"
                  style={{
                    minHeight: Math.min(hiddenFeedItemCount * FEED_ESTIMATED_ROW_HEIGHT_PX, 2_400),
                  }}
                >
                  <Button type="button" variant="outline" size="sm" onClick={onShowAllOlderFeed}>
                    Show {hiddenFeedItemCount} older messages
                  </Button>
                </div>
              </MessageScrollerItem>
            ) : null}
            {feedListEntries.map((entry) => {
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
                <MessageScrollerItem key={messageId} messageId={messageId}>
                  {item.kind === "activity-group" ? (
                    <InlineErrorBoundary label="This activity couldn't be rendered.">
                      <ActivityGroupCard
                        items={item.items}
                        recoveredToolIds={item.recoveredToolIds}
                        live={item.id === liveActivityGroupId}
                        liveStartedAt={liveStartedAt}
                        onRetry={
                          item.id === retryableActivityGroupId && onRetryFailedTurn
                            ? () =>
                                onRetryFailedTurn(
                                  unresolvedToolFailureIds(item.items, item.recoveredToolIds),
                                )
                            : undefined
                        }
                        retryDisabled={retryFailedTurnDisabled}
                        retryUnavailableReason={
                          item.id === retryableActivityGroupId ? retryUnavailableReason : undefined
                        }
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

        {interactions.map(({ threadId, interaction }, index) => (
          <MessageScrollerItem
            key={`${threadId}:${interaction.requestId}`}
            messageId={`interaction:${threadId}:${interaction.requestId}`}
          >
            <InteractionCard
              threadId={threadId}
              interaction={interaction}
              position={index + 1}
              total={interactions.length}
              onAnswerAsk={onAnswerAsk}
              onAnswerApproval={onAnswerApproval}
              onRetry={onRetryInteraction}
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
            style={{ height: bottomOffset }}
          />
        </MessageScrollerItem>
      </TranscriptScroller>
    </MessageScrollerProvider>
  );
});
