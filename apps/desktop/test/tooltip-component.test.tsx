import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { Tooltip, TooltipContent, TooltipTrigger } = await import(
  new URL("../src/components/ui/tooltip.tsx?tooltip-component-test", import.meta.url).href
);

function OpenTooltip() {
  return createElement(
    Tooltip,
    { defaultOpen: true },
    createElement(TooltipTrigger, null, "Trigger"),
    createElement(TooltipContent, null, "Tooltip content"),
  );
}

describe("desktop tooltip component", () => {
  test.serial("links trigger and content with tooltip semantics", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(OpenTooltip));
      });

      const trigger = harness.dom.window.document.querySelector('[data-slot="tooltip-trigger"]');
      const tooltip = harness.dom.window.document.querySelector('[data-slot="tooltip-content"]');
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing tooltip trigger");
      }
      if (!(tooltip instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing tooltip content");
      }

      expect(tooltip.getAttribute("role")).toBe("tooltip");
      expect(tooltip.id).toBeTruthy();
      expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("clamps the rendered tooltip box inside the viewport", async () => {
    const harness = setupJsdom({
      setupWindow: (dom) => {
        Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 80 });
        Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 120 });
      },
    });

    try {
      const elementRect = harness.dom.window.HTMLElement.prototype.getBoundingClientRect;
      harness.dom.window.HTMLElement.prototype.getBoundingClientRect = function getRect() {
        if (this.getAttribute("data-slot") === "tooltip-content") {
          return {
            bottom: 28,
            height: 20,
            left: 8,
            right: 108,
            top: 8,
            width: 100,
            x: 8,
            y: 8,
            toJSON: () => ({}),
          } as DOMRect;
        }

        return {
          bottom: 30,
          height: 10,
          left: 2,
          right: 22,
          top: 20,
          width: 20,
          x: 2,
          y: 20,
          toJSON: () => ({}),
        } as DOMRect;
      };

      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(OpenTooltip));
      });

      const tooltip = harness.dom.window.document.querySelector('[data-slot="tooltip-content"]');
      if (!(tooltip instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing tooltip content");
      }

      expect(tooltip.style.left).toBe("8px");
      expect(tooltip.style.top).toBe("8px");
      expect(tooltip.style.transform).toBe("");

      await act(async () => {
        root.unmount();
      });
      harness.dom.window.HTMLElement.prototype.getBoundingClientRect = elementRect;
    } finally {
      harness.restore();
    }
  });
});
