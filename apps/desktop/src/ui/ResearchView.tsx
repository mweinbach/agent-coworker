import { HistoryIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "../app/store";
import type { ResearchCard } from "../app/types";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { useElementWidth } from "../lib/useElementWidth";
import { cn } from "../lib/utils";
import { NewResearchComposer } from "./research/NewResearchComposer";
import { ResearchCardGrid } from "./research/ResearchCardGrid";
import { ResearchDetailPane } from "./research/ResearchDetailPane";

const RESEARCH_SPLIT_MIN_WIDTH = 808;

export function ResearchView() {
  const researchById = useAppStore((s) => s.researchById);
  const researchOrder = useAppStore((s) => s.researchOrder);
  const selectedResearchId = useAppStore((s) => s.selectedResearchId);
  const researchListError = useAppStore((s) => s.researchListError);
  const researchListLoading = useAppStore((s) => s.researchListLoading);
  const refreshResearchList = useAppStore((s) => s.refreshResearchList);
  const selectResearch = useAppStore((s) => s.selectResearch);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const viewWidth = useElementWidth(viewRef);
  const [compactHistoryOpen, setCompactHistoryOpen] = useState(false);

  const research = useMemo(
    () =>
      researchOrder
        .map((researchId) => researchById[researchId])
        .filter((entry): entry is ResearchCard => Boolean(entry)),
    [researchById, researchOrder],
  );
  const selectedResearch = selectedResearchId ? (researchById[selectedResearchId] ?? null) : null;
  const compact = viewWidth > 0 && viewWidth < RESEARCH_SPLIT_MIN_WIDTH;

  useEffect(() => {
    void refreshResearchList();
  }, [refreshResearchList]);

  return (
    <div
      ref={viewRef}
      className="flex h-full min-h-0 min-w-0 flex-row"
      data-research-layout={compact ? "compact" : "split"}
    >
      <section
        aria-hidden={compact && !compactHistoryOpen ? "true" : undefined}
        className={cn(
          "min-h-0 flex-col bg-background",
          compact
            ? compactHistoryOpen
              ? "flex w-full min-w-0"
              : "hidden"
            : "flex w-[clamp(18rem,26vw,23.75rem)] min-w-[18rem] shrink-0 border-r border-border/40",
        )}
        inert={compact && !compactHistoryOpen ? true : undefined}
      >
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
              onClick={() => {
                setCompactHistoryOpen(false);
                selectResearch(null);
              }}
              disabled={selectedResearchId === null}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              New
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {researchListError ? (
            <div className="mb-2 rounded-xl border border-destructive/35 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {researchListError}
            </div>
          ) : null}
          {researchListLoading && research.length === 0 ? (
            <div
              role="status"
              className="flex flex-col gap-2 px-1 py-1"
              aria-busy="true"
              aria-label="Loading research"
            >
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
            </div>
          ) : research.length > 0 ? (
            <ResearchCardGrid
              research={research}
              selectedResearchId={selectedResearchId}
              onSelectResearch={(researchId) => {
                setCompactHistoryOpen(false);
                void selectResearch(researchId);
              }}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-10 text-center">
              <p className="text-sm font-semibold text-foreground">Start your first research</p>
              <p className="mx-auto mt-2 max-w-[16rem] text-xs leading-5 text-muted-foreground">
                Investigate a market, compare vendors, or draft a cited brief. Use the composer on
                the right — completed runs will show up here.
              </p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-4 h-8 gap-1.5 rounded-md px-3 text-xs"
                onClick={() => {
                  setCompactHistoryOpen(false);
                  selectResearch(null);
                }}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                New research
              </Button>
            </div>
          )}
        </div>
      </section>

      <section
        aria-hidden={compact && compactHistoryOpen ? "true" : undefined}
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          compact && compactHistoryOpen ? "hidden" : "flex",
        )}
        inert={compact && compactHistoryOpen ? true : undefined}
      >
        {compact ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-background px-3 py-2">
            <Button
              aria-label="Open research history"
              className="gap-1.5"
              onClick={() => setCompactHistoryOpen(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <HistoryIcon data-icon="inline-start" />
              History
            </Button>
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {selectedResearch?.title ?? "New research"}
            </span>
          </div>
        ) : null}
        {selectedResearch ? (
          <ResearchDetailPane key={selectedResearch.id} research={selectedResearch} />
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <NewResearchComposer />
          </div>
        )}
      </section>
    </div>
  );
}
