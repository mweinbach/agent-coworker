import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { Progress } from "../src/components/ui/progress";
import { setupJsdom } from "./jsdomHarness";

describe("Progress", () => {
  let harness: ReturnType<typeof setupJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    harness = setupJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    harness.restore();
  });

  test("indeterminate mode renders the indeterminate slug and aria-busy", () => {
    act(() => {
      root.render(createElement(Progress, { indeterminate: true }));
    });
    const root2 = container.querySelector("[data-slot='progress']");
    expect(root2).toBeTruthy();
    // aria-busy must be set so screen readers announce activity without a fake %.
    expect(root2?.getAttribute("aria-busy")).toBe("true");
    // The indeterminate slug must be present (no determinate value transform).
    const slug = container.querySelector("[data-slot='progress-indeterminate']");
    expect(slug).toBeTruthy();
    // Determinate indicator must NOT render in indeterminate mode.
    expect(container.querySelector("[data-slot='progress-indicator']")).toBeFalsy();
  });

  test("determinate mode renders the Radix indicator with a value transform", () => {
    act(() => {
      root.render(createElement(Progress, { value: 40 }));
    });
    const indicator = container.querySelector("[data-slot='progress-indicator']");
    expect(indicator).toBeTruthy();
    // No indeterminate slug in determinate mode.
    expect(container.querySelector("[data-slot='progress-indeterminate']")).toBeFalsy();
  });
});
