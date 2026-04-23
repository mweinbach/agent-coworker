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
      <section className="flex min-h-0 min-w-[18rem] w-[clamp(18rem,26vw,23.75rem)] shrink-0 flex-col border-r border-border/40 bg-muted/[0.06]">
        <div className="flex items-center justify-between gap-2 px-4 pt-2 pb-3">
          <div className="text-[15px] font-semibold tracking-tight text-foreground">
            Research
          </div>
          <Button
            size="sm"
            type="button"
            className="h-7 gap-1.5 rounded-full px-3 text-xs"
            onClick={() => selectResearch(null)}
            disabled={selectedResearchId === null}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            New
          </Button>
        </div>
        <div className="border-b border-border/30" />
        <div className="px-4 pt-3 pb-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
            History
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
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
