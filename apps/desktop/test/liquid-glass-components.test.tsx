import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const {
  LiquidGlassBadge,
  LiquidGlassButton,
  LiquidGlassCard,
  LiquidGlassCardContent,
  LiquidGlassCardHeader,
  LiquidGlassCardTitle,
  LiquidGlassDialog,
  LiquidGlassDialogContent,
  LiquidGlassDialogDescription,
  LiquidGlassDialogTitle,
  LiquidGlassField,
  LiquidGlassFieldDescription,
  LiquidGlassFieldLabel,
  LiquidGlassInput,
  LiquidGlassTabs,
  LiquidGlassTabsContent,
  LiquidGlassTabsList,
  LiquidGlassTabsTrigger,
  LiquidGlassToolbar,
  LiquidGlassToolbarGroup,
} = await import("../src/components/liquid-dom");
const { LiquidGlassPage } = await import("../src/ui/settings/pages/LiquidGlassPage");

describe("liquid glass components", () => {
  test("render accessible fallback markup when WebGPU is unavailable", async () => {
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(
          createElement(
            "div",
            null,
            createElement(
              LiquidGlassCard,
              null,
              createElement(
                LiquidGlassCardHeader,
                null,
                createElement(LiquidGlassCardTitle, null, "Glass card"),
              ),
              createElement(LiquidGlassCardContent, null, "Glass content"),
            ),
            createElement(LiquidGlassButton, { type: "button" }, "Glass button"),
            createElement(LiquidGlassBadge, null, "Glass badge"),
            createElement(
              LiquidGlassToolbar,
              null,
              createElement(LiquidGlassToolbarGroup, null, createElement("span", null, "Tool")),
            ),
            createElement(
              LiquidGlassField,
              null,
              createElement(LiquidGlassFieldLabel, { htmlFor: "prompt" }, "Prompt"),
              createElement(LiquidGlassInput, { id: "prompt", placeholder: "Ask" }),
              createElement(LiquidGlassFieldDescription, null, "Describe the request."),
            ),
            createElement(
              LiquidGlassTabs,
              { defaultValue: "one" },
              createElement(
                LiquidGlassTabsList,
                { "aria-label": "Example tabs" },
                createElement(LiquidGlassTabsTrigger, { value: "one" }, "One"),
              ),
              createElement(LiquidGlassTabsContent, { value: "one" }, "Tab content"),
            ),
          ),
        );
      });

      expect(container.querySelectorAll('[data-liquid-glass-surface="fallback"]').length).toBe(6);
      expect(container.querySelector('[data-slot="liquid-glass-button"]')?.textContent).toBe(
        "Glass button",
      );
      expect(container.querySelector("input#prompt")?.getAttribute("placeholder")).toBe("Ask");
      expect(container.querySelector('[role="tab"]')?.textContent).toBe("One");

      await act(async () => {
        root?.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("gallery documents the liquid glass component family", async () => {
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(LiquidGlassPage));
      });

      expect(container.querySelector("[data-liquid-glass-gallery]")).not.toBeNull();
      expect(container.textContent).toContain("Liquid Glass component system");
      expect(container.textContent).toContain("Fallback renderer active");
      expect(container.textContent).toContain("Dialog");

      await act(async () => {
        root?.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("dialog content renders on the desktop portal layer", async () => {
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(
          createElement(
            LiquidGlassDialog,
            { open: true },
            createElement(
              LiquidGlassDialogContent,
              null,
              createElement(LiquidGlassDialogTitle, null, "Dialog title"),
              createElement(LiquidGlassDialogDescription, null, "Dialog description"),
            ),
          ),
        );
      });

      const dialogContent = harness.dom.window.document.querySelector(
        '[data-slot="liquid-glass-dialog-content"]',
      );
      const dialogOverlay = harness.dom.window.document.querySelector(
        '[data-slot="liquid-glass-dialog-overlay"]',
      );

      expect(dialogContent?.className).toContain("z-[var(--desktop-portal-layer)]");
      expect(dialogOverlay?.className).toContain("z-[var(--desktop-portal-layer)]");

      await act(async () => {
        root?.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
