import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { Dialog, DialogContent, DialogTrigger } = await import(
  new URL("../src/components/ui/dialog.tsx?dialog-component-test", import.meta.url).href,
);

type TestDialogProps = {
  preventOutsideClose?: boolean;
};

function TestDialog({ preventOutsideClose = false }: TestDialogProps) {
  const [open, setOpen] = useState(false);

  return createElement(
    Dialog,
    { open, onOpenChange: setOpen },
    createElement(DialogTrigger, null, "Open dialog"),
    createElement(
      DialogContent,
      {
        onInteractOutside: preventOutsideClose
          ? (event) => {
              event.preventDefault();
            }
          : undefined,
      },
      createElement("button", { id: "first-field", type: "button" }, "First button"),
      createElement("button", { id: "last-button", type: "button" }, "Last button"),
    ),
  );
}

describe("desktop dialog component", () => {
  test.serial("moves focus into the dialog and restores it to the trigger on close", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(TestDialog));
      });

      const trigger = harness.dom.window.document.querySelector("button");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing trigger button");
      }

      await act(async () => {
        trigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const firstField = harness.dom.window.document.getElementById("first-field");
      expect(harness.dom.window.document.activeElement).toBe(firstField);

      await act(async () => {
        harness.dom.window.document.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(harness.dom.window.document.querySelector("[role='dialog']")).toBeNull();
      const restoredTrigger = harness.dom.window.document.querySelector("#root > button");
      expect(harness.dom.window.document.activeElement).toBe(restoredTrigger);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("traps focus within the dialog when tabbing", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(TestDialog));
      });

      const trigger = harness.dom.window.document.querySelector("button");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing trigger button");
      }

      await act(async () => {
        trigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const firstField = harness.dom.window.document.getElementById("first-field");
      const lastButton = harness.dom.window.document.getElementById("last-button");
      if (!(firstField instanceof harness.dom.window.HTMLElement) || !(lastButton instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing focusable dialog elements");
      }

      lastButton.focus();
      await act(async () => {
        harness.dom.window.document.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Tab" }),
        );
      });
      expect(harness.dom.window.document.activeElement).toBe(firstField);

      firstField.focus();
      await act(async () => {
        harness.dom.window.document.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Tab", shiftKey: true }),
        );
      });
      expect(harness.dom.window.document.activeElement).toBe(lastButton);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("still closes on Escape after an outside interaction is prevented", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(TestDialog, { preventOutsideClose: true }));
      });

      const trigger = harness.dom.window.document.querySelector("button");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing trigger button");
      }

      await act(async () => {
        trigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const overlay = harness.dom.window.document.querySelector("[data-slot='dialog-overlay']");
      if (!(overlay instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing dialog overlay");
      }

      await act(async () => {
        overlay.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });
      expect(harness.dom.window.document.querySelector("[role='dialog']")).not.toBeNull();

      await act(async () => {
        harness.dom.window.document.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(harness.dom.window.document.querySelector("[role='dialog']")).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
