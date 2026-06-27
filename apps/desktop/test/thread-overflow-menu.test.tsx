import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ThreadOverflowMenu } from "../src/ui/sidebar/ThreadOverflowMenu";
import { setupJsdom } from "./jsdomHarness";

// The core accessibility win of ThreadOverflowMenu is that the trigger is a
// real, focusable <button> (replacing the previous hover-only affordance) so
// the per-thread actions are reachable by keyboard and touch. Radix
// DropdownMenu content portals into document.body via real pointer events,
// which jsdom does not fully simulate, so these tests focus on the trigger
// and on the menu wiring rather than the opened content.

describe("ThreadOverflowMenu", () => {
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

  function renderMenu(overrides: Partial<React.ComponentProps<typeof ThreadOverflowMenu>> = {}) {
    const props: React.ComponentProps<typeof ThreadOverflowMenu> = {
      canGenerateMemory: true,
      ariaLabelSuffix: "My thread",
      onRename: mock(() => {}),
      onArchive: mock(() => {}),
      onGenerateMemory: mock(() => {}),
      onDeleteHistory: mock(() => {}),
      ...overrides,
    };
    act(() => {
      root.render(createElement(ThreadOverflowMenu, props));
    });
    return props;
  }

  test("trigger is a focusable button with an accessible label", () => {
    renderMenu();
    const trigger = container.querySelector(
      "button[data-thread-overflow-trigger]",
    ) as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("aria-label")).toBe("More actions for My thread");
    // The trigger must be keyboard-focusable (not aria-hidden / disabled).
    expect(trigger.getAttribute("aria-hidden")).toBeFalsy();
    expect(trigger.disabled).toBe(false);
  });

  test("trigger reflects the ariaLabelSuffix for a different thread", () => {
    renderMenu({ ariaLabelSuffix: "Research plan" });
    const trigger = container.querySelector(
      "button[data-thread-overflow-trigger]",
    ) as HTMLButtonElement;
    expect(trigger.getAttribute("aria-label")).toBe("More actions for Research plan");
  });

  test("trigger click does not preventDefault so Radix can open it", () => {
    renderMenu();
    const trigger = container.querySelector(
      "button[data-thread-overflow-trigger]",
    ) as HTMLButtonElement;
    const event = new harness.dom.window.Event("click", { bubbles: true });
    act(() => {
      trigger.dispatchEvent(event);
    });
    // Our handler must only stopPropagation; calling preventDefault would make
    // Radix bail (defaultPrevented === true) and the menu would never open —
    // which is the regression this guards against.
    expect(event.defaultPrevented).toBe(false);
  });
});
