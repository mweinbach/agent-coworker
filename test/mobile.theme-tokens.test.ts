import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  alpha,
  mix,
  palette,
  radius,
  scaleAlpha,
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
    // border-subtle/-strong scale the (translucent) border-base alpha — mirroring
    // desktop's color-mix(border-base P%, transparent) — they do NOT overwrite it.
    expect(semanticTokens.light.borderSubtle).toBe(scaleAlpha(palette.light.borderBase, 0.76));
    expect(semanticTokens.light.borderStrong).toBe(scaleAlpha(palette.light.borderBase, 0.92));
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

describe("mobile theme tokens — desktop source-of-truth pins", () => {
  test("scaleAlpha multiplies the existing alpha and preserves rgb", () => {
    // alpha() overwrites; scaleAlpha() multiplies — the distinction matters only
    // for already-translucent inputs like border-base.
    expect(scaleAlpha("rgba(62, 74, 40, 0.18)", 0.76)).toBe("rgba(62, 74, 40, 0.137)");
    expect(scaleAlpha("rgba(62, 74, 40, 0.18)", 0.92)).toBe("rgba(62, 74, 40, 0.166)");
    expect(scaleAlpha("#232a18", 0.5)).toBe("rgba(35, 42, 24, 0.5)");
  });

  test("light border-base carries the desktop contrast bump (0.18, not 0.12)", () => {
    // Desktop bumped --border-base 0.12 -> 0.18 in the UI-contrast pass; mobile follows.
    expect(palette.light.borderBase).toBe("rgba(62, 74, 40, 0.18)");
    expect(palette.dark.borderBase).toBe("rgba(238, 241, 220, 0.14)");
    expect(semanticTokens.light.borderSubtle).toBe("rgba(62, 74, 40, 0.137)");
    expect(semanticTokens.light.borderStrong).toBe("rgba(62, 74, 40, 0.166)");
  });

  test("success/warning primitives equal the sRGB conversion of desktop's oklch()", () => {
    // base.css: light success oklch(0.69 0.16 151), warning oklch(0.78 0.16 80);
    //           dark  success oklch(0.76 0.15 151), warning oklch(0.8 0.16 80).
    // RN cannot parse oklch(), so these are the CSS Color 4 sRGB conversions.
    expect(palette.light.successBase).toBe("#3ab665");
    expect(palette.light.warningBase).toBe("#ecaa0b");
    expect(palette.dark.successBase).toBe("#5ecc7e");
    expect(palette.dark.warningBase).toBe("#f3b01d");
  });

  test("text-subtle mirrors desktop --text-subtle (92% muted), and dark danger-soft is 14%", () => {
    expect(semanticTokens.light.textSubtle).toBe(alpha(palette.light.mutedBase, 0.92));
    expect(semanticTokens.dark.textSubtle).toBe(alpha(palette.dark.mutedBase, 0.92));
    expect(semanticTokens.dark.dangerSoft).toBe(alpha(palette.dark.dangerBase, 0.14));
    expect(semanticTokens.light.dangerSoft).toBe(alpha(palette.light.dangerBase, 0.12));
  });
});

