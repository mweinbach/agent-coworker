import type { ResearchDetail } from "../../app/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Button } from "../../components/ui/button";

export function ResearchThoughtPanel({
  thoughtSummaries,
}: {
  thoughtSummaries: ResearchDetail["thoughtSummaries"];
}) {
  if (thoughtSummaries.length === 0) {
    return null;
  }

  return (
    <Collapsible className="rounded-2xl border border-border/65 bg-card/70 px-4 py-4" defaultOpen={false}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">Thinking summary</div>
          <div className="text-xs text-muted-foreground">Captured thought summaries from the running research agent.</div>
        </div>
        <CollapsibleTrigger asChild>
          <Button size="sm" variant="outline" type="button">
            Show thinking
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="mt-4 space-y-3">
          {thoughtSummaries.map((thought) => (
            <div key={thought.id} className="rounded-xl border border-border/60 bg-muted/10 px-3 py-3 text-sm text-foreground">
              {thought.text}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

