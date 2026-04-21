import { ChevronRightIcon, CornerDownRightIcon } from "lucide-react";

import type { ResearchCard } from "../../app/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { formatRelativeAge } from "../../lib/time";
import { cn } from "../../lib/utils";

function statusDotClassName(status: ResearchCard["status"]): string {
  switch (status) {
    case "completed":
      return "bg-success";
    case "running":
    case "pending":
      return "bg-primary";
    case "cancelled":
      return "bg-warning";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/60";
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
    const running = research.status === "running" || research.status === "pending";
    const isChild = depth > 0;
    const timeLabel = formatRelativeAge(research.updatedAt);
    const isSelected = selectedResearchId === research.id;

    return (
      <div key={research.id} className="space-y-1">
        <Collapsible className="space-y-1" defaultOpen={descendantSelected || depth < 1}>
          <div className={cn("flex items-start gap-1", isChild && "pl-3")}>
            {children.length > 0 ? (
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={descendantSelected ? "Collapse follow-ups" : "Expand follow-ups"}
                >
                  <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
                </button>
              </CollapsibleTrigger>
            ) : (
              <div className="mt-1.5 h-5 w-5 shrink-0" />
            )}
            <button
              type="button"
              className={cn(
                "group flex w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                isChild && "border-l border-border/55",
                isSelected
                  ? "bg-primary/10 text-foreground"
                  : "hover:bg-foreground/[0.035]",
              )}
              onClick={() => onSelectResearch(research.id)}
            >
              {isChild ? (
                <CornerDownRightIcon
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
                  aria-hidden="true"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                  {research.title || research.prompt || "Untitled research"}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className={cn(
                      "inline-block h-1.5 w-1.5 rounded-full",
                      statusDotClassName(research.status),
                      running && "animate-pulse",
                    )}
                    aria-label={`Status: ${research.status}`}
                  />
                  {running ? (
                    <span className="capitalize">{research.status}</span>
                  ) : timeLabel ? (
                    <span>{timeLabel}</span>
                  ) : null}
                </div>
              </div>
            </button>
          </div>
          {children.length > 0 ? (
            <CollapsibleContent>
              <div className={cn("space-y-1", isChild ? "ml-5" : "ml-5")}>
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
    <div className="space-y-1">
      {renderResearchTree(null, childrenByParent, selectedResearchId, onSelectResearch)}
    </div>
  );
}
