import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createPortal } from "react-dom";
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

  test("uses portal open order instead of structural depth and restores each trigger", async () => {
    const harness = setupJsdom();

    try {
      const { OverlayLayerBoundary, OverlayStackProvider, useOverlayOwner } = await import(
        "../src/ui/OverlayStack"
      );
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      function IndependentPortals() {
        const [earlierOpen, setEarlierOpen] = useState(false);
        const [laterOpen, setLaterOpen] = useState(false);
        const earlierOwner = useOverlayOwner({
          active: earlierOpen,
          label: "Earlier independent portal",
          onDismiss: () => setEarlierOpen(false),
          restoreFocus: () =>
            container.querySelector<HTMLElement>('[aria-label="Open earlier portal"]'),
        });
        const laterOwner = useOverlayOwner({
          active: laterOpen,
          label: "Later independent portal",
          onDismiss: () => setLaterOpen(false),
          restoreFocus: () =>
            container.querySelector<HTMLElement>('[aria-label="Open later portal"]'),
        });
        return createElement(
          "div",
          null,
          createElement(
            "button",
            {
              "aria-label": "Open earlier portal",
              onClick: () => setEarlierOpen(true),
              type: "button",
            },
            "Open earlier portal",
          ),
          createElement(
            "button",
            {
              "aria-label": "Open later portal",
              onClick: () => setLaterOpen(true),
              type: "button",
            },
            "Open later portal",
          ),
          createElement(
            OverlayLayerBoundary,
            null,
            earlierOpen
              ? createPortal(
                  createElement(
                    "div",
                    {
                      "data-testid": "earlier-independent-portal",
                      role: "dialog",
                      style: { zIndex: earlierOwner?.zIndex },
                    },
                    "Earlier independent portal",
                  ),
                  harness.dom.window.document.body,
                )
              : null,
          ),
          laterOpen
            ? createPortal(
                createElement(
                  "div",
                  {
                    "data-testid": "later-independent-portal",
                    role: "dialog",
                    style: { zIndex: laterOwner?.zIndex },
                  },
                  "Later independent portal",
                ),
                harness.dom.window.document.body,
              )
            : null,
        );
      }

      await act(async () => {
        root.render(createElement(OverlayStackProvider, null, createElement(IndependentPortals)));
      });

      const earlierTrigger = container.querySelector('[aria-label="Open earlier portal"]');
      const laterTrigger = container.querySelector('[aria-label="Open later portal"]');
      if (
        !(earlierTrigger instanceof harness.dom.window.HTMLButtonElement) ||
        !(laterTrigger instanceof harness.dom.window.HTMLButtonElement)
      ) {
        throw new Error("missing portal triggers");
      }
      earlierTrigger.focus();
      await act(async () => {
        earlierTrigger.click();
        await Promise.resolve();
        await new Promise<void>((resolve) =>
          harness.dom.window.requestAnimationFrame(() => resolve()),
        );
      });
      laterTrigger.focus();
      await act(async () => {
        laterTrigger.click();
        await Promise.resolve();
        await new Promise<void>((resolve) =>
          harness.dom.window.requestAnimationFrame(() => resolve()),
        );
      });

      const earlierPortal = harness.dom.window.document.querySelector(
        '[data-testid="earlier-independent-portal"]',
      );
      const laterPortal = harness.dom.window.document.querySelector(
        '[data-testid="later-independent-portal"]',
      );
      if (
        !(earlierPortal instanceof harness.dom.window.HTMLElement) ||
        !(laterPortal instanceof harness.dom.window.HTMLElement)
      ) {
        throw new Error("missing independent portals");
      }
      expect(Number(laterPortal.style.zIndex)).toBeGreaterThan(Number(earlierPortal.style.zIndex));

      await dispatchEscape(harness.dom.window);
      expect(
        harness.dom.window.document.querySelector('[data-testid="later-independent-portal"]'),
      ).toBeNull();
      expect(
        harness.dom.window.document.querySelector('[data-testid="earlier-independent-portal"]'),
      ).not.toBeNull();
      expect(harness.dom.window.document.activeElement).toBe(laterTrigger);

      await dispatchEscape(harness.dom.window);
      expect(
        harness.dom.window.document.querySelector('[data-testid="earlier-independent-portal"]'),
      ).toBeNull();
      expect(harness.dom.window.document.activeElement).toBe(earlierTrigger);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("lets an editable control consume Escape before its owning surface", async () => {
    const harness = setupJsdom();

    try {
      const { isEditableEscapeTarget, OverlayStackProvider, useOverlayOwner } = await import(
        "../src/ui/OverlayStack"
      );
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
      expect(isEditableEscapeTarget(harness.dom.window)).toBe(true);
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

      input.blur();
      await dispatchEscape(harness.dom.window);
      expect(container.querySelector('[data-testid="editable-surface"]')).toBeNull();

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("custom editable overlays dismiss only after they become topmost", async () => {
    const harness = setupJsdom();

    try {
      const { OverlayLayerBoundary, OverlayStackProvider, useOverlayOwner } = await import(
        "../src/ui/OverlayStack"
      );
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      function CompetingCustomPortals() {
        const [editorOpen, setEditorOpen] = useState(false);
        const [competingOpen, setCompetingOpen] = useState(false);
        const editorOwner = useOverlayOwner({
          active: editorOpen,
          label: "Editable custom portal",
          onDismiss: () => setEditorOpen(false),
          restoreFocus: () =>
            container.querySelector<HTMLElement>('[aria-label="Open custom editor"]'),
        });
        const competingOwner = useOverlayOwner({
          active: competingOpen,
          label: "Competing custom portal",
          onDismiss: () => setCompetingOpen(false),
          restoreFocus: () =>
            container.querySelector<HTMLElement>('[aria-label="Open competing portal"]'),
        });
        return createElement(
          "div",
          null,
          createElement(
            "button",
            {
              "aria-label": "Open custom editor",
              onClick: () => setEditorOpen(true),
              type: "button",
            },
            "Open editor",
          ),
          createElement(
            "button",
            {
              "aria-label": "Open competing portal",
              onClick: () => setCompetingOpen(true),
              type: "button",
            },
            "Open competitor",
          ),
          createElement(
            OverlayLayerBoundary,
            null,
            editorOpen
              ? createPortal(
                  createElement(
                    "div",
                    {
                      "data-testid": "custom-editor",
                      role: "dialog",
                      style: { zIndex: editorOwner?.zIndex },
                    },
                    createElement("input", {
                      "aria-label": "Custom editor input",
                      onKeyDown: (event) => {
                        if (event.key === "Escape") editorOwner?.handleEscape(event);
                      },
                    }),
                  ),
                  harness.dom.window.document.body,
                )
              : null,
          ),
          competingOpen
            ? createPortal(
                createElement(
                  "div",
                  {
                    "data-testid": "competing-portal",
                    role: "dialog",
                    style: { zIndex: competingOwner?.zIndex },
                  },
                  "Competing portal",
                ),
                harness.dom.window.document.body,
              )
            : null,
        );
      }

      await act(async () => {
        root.render(
          createElement(OverlayStackProvider, null, createElement(CompetingCustomPortals)),
        );
      });
      const editorTrigger = container.querySelector('[aria-label="Open custom editor"]');
      const competingTrigger = container.querySelector('[aria-label="Open competing portal"]');
      if (
        !(editorTrigger instanceof harness.dom.window.HTMLButtonElement) ||
        !(competingTrigger instanceof harness.dom.window.HTMLButtonElement)
      ) {
        throw new Error("missing custom portal triggers");
      }
      editorTrigger.focus();
      await act(async () => editorTrigger.click());
      competingTrigger.focus();
      await act(async () => competingTrigger.click());

      const input = harness.dom.window.document.querySelector(
        'input[aria-label="Custom editor input"]',
      );
      if (!(input instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing custom editor input");
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
      expect(
        harness.dom.window.document.querySelector('[data-testid="custom-editor"]'),
      ).not.toBeNull();
      expect(
        harness.dom.window.document.querySelector('[data-testid="competing-portal"]'),
      ).not.toBeNull();

      input.blur();
      await dispatchEscape(harness.dom.window);
      expect(
        harness.dom.window.document.querySelector('[data-testid="competing-portal"]'),
      ).toBeNull();
      expect(
        harness.dom.window.document.querySelector('[data-testid="custom-editor"]'),
      ).not.toBeNull();

      input.focus();
      await act(async () => {
        input.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await Promise.resolve();
        await new Promise<void>((resolve) =>
          harness.dom.window.requestAnimationFrame(() => resolve()),
        );
      });
      expect(harness.dom.window.document.querySelector('[data-testid="custom-editor"]')).toBeNull();
      expect(harness.dom.window.document.activeElement).toBe(editorTrigger);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });
});
