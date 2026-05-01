import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../src/components/ui/collapsible";
import { setupJsdom } from "./jsdomHarness";

describe("desktop collapsible component", () => {
  test("uses the stock Radix data-state contract", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");

      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            Collapsible,
            { defaultOpen: true },
            createElement(CollapsibleTrigger, null, "Toggle"),
            createElement(CollapsibleContent, null, "Content"),
          ),
        );
      });

      const rootElement = harness.dom.window.document.querySelector('[data-slot="collapsible"]');
      const trigger = harness.dom.window.document.querySelector(
        '[data-slot="collapsible-trigger"]',
      );
      const content = harness.dom.window.document.querySelector(
        '[data-slot="collapsible-content"]',
      );

      expect(rootElement?.getAttribute("data-state")).toBe("open");
      expect(trigger?.getAttribute("data-state")).toBe("open");
      expect(content?.getAttribute("data-state")).toBe("open");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
