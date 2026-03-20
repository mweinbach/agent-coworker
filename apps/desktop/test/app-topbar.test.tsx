import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "./jsdomHarness";

const { AppTopBar } = await import("../src/ui/layout/AppTopBar");

describe("desktop app top bar", () => {
  test("renders the right toolbar as plain top-bar controls", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: true,
            onToggleSidebar: () => {},
            sidebarCollapsed: false,
            sidebarWidth: 280,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
          }),
        );
      });

      const rightToolbar = container.querySelector(".app-topbar__toolbar--right");
      const contextToggle = container.querySelector('button[aria-label="Hide context"]');
      const sidebarToggle = container.querySelector('button[aria-label="Hide sidebar"]');

      expect(rightToolbar).not.toBeNull();
      expect(rightToolbar?.className).toContain("app-topbar__controls");
      expect(rightToolbar?.className).not.toContain("rounded");
      expect(contextToggle).not.toBeNull();
      expect(sidebarToggle).not.toBeNull();
      expect(sidebarToggle?.className).toContain("app-topbar__sidebar-toggle-button");
      expect(contextToggle?.className).toContain("app-topbar__toolbar-button");
      expect(container.textContent).toContain("Busy");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
