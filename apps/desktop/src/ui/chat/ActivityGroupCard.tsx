import {
  AlertTriangleIcon,
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
import type { ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  formatActivityElapsedMs,
  summarizeActivityGroup,
} from "./activityGroups";
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
        className="gap-1 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide animate-pulse"
      >
        <ShieldAlertIcon className="size-2.5" />
        Review
      </Badge>
    );
  }
  return (
    <ClockIcon
      className={cn("size-3 text-primary", state === "input-streaming" && "animate-pulse")}
    />
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
        {!isLast && <div className="mt-1 w-px flex-1 bg-border/45" />}
      </div>
      <div className="min-w-0 flex-1 pb-3">{children}</div>
    </div>
  );
}

type ReasoningSection = {
  title: string;
  body: string;
};

function parseReasoningSections(text: string): ReasoningSection[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
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

  if (matches.length === 0) {
    return [{ title: "", body: normalized }];
  }

  const sections: ReasoningSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const currentMatch = matches[i];
    const nextMatch = matches[i + 1];

    const contentStart = currentMatch.index + currentMatch.length;
    const contentEnd = nextMatch ? nextMatch.index : normalized.length;
    const body = normalized.slice(contentStart, contentEnd).trim();

    sections.push({
      title: currentMatch.title,
      body,
    });
  }

  if (matches[0].index > 0) {
    const leadingBody = normalized.slice(0, matches[0].index).trim();
    if (leadingBody) {
      sections.unshift({ title: "", body: leadingBody });
    }
  }

  return sections;
}

