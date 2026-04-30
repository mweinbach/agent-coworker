import { PanelLeftIcon, SquarePenIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import type { DesktopPlatformInfo } from "../../lib/desktopPlatform";
import { SidebarCollapseControl } from "./SidebarCollapseControl";
import { useWindowDragHandle } from "./useWindowDragHandle";

/**
 * Platform-specific top bar chrome (left side controls + native titlebar reserves).
 *
 * Renders different control placements per platform:
 * - macOS: SidebarCollapseControl in traffic-light area
 * - Windows: Left rail with New Chat + expand when collapsed (sidebar owns controls when expanded)
 * - Linux/other: Inline sidebar toggle (+ New Chat when collapsed)
 *
 * The shared top bar content (title, usage, right toolbar) is rendered by AppTopBar.
 */
export type PlatformTopBarChromeProps = {
  platformInfo: DesktopPlatformInfo;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  sidebarLabel: string;
};

export function PlatformTopBarChrome({
  platformInfo,
  sidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  sidebarLabel,
}: PlatformTopBarChromeProps) {
  const placement = platformInfo.topbarControlPlacement;

  if (placement === "sidebar") {
    // macOS: collapse control lives adjacent to traffic lights
    return (
      <SidebarCollapseControl
        onToggleSidebar={onToggleSidebar}
        onNewChat={onNewChat}
        sidebarCollapsed={sidebarCollapsed}
      />
    );
  }

  if (placement === "left-rail") {
    // Windows: left rail only shows when sidebar is collapsed.
    // When expanded, the sidebar titleband owns the New Chat + collapse controls.
    if (!sidebarCollapsed) {
      return null;
    }
    return <Win32CollapsedLeftRail onNewChat={onNewChat} onToggleSidebar={onToggleSidebar} sidebarLabel={sidebarLabel} />;
  }

  // Linux / other: inline toggle at left
  return (
    <div className="app-topbar__inline-sidebar-toggle app-topbar__toolbar-layer app-topbar__controls absolute left-3 top-1/2 flex min-w-0 -translate-y-1/2 items-center gap-1">
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
  );
}

function Win32CollapsedLeftRail({
  onNewChat,
  onToggleSidebar,
  sidebarLabel,
}: {
  onNewChat: () => void;
  onToggleSidebar: () => void;
  sidebarLabel: string;
}) {
  const dragHandle = useWindowDragHandle<HTMLButtonElement>(true);
  return (
    <div className="app-topbar__win32-left-rail absolute inset-y-0 left-0">
      <div className="app-topbar__win32-left-drag-zone" aria-hidden="true" />
      <div className="app-topbar__sidebar-strip app-topbar__win32-left-strip app-topbar__toolbar-layer app-topbar__controls absolute inset-0 flex min-w-0 items-center gap-1 px-1.5">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onNewChat}
          title="New Chat"
          aria-label="New Chat"
          className="app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
          {...dragHandle}
        >
          <SquarePenIcon className="h-4 w-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggleSidebar}
          title={sidebarLabel}
          aria-label={sidebarLabel}
          className="app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
          {...dragHandle}
        >
          <PanelLeftIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
