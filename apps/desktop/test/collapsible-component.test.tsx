import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { Collapsible, CollapsibleTrigger } = await import(
  new URL("../src/components/ui/collapsible.tsx?collapsible-component-test", import.meta.url).href
);

function CollapsibleClassNameFixture({ asChild }: { asChild: boolean }) {
  return createElement(
    Collapsible,
    null,
    createElement(
      CollapsibleTrigger,
      {
        asChild,
        className: "trigger-class",
        "data-testid": asChild ? "as-child-trigger" : "button-trigger",
      },
      asChild
        ? createElement("button", { className: "child-class", type: "button" }, "Toggle")
        : "Toggle",
    ),
  );
}

describe("desktop collapsible component", () => {
  test.serial("applies trigger className in the button fallback path", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(CollapsibleClassNameFixture, { asChild: false }));
      });

      const trigger = harness.dom.window.document.querySelector("[data-testid='button-trigger']");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing button trigger");
      }

      expect(trigger.className).toContain("trigger-class");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("merges child and trigger className in the asChild path", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(CollapsibleClassNameFixture, { asChild: true }));
      });

      const trigger = harness.dom.window.document.querySelector("[data-testid='as-child-trigger']");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing asChild trigger");
      }

      expect(trigger.className).toContain("child-class");
      expect(trigger.className).toContain("trigger-class");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
