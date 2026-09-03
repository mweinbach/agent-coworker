import {
  AlertTriangleIcon,
  ArrowDownIcon,
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import type { WheelEvent } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { Marker, MarkerContent } from "../../components/ui/marker";
import { cn } from "../../lib/utils";
import { DesktopMarkdown } from "../markdown";
import type { ActivityFeedItem, ActivityGroupSummary } from "./activityGroups";
import {
  activityTimestampMs,
  firstActivityTimestampMs,
  formatActivityContentSummary,
  formatActivityElapsedMs,
  summarizeActivityGroup,
} from "./activityGroups";
import { bucketTimelineEntries, TimelineNode, ToolClusterNode } from "./activityToolCluster";
import { normalizeReasoningMarkdown } from "./markdownPreview";
import {
  captureScrollAnchor,
  countNewIds,
  isNearScrollEnd,
  restoreScrollAnchor,
  type ScrollAnchorPosition,
  scrollDistanceFromEnd,
  scrollViewportToEnd,
} from "./scrollOwnership";
import { formatToolCard } from "./toolCards/toolCardFormatting";

type ReasoningSection = {
  id: string;
  title: string;
  body: string;
};

const REASONING_HEADING_PATTERN = /(?:^|\n+)(?:#+\s+|\*\*|__)([^*#\n_]+?)(?:\*\*|__)?\s*(?:\n+|$)/g;

function reasoningPreviewLabel(text: string): string {
  const trimmed = text.trim();
  const lineEnd = trimmed.indexOf("\n");
  const firstLine = trimmed.slice(0, Math.min(lineEnd < 0 ? trimmed.length : lineEnd, 2_000));
  const plainText = firstLine
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*(?:\)|$)/g, "$1")
    .replace(/!?\[([^\]\n]*)\]\[[^\]\n]*\]/g, "$1")
    .replace(/<?(?:https?:\/\/|mailto:|www\.)[^\s>]+>?/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|\W)([*_])([^*_]+)\2(?=\W|$)/g, "$1$3")
    .replace(/`+/g, "")
    .replace(/^#{1,6}\s+|^>\s?|^[-*+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return plainText.length > 140 ? `${plainText.slice(0, 139)}…` : plainText;
}

/**
 * Stable section ids so streaming heading discovery does not remount earlier
 * sections (array-index keys used to shift and flash/overlap as text grew).
 */
function stableReasoningSectionId(title: string, titleCounts: Map<string, number>): string {
  if (title) {
    const next = (titleCounts.get(title) ?? 0) + 1;
    titleCounts.set(title, next);
    return `h:${next}:${title}`;
  }
  // Each source has at most one untitled leading section. Its identity must
  // not depend on the body, which changes with every streamed token.
  return "b:leading";
}

function parseReasoningSections(text: string): ReasoningSection[] {
  const normalized = normalizeReasoningMarkdown(text);
  if (!normalized) return [];

  // Match bold headings like **Heading** or markdown headings like ### Heading
  const matches: { title: string; index: number; length: number }[] = [];

  for (const match of normalized.matchAll(REASONING_HEADING_PATTERN)) {
    matches.push({
      title: match[1].trim(),
      index: match.index,
      length: match[0].length,
    });
  }

  const titleCounts = new Map<string, number>();

  if (matches.length === 0) {
    return [
      {
        id: stableReasoningSectionId("", titleCounts),
        title: "",
        body: normalized,
      },
    ];
  }

  const sections: ReasoningSection[] = [];
  if (matches[0].index > 0) {
    const leadingBody = normalized.slice(0, matches[0].index).trim();
    if (leadingBody) {
      sections.push({
        id: stableReasoningSectionId("", titleCounts),
        title: "",
        body: leadingBody,
      });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const currentMatch = matches[i];
    const nextMatch = matches[i + 1];

    const contentStart = currentMatch.index + currentMatch.length;
    const contentEnd = nextMatch ? nextMatch.index : normalized.length;
    const body = normalized.slice(contentStart, contentEnd).trim();

    sections.push({
      id: stableReasoningSectionId(currentMatch.title, titleCounts),
      title: currentMatch.title,
      body,
    });
  }

  return sections;
}

function ReasoningMarkdown({
  body,
  className,
  streaming,
}: {
  body: string;
  className?: string;
  streaming?: boolean;
}) {
  return (
    <DesktopMarkdown
      normalizeDisplayCitations
      className={cn(className, streaming && "streaming-markdown-caret")}
      isAnimating={streaming === true}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming === true}
    >
      {body}
    </DesktopMarkdown>
  );
}

const ReasoningSectionNode = memo(function ReasoningSectionNode({
  disclosureId,
  title,
  body,
  streaming,
}: {
  disclosureId: string;
  title: string;
  body: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const preview = reasoningPreviewLabel(title || body) || "Reasoning";

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-controls={disclosureId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 rounded-md py-0.5 text-left app-type-body font-medium app-text-secondary outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate">{preview}</span>
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 app-text-muted transition-transform duration-150",
            open && "rotate-90",
          )}
        />
      </button>
      {open && body && (
        <div
          id={disclosureId}
          className="reasoning-section-in mt-1.5 pb-1 app-type-body app-text-secondary select-text"
        >
          <ReasoningMarkdown
            body={body}
            streaming={streaming}
            className="prose-sm leading-relaxed"
          />
        </div>
      )}
    </div>
  );
});

const ReasoningTimelineNode = memo(function ReasoningTimelineNode({
  sourceId,
  text,
  isLast,
  live,
  isMostRecent,
}: {
  sourceId: string;
  text: string;
  isLast: boolean;
  live?: boolean;
  isMostRecent: boolean;
}) {
  const reasoningText = text.trim();
  const sections = useMemo(() => parseReasoningSections(reasoningText), [reasoningText]);

  if (!reasoningText) {
    return (
      <TimelineNode icon={<BrainIcon className="size-3.5 app-text-muted" />} isLast={isLast}>
        <span className="activity-thinking-shimmer inline-flex items-center app-type-body">
          Thinking
        </span>
      </TimelineNode>
    );
  }

  return (
    <TimelineNode icon={<BrainIcon className="size-3.5 app-text-muted" />} isLast={isLast}>
      <div className="flex flex-col gap-1.5 min-w-0">
        {sections.map((section, idx) => {
          const isSectionMostRecent = live ? isMostRecent && idx === sections.length - 1 : true;
          // Only the live tail uses incomplete-markdown streaming so earlier
          // sections stay layout-stable while new text arrives.
          const streaming = live === true && isSectionMostRecent;
          return (
            <ReasoningSectionNode
              key={`${sourceId}:${section.id}`}
              disclosureId={`activity-reasoning-${encodeURIComponent(sourceId)}-${encodeURIComponent(section.id)}`}
              title={section.title}
              body={section.body}
              streaming={streaming}
            />
          );
        })}
      </div>
    </TimelineNode>
  );
});

function ActivityTimeline({
  summary,
  live,
  contentSummary,
}: {
  summary: ActivityGroupSummary;
  live?: boolean;
  contentSummary: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [newActivityCount, setNewActivityCount] = useState(0);
  const followingRef = useRef(following);
  const anchorRef = useRef<ScrollAnchorPosition | null>(null);
  const userScrollPendingRef = useRef(false);
  const clearPendingFrameRef = useRef<number | null>(null);
  const entryIds = useMemo(() => summary.entries.map((entry) => entry.item.id), [summary.entries]);
  const timelineBuckets = useMemo(() => bucketTimelineEntries(summary.entries), [summary.entries]);
  const previousEntryIdsRef = useRef(entryIds);
  followingRef.current = following;

  const setFollowTail = useCallback((nextFollowing: boolean) => {
    followingRef.current = nextFollowing;
    setFollowing(nextFollowing);
  }, []);

  const captureAnchor = useCallback(() => {
    const node = containerRef.current;
    const content = contentRef.current;
    if (!node || !content) return;
    anchorRef.current = captureScrollAnchor(node, content);
  }, []);

  const markUserScrollPending = useCallback(() => {
    userScrollPendingRef.current = true;
    if (clearPendingFrameRef.current !== null) {
      window.cancelAnimationFrame(clearPendingFrameRef.current);
    }
    // Clear after two frames if no scroll event arrives (nested gesture with no movement).
    clearPendingFrameRef.current = window.requestAnimationFrame(() => {
      clearPendingFrameRef.current = window.requestAnimationFrame(() => {
        clearPendingFrameRef.current = null;
        userScrollPendingRef.current = false;
      });
    });
  }, []);

  useEffect(() => {
    const addedCount = countNewIds(previousEntryIdsRef.current, entryIds);
    previousEntryIdsRef.current = entryIds;
    if (!followingRef.current && addedCount > 0) {
      setNewActivityCount((current) => current + addedCount);
    }
    if (!live || !followingRef.current || !containerRef.current) return;
    scrollViewportToEnd(containerRef.current);
  }, [entryIds, live]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (userScrollPendingRef.current) return;
        const node = containerRef.current;
        const currentContent = contentRef.current;
        if (!node || !currentContent) return;
        if (followingRef.current) {
          scrollViewportToEnd(node);
          return;
        }
        const anchor = anchorRef.current;
        if (anchor) {
          restoreScrollAnchor(node, currentContent, anchor);
          captureAnchor();
        }
      });
    });
    observer.observe(content);
    return () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (clearPendingFrameRef.current !== null) {
        window.cancelAnimationFrame(clearPendingFrameRef.current);
      }
      observer.disconnect();
    };
  }, [captureAnchor]);

  const handleScroll = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    userScrollPendingRef.current = false;
    if (isNearScrollEnd(node)) {
      setFollowTail(true);
      setNewActivityCount(0);
    } else {
      setFollowTail(false);
      captureAnchor();
    }
  }, [captureAnchor, setFollowTail]);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      const node = containerRef.current;
      if (!node) return;
      const canScrollUp = node.scrollTop > 0;
      const canScrollDown = scrollDistanceFromEnd(node) > 0;
      // Own the gesture while this viewport can move so the outer transcript
      // does not detach from a nested activity scroll.
      if ((event.deltaY < 0 && canScrollUp) || (event.deltaY > 0 && canScrollDown)) {
        event.stopPropagation();
      }
      if (event.deltaY < 0) {
        markUserScrollPending();
        setFollowTail(false);
        captureAnchor();
      }
    },
    [captureAnchor, markUserScrollPending, setFollowTail],
  );

  const jumpToLatest = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    scrollViewportToEnd(node);
    setFollowTail(true);
    setNewActivityCount(0);
    anchorRef.current = null;
  }, [setFollowTail]);

  const lastReasoningEntryId = useMemo(() => {
    const reasoningEntries = summary.entries.filter((e) => e.kind === "reasoning");
    if (reasoningEntries.length === 0) return null;
    return reasoningEntries[reasoningEntries.length - 1].item.id;
  }, [summary.entries]);
  const recoveredToolIds = useMemo(
    () => new Set(summary.recoveredToolIds),
    [summary.recoveredToolIds],
  );

  return (
    <div className="min-w-0">
      <div
        data-slot="activity-timeline-toolbar"
        className="mb-2 flex min-h-7 items-center justify-between gap-2"
      >
        <span
          data-slot="activity-content-summary"
          className="min-w-0 truncate text-xs font-medium text-muted-foreground"
        >
          {contentSummary || "Activity"}
        </span>
        {!following ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 gap-1.5 rounded-full text-muted-foreground hover:text-foreground"
            aria-label={
              newActivityCount > 0
                ? `${newActivityCount} new ${newActivityCount === 1 ? "update" : "updates"}. Jump to latest activity`
                : "Jump to latest activity"
            }
            aria-live="polite"
            onClick={jumpToLatest}
          >
            {newActivityCount > 0 ? (
              <span>{`${newActivityCount} new ${newActivityCount === 1 ? "update" : "updates"}`}</span>
            ) : null}
            <span>Latest activity</span>
            <ArrowDownIcon data-icon="inline-end" />
          </Button>
        ) : null}
      </div>
      <div
        ref={containerRef}
        data-slot="activity-timeline-viewport"
        className="max-h-[26rem] overflow-y-auto pr-1 scrollbar-thin scrollbar-gutter-stable [overflow-anchor:none]"
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        <div ref={contentRef} data-slot="activity-timeline-content">
          {timelineBuckets.map((bucket, bucketIndex) => {
            const isLastBucket = bucketIndex === timelineBuckets.length - 1;

            if (bucket.kind === "reasoning") {
              const entry = bucket.entry;
              const isMostRecent = entry.item.id === lastReasoningEntryId;
              return (
                <div
                  key={entry.item.id}
                  data-activity-entry-kind="reasoning"
                  data-scroll-anchor-id={entry.item.id}
                >
                  <ReasoningTimelineNode
                    sourceId={entry.item.id}
                    text={entry.item.text}
                    isLast={isLastBucket}
                    live={live}
                    isMostRecent={isMostRecent}
                  />
                </div>
              );
            }

            return (
              <ToolClusterNode
                key={`cluster:${bucket.entries[0].item.id}`}
                entries={bucket.entries}
                isLastBucket={isLastBucket}
                recoveredToolIds={recoveredToolIds}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatActiveAgentsSuffix(labels: readonly string[] | undefined): string {
  if (!labels || labels.length === 0) return "";
  if (labels.length === 1) return ` · ${labels[0]}`;
  if (labels.length <= 3) return ` · ${labels.join(", ")}`;
  return ` · ${labels.length} subagents`;
}

function currentActivityLabel(summary: ActivityGroupSummary): string {
  const activeTool = summary.entries.findLast(
    (entry) =>
      entry.kind === "tool" &&
      (entry.item.state === "approval-requested" ||
        entry.item.state === "input-streaming" ||
        entry.item.state === "input-available"),
  );
  const entry = activeTool ?? summary.entries[summary.entries.length - 1];
  if (!entry) return "Working";
  if (entry.kind === "reasoning") {
    const normalized = normalizeReasoningMarkdown(entry.item.text);
    let latestHeading: string | undefined;
    for (const match of normalized.matchAll(REASONING_HEADING_PATTERN)) latestHeading = match[1];
    return reasoningPreviewLabel(latestHeading ?? normalized) || "Thinking";
  }
  const { title, subtitle } = formatToolCard(
    entry.item.name,
    entry.item.args,
    entry.item.result,
    entry.item.state,
  );
  const label = subtitle ? `${title} · ${subtitle}` : title;
  return activeTool ? label : `Latest: ${label}`;
}

const LiveTimerLabel = memo(function LiveTimerLabel(props: {
  items: ActivityFeedItem[];
  live?: boolean;
  liveNowMs?: number;
  liveStartedAt?: string | null;
  summaryElapsedLabel: string | null;
  hasUnrecoveredIssue?: boolean;
  activeAgentLabels?: readonly string[];
}) {
  const {
    items,
    live,
    liveNowMs,
    liveStartedAt,
    summaryElapsedLabel,
    hasUnrecoveredIssue,
    activeAgentLabels,
  } = props;

  const [nowMs, setNowMs] = useState(() => liveNowMs ?? Date.now());
  const startedAtMs = useMemo(() => {
    if (!live) return null;
    return (
      (liveStartedAt ? activityTimestampMs(liveStartedAt) : null) ?? firstActivityTimestampMs(items)
    );
  }, [items, live, liveStartedAt]);

  useEffect(() => {
    if (!live || liveNowMs !== undefined) {
      return;
    }
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [live, liveNowMs]);

  const currentNowMs = liveNowMs ?? nowMs;
  const liveElapsedLabel =
    live === true ? formatActivityElapsedMs(currentNowMs - (startedAtMs ?? currentNowMs)) : null;

  const displayElapsedLabel = liveElapsedLabel ?? summaryElapsedLabel;
  const agentsSuffix = formatActiveAgentsSuffix(activeAgentLabels);

  if (live) {
    const base = displayElapsedLabel ? `Working for ${displayElapsedLabel}` : "Working";
    return `${base}${agentsSuffix}`;
  }

  if (hasUnrecoveredIssue) {
    return displayElapsedLabel ? `Couldn't finish after ${displayElapsedLabel}` : "Couldn't finish";
  }

  return displayElapsedLabel ? `Worked for ${displayElapsedLabel}` : "Worked";
});

