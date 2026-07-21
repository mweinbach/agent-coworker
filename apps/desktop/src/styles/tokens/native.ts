export type CaptionSymbolTone = "dark" | "light";

/**
 * Native-safe color values for Electron chrome and generated preview assets.
 *
 * Renderer styles use the matching semantic CSS custom properties. Native
 * Electron APIs cannot resolve CSS variables, so their concrete equivalents
 * live in this single design-token bridge.
 */
export const NATIVE_THEME_TOKENS = {
  transparentSurface: "#00000000",
  shellSurface: {
    light: "#e8e8e5",
    dark: "#141415",
  },
  canvasDocument: {
    light: {
      background: "#fafaf8",
      foreground: "#1f1f1c",
      mutedForeground: "#61615b",
    },
    dark: {
      background: "#232325",
      foreground: "#e9e9e7",
      mutedForeground: "#a3a39c",
    },
  },
  canvasSpreadsheet: {
    background: "#ffffff",
    foreground: "#24292f",
  },
  captionSymbol: {
    dark: "#61615b",
    light: "#e9e9e7",
  },
} as const;

export function getNativeCaptionSymbolColor(tone: CaptionSymbolTone): string {
  return NATIVE_THEME_TOKENS.captionSymbol[tone];
}
