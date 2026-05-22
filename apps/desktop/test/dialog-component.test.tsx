import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

describe("desktop dialog component", () => {
  test("renders the stock shadcn/Radix dialog structure", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");

      const { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } = await import(
        new URL("../src/components/ui/dialog.tsx?dialog-component-test", import.meta.url).href
      );
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            Dialog,
            { open: true, onOpenChange: () => {} },
            createElement(DialogTrigger, null, "Open"),
            createElement(
              DialogContent,
              null,
              createElement(DialogTitle, null, "Title"),
              createElement(DialogDescription, null, "Description"),
            ),
          ),
        );
      });

      const dialog = harness.dom.window.document.querySelector('[data-slot="dialog-content"]');
      const close = harness.dom.window.document.querySelector('[data-slot="dialog-close"]');
      const title = harness.dom.window.document.querySelector('[data-slot="dialog-title"]');
      const description = harness.dom.window.document.querySelector(
        '[data-slot="dialog-description"]',
      );

      expect(dialog?.getAttribute("role")).toBe("dialog");
      expect(dialog?.className).toContain("bg-popover");
      expect(dialog?.className).toContain("text-popover-foreground");
      expect(close).not.toBeNull();
      expect(title?.textContent).toBe("Title");
      expect(description?.textContent).toBe("Description");

      await act(async () => {
        root.unmount();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      harness.restore();
    }
  });
});
