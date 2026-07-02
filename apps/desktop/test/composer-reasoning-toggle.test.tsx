import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ComposerReasoningSelector,
  reasoningEffortOptions,
} from "../src/ui/chat/ComposerReasoningToggle";

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

    expect(html).toContain('title="Reasoning: XHigh"');
  });

  test("labels xhigh, max, and light distinctly", () => {
    for (const [value, title] of [
      ["xhigh", "Reasoning: XHigh"],
      ["max", "Reasoning: Max"],
      ["light", "Reasoning: Light"],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(ComposerReasoningSelector, {
          value,
          options: ["none", "light", "low", "medium", "high", "xhigh", "max"],
          onChange: () => {},
        }),
      );
      expect(html).toContain(`title="${title}"`);
    }
  });

  test("orders effort choices canonically regardless of catalog order", () => {
    expect(reasoningEffortOptions("medium", ["high", "none", "low", "medium"])).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
  });

  test("keeps a stale current value selectable in canonical position", () => {
    expect(reasoningEffortOptions("xhigh", ["none", "low", "medium", "high"])).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("orders the full ladder with light between minimal and low and max above xhigh", () => {
    expect(
      reasoningEffortOptions("medium", [
        "max",
        "xhigh",
        "high",
        "medium",
        "low",
        "light",
        "minimal",
        "none",
      ]),
    ).toEqual(["none", "minimal", "light", "low", "medium", "high", "xhigh", "max"]);
  });
});
