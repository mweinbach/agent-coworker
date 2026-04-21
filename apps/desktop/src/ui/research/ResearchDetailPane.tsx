import type { ResearchDetail } from "../../app/types";
import { useAppStore } from "../../app/store";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/55 px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-[1.15rem] font-semibold tracking-tight text-foreground">{research.title}</h3>
              <Badge className={cn(statusClassName(research.status))}>
                {research.status}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{research.prompt}</p>
            {research.error ? (
              <div className="mt-2 text-xs text-destructive">{research.error}</div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ResearchExportMenu researchId={research.id} pending={exportPending} />
            {running ? (
              <Button size="sm" variant="outline" type="button" onClick={() => void cancelResearch(research.id)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          <ResearchThoughtPanel thoughtSummaries={research.thoughtSummaries} />
          <ResearchReportRenderer markdown={research.outputsMarkdown} status={research.status} />
          <ResearchSourcesList sources={research.sources} />
          <ResearchFollowUpComposer parentResearchId={research.id} disabled={running} />
        </div>
      </div>
    </div>
  );
}
