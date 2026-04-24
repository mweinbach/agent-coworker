import { useEffect, useMemo } from "react";
import { PlusIcon } from "lucide-react";

import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";
import type { ResearchCard } from "../app/types";
import { NewResearchComposer } from "./research/NewResearchComposer";
import { ResearchCardGrid } from "./research/ResearchCardGrid";
import { ResearchDetailPane } from "./research/ResearchDetailPane";

export function ResearchView() {
  const researchById = useAppStore((s) => s.researchById);
  const researchOrder = useAppStore((s) => s.researchOrder);
  const selectedResearchId = useAppStore((s) => s.selectedResearchId);
  const researchListLoading = useAppStore((s) => s.researchListLoading);
  const researchListError = useAppStore((s) => s.researchListError);
  const refreshResearchList = useAppStore((s) => s.refreshResearchList);
  const selectResearch = useAppStore((s) => s.selectResearch);

  const research = useMemo(
    () => researchOrder
      .map((researchId) => researchById[researchId])
      .filter((entry): entry is ResearchCard => Boolean(entry)),
    [researchById, researchOrder],
  );
  const selectedResearch = selectedResearchId ? researchById[selectedResearchId] ?? null : null;

  useEffect(() => {
    if (researchOrder.length > 0 || researchListLoading) {
      return;
    }
    void refreshResearchList();
  }, [refreshResearchList, researchListLoading, researchOrder.length]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-row">
      <section className="flex min-h-0 min-w-[18rem] w-[clamp(18rem,26vw,23.75rem)] shrink-0 flex-col border-r border-border/40 bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--muted)/0.16)_100%)]">
        <div className="border-b border-border/35 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                Research
              </div>
              <div className="mt-0.5 text-[13px] text-muted-foreground">
                Select a run or follow-up
              </div>
            </div>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              className="h-8 gap-1.5 rounded-md border-border/60 bg-background/70 px-3 text-xs"
              onClick={() => selectResearch(null)}
              disabled={selectedResearchId === null}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              New
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {researchListError ? (
            <div className="rounded-xl border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {researchListError}
            </div>
          ) : null}
          {research.length > 0 ? (
            <ResearchCardGrid
              research={research}
              selectedResearchId={selectedResearchId}
              onSelectResearch={(researchId) => void selectResearch(researchId)}
            />
          ) : null}
        </div>
      </section>

      <section className="min-h-0 min-w-0 flex-1">
        {selectedResearch ? (
          <ResearchDetailPane research={selectedResearch} />
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <NewResearchComposer />
          </div>
        )}
      </section>
    </div>
  );
}
