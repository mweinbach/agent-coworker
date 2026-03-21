import { PanelRightIcon, LoaderCircleIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

interface AppTopBarProps {
  busy: boolean;
  contextSidebarCollapsed: boolean;
  onToggleContextSidebar: () => void;
}

/**
 * Right segment of the title row only. Full-width tint + title live in shell
 * (`.app-titlebar-backdrop`, `.app-titlebar-title`) so they sit under the
 * traffic lights and sidebar collapse control.
 */
export function AppTopBar({ busy, contextSidebarCollapsed, onToggleContextSidebar }: AppTopBarProps) {
  const rightSidebarLabel = contextSidebarCollapsed ? "Show context" : "Hide context";

  return (
    <div className="app-topbar app-topbar--main-strip relative z-[10] flex h-12 w-full shrink-0 items-center justify-end gap-2 pr-4">
      {busy ? (
        <Badge variant="secondary" className="app-topbar__controls gap-1.5">
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
  );
}
