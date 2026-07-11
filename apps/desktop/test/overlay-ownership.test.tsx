import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

async function dispatchEscape(window: Window): Promise<KeyboardEvent> {
  const event = new window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
  return event;
}

describe("desktop overlay ownership", () => {
  test("dismisses one nested Radix surface at a time", async () => {
    const harness = setupJsdom();

    try {
      const { OverlayStackProvider } = await import("../src/ui/OverlayStack");
      const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
        "../src/components/ui/dialog"
      );
      const { Popover, PopoverContent, PopoverTrigger } = await import(
        "../src/components/ui/popover"
      );
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      function NestedSurfaces() {
        const [dialogOpen, setDialogOpen] = useState(true);
        const [popoverOpen, setPopoverOpen] = useState(true);
        return createElement(
          Dialog,
          { open: dialogOpen, onOpenChange: setDialogOpen },
          createElement(
            DialogContent,
            null,
            createElement(DialogTitle, null, "Parent dialog"),
            createElement(DialogDescription, null, "Nested ownership test"),
            createElement(
              Popover,
              { open: popoverOpen, onOpenChange: setPopoverOpen },
              createElement(PopoverTrigger, null, "Nested popover trigger"),
              createElement(PopoverContent, null, "Nested popover"),
            ),
          ),
        );
      }

      await act(async () => {
        root.render(createElement(OverlayStackProvider, null, createElement(NestedSurfaces)));
      });

      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="dialog-content"][data-state="open"]',
        ),
      ).not.toBeNull();
      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="popover-content"][data-state="open"]',
        ),
      ).not.toBeNull();

      const firstEscape = await dispatchEscape(harness.dom.window);
      expect(firstEscape.defaultPrevented).toBe(true);
      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="popover-content"][data-state="open"]',
        ),
      ).toBeNull();
      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="dialog-content"][data-state="open"]',
        ),
      ).not.toBeNull();
      await dispatchEscape(harness.dom.window);
      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="dialog-content"][data-state="open"]',
        ),
      ).toBeNull();
      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("lets an editable control consume Escape before its owning surface", async () => {
    const harness = setupJsdom();

    try {
      const { OverlayStackProvider, useOverlayOwner } = await import("../src/ui/OverlayStack");
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      function EditableSurface() {
        const [open, setOpen] = useState(true);
        const [editing, setEditing] = useState(true);
        useOverlayOwner({
          active: open,
          label: "Editable surface",
          onDismiss: () => setOpen(false),
        });
        return open
          ? createElement(
              "div",
              { "data-testid": "editable-surface" },
              createElement("input", {
                "aria-label": "Rename",
                onKeyDown: (event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(false);
                },
              }),
              createElement("output", null, editing ? "editing" : "cancelled"),
            )
          : null;
      }

      await act(async () => {
        root.render(createElement(OverlayStackProvider, null, createElement(EditableSurface)));
      });

      const input = container.querySelector('input[aria-label="Rename"]');
      if (!(input instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing rename input");
      }
      input.focus();
      await act(async () => {
        input.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
      });

      expect(container.querySelector('[data-testid="editable-surface"]')).not.toBeNull();
      expect(container.textContent).toContain("cancelled");

      await dispatchEscape(harness.dom.window);
      expect(container.querySelector('[data-testid="editable-surface"]')).toBeNull();

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });
});
