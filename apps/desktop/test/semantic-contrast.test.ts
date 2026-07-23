import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const stylesDir = resolve(import.meta.dir, "../src/styles");
const baseCss = readFileSync(resolve(stylesDir, "tokens/base.css"), "utf8");
const themeBridgeCss = readFileSync(resolve(stylesDir, "theme-bridge.css"), "utf8");
const stylesCss = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");
const platformCss = readFileSync(resolve(stylesDir, "tokens/platform.css"), "utf8");

function blockBody(source: string, startToken: string, from = 0): string {
  const at = source.indexOf(startToken, from);
  if (at < 0) throw new Error(`Could not find CSS block: ${startToken}`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Unclosed CSS block: ${startToken}`);
}

function declarations(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    result[match[1]] = match[2].trim();
  }
  return result;
}

function hexChannels(value: string): [number, number, number] {
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected six-digit hex color, got ${value}`);
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function luminance(value: string): number {
  const channels = hexChannels(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

const light = declarations(blockBody(baseCss, ":root {"));
const dark = declarations(blockBody(baseCss, ':root[data-system-theme="dark"]'));

describe("desktop semantic contrast", () => {
  for (const [scheme, palette] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    test(`${scheme} primary, link, text, and focus pairs meet their WCAG targets`, () => {
      expect(
        contrastRatio(palette["--primary-foreground-base"], palette["--accent-base"]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(palette["--primary-foreground-base"], palette["--accent-hover-base"]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette["--accent-base"], palette["--panel-bg"])).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(palette["--text-base"], palette["--panel-bg"])).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(palette["--muted-base"], palette["--panel-bg"])).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(
        contrastRatio(palette["--focus-ring-base"], palette["--panel-bg"]),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(palette["--focus-ring-base"], palette["--app-bg"]),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(palette["--success-foreground-base"], palette["--success-base"]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(palette["--warning-foreground-base"], palette["--warning-base"]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(palette["--danger-foreground-base"], palette["--danger-base"]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(palette["--danger-foreground-base"], palette["--danger-hover-base"]),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("semantic primary and focus colors do not reuse inverse text or translucent accent", () => {
    expect(themeBridgeCss).toContain("--text-primary-on-accent: var(--primary-foreground-base);");
    expect(themeBridgeCss).toContain("--color-primary-foreground: var(--text-primary-on-accent);");
    expect(themeBridgeCss).toContain("--focus-ring: var(--focus-ring-base);");
    expect(themeBridgeCss).toContain("--color-ring: var(--focus-ring);");
  });

  test("high contrast and forced-colors preserve semantic hierarchy and surfaces", () => {
    expect(themeBridgeCss).toMatch(/:root\[data-high-contrast="true"\]\s*\{/);
    expect(themeBridgeCss).toContain("@media (forced-colors: active)");

    const highContrast = declarations(
      blockBody(themeBridgeCss, ':root[data-high-contrast="true"]'),
    );
    const forcedColors = declarations(
      blockBody(blockBody(themeBridgeCss, "@media (forced-colors: active)"), ":root"),
    );
    const canvasHighContrast = declarations(
      blockBody(
        themeBridgeCss,
        ':where(\n    :root[data-high-contrast="true"][data-canvas-surface],',
      ),
    );

    for (const palette of [highContrast, forcedColors]) {
      expect(palette["--surface-window"]).toBe("Canvas");
      expect(palette["--surface-card"]).toBe("Canvas");
      expect(palette["--surface-field"]).toBe("Field");
      expect(palette["--text-primary"]).toBe("CanvasText");
      expect(palette["--text-secondary"]).toBe("CanvasText");
      expect(palette["--text-muted"]).toBe("GrayText");
      expect(palette["--text-link"]).toBe("LinkText");
      expect(palette["--accent"]).toBe("Highlight");
      expect(palette["--text-primary-on-accent"]).toBe("HighlightText");
      expect(palette["--focus-ring"]).toBe("Highlight");
      expect(palette["--border-default"]).toBe("CanvasText");

      for (const token of [
        "--surface-topbar-thread-hover",
        "--surface-topbar-popover",
        "--surface-context-panel",
        "--surface-context-panel-nested",
        "--surface-settings-main",
        "--surface-settings-nav-active",
        "--surface-settings-nav-hover",
        "--surface-settings-row-hover",
      ]) {
        expect(palette[token]).toBe("Canvas");
      }
    }

    expect(canvasHighContrast["--text-secondary"]).toBe("CanvasText");
    expect(canvasHighContrast["--text-muted"]).toBe("GrayText");
  });

  test("selection pairs system highlight backgrounds with their foreground", () => {
    expect(blockBody(stylesCss, "::selection")).toContain("color: inherit;");
    expect(blockBody(stylesCss, ".is-user ::selection")).toContain("color: inherit;");

    const highContrastSelection = blockBody(
      stylesCss,
      ':root[data-high-contrast="true"] ::selection',
    );
    const forcedColorsMedia = blockBody(stylesCss, "@media (forced-colors: active)");
    const forcedColorsSelection = blockBody(forcedColorsMedia, ":root ::selection");

    expect(highContrastSelection).toContain("color: var(--text-primary-on-accent);");
    expect(stylesCss).toContain(':root[data-high-contrast="true"] .is-user ::selection');
    expect(forcedColorsSelection).toContain("color: var(--text-primary-on-accent);");
    expect(forcedColorsMedia).toContain(".is-user ::selection");
  });

  test("platform translucency cannot shadow app high-contrast surfaces", () => {
    for (const selector of [
      ':root[data-platform="darwin"]:not([data-reduced-transparency="true"]):not(',
      ':root[data-platform="win32"]:not([data-reduced-transparency="true"]):not(',
      ':root[data-platform="linux"]:not([data-reduced-transparency="true"]):not(',
      ':root[data-reduced-transparency="true"]:not([data-high-contrast="true"])',
    ]) {
      expect(platformCss).toContain(selector);
    }

    const platformHighContrast = declarations(
      blockBody(platformCss, ':root[data-high-contrast="true"]'),
    );
    expect(platformHighContrast["--surface-overlay"]).toBeUndefined();
    expect(platformHighContrast["--surface-main-card"]).toBeUndefined();
  });
});
