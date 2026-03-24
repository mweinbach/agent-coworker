import { PanelLeftIcon, SquarePenIcon } from "lucide-react";

import { Button } from "../../components/ui/button";

interface SidebarCollapseControlProps {
  onToggleSidebar: () => void;
  onNewChat: () => void;
  sidebarCollapsed: boolean;
}

export function SidebarCollapseControl({
  onToggleSidebar,
  onNewChat,
  sidebarCollapsed,
}: SidebarCollapseControlProps) {
  const label = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";

  return (
    <div className="app-sidebar-collapse-control flex items-center gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onToggleSidebar}
        title={label}
        aria-label={label}
        className="app-topbar__controls app-topbar__toolbar-button app-topbar__sidebar-toggle-button text-muted-foreground hover:text-foreground"
      >
        <PanelLeftIcon className="h-[18px] w-[18px]" />
      </Button>
      {sidebarCollapsed ? (
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onNewChat}
          title="New Chat"
          aria-label="New Chat"
          className="app-topbar__controls app-topbar__toolbar-button text-muted-foreground hover:text-foreground"
        >
          <SquarePenIcon className="h-[18px] w-[18px]" />
        </Button>
      ) : null}
    </div>
  );
}
