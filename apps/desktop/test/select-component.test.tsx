import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../src/components/ui/select";
import { setupJsdom } from "./jsdomHarness";

describe("desktop select component", () => {
  test("renders the stock trigger contract", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");

      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            Select,
            { defaultValue: "same" },
            createElement(
              SelectTrigger,
              { "aria-label": "Subagent routing", size: "sm" },
              createElement(SelectValue, null),
            ),
            createElement(
              SelectContent,
              null,
              createElement(SelectItem, { value: "same" }, "Same model"),
              createElement(SelectItem, { value: "cross" }, "Multiple providers"),
            ),
          ),
        );
      });

      const trigger = harness.dom.window.document.querySelector('[data-slot="select-trigger"]');
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing select trigger");
      }

      expect(trigger.dataset.size).toBe("sm");
      expect(trigger.getAttribute("aria-label")).toBe("Subagent routing");
      expect(trigger.getAttribute("role")).toBe("combobox");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
