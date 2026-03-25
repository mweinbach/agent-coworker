import { memo, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  GlobeIcon,
  ListTodoIcon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";

import type { ActivityFeedItem, ActivityGroupStatus } from "./activityGroups";
import type { ToolFeedState } from "../../app/types";

import { MessageResponse } from "../../components/ai-elements/message";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { cn } from "../../lib/utils";

import { summarizeActivityGroup } from "./activityGroups";
import { formatToolCard } from "./toolCards/toolCardFormatting";

/* ── Small helpers ──────────────────────────────────────────────────────────── */

function ActivityStatusIcon({ status, className }: { status: ActivityGroupStatus; className?: string }) {
  if (status === "approval") return <ShieldAlertIcon className={cn("size-3.5 shrink-0", className)} />;
  if (status === "issue") return <AlertTriangleIcon className={cn("size-3.5 shrink-0", className)} />;
  if (status === "running") return <ClockIcon className={cn("size-3.5 shrink-0", className)} />;
  return <CheckCircleIcon className={cn("size-3.5 shrink-0", className)} />;
}

function TimelineToolIcon({ title, className }: { title: string; className?: string }) {
  const t = title.toLowerCase();
  if (t.includes("todo") || t.includes("task")) return <ListTodoIcon className={className} />;
  if (t.includes("search") || t.includes("grep") || t.includes("glob")) return <SearchIcon className={className} />;
  if (t.includes("fetch") || t.includes("web") || t.includes("browser")) return <GlobeIcon className={className} />;
  if (t.includes("bash") || t.includes("shell") || t.includes("run")) return <TerminalIcon className={className} />;
  return <WrenchIcon className={className} />;
}

function ToolStateIndicator({ state }: { state: ToolFeedState }) {
  if (state === "output-available") return <CheckCircleIcon className="size-3 text-success/70" />;
  if (state === "output-error" || state === "output-denied") {
    return <XCircleIcon className="size-3 text-destructive" />;
  }
  if (state === "approval-requested") {
    return (
      <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide animate-pulse">
        <ShieldAlertIcon className="size-2.5" />
        Review
      </Badge>
    );
  }
  return <ClockIcon className={cn("size-3 text-primary", state === "input-streaming" && "animate-pulse")} />;
}

/* ── Timeline building block ────────────────────────────────────────────────── */

function TimelineNode({ icon, isLast, children }: { icon: ReactNode; isLast: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <div className="flex flex-col items-center">
        <div className="mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center">{icon}</div>
        {!isLast && <div className="mt-1 w-px flex-1 bg-border/45" />}
      </div>
      <div className="min-w-0 flex-1 pb-3">{children}</div>
    </div>
  );
}

/* ── Main card ──────────────────────────────────────────────────────────────── */

export const ActivityGroupCard = memo(function ActivityGroupCard(props: { items: ActivityFeedItem[] }) {
  const summary = useMemo(() => summarizeActivityGroup(props.items), [props.items]);
  const shouldAutoExpand = summary.status === "approval" || summary.status === "issue";
  const [expanded, setExpanded] = useState(shouldAutoExpand);

  useEffect(() => {
    if (shouldAutoExpand) setExpanded(true);
  }, [shouldAutoExpand]);

  const isDone = summary.status === "done" && summary.toolCount > 0;

  return (
    <Card className="max-w-3xl gap-0 rounded-xl border border-border/32 bg-muted/[0.07] p-0 shadow-none backdrop-blur-none">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        {/* ── Trigger / header ──────────────────────────────────────────────── */}
        <CollapsibleTrigger className="group flex w-full flex-col gap-0 text-left outline-none">
          <CardHeader className="flex-row items-center justify-between gap-2 px-2.5 pt-1.5 pb-1 transition-colors hover:bg-muted/[0.06]">
            <div className="flex min-w-0 items-center gap-1.5">
              <ClockIcon className="size-3.5 shrink-0 text-muted-foreground/45" />
              <span className="text-[12px] font-medium text-muted-foreground">{summary.title}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {isDone ? (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground/55">
                  <CheckCircleIcon className="size-3 text-success/55" />
                  Done
                </span>
              ) : (
                <Badge
                  variant={summary.status === "issue" || summary.status === "approval" ? "destructive" : "secondary"}
                  className="gap-1 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.1em]"
                >
                  <ActivityStatusIcon status={summary.status} />
                  <span>{summary.statusLabel}</span>
                </Badge>
              )}
              <ChevronDownIcon className="size-3.5 text-muted-foreground/35 transition-transform group-data-[state=open]:rotate-180" />
            </div>
          </CardHeader>
          {!expanded && summary.preview && (
            <p className="px-2.5 pb-1.5 pt-0 text-[11px] leading-snug text-muted-foreground/85 line-clamp-2">{summary.preview}</p>
          )}
        </CollapsibleTrigger>

        {/* ── Expanded timeline ─────────────────────────────────────────────── */}
        <CollapsibleContent className="overflow-hidden">
          <CardContent className="border-t border-border/35 px-3 pb-2.5 pt-2">
            <div className="max-h-[26rem] overflow-y-auto pr-0.5" style={{ maskImage: "linear-gradient(to bottom, black calc(100% - 1.5rem), transparent)" }}>
              {summary.entries.map((entry, i) => {
                const isLast = i === summary.entries.length - 1;

                if (entry.kind === "reasoning") {
                  return (
                    <div key={entry.item.id} data-activity-entry-kind="reasoning">
                      <TimelineNode icon={<ClockIcon className="size-3 text-muted-foreground/38" />} isLast={isLast}>
                        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/58">
                          {entry.item.mode === "summary" ? "Summary" : "Reasoning"}
                        </div>
                        <MessageResponse normalizeDisplayCitations className="mt-1 text-[13px] leading-snug text-foreground/82">
                          {entry.item.text}
                        </MessageResponse>
                      </TimelineNode>
                    </div>
                  );
                }

                const formatting = formatToolCard(entry.item.name, entry.item.args, entry.item.result, entry.item.state);

                return (
                  <div key={entry.item.id} data-activity-entry-kind="tool">
                    <TimelineNode
                      icon={<TimelineToolIcon title={formatting.title} className="size-3 text-muted-foreground/45" />}
                      isLast={isLast}
                    >
                      <div className="min-w-0 py-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-medium text-foreground">{formatting.title}</span>
                          <ToolStateIndicator state={entry.item.state} />
                        </div>
                        {formatting.subtitle && (
                          <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground/65">{formatting.subtitle}</div>
                        )}
                      </div>
                    </TimelineNode>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
});
