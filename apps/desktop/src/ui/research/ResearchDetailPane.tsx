import { useEffect, useState } from "react";

import type { ResearchDetail } from "../../app/types";
import { useAppStore } from "../../app/store";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { formatRelativeAge } from "../../lib/time";
import { ResearchExportMenu } from "./ResearchExportMenu";
import { ResearchFollowUpComposer } from "./ResearchFollowUpComposer";
import { ResearchReportRenderer } from "./ResearchReportRenderer";
import { ResearchSourcesList } from "./ResearchSourcesList";
import { ResearchThoughtPanel } from "./ResearchThoughtPanel";
import { cn } from "../../lib/utils";

function statusClassName(status: ResearchDetail["status"]): string {
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

function statusLabel(status: ResearchDetail["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function useRunningElapsed(startedAtIso: string, running: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running) {
      return;
    }
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const startedMs = new Date(startedAtIso).getTime();
  if (Number.isNaN(startedMs)) {
    return 0;
  }
  return Math.max(0, nowMs - startedMs);
}

export function ResearchDetailPane({ research }: { research: ResearchDetail | null }) {
  const cancelResearch = useAppStore((s) => s.cancelResearch);
  const exportPendingIds = useAppStore((s) => s.researchExportPendingIds);
  const running = research ? research.status === "running" || research.status === "pending" : false;
  const elapsedMs = useRunningElapsed(research?.createdAt ?? new Date().toISOString(), running);

  if (!research) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Select a research card to inspect the report, sources, and follow-ups.
      </div>
    );
  }

  const exportPending = exportPendingIds.includes(research.id);
  const startedAgo = formatRelativeAge(research.createdAt);
  const canExport = research.status === "completed" && research.outputsMarkdown.trim().length > 0;
  const sourceCount = research.sources.length;
  const thoughtCount = research.thoughtSummaries.length;

  const reportBlock = (
    <ResearchReportRenderer markdown={research.outputsMarkdown} status={research.status} />
  );
  const thoughtsBlock = (
    <ResearchThoughtPanel thoughtSummaries={research.thoughtSummaries} status={research.status} />
  );
  const sourcesBlock = <ResearchSourcesList sources={research.sources} />;
  const followUpBlock = research.status === "completed" ? (
    <ResearchFollowUpComposer parentResearchId={research.id} />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border/55 px-6 py-3">
        <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          <Badge className={cn(statusClassName(research.status))}>
            {statusLabel(research.status)}
          </Badge>
          {running ? (
            <>
              <span>
                <span className="tabular-nums text-foreground/80">{formatElapsed(elapsedMs)}</span> elapsed
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <span className="tabular-nums text-foreground/80">{sourceCount}</span>{" "}
                {sourceCount === 1 ? "source" : "sources"}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <span className="tabular-nums text-foreground/80">{thoughtCount}</span>{" "}
                {thoughtCount === 1 ? "note" : "notes"}
              </span>
            </>
          ) : startedAgo ? (
            <span>started {startedAgo} ago</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ResearchExportMenu
            researchId={research.id}
            pending={exportPending}
            disabled={!canExport}
          />
          {running ? (
            <Button size="sm" variant="outline" type="button" onClick={() => void cancelResearch(research.id)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          <section className="rounded-2xl border border-border/55 bg-card/40 px-4 py-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Prompt
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
              {research.prompt}
            </p>
            {research.error ? (
              <div className="mt-2 text-xs text-destructive">{research.error}</div>
            ) : null}
          </section>

          {running ? (
            <>
              {thoughtsBlock}
              {sourcesBlock}
              {reportBlock}
            </>
          ) : (
            <>
              {reportBlock}
              {sourcesBlock}
              {thoughtsBlock}
              {followUpBlock}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
