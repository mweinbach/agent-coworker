import { LayoutPanelLeftIcon, LoaderCircleIcon, PlusIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { designTokens } from "../../lib/designTokens";
import { cn } from "../../lib/utils";

interface AppTopBarProps {
  busy: boolean;
  onCreateThread: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  title: string;
  view: "chat" | "skills";
}

export function AppTopBar({
  busy,
  onCreateThread,
  onToggleSidebar,
  sidebarCollapsed,
  title,
  view,
}: AppTopBarProps) {
  const sidebarLabel = sidebarCollapsed ? "Show sidebar (Cmd/Ctrl+B)" : "Hide sidebar (Cmd/Ctrl+B)";

  return (
    <div className={cn("flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-sidebar px-4", designTokens.classes.subtleSurface)}>
      <div className="flex min-w-0 items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggleSidebar}
          title={sidebarLabel}
          aria-label={sidebarLabel}
        >
          <LayoutPanelLeftIcon className="h-4 w-4" />
        </Button>
        <div className="truncate font-semibold text-sm text-foreground">{title}</div>
      </div>
      <div className="flex items-center gap-2">
        {busy ? (
          <Badge variant="secondary" className="gap-1.5">
            <LoaderCircleIcon className="h-3.5 w-3.5 animate-spin" />
            Busy
          </Badge>
        ) : null}
        {view === "chat" ? (
          <Button size="sm" onClick={onCreateThread}>
            <PlusIcon className="h-3.5 w-3.5" />
            New
          </Button>
        ) : null}
      </div>
    </div>
  );
}
