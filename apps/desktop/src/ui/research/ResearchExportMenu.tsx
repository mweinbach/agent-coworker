import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";

export function ResearchExportMenu({ researchId, pending }: { researchId: string; pending: boolean }) {
  const exportResearch = useAppStore((s) => s.exportResearch);

  return (
    <div className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/15 p-1">
      <Button
        size="sm"
        type="button"
        variant="ghost"
        className="h-7 rounded-full px-3 text-xs"
        disabled={pending}
        onClick={() => void exportResearch(researchId, "markdown")}
      >
        Markdown
      </Button>
      <Button
        size="sm"
        type="button"
        variant="ghost"
        className="h-7 rounded-full px-3 text-xs"
        disabled={pending}
        onClick={() => void exportResearch(researchId, "pdf")}
      >
        PDF
      </Button>
      <Button
        size="sm"
        type="button"
        variant="ghost"
        className="h-7 rounded-full px-3 text-xs"
        disabled={pending}
        onClick={() => void exportResearch(researchId, "docx")}
      >
        DOCX
      </Button>
    </div>
  );
}

