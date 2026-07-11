import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AccessibleIconButton } from "../src/components/ui/button";

describe("AccessibleIconButton", () => {
  test("uses its required label as the accessible name and fallback tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(
        AccessibleIconButton,
        { label: "Open actions", type: "button" },
        createElement("svg", { "aria-hidden": "true" }),
      ),
    );
    expect(html).toContain('aria-label="Open actions"');
    expect(html).toContain('title="Open actions"');
    expect(html).toContain('data-size="icon"');
  });
});
