import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const stylesDir = resolve(import.meta.dir, "../src/styles");
const baseCss = readFileSync(resolve(stylesDir, "tokens/base.css"), "utf8");
const themeBridgeCss = readFileSync(resolve(stylesDir, "theme-bridge.css"), "utf8");

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

  test("high contrast has a complete root token pack and a forced-colors fallback", () => {
    expect(themeBridgeCss).toMatch(/:root\[data-high-contrast="true"\]\s*\{/);
    expect(themeBridgeCss).toContain("@media (forced-colors: active)");
    for (const token of [
      "--surface-window: Canvas;",
      "--surface-card: Canvas;",
      "--surface-field: Field;",
      "--text-primary: CanvasText;",
      "--text-muted: GrayText;",
      "--text-link: LinkText;",
      "--accent: Highlight;",
      "--text-primary-on-accent: HighlightText;",
      "--focus-ring: Highlight;",
      "--border-default: CanvasText;",
    ]) {
      expect(themeBridgeCss).toContain(token);
    }
    expect(themeBridgeCss.match(/--color-accent:\s*Highlight;/g)).toHaveLength(2);
    expect(themeBridgeCss.match(/--color-accent-foreground:\s*HighlightText;/g)).toHaveLength(2);
    expect(themeBridgeCss.match(/--surface-opaque:\s*Canvas;/g)).toHaveLength(2);
  });
});
