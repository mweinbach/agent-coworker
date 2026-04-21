import { ChevronRightIcon } from "lucide-react";

import type { ResearchCard } from "../../app/types";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { cn } from "../../lib/utils";

function statusLabel(status: ResearchCard["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusClassName(status: ResearchCard["status"]): string {
  switch (status) {
    case "completed":
      return "border-success/25 bg-success/10 text-success";
    case "running":
    case "pending":
      return "border-primary/25 bg-primary/10 text-primary";
    case "cancelled":
      return "border-warning/25 bg-warning/10 text-warning";
    case "failed":
      return "border-destructive/25 bg-destructive/10 text-destructive";
    default:
      return "";
  }
}

function renderResearchTree(
  parentId: string | null,
  childrenByParent: Map<string | null, ResearchCard[]>,
  selectedResearchId: string | null,
  onSelectResearch: (researchId: string) => void,
  depth = 0,
) {
  return (childrenByParent.get(parentId) ?? []).map((research) => {
    const children = childrenByParent.get(research.id) ?? [];
    const descendantSelected = selectedResearchId === research.id
      || children.some((child) => child.id === selectedResearchId || child.parentResearchId === selectedResearchId);

    return (
      <div key={research.id} className={cn("space-y-2", depth > 0 && "pl-4")}>
        <Collapsible className="space-y-2" defaultOpen={descendantSelected || depth < 1}>
          <div className="flex items-start gap-2">
            {children.length > 0 ? (
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={descendantSelected ? "Collapse follow-ups" : "Expand follow-ups"}
                >
                  <ChevronRightIcon className="h-4 w-4 data-[expanded=true]:rotate-90" />
                </button>
              </CollapsibleTrigger>
            ) : (
              <div className="mt-2 h-6 w-6 shrink-0" />
            )}
            <button
              type="button"
              className={cn(
                "w-full rounded-2xl border px-4 py-3 text-left transition-colors",
                selectedResearchId === research.id
                  ? "border-primary/45 bg-primary/10"
                  : "border-border/65 bg-card/75 hover:border-border hover:bg-card",
              )}
              onClick={() => onSelectResearch(research.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">{research.title}</div>
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{research.prompt}</div>
                </div>
                <Badge className={cn("shrink-0", statusClassName(research.status))}>
                  {statusLabel(research.status)}
                </Badge>
              </div>
            </button>
          </div>
          {children.length > 0 ? (
            <CollapsibleContent>
              <div className="space-y-2 border-l border-border/55 ml-3">
                {renderResearchTree(research.id, childrenByParent, selectedResearchId, onSelectResearch, depth + 1)}
              </div>
            </CollapsibleContent>
          ) : null}
        </Collapsible>
      </div>
    );
  });
}

export function ResearchCardGrid({
  research,
  selectedResearchId,
  onSelectResearch,
}: {
  research: ResearchCard[];
  selectedResearchId: string | null;
  onSelectResearch: (researchId: string) => void;
}) {
  const childrenByParent = new Map<string | null, ResearchCard[]>();
  for (const entry of research) {
    const key = entry.parentResearchId ?? null;
    const current = childrenByParent.get(key) ?? [];
    current.push(entry);
    childrenByParent.set(key, current);
  }
  for (const [key, entries] of childrenByParent) {
    childrenByParent.set(
      key,
      [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  }

  return (
    <div className="space-y-3">
      {renderResearchTree(null, childrenByParent, selectedResearchId, onSelectResearch)}
    </div>
  );
}
