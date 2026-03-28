import { Text, View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

type StatusPillProps = {
  label: string;
  tone?: "neutral" | "primary" | "success" | "warning" | "danger";
};

export function StatusPill({ label, tone = "neutral" }: StatusPillProps) {
  const theme = useAppTheme();

  const palette = {
    neutral: {
      backgroundColor: theme.surfaceMuted,
      color: theme.textSecondary,
    },
    primary: {
      backgroundColor: theme.primaryMuted,
      color: theme.primary,
    },
    success: {
      backgroundColor: theme.successMuted,
      color: theme.success,
    },
    warning: {
      backgroundColor: theme.warningMuted,
      color: theme.warning,
    },
    danger: {
      backgroundColor: theme.dangerMuted,
      color: theme.danger,
    },
  }[tone];

  return (
    <View
      style={{
        alignSelf: "flex-start",
        borderRadius: 999,
        borderCurve: "continuous",
        backgroundColor: palette.backgroundColor,
        paddingHorizontal: 11,
        paddingVertical: 6,
      }}
    >
      <Text
        selectable
        style={{
          color: palette.color,
          fontSize: 10,
          fontWeight: "700",
          textTransform: "uppercase",
          letterSpacing: 0.7,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
