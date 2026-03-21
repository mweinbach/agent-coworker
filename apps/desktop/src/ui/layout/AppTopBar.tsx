import { PanelLeftIcon, PanelRightIcon, LoaderCircleIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

interface AppTopBarProps {
  busy: boolean;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  contextSidebarCollapsed: boolean;
  onToggleContextSidebar: () => void;
}

export function AppTopBar({
  busy,
  onToggleSidebar,
  sidebarCollapsed,
  sidebarWidth,
  contextSidebarCollapsed,
  onToggleContextSidebar,
}: AppTopBarProps) {
  const sidebarLabel = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";
  const rightSidebarLabel = contextSidebarCollapsed ? "Show context" : "Hide context";

  return (
    <div className="app-topbar relative flex h-12 w-full shrink-0 items-stretch overflow-hidden">
      <div
        className="app-topbar__sidebar-fill"
        aria-hidden="true"
        style={{ width: sidebarCollapsed ? 0 : sidebarWidth, borderRightWidth: sidebarCollapsed ? 0 : 1 }}
      />
      <div
        className="app-topbar__content-fill"
        aria-hidden="true"
        style={{ left: sidebarCollapsed ? 0 : sidebarWidth }}
      />
      <div className="app-topbar__controls-row relative z-10 flex min-h-0 min-w-0 flex-1 items-center pr-4">
        <div className="app-topbar__sidebar-toggle-slot app-topbar__toolbar flex min-w-0 flex-1 items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onToggleSidebar}
            title={sidebarLabel}
            aria-label={sidebarLabel}
            className="app-topbar__controls app-topbar__toolbar-button app-topbar__sidebar-toggle-button text-muted-foreground hover:text-foreground"
          >
            <PanelLeftIcon className="h-[18px] w-[18px]" />
          </Button>
        </div>

        <div className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 font-semibold text-sm tracking-tight text-foreground">
          Cowork
        </div>

        <div className="app-topbar__toolbar app-topbar__toolbar--right flex min-w-0 flex-1 items-center justify-end gap-2">
          {busy ? (
            <Badge variant="secondary" className="gap-1.5">
              <LoaderCircleIcon className="h-3.5 w-3.5 animate-spin" />
              Busy
            </Badge>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onToggleContextSidebar}
            title={rightSidebarLabel}
            aria-label={rightSidebarLabel}
            className="app-topbar__controls app-topbar__toolbar-button text-muted-foreground hover:text-foreground"
          >
            <PanelRightIcon className="h-[18px] w-[18px]" />
          </Button>
        </div>
      </div>
    </div>
  );
}
