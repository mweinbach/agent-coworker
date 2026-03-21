import { PanelLeftIcon } from "lucide-react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";

/**
 * Fixed next to macOS traffic lights (or leading edge on other platforms).
 * Stays in the same window position when the sidebar is toggled.
 */
export function SidebarCollapseControl() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const label = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";

  return (
    <div className="app-sidebar-collapse-control">
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => toggleSidebar()}
        title={label}
        aria-label={label}
        className="app-topbar__controls app-topbar__toolbar-button app-topbar__sidebar-toggle-button text-muted-foreground hover:text-foreground"
      >
        <PanelLeftIcon className="h-[18px] w-[18px]" />
      </Button>
    </div>
  );
}
