import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { Dialog, DialogContent, DialogTrigger } = await import(
  new URL("../src/components/ui/dialog.tsx?select-component-test", import.meta.url).href
);
const { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = await import(
  new URL("../src/components/ui/select.tsx?select-component-test", import.meta.url).href
);

function DialogWithSelect() {
  const [open, setOpen] = useState(false);

  return createElement(
    Dialog,
    { open, onOpenChange: setOpen },
    createElement(DialogTrigger, null, "Open dialog"),
    createElement(
      DialogContent,
      null,
      createElement(
        Select,
        { defaultValue: "alpha" },
        createElement(
          SelectTrigger,
          { "aria-label": "Select value" },
          createElement(SelectValue),
        ),
        createElement(
          SelectContent,
          null,
          createElement(SelectItem, { value: "alpha" }, "Alpha"),
          createElement(SelectItem, { value: "beta" }, "Beta"),
        ),
      ),
    ),
  );
}

describe("desktop select component", () => {
  test.serial("Escape closes an open select without dismissing the parent dialog", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(DialogWithSelect));
      });

      const dialogTrigger = harness.dom.window.document.querySelector("#root > button");
      if (!(dialogTrigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing dialog trigger");
      }

      await act(async () => {
        dialogTrigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const selectTrigger = harness.dom.window.document.querySelector(
        '[data-slot="select-trigger"]',
      );
      if (!(selectTrigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing select trigger");
      }

      await act(async () => {
        selectTrigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const selectItem = harness.dom.window.document.querySelector('[data-slot="select-item"]');
      expect(selectItem).not.toBeNull();

      await act(async () => {
        selectItem?.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });

      expect(harness.dom.window.document.querySelector('[data-slot="select-content"]')).toBeNull();
      expect(harness.dom.window.document.querySelector("[role='dialog']")).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
