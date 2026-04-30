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

function FocusedTooltip() {
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
      expect(trigger.hasAttribute("aria-expanded")).toBe(false);

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

  test.serial("repositions while open when the viewport changes", async () => {
    const harness = setupJsdom({
      setupWindow: (dom) => {
        Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 200 });
        Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 200 });
      },
    });

    try {
      let triggerLeft = 20;
      const elementRect = harness.dom.window.HTMLElement.prototype.getBoundingClientRect;
      harness.dom.window.HTMLElement.prototype.getBoundingClientRect = function getRect() {
        if (this.getAttribute("data-slot") === "tooltip-content") {
          return {
            bottom: 10,
            height: 10,
            left: 0,
            right: 20,
            top: 0,
            width: 20,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }

        return {
          bottom: 40,
          height: 20,
          left: triggerLeft,
          right: triggerLeft + 20,
          top: 20,
          width: 20,
          x: triggerLeft,
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

      expect(tooltip.style.left).toBe("20px");

      triggerLeft = 80;
      await act(async () => {
        harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize"));
      });

      expect(tooltip.style.left).toBe("80px");

      await act(async () => {
        root.unmount();
      });
      harness.dom.window.HTMLElement.prototype.getBoundingClientRect = elementRect;
    } finally {
      harness.restore();
    }
  });

  test.serial("dismisses a focused tooltip on Escape", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FocusedTooltip));
      });

      const trigger = harness.dom.window.document.querySelector('[data-slot="tooltip-trigger"]');
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing tooltip trigger");
      }

      await act(async () => {
        trigger.focus();
        trigger.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
      });

      expect(harness.dom.window.document.querySelector('[data-slot="tooltip-content"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("keeps hover tooltip open when pointer moves to the tooltip content", async () => {
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

      await act(async () => {
        trigger.dispatchEvent(
          new harness.dom.window.MouseEvent("mouseleave", {
            bubbles: true,
            relatedTarget: tooltip,
          }),
        );
        tooltip.dispatchEvent(new harness.dom.window.MouseEvent("mouseenter", { bubbles: true }));
      });

      await new Promise((resolve) => setTimeout(resolve, 140));

      expect(harness.dom.window.document.querySelector('[data-slot="tooltip-content"]')).toBe(
        tooltip,
      );

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
