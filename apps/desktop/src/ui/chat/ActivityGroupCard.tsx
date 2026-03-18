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
  if (state === "output-available") return <CheckCircleIcon className="size-3 text-emerald-500/70" />;
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
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="mt-1 flex size-5 shrink-0 items-center justify-center">{icon}</div>
        {!isLast && <div className="mt-1.5 w-px flex-1 bg-border/60" />}
      </div>
      <div className="min-w-0 flex-1 pb-4">{children}</div>
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
    <Card className="max-w-3xl border-border/60 bg-card/60 shadow-[0_1px_2px_0_rgb(0_0_0/0.03)] backdrop-blur-sm">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        {/* ── Trigger / header ──────────────────────────────────────────────── */}
        <CollapsibleTrigger className="group w-full text-left outline-none">
          <CardHeader className="flex-row items-center justify-between gap-3 px-3.5 py-2.5 transition-colors hover:bg-muted/10">
            <div className="flex min-w-0 items-center gap-2">
              <ClockIcon className="size-4 shrink-0 text-muted-foreground/50" />
              <span className="text-[13px] text-muted-foreground">{summary.title}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isDone ? (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground/50">
                  <CheckCircleIcon className="size-3 text-emerald-500/60" />
                  Done
                </span>
              ) : (
                <Badge
                  variant={summary.status === "issue" || summary.status === "approval" ? "destructive" : "secondary"}
                  className="gap-1 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.14em]"
                >
                  <ActivityStatusIcon status={summary.status} />
                  <span>{summary.statusLabel}</span>
                </Badge>
              )}
              <ChevronDownIcon className="size-4 text-muted-foreground/40 transition-transform group-data-[state=open]:rotate-180" />
            </div>
          </CardHeader>
          {!expanded && summary.preview && (
            <p className="px-3.5 pb-2.5 text-xs leading-5 text-muted-foreground line-clamp-2">{summary.preview}</p>
          )}
        </CollapsibleTrigger>

        {/* ── Expanded timeline ─────────────────────────────────────────────── */}
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[collapsible-open_200ms_ease-out] data-[state=closed]:animate-[collapsible-close_200ms_ease-out]">
          <CardContent className="border-t border-border/50 px-3.5 pb-3 pt-2.5">
            <div className="max-h-[26rem] overflow-y-auto pr-1" style={{ maskImage: "linear-gradient(to bottom, black calc(100% - 1.5rem), transparent)" }}>
              {summary.entries.map((entry, i) => {
                const isLast = i === summary.entries.length - 1;

                if (entry.kind === "reasoning") {
                  return (
                    <div key={entry.item.id} data-activity-entry-kind="reasoning">
                      <TimelineNode icon={<ClockIcon className="size-3.5 text-muted-foreground/40" />} isLast={isLast}>
                        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                          {entry.item.mode === "summary" ? "Summary" : "Reasoning"}
                        </div>
                        <MessageResponse normalizeDisplayCitations className="mt-1 text-sm leading-relaxed text-foreground/80">
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
                      icon={<TimelineToolIcon title={formatting.title} className="size-3.5 text-muted-foreground/50" />}
                      isLast={isLast}
                    >
                      <div className="rounded-lg border border-border/40 bg-muted/5 px-2.5 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{formatting.title}</span>
                          <ToolStateIndicator state={entry.item.state} />
                        </div>
                        {formatting.subtitle && (
                          <div className="mt-0.5 text-xs leading-5 text-muted-foreground/60">{formatting.subtitle}</div>
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
