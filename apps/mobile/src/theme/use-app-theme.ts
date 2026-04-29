import { useColorScheme } from "react-native";

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
  primaryMuted: string;
  primaryText: string;
  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
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
    primaryMuted: tokens.accentSoft,
    primaryText: tokens.textInverse,
    success: tokens.success,
    successMuted: tokens.successSoft,
    warning: tokens.warning,
    warningMuted: tokens.warningSoft,
    danger: tokens.danger,
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
  const colorScheme = useColorScheme();
  return colorScheme === "dark" ? darkTheme : lightTheme;
}

export { palette, radius, semanticTokens, spacing, typography };