function ReasoningSectionNode({
  title,
  body,
  isMostRecent,
}: {
  title: string;
  body: string;
  isMostRecent: boolean;
}) {
  const [open, setOpen] = useState(isMostRecent);

  useEffect(() => {
    setOpen(isMostRecent);
  }, [isMostRecent]);

  if (!title) {
    return (
      <DesktopMarkdown
        normalizeDisplayCitations
        className="text-[13px] leading-snug text-foreground/82"
      >
        {body}
      </DesktopMarkdown>
    );
  }

  return (
    <div className="min-w-0 py-1 border-b border-border/12 last:border-b-0 pb-3 last:pb-0 mb-2.5 last:mb-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-left text-[13px] font-medium text-foreground outline-none hover:text-foreground/80"
      >
        <span>{title}</span>
        <ChevronRightIcon
          className={cn(
            "size-3.5 text-muted-foreground/50 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
      </button>
      {open && body && (
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground/80 pl-0.5 select-text">
          <DesktopMarkdown normalizeDisplayCitations className="prose-sm leading-relaxed">
            {body}
          </DesktopMarkdown>
        </div>
      )}
    </div>
  );
}

function ReasoningTimelineNode({
  text,
  isLast,
  live,
  isMostRecent,
}: {
  text: string;
  isLast: boolean;
  live?: boolean;
  isMostRecent: boolean;
}) {
  const reasoningText = text.trim();

  if (!reasoningText) {
    return (
      <TimelineNode
        icon={<ClockIcon className="size-3 text-muted-foreground/38" />}
        isLast={isLast}
      >
        <span className="activity-thinking-shimmer inline-flex items-center text-[13px] leading-snug">
          Thinking
        </span>
      </TimelineNode>
    );
  }

  const sections = useMemo(() => parseReasoningSections(reasoningText), [reasoningText]);

  return (
    <TimelineNode icon={<ClockIcon className="size-3 text-muted-foreground/38" />} isLast={isLast}>
      <div className="flex flex-col gap-1.5 min-w-0">
        {sections.map((section, idx) => {
          const isSectionMostRecent = live ? isMostRecent && idx === sections.length - 1 : true;
          return (
            <ReasoningSectionNode
              key={`${section.title || "reasoning"}-${section.body.slice(0, 32)}`}
              title={section.title}
              body={section.body}
              isMostRecent={isSectionMostRecent}
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

function ToolTimelineNode({
  item,
  isLast,
}: {
  item: Extract<ActivityFeedItem, { kind: "tool" }>;
  isLast: boolean;
}) {
  const formatting = useMemo(
    () => formatToolCard(item.name, item.args, item.result, item.state),
    [item.args, item.name, item.result, item.state],
  );
  const detailRows = useMemo(
    () => formatting.details.filter((row) => row.label !== "Status"),
    [formatting.details],
  );
  const argsText = useMemo(() => toPrettyJson(item.args), [item.args]);
  const resultText = useMemo(() => toPrettyJson(item.result), [item.result]);
  const hasDetails = detailRows.length > 0 || Boolean(argsText || resultText || item.approval);
  const shouldAutoExpand =
    item.state === "approval-requested" ||
    item.state === "output-error" ||
    item.state === "output-denied";
  const [open, setOpen] = useState(shouldAutoExpand && hasDetails);

  useEffect(() => {
    if (shouldAutoExpand && hasDetails) {
      setOpen(true);
    }
  }, [hasDetails, shouldAutoExpand]);

  return (
    <TimelineNode
      icon={
        <TimelineToolIcon title={formatting.title} className="size-3 text-muted-foreground/45" />
      }
      isLast={isLast}
    >
      {hasDetails ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group/tool-row flex w-full min-w-0 items-start gap-1.5 rounded-md py-0.5 text-left outline-none hover:bg-muted/20 focus-visible:ring-1 focus-visible:ring-ring/40">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-medium text-foreground">{formatting.title}</span>
                <ToolStateIndicator state={item.state} />
              </div>
              {formatting.subtitle ? (
                <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground/65">
                  {formatting.subtitle}
                </div>
              ) : null}
            </div>
            <ChevronRightIcon
              className={cn(
                "mt-0.5 size-3.5 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-hover/tool-row:text-muted-foreground",
                open && "rotate-90",
              )}
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            {detailRows.length > 0 ? (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {detailRows.map((row) => (
                  <div
                    key={`${item.id}-${row.label}`}
                    className="rounded-md border border-border/45 bg-muted/15 px-2 py-1.5"
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {row.label}
                    </div>
                    <div className="mt-0.5 break-words text-[11px] leading-snug text-foreground/85">
                      {row.value}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {argsText ? (
              <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border/40 bg-background/50 p-2 text-[11px] leading-relaxed text-foreground/80">
                {argsText}
              </pre>
            ) : null}
            {resultText ? (
              <pre
                className={cn(
                  "mt-1.5 max-h-48 overflow-auto rounded-md border p-2 text-[11px] leading-relaxed",
                  item.state === "output-error" || item.state === "output-denied"
                    ? "border-destructive/30 bg-destructive/5 text-destructive"
                    : "border-border/40 bg-background/50 text-foreground/80",
                )}
              >
                {resultText}
              </pre>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="min-w-0 py-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-foreground">{formatting.title}</span>
            <ToolStateIndicator state={item.state} />
          </div>
          {formatting.subtitle ? (
            <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground/65">
              {formatting.subtitle}
            </div>
          ) : null}
        </div>
      )}
    </TimelineNode>
  );
}

function ActivityTimeline({ summary, live }: { summary: ActivityGroupSummary; live?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onScroll = () => {
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
      stickToBottomRef.current = distanceFromBottom < 48;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!live || !containerRef.current || !summary) return;
    if (!stickToBottomRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [live, summary]);

  const lastReasoningEntryId = useMemo(() => {
    const reasoningEntries = summary.entries.filter((e) => e.kind === "reasoning");
    if (reasoningEntries.length === 0) return null;
    return reasoningEntries[reasoningEntries.length - 1].item.id;
  }, [summary.entries]);

  return (
    <div ref={containerRef} className="max-h-[26rem] overflow-y-auto pr-0.5">
      {summary.entries.map((entry, i) => {
        const isLast = i === summary.entries.length - 1;

        if (entry.kind === "reasoning") {
          const isMostRecent = entry.item.id === lastReasoningEntryId;
          return (
            <div key={entry.item.id} data-activity-entry-kind="reasoning">
              <ReasoningTimelineNode
                text={entry.item.text}
                isLast={isLast}
                live={live}
                isMostRecent={isMostRecent}
              />
            </div>
          );
        }

        return (
          <div key={entry.item.id} data-activity-entry-kind="tool">
            <ToolTimelineNode item={entry.item} isLast={isLast} />
          </div>
        );
      })}
    </div>
  );
}

/* ── Main card ──────────────────────────────────────────────────────────────── */

export const ActivityGroupCard = memo(function ActivityGroupCard(props: {
  items: ActivityFeedItem[];
  live?: boolean;
  liveNowMs?: number;
  liveStartedAt?: string | null;
  onRetry?: () => Promise<boolean>;
  retryDisabled?: boolean;
}) {
  const liveNowMsProp = props.liveNowMs;
  const [nowMs, setNowMs] = useState(() => liveNowMsProp ?? Date.now());

  useEffect(() => {
    if (!props.live || liveNowMsProp !== undefined) {
      return;
    }
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [props.live, liveNowMsProp]);

  const summary = useMemo(() => summarizeActivityGroup(props.items), [props.items]);
  const displayStatus = props.live && summary.status === "done" ? "running" : summary.status;
  const isComplete = displayStatus === "done";
  const hasUnrecoveredIssue = displayStatus === "issue";
  const liveStartedAtMs =
    props.liveStartedAt !== null && props.liveStartedAt !== undefined
      ? activityTimestampMs(props.liveStartedAt)
      : null;
  const liveElapsedLabel =
    props.live === true
      ? formatActivityElapsedMs(
          nowMs - (liveStartedAtMs ?? firstActivityTimestampMs(props.items) ?? nowMs),
        )
      : null;
  const displayElapsedLabel = liveElapsedLabel ?? summary.elapsedLabel;
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
    if (shouldAutoExpand) {
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
  const useCompactElapsedHeader =
    isComplete || hasUnrecoveredIssue || props.live === true;

  if (useCompactElapsedHeader) {
    return (
      <Collapsible open={expanded} onOpenChange={handleOpenChange}>
        <div className="flex w-full max-w-3xl items-center gap-1.5">
          <Marker asChild variant={props.live ? "border" : "separator"}>
            <CollapsibleTrigger className="group min-w-0 flex-1 pb-2.5 pt-1.5 outline-none before:hidden">
              {hasUnrecoveredIssue ? (
                <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive/75" />
              ) : null}
              <MarkerContent
                className={cn(
                  "font-mono tracking-tight transition-colors group-hover:text-foreground group-data-[variant=separator]/marker:text-left",
                  hasUnrecoveredIssue && "text-destructive/85 group-hover:text-destructive",
                )}
              >
                <span role={props.live ? "status" : undefined}>
                  {hasUnrecoveredIssue
                    ? displayElapsedLabel
                      ? `Couldn't finish after ${displayElapsedLabel}`
                      : "Couldn't finish"
                    : props.live
                      ? displayElapsedLabel
                        ? `Working for ${displayElapsedLabel}`
                        : "Working"
                      : displayElapsedLabel
                        ? `Worked for ${displayElapsedLabel}`
                        : "Worked"}
                </span>
              </MarkerContent>
              <ChevronRightIcon
                className={cn(
                  "size-3.5 shrink-0 transition-all duration-200 group-hover:opacity-100 group-data-[state=open]:rotate-90",
                  hasUnrecoveredIssue ? "text-destructive/60 opacity-60" : "opacity-0",
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
          ) : null}
        </div>

        <CollapsibleContent className="activity-trace-content max-w-3xl">
          <div className="border-b border-border/25 px-1 pb-2.5 pt-3">
            <ActivityTimeline summary={summary} live={props.live} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <Card className="max-w-3xl gap-0 rounded-xl border border-border/32 bg-muted/[0.07] p-0 shadow-none backdrop-blur-none">
      <Collapsible open={expanded} onOpenChange={handleOpenChange}>
        {/* ── Trigger / header ──────────────────────────────────────────────── */}
        <CollapsibleTrigger className="group flex w-full flex-col gap-0 rounded-xl text-left outline-none focus-visible:ring-1 focus-visible:ring-border/45 focus-visible:ring-inset focus-visible:shadow-none">
          <CardHeader className="flex items-center justify-between gap-2 px-2.5 pt-1.5 pb-1 transition-colors hover:bg-muted/[0.06]">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <ClockIcon
                className={cn(
                  "size-4 shrink-0 text-muted-foreground/45",
                  useThinkingTreatment && "text-primary/70 animate-pulse",
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
                  className="gap-1 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.1em]"
                >
                  {summary.status === "approval" ? (
                    <ShieldAlertIcon className="size-3.5 shrink-0" />
                  ) : (
                    <AlertTriangleIcon className="size-3.5 shrink-0" />
                  )}
                  <span>{summary.statusLabel}</span>
                </Badge>
              ) : null}
              <ChevronDownIcon className="size-3.5 text-muted-foreground/35 transition-transform group-data-[state=open]:rotate-180" />
            </div>
          </CardHeader>
          {!expanded && summary.preview && !isPendingReasoning && showStateBadge && (
            <p className="px-2.5 pb-1.5 pt-0 text-[11px] leading-snug text-muted-foreground/85 line-clamp-2">
              {summary.preview}
            </p>
          )}
        </CollapsibleTrigger>

        {/* ── Expanded timeline ─────────────────────────────────────────────── */}
        <CollapsibleContent className="activity-trace-content">
          <CardContent className="border-t border-border/35 px-3 pb-2.5 pt-2">
            <ActivityTimeline summary={summary} live={props.live} />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
});
