import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  GlobeIcon,
  ListTodoIcon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useMemo, useState } from "react";
import type { ToolFeedState } from "../../app/types";
import { MessageResponse } from "../../components/ai-elements/message";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { cn } from "../../lib/utils";
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

function ActivityTimeline({ summary }: { summary: ActivityGroupSummary }) {
  return (
    <div
      className="max-h-[26rem] overflow-y-auto pr-0.5"
      style={{
        maskImage: "linear-gradient(to bottom, black calc(100% - 1.5rem), transparent)",
      }}
    >
      {summary.entries.map((entry, i) => {
        const isLast = i === summary.entries.length - 1;

        if (entry.kind === "reasoning") {
          const reasoningText = entry.item.text.trim();
          return (
            <div key={entry.item.id} data-activity-entry-kind="reasoning">
              <TimelineNode
                icon={<ClockIcon className="size-3 text-muted-foreground/38" />}
                isLast={isLast}
              >
                {reasoningText ? (
                  <MessageResponse
                    normalizeDisplayCitations
                    className="text-[13px] leading-snug text-foreground/82"
                  >
                    {reasoningText}
                  </MessageResponse>
                ) : (
                  <span className="activity-thinking-shimmer inline-flex items-center text-[13px] leading-snug">
                    Thinking
                  </span>
                )}
              </TimelineNode>
            </div>
          );
        }

        const formatting = formatToolCard(
          entry.item.name,
          entry.item.args,
          entry.item.result,
          entry.item.state,
        );

        return (
          <div key={entry.item.id} data-activity-entry-kind="tool">
            <TimelineNode
              icon={
                <TimelineToolIcon
                  title={formatting.title}
                  className="size-3 text-muted-foreground/45"
                />
              }
              isLast={isLast}
            >
              <div className="min-w-0 py-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium text-foreground">
                    {formatting.title}
                  </span>
                  <ToolStateIndicator state={entry.item.state} />
                </div>
                {formatting.subtitle && (
                  <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground/65">
                    {formatting.subtitle}
                  </div>
                )}
              </div>
            </TimelineNode>
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
  const shouldAutoExpand = displayStatus === "approval" || displayStatus === "issue";
  const [expanded, setExpanded] = useState(shouldAutoExpand);

  useEffect(() => {
    if (shouldAutoExpand) setExpanded(true);
  }, [shouldAutoExpand]);

  const showStateBadge = displayStatus === "approval" || displayStatus === "issue";
  const isPendingReasoning = displayStatus === "running" && summary.preview === "Thinking...";
  const useThinkingTreatment =
    isPendingReasoning ||
    (summary.reasoningCount > 0 && summary.toolCount === 0 && !showStateBadge);
  const isComplete = displayStatus === "done";
  const useCompactElapsedHeader = isComplete || (props.live === true && !showStateBadge);

  if (useCompactElapsedHeader) {
    return (
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="group flex w-full max-w-3xl items-center gap-2 border-b border-border/35 px-1 pb-3 pt-1 text-left outline-none transition-colors hover:border-border/55 focus-visible:ring-1 focus-visible:ring-border/45 focus-visible:ring-inset">
          {props.live ? (
            <ClockIcon className="size-4 shrink-0 text-primary/70 animate-pulse" />
          ) : null}
          <span className="text-[15px] font-medium leading-6 text-muted-foreground/90">
            {props.live
              ? displayElapsedLabel
                ? `Working for ${displayElapsedLabel}`
                : "Working"
              : displayElapsedLabel
                ? `Worked for ${displayElapsedLabel}`
                : "Worked"}
          </span>
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/55 transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>

        <CollapsibleContent className="max-w-3xl overflow-hidden">
          <div className="border-b border-border/25 px-1 pb-2.5 pt-3">
            <ActivityTimeline summary={summary} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <Card className="max-w-3xl gap-0 rounded-xl border border-border/32 bg-muted/[0.07] p-0 shadow-none backdrop-blur-none">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
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
                  useThinkingTreatment
                    ? "activity-thinking-shimmer"
                    : "text-muted-foreground",
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
        <CollapsibleContent className="overflow-hidden">
          <CardContent className="border-t border-border/35 px-3 pb-2.5 pt-2">
            <ActivityTimeline summary={summary} />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
});
