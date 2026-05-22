import {
  ArrowUpRightIcon,
  BoldIcon,
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  EyeIcon,
  LoaderCircleIcon,
  MoreVerticalIcon,
  PanelRightIcon,
  PenIcon,
  XIcon,
} from "lucide-react";
import { type CSSProperties, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatCost, formatTokenCount } from "../../../../../src/session/pricing";
import type { SessionUsageSnapshot, TurnUsageSnapshot } from "../../app/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useDesktopPlatform } from "../../lib/useDesktopPlatform";
import { resolveCollapsedLeftRailWidth } from "../../lib/desktopPlatform";
import { cn } from "../../lib/utils";
import { PlatformTopBarChrome } from "./PlatformTopBarChrome";

interface AppTopBarProps {
  busy: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  contextSidebarCollapsed: boolean;
  onToggleContextSidebar: () => void;
  onPopOutQuickChat?: () => void;
  title: string;
  subtitle: string | null;
  sessionUsage: SessionUsageSnapshot | null;
  lastTurnUsage: TurnUsageSnapshot | null;
  canClearHardCap?: boolean;
  onClearHardCap?: () => void;
  showContextToggle?: boolean;
  managementMode?: "thread" | "plugins";
  suppressThreadDetails?: boolean;
  hideThreadShell?: boolean;
  managementWorkspaceId?: string | null;
  managementWorkspaces?: Array<{ id: string; name: string }>;
  onSelectManagementWorkspace?: (workspaceId: string | null) => void;
  canvasMode?: boolean;
  canvasIsMarkdown?: boolean;
  canvasActiveTab?: "preview" | "edit";
  onSetCanvasActiveTab?: (tab: "preview" | "edit") => void;
  canvasShowFormattingBar?: boolean;
  onToggleCanvasFormattingBar?: () => void;
  onPopOutCanvas?: () => void;
  onCloseCanvas?: () => void;
}

