import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { Button, buttonVariants } from "../src/components/ui/button";
import { setupJsdom } from "./jsdomHarness";

describe("desktop button component", () => {
  test("uses the stock shadcn variant contract", () => {
    expect(buttonVariants({ variant: "default" })).toContain("bg-primary");
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-secondary");
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-destructive");
    expect(buttonVariants({ variant: "outline" })).toContain("border");
    expect(buttonVariants({ variant: "ghost" })).toContain("hover:bg-accent");
    expect(buttonVariants({ variant: "link" })).toContain("underline");
  });

  test("renders stock data attributes and click behavior", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");

      const root = createRoot(container);
      let clickCount = 0;

      await act(async () => {
        root.render(
          createElement(
            Button,
            {
              variant: "secondary",
              size: "sm",
              onClick: () => {
                clickCount += 1;
              },
            },
            "Press me",
          ),
        );
      });

      const button = harness.dom.window.document.querySelector("button");
      if (!(button instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing rendered button");
      }

      expect(button.dataset.slot).toBe("button");
      expect(button.dataset.variant).toBe("secondary");
      expect(button.dataset.size).toBe("sm");

      await act(async () => {
        button.click();
      });

      expect(clickCount).toBe(1);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("composes asChild through Radix Slot", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");

      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            Button,
            { asChild: true, className: "custom-link" },
            createElement("a", { href: "#target", id: "child-link" }, "Child link"),
          ),
        );
      });

      const link = harness.dom.window.document.getElementById("child-link");
      if (!(link instanceof harness.dom.window.HTMLAnchorElement)) {
        throw new Error("missing child link");
      }

      expect(link.dataset.slot).toBe("button");
      expect(link.className).toContain("custom-link");
      expect(link.className).toContain("bg-primary");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
