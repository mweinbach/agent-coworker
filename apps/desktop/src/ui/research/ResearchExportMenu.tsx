import { FileTextIcon, FileIcon, FileTypeIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import type { ResearchExportFormat } from "../../../../../src/server/research/types";
import { cn } from "../../lib/utils";

type ExportTarget = {
  format: ResearchExportFormat;
  label: string;
  Icon: typeof FileTextIcon;
};

const EXPORT_TARGETS: ExportTarget[] = [
  { format: "markdown", label: "Markdown", Icon: FileTextIcon },
  { format: "pdf", label: "PDF", Icon: FileIcon },
  { format: "docx", label: "DOCX", Icon: FileTypeIcon },
];

export function ResearchExportMenu({
  researchId,
  pending,
  disabled,
}: {
  researchId: string;
  pending: boolean;
  disabled?: boolean;
}) {
  const exportResearch = useAppStore((s) => s.exportResearch);
  const [activeFormat, setActiveFormat] = useState<ResearchExportFormat | null>(null);

  const runExport = async (format: ResearchExportFormat) => {
    setActiveFormat(format);
    try {
      await exportResearch(researchId, format);
    } finally {
      setActiveFormat((current) => (current === format ? null : current));
    }
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-full border border-border/60 bg-muted/15 p-1",
        disabled && "opacity-60",
      )}
      role="group"
      aria-label="Export research"
    >
      {EXPORT_TARGETS.map(({ format, label, Icon }) => {
        const isPending = pending && activeFormat === format;
        return (
          <Button
            key={format}
            size="sm"
            type="button"
            variant="ghost"
            className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
            disabled={disabled || pending}
            onClick={() => void runExport(format)}
            title={disabled ? "Export becomes available when the report finishes." : `Export as ${label}`}
          >
            {isPending ? (
              <Loader2Icon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {label}
          </Button>
        );
      })}
    </div>
  );
}