describe("mobile theme tokens — global.css ⟷ tokens.ts lockstep", () => {
  // global.css (NativeWind, className styling) and tokens.ts (JS, useAppTheme +
  // native components) are two independently hand-maintained mirrors of the same
  // desktop tokens. They silently drifted before; this guard keeps them in lockstep.
  const cssPath = fileURLToPath(new URL("../apps/mobile/src/global.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");

  function blockBody(source: string, startToken: string): string {
    const at = source.indexOf(startToken);
    if (at < 0) throw new Error(`global.css: could not find ${startToken}`);
    const open = source.indexOf("{", at);
    let depth = 0;
    let i = open;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return source.slice(open + 1, i);
  }

  function declarations(body: string): Record<string, string> {
    const map: Record<string, string> = {};
    const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let m: RegExpExecArray | null = re.exec(body);
    while (m) {
      map[m[1]] = m[2].trim();
      m = re.exec(body);
    }
    return map;
  }

  const baseVars = declarations(blockBody(css, ":root {"));
  const darkOverrides = declarations(blockBody(css, "@media (prefers-color-scheme: dark)"));
  const lightScope = baseVars;
  const darkScope = { ...baseVars, ...darkOverrides };

  function resolve(name: string, scope: Record<string, string>): string {
    const seen = new Set<string>();
    let current = name;
    for (;;) {
      if (seen.has(current)) throw new Error(`global.css: var cycle at ${current}`);
      seen.add(current);
      const value = scope[current];
      if (value === undefined) throw new Error(`global.css: missing ${current}`);
      const varMatch = value.match(/^var\((--[\w-]+)\)$/);
      if (!varMatch) return value;
      current = varMatch[1];
    }
  }

  function toRgba(input: string): { r: number; g: number; b: number; a: number } {
    const v = input.trim();
    if (v.startsWith("#")) {
      const hex = v.slice(1);
      const wide = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
      return {
        r: Number.parseInt(wide.slice(0, 2), 16),
        g: Number.parseInt(wide.slice(2, 4), 16),
        b: Number.parseInt(wide.slice(4, 6), 16),
        a: 1,
      };
    }
    const m = v.match(/^rgba?\(([^)]+)\)$/i);
    if (!m) throw new Error(`unparseable color: ${input}`);
    const parts = m[1].split(",").map((p) => Number.parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }

  // global.css var name -> semanticTokens key
  const tokenMap: Record<string, keyof (typeof semanticTokens)["light"]> = {
    "--surface-window": "surfaceWindow",
    "--surface-sidebar": "surfaceSidebar",
    "--surface-card": "surfaceCard",
    "--surface-card-elevated": "surfaceCardElevated",
    "--surface-overlay": "surfaceOverlay",
    "--surface-field": "surfaceField",
    "--surface-secondary": "surfaceSecondary",
    "--surface-accent": "surfaceAccent",
    "--surface-muted-fill": "surfaceMutedFill",
    "--text-primary": "textPrimary",
    "--text-secondary": "textSecondary",
    "--text-muted": "textMuted",
    "--text-subtle": "textSubtle",
    "--text-inverse": "textInverse",
    "--text-link": "textLink",
    "--border-default": "borderDefault",
    "--border-subtle": "borderSubtle",
    "--border-strong": "borderStrong",
    "--accent": "accent",
    "--accent-foreground": "accentForeground",
    "--accent-soft": "accentSoft",
    "--success": "success",
    "--success-foreground": "successForeground",
    "--success-soft": "successSoft",
    "--warning": "warning",
    "--warning-foreground": "warningForeground",
    "--warning-soft": "warningSoft",
    "--danger": "danger",
    "--danger-foreground": "dangerForeground",
    "--danger-soft": "dangerSoft",
  };

  for (const scheme of ["light", "dark"] as const) {
    const scope = scheme === "light" ? lightScope : darkScope;
    for (const [cssVar, tokenKey] of Object.entries(tokenMap)) {
      test(`${scheme} ${cssVar} matches semanticTokens.${scheme}.${String(tokenKey)}`, () => {
        const fromCss = toRgba(resolve(cssVar, scope));
        const fromTs = toRgba(semanticTokens[scheme][tokenKey] as string);
        // channels can round ±1 between hand-authored hex and computed mixes;
        // alpha tolerates the 4-vs-3 decimal-place difference (e.g. 0.1064 vs 0.106).
        expect(Math.abs(fromCss.r - fromTs.r)).toBeLessThanOrEqual(1);
        expect(Math.abs(fromCss.g - fromTs.g)).toBeLessThanOrEqual(1);
        expect(Math.abs(fromCss.b - fromTs.b)).toBeLessThanOrEqual(1);
        expect(Math.abs(fromCss.a - fromTs.a)).toBeLessThanOrEqual(0.0016);
      });
    }
  }
});
