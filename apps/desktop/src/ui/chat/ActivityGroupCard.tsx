import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  GlobeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ReactNode, WheelEvent } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ToolFeedState } from "../../app/types";
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

/* ── Small helpers ──────────────────────────────────────────────────────────── */

function TimelineToolIcon({ title, className }: { title: string; className?: string }) {
  const t = title.toLowerCase();
  if (t.includes("todo") || t.includes("task")) return <ListTodoIcon className={className} />;
  if (t.includes("search") || t.includes("grep") || t.includes("glob"))
    return <SearchIcon className={className} />;
  if (t.includes("fetch") || t.includes("web") || t.includes("browser"))
    return <GlobeIcon className={className} />;
  if (t.includes("bash") || t.includes("shell") || t.includes("run"))
    return <TerminalIcon className={className} />;
  return <WrenchIcon className={className} />;
}

function ToolStateIndicator({ state }: { state: ToolFeedState }) {
  if (state === "output-available") return null;
  if (state === "output-error" || state === "output-denied") {
    return <XCircleIcon className="size-3 text-destructive" />;
  }
  if (state === "approval-requested") {
    return (
      <Badge
        variant="destructive"
        className="gap-1 px-1.5 py-0 text-xs font-semibold uppercase tracking-wide"
      >
        <ShieldAlertIcon className="size-2.5" />
        Review
      </Badge>
    );
  }
  return (
    <span className="activity-live-dot size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
  );
}

/* ── Timeline building block ────────────────────────────────────────────────── */

function TimelineNode({
  icon,
  isLast,
  children,
}: {
  icon: ReactNode;
  isLast: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5">
      <div className="flex flex-col items-center">
        <div className="mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center">
          {icon}
        </div>
        {!isLast && <div className="mt-1 w-px flex-1 bg-border/35" />}
      </div>
      <div className="min-w-0 flex-1 pb-3">{children}</div>
    </div>
  );
}

type ReasoningSection = {
  id: string;
  title: string;
  body: string;
};

/**
 * Stable section ids so streaming heading discovery does not remount earlier
 * sections (array-index keys used to shift and flash/overlap as text grew).
 */
function stableReasoningSectionId(
  title: string,
  body: string,
  titleCounts: Map<string, number>,
): string {
  if (title) {
    const next = (titleCounts.get(title) ?? 0) + 1;
    titleCounts.set(title, next);
    return `h:${next}:${title}`;
  }
  // Untitled leading/body blocks: key off a short prefix of the body so the
  // first paragraph keeps its identity while trailing tokens stream in.
  const prefix = body.replace(/\s+/g, " ").trim().slice(0, 48);
  return `b:${prefix || "empty"}`;
}

