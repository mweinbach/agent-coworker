import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { InputGroupButton } from "../src/components/ui/input-group";
import { setupJsdom } from "./jsdomHarness";

describe("desktop input group component", () => {
  test.serial("keeps the input group button data-size on the rendered button", async () => {
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
            InputGroupButton,
            {
              "data-testid": "input-group-button",
              size: "icon-xs",
            },
            "Open",
          ),
        );
      });

      const button = harness.dom.window.document.querySelector(
        "[data-testid='input-group-button']",
      );
      if (!(button instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing input group button");
      }

      expect(button.getAttribute("data-size")).toBe("icon-xs");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
