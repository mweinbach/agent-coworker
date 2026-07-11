import type { PropsWithChildren, ReactNode } from "react";
import { Text, View } from "react-native";

import { MAX_DYNAMIC_TYPE_MULTIPLIER } from "@/features/accessibility/mobile-accessibility";
import { radius } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";

type SectionCardProps = PropsWithChildren<{
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}>;

export function SectionCard({ title, description, action, children }: SectionCardProps) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        gap: 14,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        padding: 18,
        boxShadow: theme.shadow,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flex: 1, gap: 6 }}>
          <Text
            accessibilityRole="header"
            allowFontScaling
            maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
            selectable
            style={{
              color: theme.text,
              fontSize: 17,
              fontWeight: "600",
              letterSpacing: -0.2,
            }}
          >
            {title}
          </Text>
          {description ? (
            <Text
              allowFontScaling
              maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
              selectable
              style={{
                color: theme.textSecondary,
                fontSize: 14,
                lineHeight: 20,
              }}
            >
              {description}
            </Text>
          ) : null}
        </View>
        {action ? <View>{action}</View> : null}
      </View>
      <View style={{ gap: 12 }}>{children}</View>
    </View>
  );
}