export function AppTopBar({
  busy,
  onToggleSidebar,
  onNewChat,
  sidebarCollapsed,
  sidebarWidth,
  contextSidebarCollapsed,
  onToggleContextSidebar,
  onPopOutQuickChat,
  title,
  subtitle,
  sessionUsage,
  lastTurnUsage,
  canClearHardCap = false,
  onClearHardCap,
  showContextToggle = true,
  managementMode = "thread",
  suppressThreadDetails = false,
  hideThreadShell = false,
  managementWorkspaceId = null,
  managementWorkspaces = [],
  onSelectManagementWorkspace,
  canvasMode = false,
  canvasIsMarkdown = false,
  canvasActiveTab = "preview",
  onSetCanvasActiveTab,
  canvasShowFormattingBar = true,
  onToggleCanvasFormattingBar,
  onPopOutCanvas,
  onCloseCanvas,
}: AppTopBarProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const detailsId = useId();
  const platformInfo = useDesktopPlatform();
  const isDarwin = platformInfo.platform === "macos";
  const usesLeftRail = platformInfo.topbarControlPlacement === "left-rail";
  const collapsedRailWidth = resolveCollapsedLeftRailWidth(platformInfo);
  const showCollapsedLeftRail = usesLeftRail && sidebarCollapsed;
  const sidebarLabel = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";
  const contentFillLeft = usesLeftRail
    ? sidebarCollapsed
      ? collapsedRailWidth
      : sidebarWidth
    : sidebarCollapsed
      ? 0
      : sidebarWidth;
  const rightSidebarLabel = contextSidebarCollapsed ? "Show context" : "Hide context";
  const hasUsage = sessionUsage !== null || lastTurnUsage !== null;
  const estimatedCostLabel = useMemo(() => {
    if (!sessionUsage) {
      return "No usage yet";
    }
    if (sessionUsage.costTrackingAvailable && sessionUsage.estimatedTotalCostUsd !== null) {
      return formatCost(sessionUsage.estimatedTotalCostUsd);
    }
    return sessionUsage.totalTurns > 0 ? "Unavailable" : "No usage yet";
  }, [sessionUsage]);
  const totalTokensLabel = useMemo(() => {
    if (sessionUsage) {
      return formatTokenCount(sessionUsage.totalTokens);
    }
    if (lastTurnUsage) {
      return formatTokenCount(lastTurnUsage.usage.totalTokens);
    }
    return "—";
  }, [lastTurnUsage, sessionUsage]);
  const promptTokensLabel = sessionUsage ? formatTokenCount(sessionUsage.totalPromptTokens) : "—";
  const completionTokensLabel = sessionUsage
    ? formatTokenCount(sessionUsage.totalCompletionTokens)
    : "—";
  const totalTurnsLabel = sessionUsage ? `${sessionUsage.totalTurns}` : "0";
  const lastTurnTokensLabel = lastTurnUsage
    ? formatTokenCount(lastTurnUsage.usage.totalTokens)
    : "—";
  const lastTurnCostLabel =
    lastTurnUsage?.usage.estimatedCostUsd !== undefined
      ? formatCost(lastTurnUsage.usage.estimatedCostUsd)
      : "—";
  const budgetLine = useMemo(() => {
    const budget = sessionUsage?.budgetStatus;
    if (!budget?.configured) {
      return null;
    }
    if (budget.stopTriggered && budget.stopAtUsd !== null) {
      return `Hard cap exceeded at ${formatCost(budget.stopAtUsd)}`;
    }
    if (budget.warningTriggered && budget.warnAtUsd !== null) {
      return `Warning threshold reached at ${formatCost(budget.warnAtUsd)}`;
    }

    const parts: string[] = [];
    if (budget.warnAtUsd !== null) parts.push(`Warn ${formatCost(budget.warnAtUsd)}`);
    if (budget.stopAtUsd !== null) parts.push(`Cap ${formatCost(budget.stopAtUsd)}`);
    return parts.length > 0 ? `Budget ${parts.join(" • ")}` : null;
  }, [sessionUsage]);
  const titleOffset = showCollapsedLeftRail
    ? collapsedRailWidth
    : sidebarCollapsed
      ? 0
      : sidebarWidth;
  const showQuickChatPopOut = managementMode === "thread" && onPopOutQuickChat !== undefined;
  const defaultRightInset = canvasMode
    ? busy
      ? 12.5 * 16
      : 8.5 * 16
    : busy
      ? 8.75 * 16
      : showContextToggle || showQuickChatPopOut
        ? 4.75 * 16
        : 12;
  const win32RightInset = canvasMode
    ? busy
      ? 10.5 * 16
      : 6.5 * 16
    : busy
      ? 8.75 * 16
      : showContextToggle || showQuickChatPopOut
        ? 2.75 * 16
        : 12;
  const titleRightInset = usesLeftRail
    ? platformInfo.captionButtonReserve +
      platformInfo.topbarToolbarGap +
      win32RightInset
    : defaultRightInset;
  const collapsedThreadAnchorStyle =
    sidebarCollapsed && isDarwin ? { paddingLeft: "10rem" } : undefined;
  const reservesNativeCaptionButtons = platformInfo.captionButtonReserve > 0;
  const toolbarRightStyle = reservesNativeCaptionButtons
    ? ({
        right:
          platformInfo.captionButtonReserve + platformInfo.topbarToolbarGap + 12,
      } as CSSProperties)
    : undefined;
  const toolbarPositionClass = reservesNativeCaptionButtons ? undefined : "right-3";

  useEffect(() => {
    setDetailsOpen(false);
  }, []);

  useEffect(() => {
    if (!detailsOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (
        detailsRef.current &&
        event.target instanceof Node &&
        !detailsRef.current.contains(event.target)
      ) {
        setDetailsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setDetailsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [detailsOpen]);

  return (
    <div className="app-topbar app-topbar--frame relative flex w-full shrink-0 items-center justify-end px-3">
      <div
        className="app-topbar__sidebar-fill border-r border-border/70"
        aria-hidden="true"
        style={{
          width: sidebarCollapsed ? 0 : sidebarWidth,
          borderRightWidth: sidebarCollapsed ? 0 : 1,
        }}
      />
      <div
        className="app-topbar__content-fill"
        aria-hidden="true"
        style={{ left: contentFillLeft }}
      />
      <PlatformTopBarChrome
        platformInfo={platformInfo}
        sidebarCollapsed={sidebarCollapsed}
        sidebarWidth={sidebarWidth}
        onToggleSidebar={onToggleSidebar}
        onNewChat={onNewChat}
        sidebarLabel={sidebarLabel}
      />

      <div
        className="app-topbar__thread-shell absolute inset-y-0 flex min-w-0 items-center"
        style={{ left: titleOffset, right: titleRightInset }}
      >
        {hideThreadShell ? null : managementMode === "plugins" ? (
          <div
            className={cn(
              "app-topbar__thread-anchor relative flex min-w-0 items-center",
              sidebarCollapsed &&
                !showCollapsedLeftRail &&
                "app-topbar__thread-anchor--collapsed",
              showCollapsedLeftRail && "app-topbar__thread-anchor--win32-collapsed",
            )}
            style={collapsedThreadAnchorStyle}
          >
            <Select
              value={managementWorkspaceId ?? "__global__"}
              onValueChange={(value) => {
                onSelectManagementWorkspace?.(value === "__global__" ? null : value);
              }}
            >
              <SelectTrigger
                aria-label="Select plugin management workspace"
                className="app-topbar__thread-button app-topbar__controls h-8 border-transparent bg-transparent px-0 text-sm font-medium shadow-none hover:bg-transparent"
                size="sm"
              >
                <span className="app-topbar__thread-title truncate">{title}</span>
                <span
                  className="app-topbar__thread-separator mx-1.5 text-muted-foreground/52"
                  aria-hidden="true"
                >
                  |
                </span>
                <SelectValue placeholder="Global">
                  <span className="italic">
                    {managementWorkspaceId
                      ? (managementWorkspaces.find(
                          (workspace) => workspace.id === managementWorkspaceId,
                        )?.name ?? "Global")
                      : "Global"}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__global__">Global</SelectItem>
                {managementWorkspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div
            ref={detailsRef}
            className={cn(
              "app-topbar__thread-anchor relative flex min-w-0",
              sidebarCollapsed &&
                !showCollapsedLeftRail &&
                "app-topbar__thread-anchor--collapsed",
              showCollapsedLeftRail && "app-topbar__thread-anchor--win32-collapsed",
            )}
            style={collapsedThreadAnchorStyle}
          >
            {suppressThreadDetails ? (
              <span className="app-topbar__thread-title truncate text-[15px] font-semibold">
                {title}
              </span>
            ) : (
              <button
                type="button"
                aria-label="Open thread details"
                aria-haspopup="dialog"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                className="app-topbar__thread-button app-topbar__controls flex min-w-0 items-center gap-2"
                data-open={detailsOpen ? "true" : "false"}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <span className="app-topbar__thread-title truncate text-[15px] font-semibold">
                  {title}
                </span>
                {subtitle ? (
                  <>
                    <span
                      className="app-topbar__thread-separator text-muted-foreground/40"
                      aria-hidden="true"
                    >
                      |
                    </span>
                    <span className="app-topbar__thread-subtitle truncate text-sm text-muted-foreground/80">
                      {subtitle}
                    </span>
                  </>
                ) : null}
                <ChevronDownIcon
                  className={cn(
                    "app-topbar__thread-chevron h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-150 ease-out",
                    detailsOpen && "rotate-180",
                  )}
                />
              </button>
            )}

            {detailsOpen && !suppressThreadDetails ? (
              <div
                id={detailsId}
                role="dialog"
                aria-label="Thread details"
                className="app-topbar__thread-popover absolute left-0 top-full mt-1.5 w-[19.5rem] max-w-[min(19.5rem,calc(100vw-2rem))]"
              >
                <div className="flex items-start justify-between gap-3 px-0.5 pt-0.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium leading-none text-muted-foreground">
                      Usage
                    </p>
                    {hasUsage ? (
                      <p className="mt-2 text-[13px] leading-snug tracking-tight text-foreground/92">
                        <span className="font-semibold tabular-nums">{estimatedCostLabel}</span>
                        <span className="font-normal text-muted-foreground"> · </span>
                        <span className="font-normal text-muted-foreground">
                          {totalTurnsLabel} turn{totalTurnsLabel === "1" ? "" : "s"}
                        </span>
                      </p>
                    ) : (
                      <p className="mt-2 text-[13px] leading-snug text-muted-foreground">
                        No usage recorded yet
                      </p>
                    )}
                  </div>
                  {busy ? (
                    <Badge
                      variant="secondary"
                      className="h-6 shrink-0 gap-1 rounded-full border-border/40 bg-muted/25 px-2 text-[10px] font-medium text-muted-foreground shadow-none"
                    >
                      <LoaderCircleIcon className="h-3 w-3 animate-spin opacity-80" />
                      Busy
                    </Badge>
                  ) : null}
                </div>

                <div className="app-topbar__thread-metrics app-context-sidebar__nested-panel mt-2.5 flex flex-col rounded-[10px] border px-2.5 py-1">
                  <TopBarMetricRow label="Estimated cost" value={estimatedCostLabel} />
                  <TopBarMetricRow label="Total tokens" value={totalTokensLabel} />
                  <TopBarMetricRow label="Prompt tokens" value={promptTokensLabel} />
                  <TopBarMetricRow label="Completion tokens" value={completionTokensLabel} />
                  <TopBarMetricRow label="Turns" value={totalTurnsLabel} />
                  <TopBarMetricRow label="Last turn tokens" value={lastTurnTokensLabel} />
                </div>

                {lastTurnUsage ? (
                  <div className="mt-2 flex items-center justify-between gap-3 px-0.5 text-[11px]">
                    <span className="text-muted-foreground">Last turn cost</span>
                    <span className="tabular-nums font-medium text-foreground/88">
                      {lastTurnCostLabel}
                    </span>
                  </div>
                ) : null}

                {budgetLine ? (
                  <div className="mt-2 px-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    {budgetLine}
                  </div>
                ) : null}

                {canClearHardCap && onClearHardCap ? (
                  <div className="mt-3 flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 rounded-full px-3 text-[11px]"
                      onClick={() => {
                        onClearHardCap();
                        setDetailsOpen(false);
                      }}
                    >
                      Clear hard cap
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {canvasMode ? (
        <div
          className={cn(
            "app-topbar__toolbar-layer app-topbar__toolbar--right app-topbar__controls absolute inset-y-0 flex items-center gap-1",
            toolbarPositionClass,
          )}
          style={toolbarRightStyle}
        >
          {busy ? (
            <Badge
              variant="secondary"
              className="gap-1.5 rounded-md border-border/55 bg-muted/20 px-2 py-0 text-[11px] text-muted-foreground shadow-none"
            >
              <LoaderCircleIcon className="h-3 w-3 animate-spin" />
              Busy
            </Badge>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                title="View options"
                aria-label="Canvas view options"
                className="app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
              >
                <MoreVerticalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44 outline-none">
              {canvasIsMarkdown && onSetCanvasActiveTab ? (
                <>
                  <DropdownMenuItem
                    onClick={() => onSetCanvasActiveTab("preview")}
                    className={cn(
                      canvasActiveTab === "preview" && "font-semibold text-primary bg-primary/5",
                    )}
                  >
                    <EyeIcon className="mr-2 size-3.5" />
                    <span>Document</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onSetCanvasActiveTab("edit")}
                    className={cn(
                      canvasActiveTab === "edit" && "font-semibold text-primary bg-primary/5",
                    )}
                  >
                    <PenIcon className="mr-2 size-3.5" />
                    <span>Source</span>
                  </DropdownMenuItem>
                </>
              ) : null}
              {onToggleCanvasFormattingBar ? (
                <DropdownMenuItem
                  onClick={onToggleCanvasFormattingBar}
                  className="flex items-center justify-between cursor-pointer"
                >
                  <span className="flex items-center">
                    <BoldIcon className="mr-2 size-3.5" />
                    Show Styling Bar
                  </span>
                  {canvasShowFormattingBar && <CheckIcon className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {onPopOutCanvas ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onPopOutCanvas}
              title="Open in window"
              aria-label="Open canvas in window"
              className="app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
            >
              <ExternalLinkIcon className="h-4 w-4" />
            </Button>
          ) : null}
          {onCloseCanvas ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onCloseCanvas}
              title="Close canvas"
              aria-label="Close canvas"
              className="app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
            >
              <XIcon className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ) : showQuickChatPopOut || showContextToggle || busy ? (
        <div
          className={cn(
            "app-topbar__toolbar-layer app-topbar__toolbar--right app-topbar__controls absolute inset-y-0 flex items-center gap-1.5",
            toolbarPositionClass,
          )}
          style={toolbarRightStyle}
        >
          {busy ? (
            <Badge
              variant="secondary"
              className="gap-1.5 rounded-md border-border/55 bg-muted/20 px-2 py-0 text-[11px] text-muted-foreground shadow-none"
            >
              <LoaderCircleIcon className="h-3 w-3 animate-spin" />
              Busy
            </Badge>
          ) : null}
          {showQuickChatPopOut ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onPopOutQuickChat}
              title="Open quick chat"
              aria-label="Open quick chat"
              className="app-topbar__toolbar-button app-topbar__plain-icon-button text-muted-foreground hover:text-foreground"
            >
              <ArrowUpRightIcon className="h-4 w-4" />
            </Button>
          ) : null}
          {showContextToggle ? (
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TopBarMetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/20 py-1.5 last:border-b-0">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-[13px] font-medium tabular-nums tracking-tight text-foreground/90">
        {value}
      </span>
    </div>
  );
}
