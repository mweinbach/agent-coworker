import { useMemo, useSyncExternalStore } from "react";

import {
  type AdaptiveLayout,
  type AdaptiveLayoutInput,
  DESKTOP_LAYOUT_BREAKPOINTS,
  resolveAdaptiveLayout,
} from "./adaptiveLayout";

function subscribeToViewportWidth(onStoreChange: () => void): () => void {
  window.addEventListener("resize", onStoreChange);
  return () => window.removeEventListener("resize", onStoreChange);
}

function getViewportWidth(): number {
  return window.innerWidth;
}

function getFallbackViewportWidth(): number {
  return DESKTOP_LAYOUT_BREAKPOINTS.full;
}

export function useAdaptiveLayout({
  contextSidebarCollapsed,
  hasContextSidebar,
  leftSidebarWidth,
  rightSidebarMaximumWidth,
  rightSidebarMinimumWidth,
  rightSidebarWidth,
  sidebarCollapsed,
}: Omit<AdaptiveLayoutInput, "viewportWidth">): AdaptiveLayout {
  const viewportWidth = useSyncExternalStore(
    subscribeToViewportWidth,
    getViewportWidth,
    getFallbackViewportWidth,
  );

  return useMemo(
    () =>
      resolveAdaptiveLayout({
        contextSidebarCollapsed,
        hasContextSidebar,
        leftSidebarWidth,
        rightSidebarMaximumWidth,
        rightSidebarMinimumWidth,
        rightSidebarWidth,
        sidebarCollapsed,
        viewportWidth,
      }),
    [
      contextSidebarCollapsed,
      hasContextSidebar,
      leftSidebarWidth,
      rightSidebarMaximumWidth,
      rightSidebarMinimumWidth,
      rightSidebarWidth,
      sidebarCollapsed,
      viewportWidth,
    ],
  );
}
