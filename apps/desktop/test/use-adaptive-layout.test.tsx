import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { useAdaptiveLayout } from "../src/lib/useAdaptiveLayout";
import { setupJsdom } from "./jsdomHarness";

test.serial(
  "the adaptive layout subscription follows wide, compact, narrow, and wide again",
  async () => {
    const harness = setupJsdom({
      setupWindow(dom) {
        Object.defineProperty(dom.window, "innerWidth", {
          configurable: true,
          value: 1_240,
          writable: true,
        });
      },
    });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      function Probe() {
        const layout = useAdaptiveLayout({
          contextSidebarCollapsed: false,
          hasContextSidebar: true,
          leftSidebarWidth: 248,
          rightSidebarMaximumWidth: 600,
          rightSidebarMinimumWidth: 200,
          rightSidebarWidth: 300,
          sidebarCollapsed: false,
        });
        return createElement("output", {
          "data-left": layout.leftWidth,
          "data-primary": layout.primaryWidth,
          "data-right": layout.rightWidth,
          "data-tier": layout.tier,
        });
      }

      await act(async () => root.render(createElement(Probe)));
      const output = container.querySelector("output");
      expect(output?.dataset.tier).toBe("full");
      expect(output?.dataset.primary).toBe("692");

      for (const [width, tier, primary] of [
        [1_024, "compact", "776"],
        [800, "compact", "552"],
        [640, "narrow", "640"],
        [1_240, "full", "692"],
      ] as const) {
        await act(async () => {
          harness.dom.window.innerWidth = width;
          harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize"));
        });
        expect(output?.dataset.tier).toBe(tier);
        expect(output?.dataset.primary).toBe(primary);
      }

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  },
);
