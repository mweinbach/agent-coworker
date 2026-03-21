import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "./jsdomHarness";

const { AppTopBar } = await import("../src/ui/layout/AppTopBar");

describe("desktop app top bar", () => {
  test("renders the inline sidebar toggle and right toolbar controls", async () => {
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

      const strip = container.querySelector(".app-topbar");
      const sidebarFill = container.querySelector(".app-topbar__sidebar-fill");
      const sidebarToggle = container.querySelector('button[aria-label="Hide sidebar"]');
      const contextToggle = container.querySelector('button[aria-label="Hide context"]');

      expect(strip).not.toBeNull();
      expect(sidebarFill).not.toBeNull();
      expect(sidebarToggle).not.toBeNull();
      expect(sidebarToggle?.className).toContain("app-topbar__sidebar-toggle-button");
      expect(contextToggle).not.toBeNull();
      expect(contextToggle?.className).toContain("app-topbar__toolbar-button");
      expect(contextToggle?.className).toContain("app-topbar__toolbar-button");
      expect(container.textContent).toContain("Busy");
      expect(container.textContent).toContain("Cowork");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
