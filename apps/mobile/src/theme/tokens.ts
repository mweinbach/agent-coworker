/**
 * Mobile design tokens.
 *
 * Mirrors the desktop app's design language so the mobile and desktop
 * surfaces share the same color palette, typography, radii, and spacing.
 *
 * Source of truth on desktop:
 *   - apps/desktop/src/styles/tokens/base.css     (palette primitives)
 *   - apps/desktop/src/styles/theme-bridge.css    (semantic surfaces)
 *   - apps/desktop/src/styles/fonts.css           (IBM Plex)
 *
 * React Native cannot evaluate CSS `color-mix()` at runtime, so the
 * bridged surfaces here are pre-mixed in TypeScript using the same
 * ratios desktop uses. Update both sides in lockstep when palette
 * primitives change.
 */

type RGB = { r: number; g: number; b: number; a: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseColor(input: string): RGB {
  const value = input.trim();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: Number.parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
  }
  const rgbaMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(",").map((part) => part.trim());
    return {
      r: Number.parseFloat(parts[0]),
      g: Number.parseFloat(parts[1]),
      b: Number.parseFloat(parts[2]),
      a: parts[3] !== undefined ? Number.parseFloat(parts[3]) : 1,
    };
  }
  if (value === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  throw new Error(`tokens: unsupported color string: ${input}`);
}

