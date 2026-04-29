import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { Button, buttonVariants } from "../src/components/ui/button";
import { setupJsdom } from "./jsdomHarness";

describe("desktop button component", () => {
  test("buttonVariants includes variant styling for standalone usage", () => {
    expect(buttonVariants({ variant: "default" })).toContain("bg-primary");
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-muted/40");
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-destructive/10");
    expect(buttonVariants({ variant: "outline" })).toContain("border-border/70");
    expect(buttonVariants({ variant: "ghost" })).toContain("hover:bg-muted/40");
    expect(buttonVariants({ variant: "link" })).toContain("underline");
  });

  test("passes a real click event through onClick", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      const seen: {
        currentTargetTag: string;
        hasNativeEvent: boolean;
        targetTag: string;
        type: string;
      }[] = [];

      await act(async () => {
        root.render(
          createElement(
            Button,
            {
              onClick: (event) => {
                seen.push({
                  currentTargetTag: event.currentTarget.tagName,
                  hasNativeEvent: Boolean(event.nativeEvent),
                  targetTag: (event.target as HTMLElement).tagName,
                  type: event.type,
                });
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

      await act(async () => {
        button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({
        currentTargetTag: "BUTTON",
        hasNativeEvent: true,
        targetTag: "BUTTON",
        type: "click",
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("forwards refs in asChild mode", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      const refObject: { current: HTMLElement | null } = { current: null };

      await act(async () => {
        root.render(
          createElement(
            Button,
            { asChild: true, ref: refObject as unknown as React.Ref<HTMLButtonElement> },
            createElement("a", { href: "#target", id: "child-link" }, "Child link"),
          ),
        );
      });

      const link = harness.dom.window.document.getElementById("child-link");
      expect(refObject.current).toBe(link);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("defaults native buttons to type button", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      let submitCount = 0;

      await act(async () => {
        root.render(
          createElement(
            "form",
            {
              onSubmit: (event) => {
                event.preventDefault();
                submitCount += 1;
              },
            },
            createElement(Button, null, "Press me"),
          ),
        );
      });

      const button = harness.dom.window.document.querySelector("button");
      if (!(button instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing rendered button");
      }

      expect(button.type).toBe("button");

      await act(async () => {
        button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(submitCount).toBe(0);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("blocks activation for disabled asChild buttons", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      let clickCount = 0;
      let childClickCount = 0;

      await act(async () => {
        root.render(
          createElement(
            Button,
            {
              asChild: true,
              disabled: true,
              onClick: () => {
                clickCount += 1;
              },
            },
            createElement(
              "button",
              {
                id: "child-button",
                onClick: () => {
                  childClickCount += 1;
                },
                type: "button",
              },
              "Child button",
            ),
          ),
        );
      });

      const button = harness.dom.window.document.getElementById("child-button");
      if (!(button instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing child button");
      }

      expect(button.disabled).toBe(true);
      expect(button.tabIndex).toBe(-1);

      await act(async () => {
        button.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(clickCount).toBe(0);
      expect(childClickCount).toBe(0);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("preserves a child disabled prop when asChild button is not disabled", async () => {
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
            Button,
            { asChild: true },
            createElement(
              "button",
              {
                disabled: true,
                id: "child-button",
                type: "button",
              },
              "Child button",
            ),
          ),
        );
      });

      const button = harness.dom.window.document.getElementById("child-button");
      if (!(button instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing child button");
      }

      expect(button.disabled).toBe(true);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
