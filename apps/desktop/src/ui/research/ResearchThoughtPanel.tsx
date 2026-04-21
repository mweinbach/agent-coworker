import { ChevronRightIcon } from "lucide-react";

import type { ResearchDetail } from "../../app/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { cn } from "../../lib/utils";

export function ResearchThoughtPanel({
  thoughtSummaries,
  status,
}: {
  thoughtSummaries: ResearchDetail["thoughtSummaries"];
  status: ResearchDetail["status"];
}) {
  if (thoughtSummaries.length === 0) {
    return null;
  }

  const running = status === "running" || status === "pending";

  return (
    <Collapsible
      className="group rounded-2xl border border-border/65 bg-card/70"
      defaultOpen={running}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left transition-colors",
          "hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
        aria-label="Toggle research notes"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-foreground">Research notes</div>
            <span className="text-[11px] font-medium text-muted-foreground">
              {thoughtSummaries.length}
            </span>
            {running ? (
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse"
                aria-hidden="true"
              />
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">
            Captured thought summaries from the research agent.
          </div>
        </div>
        <ChevronRightIcon
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 px-4 pb-4">
          {thoughtSummaries.map((thought) => (
            <div
              key={thought.id}
              className="rounded-xl border border-border/60 bg-muted/10 px-3 py-3 text-sm text-foreground"
            >
              {thought.text}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
