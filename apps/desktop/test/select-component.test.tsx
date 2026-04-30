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
        createElement(SelectTrigger, { "aria-label": "Select value" }, createElement(SelectValue)),
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

function DialogWithSelectAndField() {
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
        createElement(SelectTrigger, { "aria-label": "Select value" }, createElement(SelectValue)),
        createElement(
          SelectContent,
          null,
          createElement(SelectItem, { value: "alpha" }, "Alpha"),
          createElement(SelectItem, { value: "beta" }, "Beta"),
        ),
      ),
      createElement("button", { "aria-label": "Next field", type: "button" }, "Next field"),
    ),
  );
}

function PositionedSelect() {
  return createElement(
    Select,
    { defaultValue: "alpha" },
    createElement(SelectTrigger, { "aria-label": "Select value" }, createElement(SelectValue)),
    createElement(
      SelectContent,
      null,
      createElement(SelectItem, { value: "alpha" }, "Alpha"),
      createElement(SelectItem, { value: "beta" }, "Beta"),
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

  test.serial("clamps menu height to the available viewport space", async () => {
    const harness = setupJsdom({
      setupWindow: (dom) => {
        Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 100 });
        Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 320 });
      },
    });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(PositionedSelect));
      });

      const selectTrigger = harness.dom.window.document.querySelector(
        '[data-slot="select-trigger"]',
      );
      if (!(selectTrigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing select trigger");
      }

      selectTrigger.getBoundingClientRect = () =>
        ({
          bottom: 55,
          height: 10,
          left: 20,
          right: 180,
          top: 45,
          width: 160,
          x: 20,
          y: 45,
          toJSON: () => ({}),
        }) as DOMRect;

      await act(async () => {
        selectTrigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const viewport = harness.dom.window.document.querySelector('[data-slot="select-viewport"]');
      if (!(viewport instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing select viewport");
      }

      expect(viewport.style.maxHeight).toBe("31px");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("does not add every option to the tab order", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(PositionedSelect));
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

      const items = Array.from(
        harness.dom.window.document.querySelectorAll('[data-slot="select-item"]'),
      );
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.getAttribute("tabindex") === "-1")).toBe(true);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("opens from the focused trigger with arrow keys", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(PositionedSelect));
      });

      const selectTrigger = harness.dom.window.document.querySelector(
        '[data-slot="select-trigger"]',
      );
      if (!(selectTrigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing select trigger");
      }

      await act(async () => {
        selectTrigger.focus();
        selectTrigger.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "ArrowDown",
          }),
        );
      });

      expect(
        harness.dom.window.document.querySelector('[data-slot="select-content"]'),
      ).not.toBeNull();

      const items = Array.from(
        harness.dom.window.document.querySelectorAll('[data-slot="select-item"]'),
      );
      expect(items).toHaveLength(2);
      expect(harness.dom.window.document.activeElement).toBe(items[0]);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("closes the open menu when tabbing away from the select", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(PositionedSelect));
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

      expect(
        harness.dom.window.document.querySelector('[data-slot="select-content"]'),
      ).not.toBeNull();

      await act(async () => {
        selectTrigger.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Tab" }),
        );
      });

      expect(harness.dom.window.document.querySelector('[data-slot="select-content"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("preserves dialog tab progression when tabbing out from an open option", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(DialogWithSelectAndField));
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
      const nextField = harness.dom.window.document.querySelector('[aria-label="Next field"]');
      if (!(selectItem instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing select item");
      }
      if (!(nextField instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing next field");
      }

      await act(async () => {
        selectItem.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Tab",
          }),
        );
      });

      expect(harness.dom.window.document.querySelector('[data-slot="select-content"]')).toBeNull();
      expect(harness.dom.window.document.activeElement).toBe(nextField);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial(
    "does not wrap page focus when tabbing from the last open select outside a dialog",
    async () => {
      const harness = setupJsdom();

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) {
          throw new Error("missing root");
        }

        const root = createRoot(container);

        await act(async () => {
          root.render(
            createElement(
              "div",
              null,
              createElement("button", { id: "first-button", type: "button" }, "First"),
              createElement(PositionedSelect),
            ),
          );
        });

        const selectTrigger = harness.dom.window.document.querySelector(
          '[data-slot="select-trigger"]',
        );
        if (!(selectTrigger instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing select trigger");
        }

        await act(async () => {
          selectTrigger.dispatchEvent(
            new harness.dom.window.MouseEvent("click", { bubbles: true }),
          );
        });

        const selectItem = harness.dom.window.document.querySelector('[data-slot="select-item"]');
        const firstButton = harness.dom.window.document.getElementById("first-button");
        if (!(selectItem instanceof harness.dom.window.HTMLDivElement)) {
          throw new Error("missing select item");
        }
        if (!(firstButton instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing first button");
        }

        await act(async () => {
          selectItem.dispatchEvent(
            new harness.dom.window.KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              key: "Tab",
            }),
          );
        });

        expect(
          harness.dom.window.document.querySelector('[data-slot="select-content"]'),
        ).toBeNull();
        expect(harness.dom.window.document.activeElement).not.toBe(firstButton);

        await act(async () => {
          root.unmount();
        });
      } finally {
        harness.restore();
      }
    },
  );

  test.serial("closes the open menu when focus leaves the select", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            "div",
            null,
            createElement(PositionedSelect),
            createElement("button", { id: "outside-button", type: "button" }, "Outside"),
          ),
        );
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

      expect(
        harness.dom.window.document.querySelector('[data-slot="select-content"]'),
      ).not.toBeNull();

      const outsideButton = harness.dom.window.document.getElementById("outside-button");
      if (!(outsideButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing outside button");
      }

      await act(async () => {
        outsideButton.focus();
      });

      expect(harness.dom.window.document.querySelector('[data-slot="select-content"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
