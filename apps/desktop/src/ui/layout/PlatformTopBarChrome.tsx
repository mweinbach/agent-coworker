import { PanelLeftIcon, SquarePenIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { Button } from "../../components/ui/button";
import {
  type DesktopPlatformInfo,
  resolveCollapsedLeftRailWidth,
} from "../../lib/desktopPlatform";
import { SidebarCollapseControl } from "./SidebarCollapseControl";

/**
 * Platform-specific top bar chrome (left side controls + native titlebar reserves).
 *
 * Renders different control placements per platform:
 * - macOS: SidebarCollapseControl in traffic-light area
 * - Windows: Left rail owns the collapse/expand button in both states, with
 *   New Chat added beside it only when collapsed so the collapse icon stays
 *   mounted through sidebar width animations
 * - Linux/other: Inline sidebar toggle (+ New Chat when collapsed)
 *
 * The shared top bar content (title, usage, right toolbar) is rendered by AppTopBar.
 */
export type PlatformTopBarChromeProps = {
  platformInfo: DesktopPlatformInfo;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  sidebarLabel: string;
};

export function PlatformTopBarChrome({
  platformInfo,
  sidebarCollapsed,
  sidebarWidth,
  onToggleSidebar,
  onNewChat,
  sidebarLabel,
}: PlatformTopBarChromeProps) {
  const placement = platformInfo.topbarControlPlacement;
  const collapsedRailWidth = resolveCollapsedLeftRailWidth(platformInfo);
  const leftRailWidth = sidebarCollapsed
    ? collapsedRailWidth
    : Math.max(collapsedRailWidth, sidebarWidth);

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
    // Windows: keep the sidebar toggle in the topbar rail for both expanded
    // and collapsed states so the icon does not unmount/remount during the
    // sidebar width animation. New Chat appears next to it only when collapsed.
    return (
      <Win32LeftRail
        onNewChat={onNewChat}
        onToggleSidebar={onToggleSidebar}
        sidebarCollapsed={sidebarCollapsed}
        sidebarLabel={sidebarLabel}
        railWidth={leftRailWidth}
      />
    );
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

function Win32LeftRail({
  onNewChat,
  onToggleSidebar,
  sidebarCollapsed,
  sidebarLabel,
  railWidth,
}: {
  onNewChat: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  sidebarLabel: string;
  railWidth: number;
}) {
  const railStyle =
    railWidth > 0 ? ({ width: railWidth, minWidth: railWidth } as CSSProperties) : undefined;

  return (
    <div
      className="app-topbar__win32-left-rail absolute inset-y-0 left-0"
      style={railStyle}
    >
      <div className="app-topbar__sidebar-strip app-topbar__win32-left-strip app-topbar__toolbar-layer app-topbar__controls absolute inset-0 flex min-w-0 items-center gap-1 px-1.5">
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
    </div>
  );
}
