import type { SystemAppearance, ThemeSource } from "./desktopApi";

export const THEME_SOURCE_STORAGE_KEY = "cowork.themeSource";
export const RESOLVED_THEME_STORAGE_KEY = "cowork.resolvedTheme";

export function parseThemeSource(value: string | null | undefined): ThemeSource {
  return value === "light" || value === "dark" ? value : "system";
}

export function readBootstrappedThemeSource(root: HTMLElement): ThemeSource {
  return parseThemeSource(root.dataset.themeSource);
}

export function applySystemAppearanceToDocument(
  appearance: SystemAppearance,
  documentTarget: Document,
  storage?: Pick<Storage, "setItem">,
): void {
  const root = documentTarget.documentElement;
  const theme = appearance.shouldUseDarkColors ? "dark" : "light";
  root.dataset.systemTheme = theme;
  root.dataset.systemUiTheme = appearance.shouldUseDarkColorsForSystemIntegratedUI
    ? "dark"
    : "light";
  root.dataset.theme = theme;
  root.dataset.themeSource = appearance.themeSource;
  root.dataset.platform = appearance.platform;
  root.dataset.highContrast =
    appearance.shouldUseHighContrastColors || appearance.inForcedColorsMode ? "true" : "false";
  root.dataset.reducedTransparency = appearance.prefersReducedTransparency ? "true" : "false";
  root.style.colorScheme =
    root.dataset.highContrast === "true"
      ? "light dark"
      : root.dataset.canvasSurface === "spreadsheet"
        ? "light"
        : theme;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");

  if (!storage) {
    return;
  }
  try {
    storage.setItem(THEME_SOURCE_STORAGE_KEY, appearance.themeSource);
    storage.setItem(RESOLVED_THEME_STORAGE_KEY, theme);
  } catch {
    // Storage failures must not prevent the resolved theme from being painted.
  }
}
