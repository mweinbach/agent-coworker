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
  backgroundMuted: "#e8dfd2",
  surface: "#faf6ef",
  surfaceMuted: "#f5ede3",
  surfaceElevated: "#ffffff",
  border: "rgba(94, 67, 41, 0.18)",
  borderMuted: "rgba(94, 67, 41, 0.12)",
  text: "#2f2318",
  textSecondary: "#5a4736",
  textTertiary: "rgba(47, 35, 24, 0.58)",
  primary: "#8e603f",
  primaryMuted: "rgba(142, 96, 63, 0.14)",
  primaryText: "#ffffff",
  success: "#1F9B4E",
  successMuted: "rgba(31, 155, 78, 0.15)",
  warning: "#DD892E",
  warningMuted: "rgba(221, 137, 46, 0.14)",
  danger: "#bb3e3e",
  dangerMuted: "rgba(187, 62, 62, 0.12)",
  accent: "#8e603f",
  accentMuted: "rgba(142, 96, 63, 0.14)",
  shadow: "0 1px 2px rgba(0, 0, 0, 0.035)",
};

const darkTheme: AppTheme = {
  isDark: true,
  background: "#1f1913",
  backgroundMuted: "#29221b",
  surface: "#322920",
  surfaceMuted: "#3a3026",
  surfaceElevated: "#453a2f",
  border: "rgba(255, 233, 212, 0.16)",
  borderMuted: "rgba(255, 233, 212, 0.14)",
  text: "#f6ece0",
  textSecondary: "#d8c7b6",
  textTertiary: "rgba(246, 236, 224, 0.62)",
  primary: "#d39261",
  primaryMuted: "rgba(211, 146, 97, 0.16)",
  primaryText: "#1f1913",
  success: "#36B865",
  successMuted: "rgba(54, 184, 101, 0.15)",
  warning: "#E69237",
  warningMuted: "rgba(230, 146, 55, 0.16)",
  danger: "#e86060",
  dangerMuted: "rgba(232, 96, 96, 0.14)",
  accent: "#d39261",
  accentMuted: "rgba(211, 146, 97, 0.18)",
  shadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
};

export function useAppTheme(): AppTheme {
  const colorScheme = useColorScheme();
  return colorScheme === "dark" ? darkTheme : lightTheme;
}
