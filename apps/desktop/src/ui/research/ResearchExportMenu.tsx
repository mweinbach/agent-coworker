import {
  ChevronDownIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  FileTypeIcon,
  Loader2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ResearchExportFormat } from "../../../../../src/server/research/types";
import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
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
  const [open, setOpen] = useState(false);
  const [activeFormat, setActiveFormat] = useState<ResearchExportFormat | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        rootRef.current.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const runExport = async (format: ResearchExportFormat) => {
    setActiveFormat(format);
    try {
      await exportResearch(researchId, format);
    } finally {
      setActiveFormat((current) => (current === format ? null : current));
    }
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="sm"
        type="button"
        variant="outline"
        className="h-7 gap-1.5 rounded-full border-border/60 bg-muted/15 px-3 text-xs"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={
          disabled ? "Download becomes available when the report finishes." : "Download this report"
        }
      >
        {pending ? (
          <Loader2Icon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <DownloadIcon className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Download
        <ChevronDownIcon
          className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </Button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-lg border border-border/50 bg-popover text-popover-foreground shadow-lg"
        >
          {EXPORT_TARGETS.map(({ format, label, hint, Icon }) => {
            const isPending = pending && activeFormat === format;
            return (
              <button
                key={format}
                type="button"
                role="menuitem"
                disabled={pending}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors",
                  "hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
                onClick={() => void runExport(format)}
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
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
