import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

describe("desktop tooltip component", () => {
  test.serial("renders through the required stock TooltipProvider", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");

      const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await import(
        new URL("../src/components/ui/tooltip.tsx?tooltip-component-test", import.meta.url).href
      );
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            TooltipProvider,
            null,
            createElement(
              Tooltip,
              { defaultOpen: true },
              createElement(TooltipTrigger, null, "Trigger"),
              createElement(TooltipContent, null, "Tooltip content"),
            ),
          ),
        );
      });

      const trigger = harness.dom.window.document.querySelector('[data-slot="tooltip-trigger"]');
      const tooltip = harness.dom.window.document.querySelector('[data-slot="tooltip-content"]');
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing tooltip trigger");
      }
      if (!(tooltip instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing tooltip content");
      }

      expect(tooltip.textContent).toContain("Tooltip content");
      expect(tooltip.className).toContain("bg-foreground");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
