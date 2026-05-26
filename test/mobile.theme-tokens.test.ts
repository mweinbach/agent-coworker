import { describe, expect, test } from "bun:test";

import {
  alpha,
  mix,
  palette,
  radius,
  semanticTokens,
  spacing,
  typography,
} from "../apps/mobile/src/theme/tokens";

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

  test("light palette mirrors desktop primitives", () => {
    expect(palette.light.appBg).toBe("#dde1ca");
    expect(palette.light.panelBg).toBe("#f8f9f2");
    expect(palette.light.accentBase).toBe("#6f8042");
    expect(palette.light.textBase).toBe("#232a18");
  });

  test("dark palette mirrors desktop primitives", () => {
    expect(palette.dark.appBg).toBe("#171d13");
    expect(palette.dark.accentBase).toBe("#a8b963");
    expect(palette.dark.dangerBase).toBe("#e86060");
  });

  test("semantic tokens derive surfaces using same ratios as desktop bridge", () => {
    expect(semanticTokens.light.surfaceWindow).toBe(palette.light.appBg);
    expect(semanticTokens.light.surfaceCard).toBe(
      mix(palette.light.panelBg, palette.light.appBg, 94),
    );
    expect(semanticTokens.light.surfaceField).toBe(
      mix(palette.light.panelBg, palette.light.appBg, 90),
    );
    expect(semanticTokens.light.surfaceMutedFill).toBe(alpha(palette.light.textBase, 0.06));
    expect(semanticTokens.light.borderSubtle).toBe(alpha(palette.light.borderBase, 0.76));
    expect(semanticTokens.light.accent).toBe(palette.light.accentBase);
    expect(semanticTokens.light.accentForeground).toBe(palette.light.accentForegroundBase);
    expect(semanticTokens.light.shadowSurface).toContain("inset 0 1px 0");
    expect(semanticTokens.dark.surfaceCard).toBe(mix(palette.dark.panelBg, palette.dark.appBg, 94));
    expect(semanticTokens.dark.accent).toBe(palette.dark.accentBase);
    expect(semanticTokens.dark.accentForeground).toBe(palette.dark.accentForegroundBase);
  });

  test("typography exposes IBM Plex families that match the desktop bundle", () => {
    expect(typography.fontFamilySans).toBe("IBMPlexSans");
    expect(typography.fontFamilyMono).toBe("IBMPlexMono");
  });

  test("radius scale uses 8px base from desktop --radius-base", () => {
    expect(radius.md).toBe(8);
    expect(radius.sm).toBeLessThan(radius.md);
    expect(radius.lg).toBeGreaterThan(radius.md);
    expect(radius.pill).toBe(999);
  });

  test("spacing scale is monotonic", () => {
    const scale = [
      spacing.xs,
      spacing.sm,
      spacing.md,
      spacing.lg,
      spacing.xl,
      spacing["2xl"],
      spacing["3xl"],
    ];
    for (let i = 1; i < scale.length; i += 1) {
      expect(scale[i]).toBeGreaterThan(scale[i - 1]);
    }
  });
});
