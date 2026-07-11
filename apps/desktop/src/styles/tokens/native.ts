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
    light: "#dde1ca",
    dark: "#171d13",
  },
  canvasDocument: {
    light: {
      background: "#f8f9f2",
      foreground: "#232a18",
      mutedForeground: "#556041",
    },
    dark: {
      background: "#2a3120",
      foreground: "#eef0dc",
      mutedForeground: "#c7ceaf",
    },
  },
  canvasSpreadsheet: {
    background: "#ffffff",
    foreground: "#24292f",
  },
  captionSymbol: {
    dark: "#556041",
    light: "#eef0dc",
  },
} as const;

export function getNativeCaptionSymbolColor(tone: CaptionSymbolTone): string {
  return NATIVE_THEME_TOKENS.captionSymbol[tone];
}