/* ── Main card ──────────────────────────────────────────────────────────────── */

export const ActivityGroupCard = memo(function ActivityGroupCard(props: {
  items: ActivityFeedItem[];
  recoveredToolIds?: string[];
  live?: boolean;
  liveNowMs?: number;
  liveStartedAt?: string | null;
  /** Short labels for busy subagents shown on the live working header. */
  activeAgentLabels?: readonly string[];
  onRetry?: () => Promise<boolean>;
  retryDisabled?: boolean;
  retryUnavailableReason?: string;
}) {
  const summary = useMemo(
    () => summarizeActivityGroup(props.items, props.recoveredToolIds),
    [props.items, props.recoveredToolIds],
  );
  const currentAction = useMemo(
    () => (props.live ? currentActivityLabel(summary) : ""),
    [props.live, summary],
  );
  const displayStatus = props.live && summary.status === "done" ? "running" : summary.status;
  // contentSummary is shown only when the timeline is expanded.
  const isComplete = displayStatus === "done";
  const hasUnrecoveredIssue = displayStatus === "issue";
  const shouldAutoExpand =
    displayStatus === "approval" || (props.live === true && displayStatus === "issue");
  const [expanded, setExpanded] = useState(shouldAutoExpand);
  const contentSummary = useMemo(
    () => (expanded ? formatActivityContentSummary(props.items) : null),
    [expanded, props.items],
  );
  const [retrying, setRetrying] = useState(false);
  // Remember whether the user has manually expanded/collapsed this group, so a
  // turn completing doesn't slam the card shut while they're still reading it.
  const userToggledRef = useRef(false);
  const handleOpenChange = (open: boolean) => {
    userToggledRef.current = true;
    setExpanded(open);
  };
  const handleRetry = async () => {
    if (!props.onRetry || props.retryDisabled || retrying) return;
    setRetrying(true);
    try {
      await props.onRetry();
    } finally {
      setRetrying(false);
    }
  };

  useEffect(() => {
    if (!userToggledRef.current && shouldAutoExpand) {
      setExpanded(true);
    }
    // Do not auto-collapse on complete — users often want the audit trail.
    // Collapse only when a new turn starts (parent remounts) or the user toggles.
  }, [shouldAutoExpand]);

  const showStateBadge = displayStatus === "approval" || displayStatus === "issue";
  const isPendingReasoning = displayStatus === "running" && summary.preview === "Thinking...";
  const useThinkingTreatment =
    isPendingReasoning ||
    (summary.reasoningCount > 0 && summary.toolCount === 0 && !showStateBadge);
  // Keep one structural shell for live turns (including mid-turn approval) and
  // terminal compact rows so chrome does not jump between Marker and Card.
  const useCompactElapsedHeader = isComplete || hasUnrecoveredIssue || props.live === true;

  if (useCompactElapsedHeader) {
    return (
      <>
        <Collapsible open={expanded} onOpenChange={handleOpenChange}>
          <div className="flex w-full max-w-3xl items-center gap-1.5">
            <Marker asChild variant={props.live ? "default" : "separator"}>
              <CollapsibleTrigger
                data-slot="activity-disclosure"
                className="group min-w-0 flex-1 rounded-md py-1.5 outline-none before:hidden focus-visible:ring-1 focus-visible:ring-ring"
              >
                {hasUnrecoveredIssue ? (
                  <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive/75" />
                ) : props.live ? (
                  <span
                    className="activity-live-dot size-1.5 shrink-0 self-center rounded-full bg-primary"
                    aria-hidden
                  />
                ) : null}
                <MarkerContent
                  className={cn(
                    "min-w-0 app-type-body font-medium tabular-nums transition-colors group-hover:text-foreground group-data-[variant=separator]/marker:text-left",
                    hasUnrecoveredIssue
                      ? "text-destructive/85 group-hover:text-destructive"
                      : props.live
                        ? "app-text-secondary"
                        : "text-muted-foreground",
                  )}
                >
                  {props.live ? (
                    <span
                      data-slot="activity-current-action"
                      className="block truncate"
                      title={currentAction}
                    >
                      {currentAction}
                    </span>
                  ) : (
                    <LiveTimerLabel
                      items={props.items}
                      summaryElapsedLabel={summary.elapsedLabel}
                      hasUnrecoveredIssue={hasUnrecoveredIssue}
                    />
                  )}
                </MarkerContent>
                {props.live ? (
                  <span className="ml-auto min-w-0 max-w-[45%] shrink-0 truncate text-xs tabular-nums text-muted-foreground">
                    <LiveTimerLabel
                      items={props.items}
                      live={props.live}
                      liveNowMs={props.liveNowMs}
                      liveStartedAt={props.liveStartedAt}
                      summaryElapsedLabel={summary.elapsedLabel}
                      hasUnrecoveredIssue={hasUnrecoveredIssue}
                      activeAgentLabels={props.activeAgentLabels}
                    />
                  </span>
                ) : null}
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-90",
                    hasUnrecoveredIssue ? "text-destructive/60" : "app-text-muted",
                  )}
                />
              </CollapsibleTrigger>
            </Marker>
            {hasUnrecoveredIssue && props.onRetry ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={props.retryDisabled || retrying}
                aria-busy={retrying || undefined}
                onClick={() => void handleRetry()}
                className="text-muted-foreground hover:text-foreground"
              >
                {retrying ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />}
                {retrying ? "Retrying" : "Retry"}
              </Button>
            ) : hasUnrecoveredIssue && props.retryUnavailableReason ? (
              <span
                className="max-w-48 text-right text-xs leading-tight text-muted-foreground"
                data-slot="activity-retry-unavailable"
              >
                {props.retryUnavailableReason}
              </span>
            ) : null}
          </div>

          {props.live && !expanded && (summary.toolCount > 0 || summary.reasoningCount > 0) ? (
            <p
              className="mb-1 ml-3.5 text-xs text-muted-foreground"
              data-slot="activity-history-summary"
            >
              {summary.toolCount > 0
                ? `${summary.toolCount} ${summary.toolCount === 1 ? "tool" : "tools"} used`
                : "Reasoning"}
            </p>
          ) : null}

          <CollapsibleContent className="activity-trace-content max-w-3xl">
            <div className="ml-0.5 border-l app-border-subtle pb-1 pl-3 pt-1">
              <ActivityTimeline
                summary={summary}
                live={props.live}
                contentSummary={contentSummary}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
        {props.live ? (
          <span className="sr-only" role="status" aria-live="polite">
            Cowork is working.
          </span>
        ) : null}
        {hasUnrecoveredIssue ? (
          <span className="sr-only" role="alert">
            {props.live
              ? "A tool failed. Cowork is still working."
              : "Cowork could not finish this activity."}
          </span>
        ) : null}
      </>
    );
  }

  return (
    <Card className="max-w-3xl gap-0 rounded-xl border app-border-subtle app-fill-subtle p-0 shadow-none backdrop-blur-none">
      <Collapsible open={expanded} onOpenChange={handleOpenChange}>
        {/* ── Trigger / header ──────────────────────────────────────────────── */}
        <CollapsibleTrigger className="group flex w-full flex-col gap-0 rounded-xl text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset focus-visible:shadow-none">
          <CardHeader className="flex items-center justify-between gap-2 px-2.5 pt-1.5 pb-1 transition-colors hover:bg-muted/[0.06]">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <ClockIcon
                className={cn(
                  "size-4 shrink-0 app-text-muted",
                  useThinkingTreatment && "text-primary/70",
                )}
              />
              <span
                className={cn(
                  "min-w-0 truncate app-type-body font-normal italic",
                  useThinkingTreatment ? "activity-thinking-shimmer" : "text-muted-foreground",
                )}
              >
                {isPendingReasoning ? "Thinking" : summary.preview}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {showStateBadge ? (
                <Badge
                  variant="destructive"
                  className="gap-1 px-1.5 py-0 text-xs font-semibold uppercase tracking-[0.1em]"
                >
                  {summary.status === "approval" ? (
                    <ShieldAlertIcon className="size-3.5 shrink-0" />
                  ) : (
                    <AlertTriangleIcon className="size-3.5 shrink-0" />
                  )}
                  <span>{summary.statusLabel}</span>
                </Badge>
              ) : null}
              <ChevronDownIcon className="size-3.5 app-text-muted transition-transform group-data-[state=open]:rotate-180" />
            </div>
          </CardHeader>
          {!expanded && summary.preview && !isPendingReasoning && showStateBadge && (
            <p className="px-2.5 pb-1.5 pt-0 text-xs leading-snug app-text-muted line-clamp-2">
              {summary.preview}
            </p>
          )}
        </CollapsibleTrigger>

        {/* ── Expanded timeline ─────────────────────────────────────────────── */}
        <CollapsibleContent className="activity-trace-content">
          <CardContent className="border-t app-border-subtle px-3 pb-2.5 pt-2">
            <ActivityTimeline summary={summary} live={props.live} contentSummary={contentSummary} />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
});
