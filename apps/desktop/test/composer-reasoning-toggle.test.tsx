import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ComposerReasoningToggle } from "../src/ui/chat/ComposerReasoningToggle";
import { setupJsdom } from "./jsdomHarness";

describe("composer reasoning toggle", () => {
  test("renders a compact pressed state beside composer tools", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerReasoningToggle, {
        enabled: true,
        onChange: () => {},
      }),
    );

    expect(html).toContain('data-slot="composer-reasoning-toggle"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Reasoning on"');
    expect(html).toContain("Reasoning");
  });

  test("toggles the enabled value", async () => {
    const harness = setupJsdom();
    const onChange = mock((_enabled: boolean) => {});
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(ComposerReasoningToggle, {
            enabled: false,
            onChange,
          }),
        );
      });

      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-slot="composer-reasoning-toggle"]',
      );
      expect(toggle?.getAttribute("aria-pressed")).toBe("false");
      await act(async () => {
        toggle?.click();
      });
      expect(onChange).toHaveBeenCalledWith(true);
    } finally {
      await act(async () => root.unmount());
      harness.restore();
    }
  });
});
