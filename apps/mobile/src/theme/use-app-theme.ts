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
  background: "#e4ddd2",
  backgroundMuted: "#dcd3c5",
  surface: "#faf6ef",
  surfaceMuted: "#f0ebe2",
  surfaceElevated: "#ffffff",
  border: "rgba(94, 67, 41, 0.18)",
  borderMuted: "rgba(94, 67, 41, 0.12)",
  text: "#2f2318",
  textSecondary: "#5a4736",
  textTertiary: "rgba(90, 71, 54, 0.6)",
  primary: "#8e603f",
  primaryMuted: "rgba(142, 96, 63, 0.15)",
  primaryText: "#ffffff",
  success: "#15803d",
  successMuted: "rgba(21, 128, 61, 0.15)",
  warning: "#b45309",
  warningMuted: "rgba(180, 83, 9, 0.15)",
  danger: "#bb3e3e",
  dangerMuted: "rgba(187, 62, 62, 0.12)",
  accent: "#8e603f",
  accentMuted: "rgba(142, 96, 63, 0.15)",
  shadow: "0 12px 30px rgba(0, 0, 0, 0.1)",
};

const darkTheme: AppTheme = {
  isDark: true,
  background: "#1f1913",
  backgroundMuted: "#16120e",
  surface: "#322920",
  surfaceMuted: "#29221b",
  surfaceElevated: "#3d3328",
  border: "rgba(255, 233, 212, 0.16)",
  borderMuted: "rgba(255, 233, 212, 0.14)",
  text: "#f6ece0",
  textSecondary: "#d8c7b6",
  textTertiary: "rgba(216, 199, 182, 0.6)",
  primary: "#d39261",
  primaryMuted: "rgba(211, 146, 97, 0.15)",
  primaryText: "#1f1913",
  success: "#22c55e",
  successMuted: "rgba(34, 197, 94, 0.15)",
  warning: "#f59e0b",
  warningMuted: "rgba(245, 158, 11, 0.15)",
  danger: "#e86060",
  dangerMuted: "rgba(232, 96, 96, 0.14)",
  accent: "#d39261",
  accentMuted: "rgba(211, 146, 97, 0.15)",
  shadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
};

export function useAppTheme(): AppTheme {
  const colorScheme = useColorScheme();
  return colorScheme === "light" ? lightTheme : darkTheme;
}
