import { describe, expect, test } from "bun:test";
import { act, createElement, Fragment, useState } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } = await import(
  new URL("../src/components/ui/dialog.tsx?dialog-component-test", import.meta.url).href
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

function ControlledDialogWithExternalTrigger() {
  const [open, setOpen] = useState(false);

  return createElement(
    Fragment,
    null,
    createElement(
      "button",
      {
        id: "external-trigger",
        type: "button",
        onClick: () => setOpen(true),
      },
      "External trigger",
    ),
    createElement(
      Dialog,
      { open, onOpenChange: setOpen },
      createElement(
        DialogContent,
        null,
        createElement("button", { id: "external-dialog-button", type: "button" }, "Inside dialog"),
      ),
    ),
  );
}

function DisabledAsChildDialogTrigger() {
  const [open, setOpen] = useState(false);

  return createElement(
    Dialog,
    { open, onOpenChange: setOpen },
    createElement(
      DialogTrigger,
      {
        asChild: true,
        className: "trigger-forwarded",
        "data-testid": "as-child-trigger",
        disabled: true,
      },
      createElement("button", { className: "child-class", type: "button" }, "Open dialog"),
    ),
    createElement(
      DialogContent,
      null,
      createElement("button", { id: "as-child-dialog-button", type: "button" }, "Inside dialog"),
    ),
  );
}

function LabelledDialog() {
  const [open, setOpen] = useState(false);

  return createElement(
    Dialog,
    { open, onOpenChange: setOpen },
    createElement(DialogTrigger, null, "Open dialog"),
    createElement(
      DialogContent,
      null,
      createElement(DialogTitle, null, "Dialog title"),
      createElement(DialogDescription, null, "Dialog description"),
      createElement("button", { id: "labelled-dialog-button", type: "button" }, "Inside dialog"),
    ),
  );
}

function AsChildDialogTriggerWithClick({ onTriggerClick }: { onTriggerClick: () => void }) {
  const [open, setOpen] = useState(false);

  return createElement(
    Dialog,
    { open, onOpenChange: setOpen },
    createElement(
      DialogTrigger,
      {
        asChild: true,
        onClick: onTriggerClick,
      },
      createElement("button", { id: "as-child-trigger-click", type: "button" }, "Open dialog"),
    ),
    createElement(
      DialogContent,
      null,
      createElement("button", { id: "as-child-click-dialog-button", type: "button" }, "Inside"),
    ),
  );
}

function PreventedAsChildDialogTrigger({ onTriggerClick }: { onTriggerClick: () => void }) {
  const [open, setOpen] = useState(false);

  return createElement(
    Dialog,
    { open, onOpenChange: setOpen },
    createElement(
      DialogTrigger,
      {
        asChild: true,
        onClick: onTriggerClick,
      },
      createElement(
        "button",
        {
          id: "prevented-as-child-trigger",
          onClick: (event) => event.preventDefault(),
          type: "button",
        },
        "Open dialog",
      ),
    ),
    createElement(
      DialogContent,
      null,
      createElement("button", { id: "prevented-dialog-button", type: "button" }, "Inside dialog"),
    ),
  );
}

function StackedDialogs() {
  const [outerOpen, setOuterOpen] = useState(true);
  const [innerOpen, setInnerOpen] = useState(true);

  return createElement(
    Fragment,
    null,
    createElement(
      Dialog,
      { open: outerOpen, onOpenChange: setOuterOpen },
      createElement(
        DialogContent,
        null,
        createElement("button", { id: "outer-dialog-button", type: "button" }, "Outer dialog"),
      ),
    ),
    createElement(
      Dialog,
      { open: innerOpen, onOpenChange: setInnerOpen },
      createElement(
        DialogContent,
        null,
        createElement("button", { id: "inner-dialog-button", type: "button" }, "Inner dialog"),
      ),
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
      if (
        !(firstField instanceof harness.dom.window.HTMLElement) ||
        !(lastButton instanceof harness.dom.window.HTMLElement)
      ) {
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
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            key: "Tab",
            shiftKey: true,
          }),
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

  test.serial("consumes Escape before window handlers can react", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      let windowEscapeCount = 0;
      const handleWindowKeyDown = () => {
        windowEscapeCount += 1;
      };
      harness.dom.window.addEventListener("keydown", handleWindowKeyDown);

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

      await act(async () => {
        harness.dom.window.document.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(windowEscapeCount).toBe(0);
      expect(harness.dom.window.document.querySelector("[role='dialog']")).toBeNull();

      harness.dom.window.removeEventListener("keydown", handleWindowKeyDown);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("restores focus for controlled dialogs opened externally", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(ControlledDialogWithExternalTrigger));
      });

      const trigger = harness.dom.window.document.getElementById("external-trigger");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing external trigger");
      }

      trigger.focus();
      await act(async () => {
        trigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const dialogButton = harness.dom.window.document.getElementById("external-dialog-button");
      expect(harness.dom.window.document.activeElement).toBe(dialogButton);

      await act(async () => {
        harness.dom.window.document.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(harness.dom.window.document.querySelector("[role='dialog']")).toBeNull();
      expect(harness.dom.window.document.activeElement).toBe(trigger);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("forwards props and disabled state to asChild triggers", async () => {
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
            createElement(DisabledAsChildDialogTrigger),
          ),
        );
      });

      const trigger = harness.dom.window.document.querySelector("[data-testid='as-child-trigger']");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing asChild trigger");
      }

      expect(trigger.disabled).toBe(true);
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(trigger.className).toContain("child-class");
      expect(trigger.className).toContain("trigger-forwarded");

      await act(async () => {
        trigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(harness.dom.window.document.querySelector("[role='dialog']")).toBeNull();
      expect(parentClickCount).toBe(0);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("stops disabled native trigger clicks from bubbling to parents", async () => {
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
            createElement(
              Dialog,
              null,
              createElement(
                DialogTrigger,
                { disabled: true, "data-testid": "native-disabled-trigger" },
                "Open dialog",
              ),
              createElement(
                DialogContent,
                null,
                createElement("button", { id: "native-disabled-button", type: "button" }, "Inside"),
              ),
            ),
          ),
        );
      });

      const trigger = harness.dom.window.document.querySelector(
        "[data-testid='native-disabled-trigger']",
      );
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing native trigger");
      }

      await act(async () => {
        trigger.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(parentClickCount).toBe(0);
      expect(harness.dom.window.document.querySelector("[role='dialog']")).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("labels dialog content from title and description", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(LabelledDialog));
      });

      const trigger = harness.dom.window.document.querySelector("button");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing trigger button");
      }

      await act(async () => {
        trigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const dialog = harness.dom.window.document.querySelector("[role='dialog']");
      const title = harness.dom.window.document.querySelector("[data-slot='dialog-title']");
      const description = harness.dom.window.document.querySelector(
        "[data-slot='dialog-description']",
      );
      if (
        !(dialog instanceof harness.dom.window.HTMLDivElement) ||
        !(title instanceof harness.dom.window.HTMLHeadingElement) ||
        !(description instanceof harness.dom.window.HTMLParagraphElement)
      ) {
        throw new Error("missing labelled dialog elements");
      }

      expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
      expect(dialog.getAttribute("aria-describedby")).toBe(description.id);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("calls asChild trigger onClick only once", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      let triggerClickCount = 0;

      await act(async () => {
        root.render(
          createElement(AsChildDialogTriggerWithClick, {
            onTriggerClick: () => {
              triggerClickCount += 1;
            },
          }),
        );
      });

      const trigger = harness.dom.window.document.getElementById("as-child-trigger-click");
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing asChild trigger");
      }

      await act(async () => {
        trigger.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(triggerClickCount).toBe(1);
      expect(harness.dom.window.document.querySelector("[role='dialog']")).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial(
    "respects prevented child clicks before running asChild trigger handlers",
    async () => {
      const harness = setupJsdom();

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) {
          throw new Error("missing root");
        }

        const root = createRoot(container);
        let triggerClickCount = 0;

        await act(async () => {
          root.render(
            createElement(PreventedAsChildDialogTrigger, {
              onTriggerClick: () => {
                triggerClickCount += 1;
              },
            }),
          );
        });

        const trigger = harness.dom.window.document.getElementById("prevented-as-child-trigger");
        if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing asChild trigger");
        }

        await act(async () => {
          trigger.dispatchEvent(
            new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
          );
        });

        expect(triggerClickCount).toBe(0);
        expect(harness.dom.window.document.querySelector("[role='dialog']")).toBeNull();

        await act(async () => {
          root.unmount();
        });
      } finally {
        harness.restore();
      }
    },
  );

  test.serial(
    "only the topmost dialog handles Escape and preserves body scroll lock until the last close",
    async () => {
      const harness = setupJsdom();

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) {
          throw new Error("missing root");
        }

        harness.dom.window.document.body.style.overflow = "scroll";

        const root = createRoot(container);

        await act(async () => {
          root.render(createElement(StackedDialogs));
        });

        expect(harness.dom.window.document.body.style.overflow).toBe("hidden");
        expect(harness.dom.window.document.getElementById("outer-dialog-button")).not.toBeNull();
        expect(harness.dom.window.document.getElementById("inner-dialog-button")).not.toBeNull();

        await act(async () => {
          harness.dom.window.document.dispatchEvent(
            new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(harness.dom.window.document.getElementById("inner-dialog-button")).toBeNull();
        expect(harness.dom.window.document.getElementById("outer-dialog-button")).not.toBeNull();
        expect(harness.dom.window.document.body.style.overflow).toBe("hidden");

        await act(async () => {
          harness.dom.window.document.dispatchEvent(
            new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(harness.dom.window.document.getElementById("outer-dialog-button")).toBeNull();
        expect(harness.dom.window.document.body.style.overflow).toBe("scroll");

        await act(async () => {
          root.unmount();
        });
      } finally {
        harness.restore();
      }
    },
  );

  test.serial("only the topmost dialog handles Tab focus trapping", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(StackedDialogs));
      });

      const outerButton = harness.dom.window.document.getElementById("outer-dialog-button");
      const innerButton = harness.dom.window.document.getElementById("inner-dialog-button");
      if (
        !(outerButton instanceof harness.dom.window.HTMLElement) ||
        !(innerButton instanceof harness.dom.window.HTMLElement)
      ) {
        throw new Error("missing stacked dialog buttons");
      }

      const focusElement = harness.dom.window.HTMLElement.prototype.focus;
      let outerFocusCount = 0;
      let innerFocusCount = 0;
      outerButton.focus = function focusOuter() {
        outerFocusCount += 1;
        focusElement.call(this);
      };
      innerButton.focus = function focusInner() {
        innerFocusCount += 1;
        focusElement.call(this);
      };
      harness.dom.window.document.body.focus();

      await act(async () => {
        harness.dom.window.document.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Tab" }),
        );
      });

      expect(outerFocusCount).toBe(0);
      expect(innerFocusCount).toBe(1);
      expect(harness.dom.window.document.activeElement).toBe(innerButton);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
