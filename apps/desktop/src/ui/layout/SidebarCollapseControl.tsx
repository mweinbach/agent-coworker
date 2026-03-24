import { PanelLeftIcon, SquarePenIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

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
    <div className="app-sidebar-collapse-control flex items-center">
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onToggleSidebar}
        title={label}
        aria-label={label}
        className="app-topbar__controls app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
      >
        <PanelLeftIcon className="h-[18px] w-[18px]" />
      </Button>
      <div
        aria-hidden={!sidebarCollapsed}
        className={cn(
          "app-topbar__new-chat-reveal flex items-center overflow-hidden transition-[max-width,opacity,transform,margin] duration-200 ease-out",
          sidebarCollapsed ? "ml-1 max-w-7 opacity-100 translate-x-0" : "ml-0 max-w-0 opacity-0 -translate-x-1 pointer-events-none",
        )}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onNewChat}
          title="New Chat"
          aria-label="New Chat"
          className="app-topbar__controls app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
        >
          <SquarePenIcon className="h-[18px] w-[18px]" />
        </Button>
      </div>
    </div>
  );
}
