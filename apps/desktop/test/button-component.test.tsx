import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
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
});
