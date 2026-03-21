import { PanelLeftIcon } from "lucide-react";

import { Button } from "../../components/ui/button";

interface SidebarCollapseControlProps {
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
}

export function SidebarCollapseControl({
  onToggleSidebar,
  sidebarCollapsed,
}: SidebarCollapseControlProps) {
  const label = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";

  return (
    <div className="app-sidebar-collapse-control">
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
    </div>
  );
}
