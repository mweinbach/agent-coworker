import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "./jsdomHarness";

const { AppTopBar } = await import("../src/ui/layout/AppTopBar");

describe("desktop app top bar", () => {
  test("renders busy badge and context sidebar toggle", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: true,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
          }),
        );
      });

      const strip = container.querySelector(".app-topbar--main-strip");
      const contextToggle = container.querySelector('button[aria-label="Hide context"]');

      expect(strip).not.toBeNull();
      expect(strip?.className).not.toContain("rounded");
      expect(contextToggle).not.toBeNull();
      expect(contextToggle?.className).toContain("app-topbar__controls");
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
