import { expect, test } from "bun:test";
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/components/ui/dropdown-menu";
import { AdaptiveRailSurface } from "../src/ui/layout/AdaptiveRailSurface";
import { OverlayStackProvider } from "../src/ui/OverlayStack";
import { setupJsdom } from "./jsdomHarness";

test.serial(
  "adaptive overlay rails trap focus, close with Escape, and restore the trigger",
  async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      function Harness() {
        const [open, setOpen] = useState(false);
        return createElement(
          OverlayStackProvider,
          null,
          createElement(
            "button",
            { type: "button", onClick: () => setOpen((value) => !value) },
            "Open navigation",
          ),
          createElement(
            AdaptiveRailSurface,
            {
              active: open,
              label: "Navigation",
              onClose: () => setOpen(false),
              overlay: true,
              side: "left",
              width: 280,
            },
            createElement("button", { type: "button" }, "New chat"),
          ),
        );
      }

      await act(async () => root.render(createElement(Harness)));
      const trigger = container.querySelector<HTMLButtonElement>("button");
      if (!trigger) throw new Error("missing trigger");

      trigger.focus();
      await act(async () => trigger.click());
      await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));

      const drawer = harness.dom.window.document.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="Navigation"]',
      );
      const close = drawer?.querySelector<HTMLButtonElement>('[aria-label="Close Navigation"]');
      expect(drawer).not.toBeNull();
      expect(drawer?.hasAttribute("inert")).toBe(false);
      expect(close).toBe(harness.dom.window.document.activeElement);

      await act(async () => {
        close?.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            key: "Tab",
            shiftKey: true,
          }),
        );
      });
      const newChat = Array.from(drawer?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "New chat",
      );
      expect(newChat).toBe(harness.dom.window.document.activeElement);

      await act(async () => {
        newChat?.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Tab" }),
        );
      });
      expect(close).toBe(harness.dom.window.document.activeElement);

      await act(async () => trigger.focus());
      expect(close).toBe(harness.dom.window.document.activeElement);

      await act(async () => trigger.click());
      await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(drawer?.getAttribute("aria-hidden")).toBe("true");
      expect(trigger).toBe(harness.dom.window.document.activeElement);

      await act(async () => trigger.click());
      await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(close).toBe(harness.dom.window.document.activeElement);

      const portaledMenu = harness.dom.window.document.createElement("div");
      portaledMenu.dataset.overlayLayerSequence = "999";
      const portaledAction = harness.dom.window.document.createElement("button");
      portaledAction.textContent = "Portaled action";
      portaledMenu.append(portaledAction);
      harness.dom.window.document.body.append(portaledMenu);
      await act(async () => portaledAction.focus());
      expect(portaledAction).toBe(harness.dom.window.document.activeElement);

      await act(async () => trigger.focus());
      expect(close).toBe(harness.dom.window.document.activeElement);

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));

      expect(drawer?.getAttribute("aria-hidden")).toBe("true");
      expect(drawer?.hasAttribute("inert")).toBe(true);
      expect(trigger).toBe(harness.dom.window.document.activeElement);

      await act(async () => trigger.click());
      await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));
      const backdrop = harness.dom.window.document.body.querySelector<HTMLElement>(
        '[data-slot="adaptive-rail-backdrop"]',
      );
      expect(backdrop).not.toBeNull();
      expect(backdrop?.parentElement).toBe(drawer?.parentElement);
      await act(async () => {
        backdrop?.dispatchEvent(
          new harness.dom.window.PointerEvent("pointerdown", { bubbles: true }),
        );
      });
      await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(drawer?.getAttribute("aria-hidden")).toBe("true");
      expect(trigger).toBe(harness.dom.window.document.activeElement);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  },
);

test.serial("adaptive overlay rails permit focus in nested portaled menus", async () => {
  const harness = setupJsdom({ includeAnimationFrame: true });

  try {
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          OverlayStackProvider,
          null,
          createElement(
            AdaptiveRailSurface,
            {
              active: true,
              label: "Navigation",
              onClose: () => {},
              overlay: true,
              side: "left",
              width: 280,
            },
            createElement(
              DropdownMenu,
              { open: true },
              createElement(DropdownMenuTrigger, null, "Actions"),
              createElement(
                DropdownMenuContent,
                null,
                createElement(DropdownMenuItem, null, "Rename"),
              ),
            ),
          ),
        ),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const menu = harness.dom.window.document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-content"]',
    );
    const menuItem = harness.dom.window.document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-item"]',
    );
    expect(Number(menu?.dataset.overlayLayerSequence)).toBeGreaterThan(0);
    if (!menuItem) throw new Error("missing portaled menu item");

    await act(async () => menuItem.focus());
    expect(menuItem).toBe(harness.dom.window.document.activeElement);

    await act(async () => root.unmount());
  } finally {
    harness.restore();
  }
});

test.serial("adaptive rails restore focus when an active overlay becomes inline", async () => {
  const harness = setupJsdom({ includeAnimationFrame: true });
  let setOverlayMode: ((overlay: boolean) => void) | null = null;

  try {
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    function Harness() {
      const [overlay, setOverlay] = useState(false);
      setOverlayMode = setOverlay;
      return createElement(
        OverlayStackProvider,
        null,
        createElement("button", { type: "button" }, "Resize trigger"),
        createElement(
          AdaptiveRailSurface,
          {
            active: true,
            label: "Navigation",
            onClose: () => {},
            overlay,
            side: "left",
            width: 280,
          },
          createElement("button", { type: "button" }, "New chat"),
        ),
      );
    }

    await act(async () => root.render(createElement(Harness)));
    const trigger = container.querySelector<HTMLButtonElement>("button");
    if (!trigger || !setOverlayMode) throw new Error("missing adaptive rail controls");
    trigger.focus();

    await act(async () => setOverlayMode?.(true));
    await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(harness.dom.window.document.activeElement?.getAttribute("aria-label")).toBe(
      "Close Navigation",
    );

    await act(async () => setOverlayMode?.(false));
    await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(trigger).toBe(harness.dom.window.document.activeElement);

    await act(async () => root.unmount());
  } finally {
    harness.restore();
  }
});

test.serial(
  "switching a rail between inline and overlay keeps its live child mounted",
  async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let mounts = 0;
    let unmounts = 0;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      function LiveChild() {
        useEffect(() => {
          mounts += 1;
          return () => {
            unmounts += 1;
          };
        }, []);
        return createElement("textarea", { defaultValue: "Unsaved Canvas text" });
      }

      function Harness() {
        const [overlay, setOverlay] = useState(false);
        return createElement(
          OverlayStackProvider,
          null,
          createElement(
            "button",
            { type: "button", onClick: () => setOverlay((value) => !value) },
            "Change tier",
          ),
          createElement(
            AdaptiveRailSurface,
            {
              active: true,
              label: "Canvas",
              onClose: () => {},
              overlay,
              side: "right",
              width: 400,
            },
            createElement(LiveChild),
          ),
        );
      }

      await act(async () => root.render(createElement(Harness)));
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
      const toggle = container.querySelector<HTMLButtonElement>("button");
      if (!textarea || !toggle) throw new Error("missing adaptive rail controls");
      textarea.value = "Locally edited Canvas text";

      await act(async () => toggle.click());
      expect(mounts).toBe(1);
      expect(unmounts).toBe(0);
      expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
        "Locally edited Canvas text",
      );

      await act(async () => toggle.click());
      expect(mounts).toBe(1);
      expect(unmounts).toBe(0);

      await act(async () => root.unmount());
      expect(unmounts).toBe(1);
    } finally {
      harness.restore();
    }
  },
);
