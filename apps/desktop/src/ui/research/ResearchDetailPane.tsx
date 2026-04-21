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

export function ResearchDetailPane({ research }: { research: ResearchDetail | null }) {
  const cancelResearch = useAppStore((s) => s.cancelResearch);
  const exportPendingIds = useAppStore((s) => s.researchExportPendingIds);

  if (!research) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Select a research card to inspect the report, sources, and follow-ups.
      </div>
    );
  }

  const exportPending = exportPendingIds.includes(research.id);
  const running = research.status === "running" || research.status === "pending";
  const startedAgo = formatRelativeAge(research.createdAt);
  const canExport = research.status === "completed" && research.outputsMarkdown.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border/55 px-6 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge className={cn(statusClassName(research.status))}>
            {statusLabel(research.status)}
          </Badge>
          {startedAgo ? (
            <span className="text-xs text-muted-foreground">
              started {startedAgo} ago
            </span>
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

          <ResearchThoughtPanel thoughtSummaries={research.thoughtSummaries} status={research.status} />
          <ResearchReportRenderer markdown={research.outputsMarkdown} status={research.status} />
          <ResearchSourcesList sources={research.sources} />
          {research.status === "completed" ? (
            <ResearchFollowUpComposer parentResearchId={research.id} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
