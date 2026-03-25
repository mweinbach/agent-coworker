import { useColorScheme } from "react-native";

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
};

const lightTheme: AppTheme = {
  isDark: false,
  background: "#F4F7FB",
  backgroundMuted: "#E8EEF6",
  surface: "#FFFFFF",
  surfaceMuted: "#EDF2F8",
  surfaceElevated: "#F8FAFD",
  border: "#D6DFEA",
  borderMuted: "#E7EDF5",
  text: "#111827",
  textSecondary: "#4B5563",
  textTertiary: "#6B7280",
  primary: "#4F46E5",
  primaryMuted: "#EEF2FF",
  primaryText: "#EEF2FF",
  success: "#059669",
  successMuted: "#D1FAE5",
  warning: "#D97706",
  warningMuted: "#FEF3C7",
  danger: "#DC2626",
  dangerMuted: "#FEE2E2",
  accent: "#0F766E",
  accentMuted: "#CCFBF1",
  shadow: "0 18px 42px rgba(15, 23, 42, 0.08)",
};

const darkTheme: AppTheme = {
  isDark: true,
  background: "#07101D",
  backgroundMuted: "#0D1727",
  surface: "#101B2D",
  surfaceMuted: "#162236",
  surfaceElevated: "#1A2740",
  border: "#24344E",
  borderMuted: "#1B2940",
  text: "#F8FAFC",
  textSecondary: "#CBD5E1",
  textTertiary: "#94A3B8",
  primary: "#8B5CF6",
  primaryMuted: "#2E1E55",
  primaryText: "#F5F3FF",
  success: "#34D399",
  successMuted: "#083B31",
  warning: "#F59E0B",
  warningMuted: "#3B2A0B",
  danger: "#F87171",
  dangerMuted: "#3B1016",
  accent: "#38BDF8",
  accentMuted: "#082F49",
  shadow: "0 18px 42px rgba(2, 6, 23, 0.4)",
};

export function useAppTheme(): AppTheme {
  const colorScheme = useColorScheme();
  return colorScheme === "light" ? lightTheme : darkTheme;
}
