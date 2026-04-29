import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { Tool, ToolContent, ToolHeader } from "../src/components/ai-elements/tool";
import { Card, CardDescription } from "../src/components/ui/card";
import { Dialog, DialogContent } from "../src/components/ui/dialog";
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

  test("select content anchors to the trigger instead of the window corner", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      Object.defineProperty(harness.dom.window, "innerWidth", {
        configurable: true,
        value: 1200,
      });
      Object.defineProperty(harness.dom.window, "innerHeight", {
        configurable: true,
        value: 800,
      });

      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            Select,
            { defaultValue: "same" },
            createElement(
              SelectTrigger,
              { "aria-label": "Subagent routing" },
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

      const trigger = container.querySelector('[aria-label="Subagent routing"]');
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing select trigger");
      }
      trigger.getBoundingClientRect = () =>
        ({
          bottom: 240,
          height: 40,
          left: 460,
          right: 760,
          top: 200,
          width: 300,
          x: 460,
          y: 200,
          toJSON: () => ({}),
        }) as DOMRect;

      await act(async () => {
        trigger.click();
      });

      const content = harness.dom.window.document.querySelector('[data-slot="select-content"]');
      if (!(content instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing select content");
      }

      expect(content.style.left).toBe("460px");
      expect(content.style.top).toBe("246px");
      expect(content.style.width).toBe("300px");
      expect(content.className).toContain("z-[1000]");

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
});