function formatColor(rgb: RGB): string {
  const r = Math.round(clamp(rgb.r, 0, 255));
  const g = Math.round(clamp(rgb.g, 0, 255));
  const b = Math.round(clamp(rgb.b, 0, 255));
  const a = Number.parseFloat(clamp(rgb.a, 0, 1).toFixed(3));
  if (a >= 1) {
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * sRGB linear interpolation of two colors. Mirrors CSS
 * `color-mix(in srgb, a P%, b)` where P is `percentA`.
 */
export function mix(a: string, b: string, percentA: number): string {
  const ratio = clamp(percentA, 0, 100) / 100;
  const ca = parseColor(a);
  const cb = parseColor(b);
  return formatColor({
    r: ca.r * ratio + cb.r * (1 - ratio),
    g: ca.g * ratio + cb.g * (1 - ratio),
    b: ca.b * ratio + cb.b * (1 - ratio),
    a: ca.a * ratio + cb.a * (1 - ratio),
  });
}

/**
 * Returns the input color with the given alpha (0-1).
 */
export function alpha(input: string, a: number): string {
  const c = parseColor(input);
  return formatColor({ ...c, a: clamp(a, 0, 1) });
}

/**
 * Palette primitives. These exactly match the desktop variables in
 * `apps/desktop/src/styles/tokens/base.css`.
 *
 * `oklch(...)` values from desktop are pre-converted to sRGB hex here
 * because React Native does not parse OKLCH.
 */
export const palette = {
  light: {
    appBg: "#dde1ca",
    sidebarBg: "#e1e4cd",
    panelBg: "#f8f9f2",
    textBase: "#232a18",
    mutedBase: "#556041",
    accentBase: "#6f8042",
    accentForegroundBase: "#ffffff",
    inverseText: "#ffffff",
    dangerBase: "#bb3e3e",
    successBase: "#1ea155",
    successForegroundBase: "#ffffff",
    warningBase: "#d99422",
    warningForegroundBase: "#232a18",
    borderBase: "rgba(62, 74, 40, 0.12)",
    glassBorder: "rgba(62, 74, 40, 0.18)",
    shadowSurfaceBase: "0 1px 3px rgba(0, 0, 0, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.4)",
    shadowOverlayBase: "0 12px 30px rgba(0, 0, 0, 0.1)",
  },
  dark: {
    appBg: "#171d13",
    sidebarBg: "#202719",
    panelBg: "#2a3120",
    textBase: "#eef0dc",
    mutedBase: "#c7ceaf",
    accentBase: "#a8b963",
    accentForegroundBase: "#121a10",
    inverseText: "#ffffff",
    dangerBase: "#e86060",
    successBase: "#3fbb74",
    successForegroundBase: "#121a10",
    warningBase: "#e0a131",
    warningForegroundBase: "#1a2012",
    borderBase: "rgba(238, 241, 220, 0.14)",
    glassBorder: "rgba(238, 241, 220, 0.16)",
    shadowSurfaceBase: "0 1px 2px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
    shadowOverlayBase: "0 12px 30px rgba(0, 0, 0, 0.35)",
  },
} as const;

export type PalettePrimitives = (typeof palette)[keyof typeof palette];

export type SemanticTokens = {
  isDark: boolean;
  /** Window / root scrollback background. */
  surfaceWindow: string;
  /** Slight chrome tint between window and panels (sidebar). */
  surfaceSidebar: string;
  /** Card / section background. */
  surfaceCard: string;
  /** Slightly elevated card surface. */
  surfaceCardElevated: string;
  /** Modal / popover background. */
  surfaceOverlay: string;
  /** Form field background. */
  surfaceField: string;
  /** Selected / accent-tinted secondary surface. */
  surfaceSecondary: string;
  /** Accent-tinted hover/selection wash. */
  surfaceAccent: string;
  /** Tag / code background — neutral muted fill. */
  surfaceMutedFill: string;

  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textSubtle: string;
  textInverse: string;
  textLink: string;

  borderDefault: string;
  borderSubtle: string;
  borderStrong: string;

  accent: string;
  accentForeground: string;
  accentSoft: string;

  success: string;
  successForeground: string;
  successSoft: string;
  warning: string;
  warningForeground: string;
  warningSoft: string;
  danger: string;
  dangerForeground: string;
  dangerSoft: string;

  shadowSurface: string;
  shadowOverlay: string;
};

function buildSemanticTokens(p: PalettePrimitives, isDark: boolean): SemanticTokens {
  const surfaceCard = mix(p.panelBg, p.appBg, 94);
  return {
    isDark,
    surfaceWindow: p.appBg,
    surfaceSidebar: p.sidebarBg,
    surfaceCard,
    surfaceCardElevated: mix(p.panelBg, surfaceCard, 84),
    surfaceOverlay: p.panelBg,
    surfaceField: mix(p.panelBg, p.appBg, 90),
    surfaceSecondary: mix(p.accentBase, p.panelBg, 12),
    surfaceAccent: mix(p.accentBase, p.panelBg, 14),
    surfaceMutedFill: alpha(p.textBase, 0.06),

    textPrimary: p.textBase,
    textSecondary: alpha(p.textBase, 0.88),
    textMuted: p.mutedBase,
    textSubtle: alpha(p.mutedBase, 0.78),
    textInverse: p.inverseText,
    textLink: p.accentBase,

    borderDefault: p.borderBase,
    borderSubtle: alpha(p.borderBase, 0.76),
    borderStrong: alpha(p.borderBase, 0.92),

    accent: p.accentBase,
    accentForeground: p.accentForegroundBase,
    accentSoft: alpha(p.accentBase, 0.14),

    success: p.successBase,
    successForeground: p.successForegroundBase,
    successSoft: alpha(p.successBase, 0.15),
    warning: p.warningBase,
    warningForeground: p.warningForegroundBase,
    warningSoft: alpha(p.warningBase, 0.16),
    danger: p.dangerBase,
    dangerForeground: p.inverseText,
    dangerSoft: alpha(p.dangerBase, isDark ? 0.16 : 0.12),

    shadowSurface: p.shadowSurfaceBase,
    shadowOverlay: p.shadowOverlayBase,
  };
}

export const semanticTokens = {
  light: buildSemanticTokens(palette.light, false),
  dark: buildSemanticTokens(palette.dark, true),
} as const;

/**
 * Typography tokens. The mobile app loads IBM Plex via `expo-font` in
 * `app/_layout.tsx`; until the fonts finish loading, fall back to the
 * system stack so the UI still renders.
 */
export const typography = {
  fontFamilySans: "IBMPlexSans",
  fontFamilyMono: "IBMPlexMono",
  /** System fallback used until expo-font reports the family is ready. */
  fontFamilySansFallback: undefined as string | undefined,
  fontFamilyMonoFallback: "Menlo",
  size: {
    xs: 11,
    sm: 12,
    base: 13,
    md: 14,
    lg: 15,
    xl: 17,
    "2xl": 20,
    "3xl": 24,
  },
  lineHeight: {
    xs: 16,
    sm: 18,
    base: 20,
    md: 22,
    lg: 22,
    xl: 24,
    "2xl": 28,
    "3xl": 30,
  },
  weight: {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },
} as const;

/**
 * Radius scale derived from the desktop `--radius-base: 0.5rem` (8 px)
 * with the same `radius-sm`/`radius-md`/`radius-lg` proportions.
 */
export const radius = {
  sm: 5,
  md: 8,
  lg: 10,
  field: 7,
  card: 16,
  pill: 999,
} as const;

/**
 * Spacing scale. Mobile screens already pad in multiples of 2/4 px, so
 * we expose a small named ramp instead of arbitrary numbers.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 18,
  "2xl": 24,
  "3xl": 32,
} as const;
