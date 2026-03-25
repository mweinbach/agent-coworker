import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { Tool, ToolContent, ToolHeader } from "../src/components/ai-elements/tool";
import { Card, CardDescription } from "../src/components/ui/card";
import { Dialog, DialogContent } from "../src/components/ui/dialog";
import { Input } from "../src/components/ui/input";
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
            createElement(
              Card,
              null,
              createElement(CardDescription, null, "Token-aware card"),
            ),
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

      expect(card?.className).toContain("app-surface-card");
      expect(card?.className).toContain("app-border-subtle");
      expect(description?.className).toContain("app-text-muted");
      expect(input?.className).toContain("app-surface-field");
      expect(input?.className).toContain("app-shadow-field");
      expect(textarea?.className).toContain("app-surface-field");
      expect(textarea?.className).toContain("app-shadow-field");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("dialog overlays consume overlay token utilities", async () => {
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
            Dialog,
            { open: true, onOpenChange: () => {} },
            createElement(
              DialogContent,
              null,
              createElement("button", { type: "button" }, "Focusable"),
            ),
          ),
        );
      });

      const dialog = harness.dom.window.document.querySelector("[role='dialog']");
      expect(dialog?.className).toContain("app-surface-overlay");
      expect(dialog?.className).toContain("app-border-strong");
      expect(dialog?.className).toContain("app-shadow-overlay");

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

    expect(stylesCss).toMatch(/\.app-topbar__sidebar-fill\s*\{[^}]*background:\s*var\(--surface-sidebar-pane\);/s);
    expect(stylesCss).toMatch(/\.app-topbar__content-fill\s*\{[^}]*background:\s*var\(--surface-workspace-pane\);/s);
    expect(stylesCss).toMatch(/\.app-skills-view\s*\{[^}]*background:\s*var\(--surface-workspace-pane\);/s);
  });
});
