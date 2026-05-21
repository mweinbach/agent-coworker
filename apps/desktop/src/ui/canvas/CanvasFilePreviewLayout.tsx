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
  return (
    <div
      className={cn(
        "flex h-full w-full min-w-0 flex-col",
        isCanvasMode ? "bg-background" : "bg-[var(--surface-sidebar-pane)]",
        isCanvasMode && "app-canvas-mode-window",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-0">
        {isCanvasMode ? (
          <CanvasElectronTitlebar
            isAgentBusy={isAgentBusy}
            leading={
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
        <div className={cn("flex-1 min-h-0 p-3", isCanvasMode && "p-5")}>{children}</div>
      </div>
    </div>
  );
}
