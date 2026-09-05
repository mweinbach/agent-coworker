import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { alpha, mix, scaleAlpha, semanticTokens } from "../apps/mobile/src/theme/tokens";

function luminance(hexColor: string): number {
  const hex = hexColor.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected a hex color, got ${hexColor}`);
  const channels = [0, 2, 4].map((offset) => {
    const normalized = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("mobile theme tokens", () => {
  test("mix performs srgb interpolation that matches CSS color-mix", () => {
    expect(mix("#ffffff", "#000000", 50)).toBe("#808080");
    expect(mix("#ff0000", "#0000ff", 100)).toBe("#ff0000");
    expect(mix("#ff0000", "#0000ff", 0)).toBe("#0000ff");
    expect(mix("#dde1ca", "#dde1ca", 50)).toBe("#dde1ca");
  });

  test("alpha preserves rgb and overrides opacity", () => {
    expect(alpha("#232a18", 0.06)).toBe("rgba(35, 42, 24, 0.06)");
    expect(alpha("rgba(0, 0, 0, 1)", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
  });

  test("primary controls pass WCAG AA in both mobile color schemes", () => {
    expect(
      contrastRatio(semanticTokens.light.accentForeground, semanticTokens.light.accent),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(semanticTokens.dark.accentForeground, semanticTokens.dark.accent),
    ).toBeGreaterThanOrEqual(4.5);
    for (const scheme of ["light", "dark"] as const) {
      const tokens = semanticTokens[scheme];
      expect(contrastRatio(tokens.accentForeground, tokens.accentPressed)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(tokens.successForeground, tokens.success)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens.warningForeground, tokens.warning)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens.dangerForeground, tokens.danger)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("destructive buttons consume the semantic danger foreground", () => {
    const themeSource = readFileSync(
      fileURLToPath(new URL("../apps/mobile/src/theme/use-app-theme.ts", import.meta.url)),
      "utf8",
    );
    const buttonSource = readFileSync(
      fileURLToPath(new URL("../apps/mobile/src/components/ui/app-button.tsx", import.meta.url)),
      "utf8",
    );

    expect(themeSource).toContain("dangerText: tokens.dangerForeground");
    expect(buttonSource).toContain("label: theme.dangerText");
    expect(buttonSource).not.toContain('label: "#ffffff"');
  });

  test("pressed destructive controls use an opaque semantic danger color", () => {
    const buttonSource = readFileSync(
      fileURLToPath(new URL("../apps/mobile/src/components/ui/app-button.tsx", import.meta.url)),
      "utf8",
    );
    const darkTokens = semanticTokens.dark;

    expect(buttonSource).toContain("pressedBackground: theme.danger");
    expect(buttonSource).not.toContain("pressedBackground: alpha(theme.danger");
    expect(darkTokens.danger).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastRatio(darkTokens.dangerForeground, darkTokens.danger)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  test("pressed primary controls use the solid semantic pressed color", () => {
    const themeSource = readFileSync(
      fileURLToPath(new URL("../apps/mobile/src/theme/use-app-theme.ts", import.meta.url)),
      "utf8",
    );
    const buttonSource = readFileSync(
      fileURLToPath(new URL("../apps/mobile/src/components/ui/app-button.tsx", import.meta.url)),
      "utf8",
    );

    expect(themeSource).toContain("primaryPressed: tokens.accentPressed");
    expect(buttonSource).toContain("pressedBackground: theme.primaryPressed");
    expect(buttonSource.match(/pressedBackground: theme\.primaryMuted/g)).toHaveLength(1);

    for (const relativePath of [
      "../apps/mobile/src/components/thread/pending-request-card.tsx",
      "../apps/mobile/src/app/(app)/(tabs)/(chats)/thread/[id].tsx",
    ]) {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
      expect(source).not.toContain("pressed ? theme.primaryMuted : theme.primary");
    }
  });
});

describe("mobile theme alpha scaling", () => {
  test("scaleAlpha multiplies the existing alpha and preserves rgb", () => {
    // alpha() overwrites; scaleAlpha() multiplies — the distinction matters only
    // for already-translucent inputs like border-base.
    expect(scaleAlpha("rgba(62, 74, 40, 0.18)", 0.76)).toBe("rgba(62, 74, 40, 0.137)");
    expect(scaleAlpha("rgba(62, 74, 40, 0.18)", 0.92)).toBe("rgba(62, 74, 40, 0.166)");
    expect(scaleAlpha("#232a18", 0.5)).toBe("rgba(35, 42, 24, 0.5)");
  });
});
