import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { Collapsible, CollapsibleTrigger } = await import(
  new URL("../src/components/ui/collapsible.tsx?collapsible-component-test", import.meta.url).href
);

function CollapsibleClassNameFixture({
  asChild,
  disabled = false,
}: {
  asChild: boolean;
  disabled?: boolean;
}) {
  return createElement(
    Collapsible,
    { disabled },
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

function CollapsibleAsChildClickFixture({
  childPreventsDefault = false,
  disabled = false,
  onChildClick,
  onTriggerClick,
  triggerPreventsDefault = false,
}: {
  childPreventsDefault?: boolean;
  disabled?: boolean;
  onChildClick: () => void;
  onTriggerClick: () => void;
  triggerPreventsDefault?: boolean;
}) {
  return createElement(
    Collapsible,
    { disabled },
    createElement(
      CollapsibleTrigger,
      {
        asChild: true,
        "data-testid": "trigger",
        onClick: (event) => {
          onTriggerClick();
          if (triggerPreventsDefault) {
            event.preventDefault();
          }
        },
      },
      createElement(
        "div",
        {
          onClick: (event) => {
            onChildClick();
            if (childPreventsDefault) {
              event.preventDefault();
            }
          },
          role: "button",
          tabIndex: 0,
        },
        "Toggle",
      ),
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

  test.serial("keeps root state data attributes authoritative over consumer props", async () => {
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
            Collapsible,
            {
              "data-disabled": "consumer-disabled",
              "data-expanded": "false",
              "data-state": "closed",
              "data-testid": "collapsible-root",
              defaultOpen: true,
              disabled: true,
            },
            createElement(CollapsibleTrigger, null, "Toggle"),
          ),
        );
      });

      const collapsible = harness.dom.window.document.querySelector(
        "[data-testid='collapsible-root']",
      );
      if (!(collapsible instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing collapsible root");
      }

      expect(collapsible.getAttribute("data-disabled")).toBe("");
      expect(collapsible.getAttribute("data-expanded")).toBe("true");
      expect(collapsible.getAttribute("data-state")).toBe("open");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("forwards native disabled state in the asChild path", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(CollapsibleClassNameFixture, { asChild: true, disabled: true }));
      });

      const trigger = harness.dom.window.document.querySelector("[data-testid='as-child-trigger']");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing asChild trigger");
      }

      expect(trigger.disabled).toBe(true);
      expect(trigger.getAttribute("aria-disabled")).toBe("true");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("blocks child and trigger clicks for disabled asChild triggers", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      let childClickCount = 0;
      let triggerClickCount = 0;

      await act(async () => {
        root.render(
          createElement(CollapsibleAsChildClickFixture, {
            disabled: true,
            onChildClick: () => {
              childClickCount += 1;
            },
            onTriggerClick: () => {
              triggerClickCount += 1;
            },
          }),
        );
      });

      const trigger = harness.dom.window.document.querySelector("[data-testid='trigger']");
      if (!(trigger instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing trigger");
      }

      await act(async () => {
        trigger.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(childClickCount).toBe(0);
      expect(triggerClickCount).toBe(0);
      expect(trigger.getAttribute("data-expanded")).toBe("false");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("blocks trigger clicks for disabled button triggers", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      let triggerClickCount = 0;
      let parentClickCount = 0;

      await act(async () => {
        root.render(
          createElement(
            "div",
            {
              onClick: () => {
                parentClickCount += 1;
              },
            },
            createElement(
              Collapsible,
              { disabled: true },
              createElement(
                CollapsibleTrigger,
                {
                  "data-testid": "button-trigger",
                  onClick: () => {
                    triggerClickCount += 1;
                  },
                },
                "Toggle",
              ),
            ),
          ),
        );
      });

      const trigger = harness.dom.window.document.querySelector("[data-testid='button-trigger']");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing button trigger");
      }

      await act(async () => {
        trigger.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(triggerClickCount).toBe(0);
      expect(parentClickCount).toBe(0);
      expect(trigger.getAttribute("data-expanded")).toBe("false");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("stops disabled asChild trigger clicks from bubbling to parents", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      let parentClickCount = 0;

      await act(async () => {
        root.render(
          createElement(
            "div",
            {
              onClick: () => {
                parentClickCount += 1;
              },
            },
            createElement(CollapsibleAsChildClickFixture, {
              disabled: true,
              onChildClick: () => {},
              onTriggerClick: () => {},
            }),
          ),
        );
      });

      const trigger = harness.dom.window.document.querySelector("[data-testid='trigger']");
      if (!(trigger instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing trigger");
      }

      await act(async () => {
        trigger.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(parentClickCount).toBe(0);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("respects child preventDefault before running trigger clicks", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      let childClickCount = 0;
      let triggerClickCount = 0;

      await act(async () => {
        root.render(
          createElement(CollapsibleAsChildClickFixture, {
            childPreventsDefault: true,
            onChildClick: () => {
              childClickCount += 1;
            },
            onTriggerClick: () => {
              triggerClickCount += 1;
            },
          }),
        );
      });

      const trigger = harness.dom.window.document.querySelector("[data-testid='trigger']");
      if (!(trigger instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing trigger");
      }

      await act(async () => {
        trigger.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(childClickCount).toBe(1);
      expect(triggerClickCount).toBe(0);
      expect(trigger.getAttribute("data-expanded")).toBe("false");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("respects trigger preventDefault before toggling asChild triggers", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      let childClickCount = 0;
      let triggerClickCount = 0;

      await act(async () => {
        root.render(
          createElement(CollapsibleAsChildClickFixture, {
            onChildClick: () => {
              childClickCount += 1;
            },
            onTriggerClick: () => {
              triggerClickCount += 1;
            },
            triggerPreventsDefault: true,
          }),
        );
      });

      const trigger = harness.dom.window.document.querySelector("[data-testid='trigger']");
      if (!(trigger instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing trigger");
      }

      await act(async () => {
        trigger.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(childClickCount).toBe(1);
      expect(triggerClickCount).toBe(1);
      expect(trigger.getAttribute("data-expanded")).toBe("false");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
