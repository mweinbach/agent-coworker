import {
  ChevronDownIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  FileTypeIcon,
  Loader2Icon,
} from "lucide-react";
import { useState } from "react";
import type { ResearchExportFormat } from "../../../../../src/server/research/types";
import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { cn } from "../../lib/utils";

type ExportTarget = {
  format: ResearchExportFormat;
  label: string;
  hint: string;
  Icon: typeof FileTextIcon;
};

const EXPORT_TARGETS: ExportTarget[] = [
  { format: "markdown", label: "Markdown", hint: ".md", Icon: FileTextIcon },
  { format: "pdf", label: "PDF", hint: ".pdf", Icon: FileIcon },
  { format: "docx", label: "Word", hint: ".docx", Icon: FileTypeIcon },
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          type="button"
          variant="outline"
          className="h-7 gap-1.5 rounded-full border-border/60 bg-muted/15 px-3 text-xs"
          disabled={disabled}
          title={
            disabled
              ? "Download becomes available when the report finishes."
              : "Download this report"
          }
        >
          {pending ? (
            <Loader2Icon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <DownloadIcon className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Download
          <ChevronDownIcon className="h-3 w-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {EXPORT_TARGETS.map(({ format, label, hint, Icon }) => {
          const isPending = pending && activeFormat === format;
          return (
            <DropdownMenuItem
              key={format}
              disabled={pending}
              onSelect={() => void runExport(format)}
              className={cn(
                "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-xs",
                "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60",
              )}
            >
              {isPending ? (
                <Loader2Icon
                  className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="flex-1 font-medium text-foreground">{label}</span>
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {hint}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
