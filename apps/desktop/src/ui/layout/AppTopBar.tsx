import { PanelLeftIcon, PanelRightIcon, LoaderCircleIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { SidebarCollapseControl } from "./SidebarCollapseControl";

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
    <div className="app-topbar app-topbar--frame relative flex w-full shrink-0 items-center justify-end overflow-hidden px-4">
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
      <SidebarCollapseControl onToggleSidebar={onToggleSidebar} sidebarCollapsed={sidebarCollapsed} />
      <div className="app-topbar__inline-sidebar-toggle app-topbar__toolbar app-topbar__controls absolute left-4 top-1/2 flex min-w-0 -translate-y-1/2 items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggleSidebar}
          title={sidebarLabel}
          aria-label={sidebarLabel}
          className="app-topbar__toolbar-button app-topbar__sidebar-toggle-button text-muted-foreground hover:text-foreground"
        >
          <PanelLeftIcon className="h-[18px] w-[18px]" />
        </Button>
      </div>

      <div className="app-topbar__title pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
        Cowork
      </div>

      <div className="app-topbar__toolbar app-topbar__toolbar--right app-topbar__controls absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-2">
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
          className="app-topbar__toolbar-button text-muted-foreground hover:text-foreground"
        >
          <PanelRightIcon className="h-[18px] w-[18px]" />
        </Button>
      </div>
    </div>
  );
}
