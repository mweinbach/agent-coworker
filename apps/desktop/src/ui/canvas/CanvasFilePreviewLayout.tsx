import { TableIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { CanvasElectronTitlebar } from "./CanvasElectronTitlebar";

type CanvasFilePreviewLayoutProps = {
  isCanvasMode: boolean;
  isAgentBusy: boolean;
  fileName: string;
  previewKind: string;
  onClose: () => void;
  children: ReactNode;
};

export function CanvasFilePreviewLayout({
  isCanvasMode,
  isAgentBusy,
  fileName,
  previewKind,
  onClose,
  children,
}: CanvasFilePreviewLayoutProps) {
  const isSpreadsheet = previewKind === "csv" || previewKind === "xlsx";

  return (
    <div
      className={cn(
        "flex h-full w-full min-w-0 flex-col",
        isSpreadsheet
          ? "bg-[var(--surface-spreadsheet)] text-[var(--text-spreadsheet)]"
          : isCanvasMode
            ? "bg-background"
            : "bg-[var(--surface-sidebar-pane)]",
        isCanvasMode && "app-canvas-mode-window",
      )}
      style={isSpreadsheet ? { colorScheme: "light" } : undefined}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-0">
        {isCanvasMode ? (
          <CanvasElectronTitlebar
            isAgentBusy={isAgentBusy}
            leading={
              isSpreadsheet ? (
                <span className="sr-only">Spreadsheet preview</span>
              ) : (
                <>
                  <TableIcon className="size-3.5 text-muted-foreground shrink-0" />
                  <div className="flex min-w-0 items-center gap-1">
                    <span
                      className="truncate text-xs font-semibold tracking-wide text-foreground"
                      title={fileName}
                    >
                      {fileName}
                    </span>
                    <span className="text-[10px] text-muted-foreground shrink-0 uppercase">
                      ({previewKind})
                    </span>
                  </div>
                </>
              )
            }
            trailing={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onClose}
                title="Close Window"
                className="size-6 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md"
              >
                <XIcon className="size-3.5" />
              </Button>
            }
          />
        ) : null}
        <div
          className={cn(
            "min-h-0 flex-1",
            isSpreadsheet ? "p-0" : "p-3",
            isCanvasMode && !isSpreadsheet && "p-5",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
