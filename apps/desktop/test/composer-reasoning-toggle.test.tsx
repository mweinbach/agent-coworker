import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ComposerReasoningSelector } from "../src/ui/chat/ComposerReasoningToggle";

describe("composer reasoning selector", () => {
  test("renders a compact effort selector beside composer tools", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerReasoningSelector, {
        value: "high",
        options: ["none", "low", "medium", "high"],
        onChange: () => {},
      }),
    );

    expect(html).toContain('data-slot="composer-reasoning-selector"');
    expect(html).toContain('aria-label="Reasoning effort"');
    expect(html).toContain('title="Reasoning: High"');
  });

  test("renders a stale current value even when it is not in the available option list", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerReasoningSelector, {
        value: "xhigh",
        options: ["none", "low", "medium", "high"],
        onChange: () => {},
      }),
    );

    expect(html).toContain('title="Reasoning: Max"');
  });
});
