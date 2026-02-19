import { PanelLeftIcon, PanelRightIcon, ChevronLeftIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { designTokens } from "../../lib/designTokens";
import { cn } from "../../lib/utils";

interface AppTopBarProps {
  busy: boolean;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  contextSidebarCollapsed: boolean;
  onToggleContextSidebar: () => void;
}

export function AppTopBar({
  busy,
  onToggleSidebar,
  sidebarCollapsed,
  contextSidebarCollapsed,
  onToggleContextSidebar,
}: AppTopBarProps) {
  const sidebarLabel = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";
  const rightSidebarLabel = contextSidebarCollapsed ? "Show context" : "Hide context";

  return (
    <div
      className={cn(
        "app-topbar flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-sidebar/85 px-4 backdrop-blur-xl",
        "app-topbar--macos-inset",
        designTokens.classes.subtleSurface,
      )}
    >
      <div className="app-topbar__controls flex min-w-0 items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggleSidebar}
          title={sidebarLabel}
          aria-label={sidebarLabel}
          className="text-muted-foreground hover:text-foreground mr-2"
        >
          <PanelLeftIcon className="h-[18px] w-[18px]" />
        </Button>
        <Button size="icon-sm" variant="ghost" disabled className="text-muted-foreground opacity-50">
          <ChevronLeftIcon className="h-5 w-5" />
        </Button>
        <Button size="icon-sm" variant="ghost" disabled className="text-muted-foreground opacity-50">
          <ChevronRightIcon className="h-5 w-5" />
        </Button>
      </div>

      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-semibold text-sm tracking-tight text-foreground flex items-center gap-2">
        
        Cowork
      </div>

      <div className="app-topbar__controls flex items-center gap-2">
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
          className="text-muted-foreground hover:text-foreground"
        >
          <PanelRightIcon className="h-[18px] w-[18px]" />
        </Button>
      </div>
    </div>
  );
}
