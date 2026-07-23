import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

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
import { ToolCard } from "../src/ui/chat/toolCards/ToolCard";
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

  test("app-owned tool cards use token-backed flat surfaces and status colors", () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        name: "read",
        state: "output-available",
        result: "done",
      }),
    );

    expect(html).toContain("bg-foreground/[0.02]");
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

  test("selector popovers use an opaque surface over translucent platform chrome", () => {
    const selectSource = readFileSync(
      resolve(import.meta.dir, "../src/components/ui/select.tsx"),
      "utf8",
    );
    const popoverSource = readFileSync(
      resolve(import.meta.dir, "../src/components/ui/popover.tsx"),
      "utf8",
    );
    const tokenUtilities = readFileSync(
      resolve(import.meta.dir, "../src/styles/token-utilities.css"),
      "utf8",
    );

    expect(selectSource).toMatch(/data-slot="select-content"[\s\S]*app-surface-opaque/);
    expect(popoverSource).toMatch(/data-slot="popover-content"[\s\S]*app-surface-opaque/);
    expect(tokenUtilities).toMatch(/\.app-surface-opaque\s*\{[^}]*var\(--surface-opaque\)/s);
  });

  test("high-contrast selected rows keep descendants on the selected foreground", () => {
    const commandSource = readFileSync(
      resolve(import.meta.dir, "../src/components/ui/command.tsx"),
      "utf8",
    );
    const selectSource = readFileSync(
      resolve(import.meta.dir, "../src/components/ui/select.tsx"),
      "utf8",
    );
    const dropdownSource = readFileSync(
      resolve(import.meta.dir, "../src/components/ui/dropdown-menu.tsx"),
      "utf8",
    );
    const dialogSource = readFileSync(
      resolve(import.meta.dir, "../src/components/ui/dialog.tsx"),
      "utf8",
    );
    const stylesCss = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");
    const themeBridgeSource = readFileSync(
      resolve(import.meta.dir, "../src/styles/theme-bridge.css"),
      "utf8",
    );
    const settingsSource = readFileSync(
      resolve(import.meta.dir, "../src/ui/settings/SettingsShell.tsx"),
      "utf8",
    );

    expect(themeBridgeSource).toContain("--color-accent: var(--surface-accent-interactive);");
    expect(themeBridgeSource).toContain(
      "--color-accent-foreground: var(--text-accent-foreground);",
    );
    expect(stylesCss).toMatch(
      /\.settings-shell__nav-button--active\s*\{[^}]*background:\s*var\(--surface-settings-nav-active\);[^}]*color:\s*var\(--text-settings-nav-active\);/s,
    );
    expect(settingsSource).toContain("text-[var(--text-settings-nav-active-icon)]");
    expect(commandSource).toContain(
      "data-[selected=true]:[&_svg:not([class*='text-'])]:text-accent-foreground",
    );
    expect(commandSource).toContain(
      "data-[selected=true]:[&_[data-slot='command-shortcut']_kbd]:text-accent-foreground",
    );
    expect(selectSource).toContain("focus:[&_svg:not([class*='text-'])]:text-accent-foreground");
    expect(selectSource).not.toContain("data-[state=checked]:[&_svg:not([class*='text-'])]");
    expect(dropdownSource).toContain("data-[variant=destructive]:text-destructive");
    expect(dropdownSource).toContain("data-[variant=destructive]:focus:bg-destructive/10");
    expect(dropdownSource).toContain("data-[variant=destructive]:focus:text-destructive");
    expect(dropdownSource).toContain("focus:[&_svg:not([class*='text-'])]:text-accent-foreground");
    expect(stylesCss).toMatch(
      /:where\(:root\[data-high-contrast="true"\]\)\s+\[data-slot="dropdown-menu-item"\]\[data-variant="destructive"\]:focus\s*\{[^}]*--danger:\s*var\(--text-accent-foreground\);[^}]*background:\s*var\(--surface-accent-interactive\);[^}]*color:\s*var\(--text-accent-foreground\);/s,
    );
    expect(stylesCss).toMatch(
      /@media \(forced-colors: active\)[\s\S]*:where\(:root\)\s+\[data-slot="dropdown-menu-item"\]\[data-variant="destructive"\]:focus\s*\{[^}]*--danger:\s*var\(--text-accent-foreground\);[^}]*background:\s*var\(--surface-accent-interactive\);[^}]*color:\s*var\(--text-accent-foreground\);/s,
    );
    expect(dialogSource).toContain(
      "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
    );
    expect(dialogSource).not.toContain(
      "data-[state=open]:bg-accent data-[state=open]:text-muted-foreground",
    );
  });

  test("selected file rows let icons and metadata inherit the accent foreground", () => {
    const explorerSource = readFileSync(
      resolve(import.meta.dir, "../src/ui/file-explorer/WorkspaceFileExplorer.tsx"),
      "utf8",
    );

    expect(explorerSource).not.toContain('selected ? "text-link/80"');
    expect(explorerSource).not.toContain('selected ? "text-accent-foreground/85"');
  });
});
