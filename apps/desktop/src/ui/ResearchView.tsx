import { useEffect, useMemo, useState } from "react";
import { PlusIcon, RefreshCwIcon } from "lucide-react";

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
  const [composerOpen, setComposerOpen] = useState(false);

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border/55 px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-[1.1rem] font-semibold tracking-tight text-foreground">Research</h2>
          <p className="text-sm text-muted-foreground">
            Long-running cited reports, streamed separately from chat threads.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            type="button"
            variant="outline"
            className="gap-2"
            onClick={() => void refreshResearchList()}
          >
            <RefreshCwIcon className="h-4 w-4" />
            Refresh
          </Button>
          <Button
            size="sm"
            type="button"
            className="gap-2"
            onClick={() => setComposerOpen((open) => !open)}
          >
            <PlusIcon className="h-4 w-4" />
            New Research
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 w-[380px] shrink-0 flex-col border-r border-border/55 bg-muted/10">
          {composerOpen || research.length === 0 ? (
            <NewResearchComposer onSubmitted={() => setComposerOpen(false)} />
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {researchListError ? (
              <div className="rounded-xl border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {researchListError}
              </div>
            ) : null}
            {research.length === 0 && !researchListLoading && !researchListError ? (
              <div className="rounded-2xl border border-border/60 bg-card/70 px-4 py-5 text-center text-sm text-muted-foreground">
                Start a research run to build a cited report here.
              </div>
            ) : (
              <ResearchCardGrid
                research={research}
                selectedResearchId={selectedResearchId}
                onSelectResearch={(researchId) => void selectResearch(researchId)}
              />
            )}
          </div>
        </section>

        <section className="min-h-0 flex-1">
          <ResearchDetailPane research={selectedResearch} />
        </section>
      </div>
    </div>
  );
}

