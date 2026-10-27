import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Switch } from "../src/components/ui/switch";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("desktop token consumers", () => {
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
    expect(settingsSource).toContain('className="settings-nav-tile"');
    // Increase Contrast drops the colored tile; the active glyph keeps the selected foreground.
    expect(stylesCss).toMatch(
      /:root\[data-high-contrast="true"\] \.settings-shell__nav-button--active \.settings-nav-tile\s*\{[^}]*color:\s*var\(--text-settings-nav-active-icon\);/s,
    );
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

  test("accessibility row descendants and switch states use system contrast pairs", () => {
    const switchSource = readFileSync(
      resolve(import.meta.dir, "../src/components/ui/switch.tsx"),
      "utf8",
    );
    const stopSource = readFileSync(
      resolve(import.meta.dir, "../src/ui/composer/MessageComposer.tsx"),
      "utf8",
    );
    const stylesCss = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");
    const baseTokens = readFileSync(
      resolve(import.meta.dir, "../src/styles/tokens/base.css"),
      "utf8",
    );
    const glassCss = readFileSync(resolve(import.meta.dir, "../src/styles/glass.css"), "utf8");
    const switchMarkup = renderToStaticMarkup(createElement(Switch));

    expect(switchMarkup).toContain('data-slot="switch"');
    expect(switchMarkup).toContain('data-state="unchecked"');
    expect(switchMarkup).toContain('class="lg-thumb-face"');

    const switchRulesStart = stylesCss.indexOf(
      ':root[data-high-contrast="true"] [data-slot="switch"][data-state="unchecked"]',
    );
    expect(switchRulesStart).toBeGreaterThan(
      stylesCss.lastIndexOf('@import "shadcn/tailwind.css";'),
    );

    const highContrastSwitchRules = [
      [
        ':root[data-high-contrast="true"] [data-slot="switch"][data-state="unchecked"]',
        "background-color: CanvasText !important;",
      ],
      [
        ':root[data-high-contrast="true"] [data-slot="switch"][data-state="unchecked"] .lg-thumb-face',
        "background-color: Canvas !important;",
      ],
      [
        ':root[data-high-contrast="true"] [data-slot="switch"][data-state="checked"]',
        "background-color: Highlight !important;",
      ],
      [
        ':root[data-high-contrast="true"] [data-slot="switch"][data-state="checked"] .lg-thumb-face',
        "background-color: HighlightText !important;",
      ],
    ] as const;
    for (const [selector, declaration] of highContrastSwitchRules) {
      const selectorPattern = escapeRegExp(selector).replace(/ /g, "\\s+");
      expect(stylesCss).toMatch(
        new RegExp(`${selectorPattern}\\s*\\{[^}]*${escapeRegExp(declaration)}`),
      );
    }

    const forcedColorsBlock = stylesCss.slice(stylesCss.indexOf("@media (forced-colors: active)"));
    expect(forcedColorsBlock).toContain(':root [data-slot="switch"][data-state="unchecked"]');
    expect(forcedColorsBlock).toContain(
      ':root [data-slot="switch"][data-state="unchecked"] .lg-thumb-face',
    );
    expect(forcedColorsBlock).toContain(':root [data-slot="switch"][data-state="checked"]');
    expect(forcedColorsBlock).toContain(
      ':root [data-slot="switch"][data-state="checked"] .lg-thumb-face',
    );
    expect(forcedColorsBlock).toContain("background-color: CanvasText !important;");
    expect(forcedColorsBlock).toContain("background-color: Canvas !important;");
    expect(forcedColorsBlock).toContain("background-color: Highlight !important;");
    expect(forcedColorsBlock).toContain("background-color: HighlightText !important;");

    expect(stylesCss).not.toMatch(/:where\([^)]*\[data-slot="switch(?:-thumb)?"\][^)]*\)\s*\{/);

    for (const selector of [
      '[data-slot="command-item"][data-selected="true"]',
      '[data-slot="dropdown-menu-item"]:focus',
    ]) {
      expect(stylesCss).toContain(selector);
    }
    expect(stylesCss).toContain("color: var(--text-accent-foreground) !important;");
    expect(stylesCss).not.toContain("fill: currentColor !important;");
    expect(stylesCss).not.toContain("stroke: currentColor !important;");
    expect(stylesCss).not.toContain('[aria-hidden="true"] *');
    expect(stylesCss).toContain("[hidden] *");
    expect(stylesCss).toContain(".sr-only *");
    expect(stylesCss).toContain("input");
    expect(stylesCss).toContain("textarea");
    expect(stylesCss).toContain("select");
    expect(stylesCss).toContain("button");
    expect(stylesCss).toContain('[contenteditable="true"]');

    expect(stylesCss).toContain('[data-slot="switch"][data-state="unchecked"]');
    expect(stylesCss).toContain("background-color: CanvasText !important;");
    expect(stylesCss).toContain('[data-state="unchecked"]');
    expect(stylesCss).toContain(".lg-thumb-face");
    expect(stylesCss).toContain("background-color: Canvas !important;");
    expect(stylesCss).toContain('[data-slot="switch"][data-state="checked"]');
    expect(stylesCss).toContain("background-color: Highlight !important;");
    expect(stylesCss).toContain('[data-state="checked"]');
    expect(stylesCss).toContain("background-color: HighlightText !important;");

    // The glass switch draws its track and fill from tokens mapped onto the app palette.
    expect(switchSource).toContain('data-state={checked ? "checked" : "unchecked"}');
    expect(baseTokens).toMatch(/--lg-track:\s*color-mix\(in srgb, var\(--text-base\)/);
    expect(baseTokens).toMatch(/--lg-on:\s*var\(--accent\)/);
    // Stop stays a quiet glass control, not a filled destructive button.
    expect(stopSource).toContain('className={cn("app-composer-stop", className)}');
    expect(glassCss).toMatch(
      /\.app-composer-stop\.lg-button\s*\{[^}]*color:\s*var\(--text-muted\)/,
    );
    expect(stopSource).not.toContain("disabled:bg-destructive/80");
  });
});
