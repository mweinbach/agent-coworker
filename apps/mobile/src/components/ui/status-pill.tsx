import { Text, View } from "react-native";

import { MAX_DYNAMIC_TYPE_MULTIPLIER } from "@/features/accessibility/mobile-accessibility";
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
      accessibilityLabel={`Status: ${label}`}
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
        allowFontScaling
        maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
        selectable
        style={{
          color: palette.color,
          fontSize: 10,
          fontWeight: "600",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