function parseReasoningSections(text: string): ReasoningSection[] {
  const normalized = normalizeReasoningMarkdown(text);
  if (!normalized) return [];

  // Match bold headings like **Heading** or markdown headings like ### Heading
  const headingRegex = /(?:^|\n+)(?:#+\s+|\*\*|__)([^*#\n_]+?)(?:\*\*|__)?\s*(?:\n+|$)/g;
  const matches: { title: string; index: number; length: number }[] = [];

  let match: RegExpExecArray | null = headingRegex.exec(normalized);
  while (match !== null) {
    matches.push({
      title: match[1].trim(),
      index: match.index,
      length: match[0].length,
    });
    match = headingRegex.exec(normalized);
  }

  const titleCounts = new Map<string, number>();

  if (matches.length === 0) {
    return [
      {
        id: stableReasoningSectionId("", normalized, titleCounts),
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
        id: stableReasoningSectionId("", leadingBody, titleCounts),
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
      id: stableReasoningSectionId(currentMatch.title, body, titleCounts),
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

function ReasoningSectionNode({
  disclosureId,
  title,
  body,
  isMostRecent,
  streaming,
}: {
  disclosureId: string;
  title: string;
  body: string;
  isMostRecent: boolean;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(isMostRecent);
  // Keep the live tail open without fighting a user who collapsed an earlier section.
  useEffect(() => {
    if (isMostRecent && streaming) setOpen(true);
  }, [isMostRecent, streaming]);

  if (!title) {
    return (
      <ReasoningMarkdown
        body={body}
        streaming={streaming}
        className="app-type-body app-text-secondary"
      />
    );
  }

  return (
    <div className="min-w-0 py-1">
      <button
        type="button"
        aria-controls={disclosureId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 text-left app-type-body font-medium app-text-secondary outline-none transition-colors hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 app-text-muted transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span>{title}</span>
      </button>
      {open && body && (
        <div
          id={disclosureId}
          className="reasoning-section-in mt-1.5 ml-[7px] border-l-2 app-border-subtle pl-3 app-type-body app-text-muted select-text"
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
}

function ReasoningTimelineNode({
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

  if (!reasoningText) {
    return (
      <TimelineNode icon={<ClockIcon className="size-3 app-text-muted" />} isLast={isLast}>
        <span className="activity-thinking-shimmer inline-flex items-center app-type-body">
          Thinking
        </span>
      </TimelineNode>
    );
  }

  const sections = parseReasoningSections(reasoningText);

  return (
    <TimelineNode icon={<ClockIcon className="size-3 app-text-muted" />} isLast={isLast}>
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
              isMostRecent={isSectionMostRecent}
              streaming={streaming}
            />
          );
        })}
      </div>
    </TimelineNode>
  );
}

function toPrettyJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolRowSummary({
  title,
  subtitle,
  recovered,
  state,
  hideTitle,
  retryOf,
}: {
  title: string;
  subtitle: string;
  recovered: boolean;
  state: ToolFeedState;
  hideTitle?: boolean;
  retryOf?: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        {hideTitle ? (
          <span className="min-w-0 truncate app-type-body text-foreground">
            {subtitle || title}
          </span>
        ) : (
          <span className="app-type-body font-medium text-foreground">{title}</span>
        )}
        {recovered ? (
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-xs font-semibold uppercase tracking-wide"
            data-tool-recovery="recovered"
          >
            Recovered
          </Badge>
        ) : (
          <ToolStateIndicator state={state} />
        )}
      </div>
      {!hideTitle && subtitle ? (
        <div className="mt-0.5 text-xs leading-snug app-text-muted">{subtitle}</div>
      ) : null}
      {retryOf ? (
        <div className="mt-0.5 text-xs font-medium app-text-muted" data-tool-recovery="retry">
          Retry of failed call
        </div>
      ) : null}
    </div>
  );
}

function ToolTimelineNode({
  item,
  isLast,
  recovered,
  hideTitle = false,
  forcePlain = false,
  embedded = false,
}: {
  item: Extract<ActivityFeedItem, { kind: "tool" }>;
  isLast: boolean;
  recovered: boolean;
  /** When true, the parent cluster already shows the tool name — only render the row detail. */
  hideTitle?: boolean;
  /** Cluster children render as plain rows; only issues get their own disclosure. */
  forcePlain?: boolean;
  /** Skip the outer timeline rail when nested under a cluster disclosure. */
  embedded?: boolean;
}) {
  const formatting = useMemo(
    () => formatToolCard(item.name, item.args, item.result, item.state),
    [item.args, item.name, item.result, item.state],
  );
  const detailRows = useMemo(
    () =>
      formatting.details.filter(
        (row) => row.label !== "Status" && !(row.label === "Path" && formatting.subtitle),
      ),
    [formatting.details, formatting.subtitle],
  );
  const argsText = useMemo(() => toPrettyJson(item.args), [item.args]);
  const resultText = useMemo(() => toPrettyJson(item.result), [item.result]);
  const hasRawPayload = Boolean(argsText || resultText);
  const hasDetails = detailRows.length > 0 || hasRawPayload || Boolean(item.approval);
  const shouldAutoExpand =
    item.state === "approval-requested" ||
    item.state === "output-error" ||
    item.state === "output-denied";
  const allowDisclosure = !forcePlain || shouldAutoExpand;
  const [open, setOpen] = useState(shouldAutoExpand && hasDetails && allowDisclosure);
  const [rawOpen, setRawOpen] = useState(false);
  const userToggledRef = useRef(false);
  const handleOpenChange = (nextOpen: boolean) => {
    userToggledRef.current = true;
    setOpen(nextOpen);
  };

  useEffect(() => {
    if (!userToggledRef.current && shouldAutoExpand && hasDetails && allowDisclosure) {
      setOpen(true);
    }
  }, [allowDisclosure, hasDetails, shouldAutoExpand]);

  const summary = (
    <ToolRowSummary
      title={formatting.title}
      subtitle={formatting.subtitle}
      recovered={recovered}
      state={item.state}
      hideTitle={hideTitle}
      retryOf={item.retryOf}
    />
  );

  const body =
    hasDetails && allowDisclosure ? (
      <Collapsible open={open} onOpenChange={handleOpenChange}>
        <CollapsibleTrigger className="group/tool-row flex w-full min-w-0 items-start gap-1.5 rounded-md py-0.5 text-left outline-none hover:app-hover-wash focus-visible:ring-1 focus-visible:ring-ring">
          {summary}
          <ChevronRightIcon
            className={cn(
              "mt-0.5 size-3.5 shrink-0 app-text-muted transition-transform duration-150 group-hover/tool-row:text-muted-foreground",
              open && "rotate-90",
            )}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="activity-trace-content pt-1.5">
          {detailRows.length > 0 ? (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {detailRows.map((row) => (
                <div
                  key={`${item.id}-${row.label}`}
                  className="rounded-lg app-fill-subtle px-2 py-1.5"
                >
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {row.label}
                  </div>
                  <div className="mt-0.5 break-words text-xs leading-snug app-text-secondary">
                    {row.value}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {item.approval ? (
            <div className="mt-1.5 rounded-lg app-fill-subtle px-2 py-1.5 app-type-caption app-text-secondary">
              Approval required
            </div>
          ) : null}
          {hasRawPayload ? (
            <Collapsible open={rawOpen} onOpenChange={setRawOpen}>
              <CollapsibleTrigger className="mt-1.5 flex items-center gap-1 text-xs font-medium app-text-muted outline-none hover:text-foreground">
                <ChevronRightIcon
                  className={cn("size-3 transition-transform", rawOpen && "rotate-90")}
                />
                Raw input/output
              </CollapsibleTrigger>
              <CollapsibleContent>
                {argsText ? (
                  <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg app-fill-subtle p-2 app-type-caption app-text-secondary">
                    {argsText}
                  </pre>
                ) : null}
                {resultText ? (
                  <pre
                    className={cn(
                      "mt-1.5 max-h-48 overflow-auto rounded-lg p-2 text-xs leading-relaxed",
                      item.state === "output-error" || item.state === "output-denied"
                        ? "bg-destructive/[0.06] text-destructive"
                        : "app-fill-subtle app-text-secondary",
                    )}
                  >
                    {resultText}
                  </pre>
                ) : null}
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    ) : (
      <div className="min-w-0 py-0.5">{summary}</div>
    );

  if (embedded) {
    return body;
  }

  return (
    <TimelineNode
      icon={<TimelineToolIcon title={formatting.title} className="size-3 app-text-muted" />}
      isLast={isLast}
    >
      {body}
    </TimelineNode>
  );
}

type TimelineRenderBucket =
  | { kind: "reasoning"; entry: ActivityGroupSummary["entries"][number] & { kind: "reasoning" } }
  | {
      kind: "tool-cluster";
      name: string;
      entries: Array<ActivityGroupSummary["entries"][number] & { kind: "tool" }>;
    };

/**
 * Cluster consecutive same-name tools so parallel bursts (e.g. four webSearch
 * calls) read as one intentional group instead of a shuffled checklist.
 */
function bucketTimelineEntries(entries: ActivityGroupSummary["entries"]): TimelineRenderBucket[] {
  const buckets: TimelineRenderBucket[] = [];
  for (const entry of entries) {
    if (entry.kind === "reasoning") {
      buckets.push({ kind: "reasoning", entry });
      continue;
    }
    const previous = buckets[buckets.length - 1];
    if (
      previous?.kind === "tool-cluster" &&
      previous.name.toLowerCase() === entry.item.name.toLowerCase()
    ) {
      previous.entries.push(entry);
      continue;
    }
    buckets.push({ kind: "tool-cluster", name: entry.item.name, entries: [entry] });
  }
  return buckets;
}

function ToolClusterNode({
  entries,
  isLastBucket,
  recoveredToolIds,
}: {
  entries: Array<ActivityGroupSummary["entries"][number] & { kind: "tool" }>;
  isLastBucket: boolean;
  recoveredToolIds: ReadonlySet<string>;
}) {
  const showClusterChrome = entries.length > 1;
  const clusterLabel = formatToolCard(
    entries[0].item.name,
    undefined,
    undefined,
    "output-available",
  ).title;
  const clusterOpenByDefault = entries.some(
    (entry) =>
      entry.item.state === "approval-requested" ||
      entry.item.state === "output-error" ||
      entry.item.state === "output-denied" ||
      entry.item.state === "input-streaming" ||
      entry.item.state === "input-available",
  );
  const [clusterOpen, setClusterOpen] = useState(clusterOpenByDefault || !showClusterChrome);
  const previews = entries
    .map(
      (entry) =>
        formatToolCard(entry.item.name, entry.item.args, entry.item.result, entry.item.state)
          .subtitle,
    )
    .filter((line) => line.length > 0)
    .slice(0, 3);

  if (!showClusterChrome) {
    const entry = entries[0];
    return (
      <div
        data-activity-entry-kind="tool-cluster"
        data-tool-cluster-size="1"
        data-scroll-anchor-id={entry.item.id}
      >
        <div data-activity-entry-kind="tool" data-scroll-anchor-id={entry.item.id}>
          <ToolTimelineNode
            item={entry.item}
            isLast={isLastBucket}
            recovered={recoveredToolIds.has(entry.item.id)}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      data-activity-entry-kind="tool-cluster"
      data-tool-cluster-size={entries.length}
      data-scroll-anchor-id={entries[0].item.id}
      className="mb-0.5"
    >
      <TimelineNode
        icon={<TimelineToolIcon title={clusterLabel} className="size-3 app-text-muted" />}
        isLast={isLastBucket}
      >
        <Collapsible open={clusterOpen} onOpenChange={setClusterOpen}>
          <CollapsibleTrigger
            className="group/cluster flex w-full min-w-0 items-start gap-1.5 rounded-md py-0.5 text-left outline-none hover:app-hover-wash focus-visible:ring-1 focus-visible:ring-ring"
            data-slot="tool-cluster-label"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 app-type-body font-medium text-foreground">
                <span>{clusterLabel}</span>
                <span className="tabular-nums app-text-muted">×{entries.length}</span>
              </div>
              {previews.length > 0 ? (
                <div className="mt-0.5 flex flex-col gap-0.5 app-type-caption app-text-muted">
                  {previews.map((preview) => (
                    <div key={preview} className="truncate">
                      {preview}
                    </div>
                  ))}
                  {entries.length > previews.length ? (
                    <div>+{entries.length - previews.length} more</div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <ChevronRightIcon
              className={cn(
                "mt-0.5 size-3.5 shrink-0 app-text-muted transition-transform duration-150",
                clusterOpen && "rotate-90",
              )}
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="activity-trace-content pt-1.5">
            <div className="ml-0.5 flex flex-col gap-1 border-l app-border-subtle pl-2.5">
              {entries.map((entry) => (
                <div
                  key={entry.item.id}
                  data-activity-entry-kind="tool"
                  data-scroll-anchor-id={entry.item.id}
                >
                  <ToolTimelineNode
                    item={entry.item}
                    isLast
                    recovered={recoveredToolIds.has(entry.item.id)}
                    hideTitle
                    forcePlain
                    embedded
                  />
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </TimelineNode>
    </div>
  );
}

function ActivityTimeline({ summary, live }: { summary: ActivityGroupSummary; live?: boolean }) {
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
    <div className="relative">
      <div
        ref={containerRef}
        data-slot="activity-timeline-viewport"
        className="max-h-[26rem] overflow-y-auto pr-0.5 [overflow-anchor:none]"
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
      {!following ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 gap-1.5 border border-border bg-background shadow-sm"
          aria-label={
            newActivityCount > 0
              ? `${newActivityCount} new ${newActivityCount === 1 ? "update" : "updates"}. Jump to latest`
              : "Jump to latest activity"
          }
          aria-live="polite"
          onClick={jumpToLatest}
        >
          <ArrowDownIcon data-icon="inline-start" />
          {newActivityCount > 0
            ? `${newActivityCount} new ${newActivityCount === 1 ? "update" : "updates"}`
            : "Jump to latest"}
        </Button>
      ) : null}
    </div>
  );
}

function formatActiveAgentsSuffix(labels: readonly string[] | undefined): string {
  if (!labels || labels.length === 0) return "";
  if (labels.length === 1) return ` · ${labels[0]}`;
  if (labels.length <= 3) return ` · ${labels.join(", ")}`;
  return ` · ${labels.length} subagents`;
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

  useEffect(() => {
    if (!live || liveNowMs !== undefined) {
      return;
    }
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [live, liveNowMs]);

  const liveStartedAtMs =
    liveStartedAt !== null && liveStartedAt !== undefined
      ? activityTimestampMs(liveStartedAt)
      : null;

  const currentNowMs = liveNowMs ?? nowMs;
  const liveElapsedLabel =
    live === true
      ? formatActivityElapsedMs(
          currentNowMs - (liveStartedAtMs ?? firstActivityTimestampMs(items) ?? currentNowMs),
        )
      : null;

  const displayElapsedLabel = liveElapsedLabel ?? summaryElapsedLabel;
  const agentsSuffix = formatActiveAgentsSuffix(activeAgentLabels);

  if (hasUnrecoveredIssue) {
    return displayElapsedLabel ? `Couldn't finish after ${displayElapsedLabel}` : "Couldn't finish";
  }

  if (live) {
    const base = displayElapsedLabel ? `Working for ${displayElapsedLabel}` : "Working";
    return `${base}${agentsSuffix}`;
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
  const contentSummary = useMemo(() => formatActivityContentSummary(props.items), [props.items]);
  const displayStatus = props.live && summary.status === "done" ? "running" : summary.status;
  // contentSummary is shown only when the timeline is expanded.
  const isComplete = displayStatus === "done";
  const hasUnrecoveredIssue = displayStatus === "issue";
  // Live issue groups stay expanded so unrecovered tool errors remain visible
  // in the audit trail while the turn is still running.
  const shouldAutoExpand =
    displayStatus === "approval" ||
    displayStatus === "running" ||
    (props.live === true && displayStatus === "issue");
  const [expanded, setExpanded] = useState(shouldAutoExpand);
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
            <Marker asChild variant={props.live ? "border" : "separator"}>
              <CollapsibleTrigger className="group min-w-0 flex-1 pb-2.5 pt-1.5 outline-none before:hidden">
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
                    "app-type-body font-medium tabular-nums transition-colors group-hover:text-foreground group-data-[variant=separator]/marker:text-left",
                    hasUnrecoveredIssue
                      ? "text-destructive/85 group-hover:text-destructive"
                      : props.live
                        ? "app-text-secondary"
                        : "text-muted-foreground",
                  )}
                >
                  <LiveTimerLabel
                    items={props.items}
                    live={props.live}
                    liveNowMs={props.liveNowMs}
                    liveStartedAt={props.liveStartedAt}
                    summaryElapsedLabel={summary.elapsedLabel}
                    hasUnrecoveredIssue={hasUnrecoveredIssue}
                    activeAgentLabels={props.activeAgentLabels}
                  />
                </MarkerContent>
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

          <CollapsibleContent className="activity-trace-content max-w-3xl">
            <div className="border-b app-border-subtle px-1 pb-2.5 pt-3">
              {contentSummary ? (
                <div
                  className="app-type-label mb-2 px-0.5 font-medium uppercase tracking-wide app-text-muted"
                  data-slot="activity-content-summary"
                >
                  {contentSummary}
                </div>
              ) : null}
              <ActivityTimeline summary={summary} live={props.live} />
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
            Cowork could not finish this activity.
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
                  "min-w-0 truncate text-[13.5px] font-normal italic leading-6",
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
            <ActivityTimeline summary={summary} live={props.live} />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
});
