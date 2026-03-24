import { PanelLeftIcon, PanelRightIcon, LoaderCircleIcon, SquarePenIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { SidebarCollapseControl } from "./SidebarCollapseControl";

interface AppTopBarProps {
  busy: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  contextSidebarCollapsed: boolean;
  onToggleContextSidebar: () => void;
}

export function AppTopBar({
  busy,
  onToggleSidebar,
  onNewChat,
  sidebarCollapsed,
  sidebarWidth,
  contextSidebarCollapsed,
  onToggleContextSidebar,
}: AppTopBarProps) {
  const sidebarLabel = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";
  const rightSidebarLabel = contextSidebarCollapsed ? "Show context" : "Hide context";

  return (
    <div className="app-topbar app-topbar--frame relative flex w-full shrink-0 items-center justify-end overflow-hidden px-3">
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
      <SidebarCollapseControl
        onToggleSidebar={onToggleSidebar}
        onNewChat={onNewChat}
        sidebarCollapsed={sidebarCollapsed}
      />
      <div className="app-topbar__inline-sidebar-toggle app-topbar__toolbar app-topbar__controls absolute left-3 top-1/2 flex min-w-0 -translate-y-1/2 items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggleSidebar}
          title={sidebarLabel}
          aria-label={sidebarLabel}
          className="app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
        >
          <PanelLeftIcon className="h-4 w-4" />
        </Button>
        {sidebarCollapsed ? (
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onNewChat}
            title="New Chat"
            aria-label="New Chat"
            className="app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
          >
            <SquarePenIcon className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div className="app-topbar__title pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center gap-2 text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        Cowork
      </div>

      <div className="app-topbar__toolbar app-topbar__toolbar--right app-topbar__controls absolute inset-y-0 right-3 flex items-center gap-1.5">
        {busy ? (
          <Badge variant="secondary" className="gap-1.5 rounded-md border-border/55 bg-muted/20 px-2 py-0 text-[11px] text-muted-foreground shadow-none">
            <LoaderCircleIcon className="h-3 w-3 animate-spin" />
            Busy
          </Badge>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggleContextSidebar}
          title={rightSidebarLabel}
          aria-label={rightSidebarLabel}
          className="app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
        >
          <PanelRightIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
