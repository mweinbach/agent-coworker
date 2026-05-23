import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { Tool, ToolContent, ToolHeader } from "../src/components/ai-elements/tool";
import { Card, CardDescription } from "../src/components/ui/card";
import { Input } from "../src/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../src/components/ui/select";
import { Textarea } from "../src/components/ui/textarea";
import { setupJsdom } from "./jsdomHarness";

describe("desktop token consumers", () => {
  test("shared UI wrappers expose the canonical token utility classes", async () => {
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
            "div",
            null,
            createElement(Card, null, createElement(CardDescription, null, "Token-aware card")),
            createElement(Input, {
              "aria-label": "Search",
              defaultValue: "tokens",
            }),
            createElement(Textarea, {
              "aria-label": "Notes",
              defaultValue: "semantic surfaces",
            }),
          ),
        );
      });

      const card = container.querySelector("[data-slot='card']");
      const description = container.querySelector("[data-slot='card-description']");
      const input = container.querySelector("[data-slot='input']");
      const textarea = container.querySelector("[data-slot='textarea']");

      expect(card?.className).toContain("bg-card");
      expect(card?.className).toContain("text-card-foreground");
      expect(description?.className).toContain("text-muted-foreground");
      expect(input?.className).toContain("border-input");
      expect(input?.className).toContain("bg-transparent");
      expect(textarea?.className).toContain("border-input");
      expect(textarea?.className).toContain("bg-transparent");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("select trigger uses shadcn data slots and semantic sizing", async () => {
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

      const trigger = container.querySelector('[data-slot="select-trigger"]');
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing select trigger");
      }

      expect(trigger.dataset.size).toBe("sm");
      expect(trigger.className).toContain("border-input");
      expect(trigger.getAttribute("role")).toBe("combobox");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("ai-elements tool surfaces use token-backed shadows and status colors", () => {
    const html = renderToStaticMarkup(
      createElement(
        Tool,
        { defaultOpen: true },
        createElement(ToolHeader, {
          title: "read",
          state: "output-available",
        }),
        createElement(ToolContent, null, "done"),
      ),
    );

    expect(html).toContain("app-shadow-surface");
    expect(html).toContain("text-success/90");
  });

  test("layout and skills surfaces resolve through shared token vars", () => {
    const stylesCss = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");

    expect(stylesCss).toMatch(
      /\.app-topbar__sidebar-fill\s*\{[^}]*background:\s*var\(--surface-sidebar-pane\);/s,
    );
    expect(stylesCss).toMatch(
      /\.app-topbar__content-fill\s*\{[^}]*background:\s*var\(--surface-workspace-pane\);/s,
    );
    expect(stylesCss).toMatch(
      /\.app-skills-view\s*\{[^}]*background:\s*var\(--surface-workspace-pane\);/s,
    );
  });

  test("desktop shell disables incidental text selection by default", () => {
    const stylesCss = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");

    expect(stylesCss).toMatch(/body\s*\{[^}]*user-select:\s*none/s);
    expect(stylesCss).toMatch(/\.select-text[^}]*user-select:\s*text/s);
    expect(stylesCss).toContain('[data-file-preview-content="true"]');
    expect(stylesCss).toContain(".settings-shell__content");
  });

  test("desktop portal slots render above the Electron chrome layer", () => {
    const stylesCss = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");
    const portalLayer = stylesCss.match(/--desktop-portal-layer:\s*(\d+);/);

    expect(portalLayer).not.toBeNull();
    expect(Number(portalLayer?.[1])).toBeGreaterThan(81);

    for (const slot of [
      "dialog-content",
      "dropdown-menu-content",
      "popover-content",
      "select-content",
      "sheet-content",
      "tooltip-content",
    ]) {
      expect(stylesCss).toContain(`[data-slot="${slot}"]`);
    }
    expect(stylesCss).toMatch(
      /\[data-slot="tooltip-content"\]\s*\{\s*z-index:\s*var\(--desktop-portal-layer\);/s,
    );
  });
});
