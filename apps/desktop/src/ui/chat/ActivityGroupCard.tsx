import { memo, useEffect, useMemo, useState } from "react";

import {
  AlertTriangleIcon,
  BrainIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  ShieldAlertIcon,
} from "lucide-react";

import type { ActivityFeedItem, ActivityGroupStatus } from "./activityGroups";

import { MessageResponse } from "../../components/ai-elements/message";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { cn } from "../../lib/utils";

import { summarizeActivityGroup } from "./activityGroups";
import { ToolCard } from "./toolCards/ToolCard";

function ActivityStatusIcon({ status, className }: { status: ActivityGroupStatus; className?: string }) {
  if (status === "approval") {
    return <ShieldAlertIcon className={cn("size-3.5 shrink-0", className)} />;
  }
  if (status === "issue") {
    return <AlertTriangleIcon className={cn("size-3.5 shrink-0", className)} />;
  }
  if (status === "running") {
    return <ClockIcon className={cn("size-3.5 shrink-0", className)} />;
  }
  return <CheckCircleIcon className={cn("size-3.5 shrink-0", className)} />;
}

function reasoningLabel(mode: "reasoning" | "summary"): string {
  return mode === "summary" ? "Reasoning summary" : "Reasoning";
}

const ReasoningTraceRow = memo(function ReasoningTraceRow(props: {
  mode: "reasoning" | "summary";
  text: string;
}) {
  return (
    <div data-activity-entry-kind="reasoning" className="rounded-xl border border-border/50 bg-muted/10 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/30 ring-1 ring-border/40">
          <BrainIcon className="size-3 text-muted-foreground/80" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {reasoningLabel(props.mode)}
          </div>
          <MessageResponse className="mt-1 text-sm leading-6 text-foreground/85">
            {props.text}
          </MessageResponse>
        </div>
      </div>
    </div>
  );
});

export const ActivityGroupCard = memo(function ActivityGroupCard(props: { items: ActivityFeedItem[] }) {
  const summary = useMemo(() => summarizeActivityGroup(props.items), [props.items]);
  const shouldAutoExpand = summary.status === "approval" || summary.status === "issue";
  const [expanded, setExpanded] = useState(shouldAutoExpand);

  useEffect(() => {
    if (shouldAutoExpand) {
      setExpanded(true);
    }
  }, [shouldAutoExpand]);

  return (
    <Card className="max-w-3xl border-border/60 bg-card/60 shadow-sm backdrop-blur-sm">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="group w-full text-left outline-none">
          <CardHeader className="gap-2 px-3.5 py-3 transition-colors hover:bg-muted/10">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/70">
                  <BrainIcon className="size-3.5 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <div className="text-sm font-semibold text-foreground">{summary.title}</div>
                    {summary.reasoningCount > 0 ? (
                      <Badge variant="secondary" className="px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.14em]">
                        {summary.reasoningCount === 1 ? "1 note" : `${summary.reasoningCount} notes`}
                      </Badge>
                    ) : null}
                    {summary.toolCount > 0 ? (
                      <Badge variant="outline" className="px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.14em]">
                        {summary.toolCount === 1 ? "1 tool" : `${summary.toolCount} tools`}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                    {summary.preview}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge
                  variant={summary.status === "issue" ? "destructive" : summary.status === "done" ? "outline" : "secondary"}
                  className="gap-1 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.14em]"
                >
                  <ActivityStatusIcon status={summary.status} />
                  <span>{summary.statusLabel}</span>
                </Badge>
                <ChevronDownIcon className="size-4 text-muted-foreground/50 transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="border-t border-border/50 px-3.5 pb-3 pt-2.5">
            <div className={cn("flex flex-col gap-2", summary.entries.length > 8 && "max-h-[28rem] overflow-y-auto pr-1")}>
              {summary.entries.map((entry) => (
                entry.kind === "reasoning" ? (
                  <ReasoningTraceRow
                    key={entry.item.id}
                    mode={entry.item.mode}
                    text={entry.item.text}
                  />
                ) : (
                  <div key={entry.item.id} data-activity-entry-kind="tool">
                    <ToolCard
                      args={entry.item.args}
                      approval={entry.item.approval}
                      name={entry.item.name}
                      result={entry.item.result}
                      state={entry.item.state}
                      variant="trace"
                    />
                  </div>
                )
              ))}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
});
