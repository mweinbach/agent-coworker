import { useColorScheme } from "react-native";
import { resolveColorScheme } from "./resolve-color-scheme";
import { palette, radius, semanticTokens, spacing, typography } from "./tokens";

export type AppTheme = {
  isDark: boolean;
  background: string;
  backgroundMuted: string;
  surface: string;
  surfaceMuted: string;
  surfaceElevated: string;
  border: string;
  borderMuted: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  primary: string;
  primaryPressed: string;
  primaryMuted: string;
  primaryText: string;
  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
  dangerText: string;
  dangerMuted: string;
  accent: string;
  accentMuted: string;
  shadow: string;
  fontFamilySans: string;
  fontFamilyMono: string;
};

function buildAppTheme(scheme: "light" | "dark"): AppTheme {
  const tokens = semanticTokens[scheme];
  return {
    isDark: tokens.isDark,
    background: tokens.surfaceWindow,
    backgroundMuted: tokens.surfaceSidebar,
    surface: tokens.surfaceCard,
    surfaceMuted: tokens.surfaceMutedFill,
    surfaceElevated: tokens.surfaceCardElevated,
    border: tokens.borderDefault,
    borderMuted: tokens.borderSubtle,
    text: tokens.textPrimary,
    textSecondary: tokens.textMuted,
    textTertiary: tokens.textSubtle,
    primary: tokens.accent,
    primaryPressed: tokens.accentPressed,
    primaryMuted: tokens.accentSoft,
    primaryText: tokens.accentForeground,
    success: tokens.success,
    successMuted: tokens.successSoft,
    warning: tokens.warning,
    warningMuted: tokens.warningSoft,
    danger: tokens.danger,
    dangerText: tokens.dangerForeground,
    dangerMuted: tokens.dangerSoft,
    accent: tokens.accent,
    accentMuted: tokens.accentSoft,
    shadow: tokens.shadowSurface,
    fontFamilySans: typography.fontFamilySans,
    fontFamilyMono: typography.fontFamilyMono,
  };
}

const lightTheme = buildAppTheme("light");
const darkTheme = buildAppTheme("dark");

export function useAppTheme(): AppTheme {
  const scheme = resolveColorScheme(useColorScheme());
  return scheme === "dark" ? darkTheme : lightTheme;
}

export { palette, radius, resolveColorScheme, semanticTokens, spacing, typography };
