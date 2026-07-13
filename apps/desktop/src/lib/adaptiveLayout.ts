export const MAIN_WINDOW_MIN_WIDTH = 640;
export const MIN_PRIMARY_WORKSPACE_WIDTH = 520;

export const DESKTOP_LAYOUT_BREAKPOINTS = {
  narrow: 720,
  full: 1_120,
} as const;

const LEFT_SIDEBAR_MINIMUM_WIDTH = 160;
const LEFT_SIDEBAR_MAXIMUM_WIDTH = 440;

export type DesktopLayoutTier = "full" | "compact" | "narrow";
export type AdaptiveRightRailKind = "canvas" | "context" | "task";

export type RightRailSizing = {
  maximumWidth: number;
  minimumWidth: number;
  preferredWidth: number;
};

export type AdaptiveLayoutInput = {
  contextSidebarCollapsed: boolean;
  hasContextSidebar: boolean;
  leftSidebarWidth: number;
  rightSidebarMaximumWidth: number;
  rightSidebarMinimumWidth: number;
  rightSidebarWidth: number;
  sidebarCollapsed: boolean;
  viewportWidth: number;
};

export type AdaptiveLayout = {
  leftInline: boolean;
  leftMaximumWidth: number;
  leftOverlay: boolean;
  leftWidth: number;
  primaryWidth: number;
  rightInline: boolean;
  rightMaximumWidth: number;
  rightOverlay: boolean;
  rightWidth: number;
  tier: DesktopLayoutTier;
  viewportWidth: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function resolveRightRailSizing(
  kind: AdaptiveRightRailKind,
  widths: { canvas: number; context: number },
): RightRailSizing {
  switch (kind) {
    case "canvas":
      return {
        maximumWidth: 900,
        minimumWidth: 320,
        preferredWidth: clamp(widths.canvas, 320, 900),
      };
    case "task":
      return {
        maximumWidth: 600,
        minimumWidth: 360,
        preferredWidth: clamp(widths.context, 360, 600),
      };
    case "context":
      return {
        maximumWidth: 600,
        minimumWidth: 200,
        preferredWidth: clamp(widths.context, 200, 600),
      };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function resolveDesktopLayoutTier(viewportWidth: number): DesktopLayoutTier {
  if (viewportWidth < DESKTOP_LAYOUT_BREAKPOINTS.narrow) {
    return "narrow";
  }
  if (viewportWidth < DESKTOP_LAYOUT_BREAKPOINTS.full) {
    return "compact";
  }
  return "full";
}

/**
 * Resolves transient renderer layout without changing persisted rail preferences.
 *
 * Compact windows move the context rail into an overlay first. Narrow windows
 * move both rails into overlays. Inline widths are clamped around a protected
 * primary workspace, and the saved preferences become effective again when
 * the viewport has room for them.
 */
export function resolveAdaptiveLayout(input: AdaptiveLayoutInput): AdaptiveLayout {
  const viewportWidth = Math.max(0, input.viewportWidth);
  const tier = resolveDesktopLayoutTier(viewportWidth);
  const leftOverlay = tier === "narrow";
  const rightOverlay = input.hasContextSidebar && tier !== "full";
  const leftInline = !leftOverlay && !input.sidebarCollapsed;
  const rightInline = input.hasContextSidebar && !rightOverlay && !input.contextSidebarCollapsed;
  const railCapacity = Math.max(0, viewportWidth - MIN_PRIMARY_WORKSPACE_WIDTH);

  const requestedRightMinimum = Math.max(0, input.rightSidebarMinimumWidth);
  const requestedRightMaximum = Math.max(requestedRightMinimum, input.rightSidebarMaximumWidth);
  const reservedRightMinimum = rightInline ? requestedRightMinimum : 0;
  const leftMaximumWidth = leftInline
    ? Math.max(0, Math.min(LEFT_SIDEBAR_MAXIMUM_WIDTH, railCapacity - reservedRightMinimum))
    : 0;
  const leftMinimumWidth = Math.min(LEFT_SIDEBAR_MINIMUM_WIDTH, leftMaximumWidth);
  const leftWidth = leftInline
    ? clamp(input.leftSidebarWidth, leftMinimumWidth, leftMaximumWidth)
    : 0;

  const rightMaximumWidth = rightInline
    ? Math.max(0, Math.min(requestedRightMaximum, railCapacity - leftWidth))
    : 0;
  const rightMinimumWidth = Math.min(requestedRightMinimum, rightMaximumWidth);
  const rightWidth = rightInline
    ? clamp(input.rightSidebarWidth, rightMinimumWidth, rightMaximumWidth)
    : 0;

  return {
    leftInline,
    leftMaximumWidth,
    leftOverlay,
    leftWidth,
    primaryWidth: Math.max(0, viewportWidth - leftWidth - rightWidth),
    rightInline,
    rightMaximumWidth,
    rightOverlay,
    rightWidth,
    tier,
    viewportWidth,
  };
}
