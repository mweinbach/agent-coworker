import { describe, expect, test } from "bun:test";

import {
  DESKTOP_LAYOUT_BREAKPOINTS,
  MAIN_WINDOW_MIN_WIDTH,
  MIN_PRIMARY_WORKSPACE_WIDTH,
  resolveAdaptiveLayout,
  resolveRightRailSizing,
} from "../src/lib/adaptiveLayout";

const DEFAULT_LAYOUT = {
  contextSidebarCollapsed: false,
  hasContextSidebar: true,
  leftSidebarWidth: 248,
  rightSidebarMaximumWidth: 600,
  rightSidebarMinimumWidth: 200,
  rightSidebarWidth: 300,
  sidebarCollapsed: false,
};

describe("adaptive desktop layout", () => {
  test.each([
    [640, "narrow", true, true],
    [800, "compact", false, true],
    [1_024, "compact", false, true],
    [1_240, "full", false, false],
  ] as const)(
    "maps %ipx to the %s tier with the expected overlay rails",
    (viewportWidth, tier, leftOverlay, rightOverlay) => {
      const layout = resolveAdaptiveLayout({ ...DEFAULT_LAYOUT, viewportWidth });

      expect(layout.tier).toBe(tier);
      expect(layout.leftOverlay).toBe(leftOverlay);
      expect(layout.rightOverlay).toBe(rightOverlay);
      expect(layout.primaryWidth).toBeGreaterThanOrEqual(MIN_PRIMARY_WORKSPACE_WIDTH);
    },
  );

  test("keeps automatic overlay behavior separate from saved collapse preferences", () => {
    const compact = resolveAdaptiveLayout({ ...DEFAULT_LAYOUT, viewportWidth: 800 });
    expect(compact.leftInline).toBe(true);
    expect(compact.rightInline).toBe(false);
    expect(compact.leftWidth).toBe(248);
    expect(compact.rightWidth).toBe(0);

    const wideAgain = resolveAdaptiveLayout({ ...DEFAULT_LAYOUT, viewportWidth: 1_240 });
    expect(wideAgain.leftInline).toBe(true);
    expect(wideAgain.rightInline).toBe(true);
    expect(wideAgain.leftWidth).toBe(248);
    expect(wideAgain.rightWidth).toBe(300);
  });

  test("respects explicit collapsed preferences when their rails can be inline", () => {
    const layout = resolveAdaptiveLayout({
      ...DEFAULT_LAYOUT,
      contextSidebarCollapsed: true,
      sidebarCollapsed: true,
      viewportWidth: 1_240,
    });

    expect(layout.leftInline).toBe(false);
    expect(layout.rightInline).toBe(false);
    expect(layout.primaryWidth).toBe(1_240);
  });

  test("shrinks extreme rail preferences without squeezing the primary workspace", () => {
    const layout = resolveAdaptiveLayout({
      ...DEFAULT_LAYOUT,
      leftSidebarWidth: 440,
      rightSidebarMinimumWidth: 320,
      rightSidebarMaximumWidth: 900,
      rightSidebarWidth: 900,
      viewportWidth: 1_240,
    });

    expect(layout.leftWidth).toBe(400);
    expect(layout.rightWidth).toBe(320);
    expect(layout.primaryWidth).toBe(MIN_PRIMARY_WORKSPACE_WIDTH);
    expect(layout.leftMaximumWidth).toBe(400);
    expect(layout.rightMaximumWidth).toBe(320);
  });

  test("clamps the compact left rail against the available primary width", () => {
    const layout = resolveAdaptiveLayout({
      ...DEFAULT_LAYOUT,
      leftSidebarWidth: 440,
      viewportWidth: DESKTOP_LAYOUT_BREAKPOINTS.narrow + 40,
    });

    expect(layout.tier).toBe("compact");
    expect(layout.leftWidth).toBe(240);
    expect(layout.primaryWidth).toBe(MIN_PRIMARY_WORKSPACE_WIDTH);
    expect(layout.leftMaximumWidth).toBe(240);
  });

  test("uses the whole viewport when no context surface is available", () => {
    const layout = resolveAdaptiveLayout({
      ...DEFAULT_LAYOUT,
      hasContextSidebar: false,
      viewportWidth: 1_240,
    });

    expect(layout.rightOverlay).toBe(false);
    expect(layout.rightInline).toBe(false);
    expect(layout.rightWidth).toBe(0);
    expect(layout.primaryWidth).toBe(992);
  });

  test("keeps the Electron minimum width aligned with the narrow verification target", () => {
    expect(MAIN_WINDOW_MIN_WIDTH).toBe(640);
    expect(DESKTOP_LAYOUT_BREAKPOINTS.narrow).toBeGreaterThan(MAIN_WINDOW_MIN_WIDTH);
    expect(DESKTOP_LAYOUT_BREAKPOINTS.full).toBeLessThanOrEqual(1_240);
  });

  test("uses one surface-aware descriptor for pane rendering and resizing", () => {
    expect(resolveRightRailSizing("context", { canvas: 500, context: 300 })).toEqual({
      maximumWidth: 600,
      minimumWidth: 200,
      preferredWidth: 300,
    });
    expect(resolveRightRailSizing("task", { canvas: 500, context: 300 })).toEqual({
      maximumWidth: 600,
      minimumWidth: 360,
      preferredWidth: 360,
    });
    expect(resolveRightRailSizing("canvas", { canvas: 200, context: 300 })).toEqual({
      maximumWidth: 900,
      minimumWidth: 320,
      preferredWidth: 320,
    });
  });
});
