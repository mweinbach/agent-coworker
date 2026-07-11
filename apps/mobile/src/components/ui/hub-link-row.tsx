import { Link } from "expo-router";
import type { ComponentProps } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  minimumTouchTarget,
} from "@/features/accessibility/mobile-accessibility";
import { useAppTheme } from "@/theme/use-app-theme";

import { SFSymbol } from "./sf-symbol";

type HubLinkRowProps = {
  label: string;
  description?: string;
  detail?: string;
  href: string;
  icon?: string;
  isLast?: boolean;
};

export function HubLinkRow({
  label,
  description,
  detail,
  href,
  icon = "square.grid.2x2",
  isLast = false,
}: HubLinkRowProps) {
  const theme = useAppTheme();
  const accessibilityLabel = [label, detail, description].filter(Boolean).join(", ");

  return (
    <Link href={href as ComponentProps<typeof Link>["href"]} asChild>
      <Pressable
        accessibilityHint="Opens a screen"
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="link"
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          minHeight: minimumTouchTarget(),
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: theme.borderMuted,
          backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
          paddingHorizontal: 16,
          paddingVertical: 10,
        })}
      >
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.primaryMuted,
          }}
        >
          <SFSymbol name={icon} size={20} color={theme.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text
            allowFontScaling
            maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
            style={{ color: theme.text, fontSize: 17, fontWeight: "400" }}
          >
            {label}
          </Text>
          {description ? (
            <Text
              allowFontScaling
              maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
              style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}
            >
              {description}
            </Text>
          ) : null}
        </View>
        <View style={{ maxWidth: "34%", alignItems: "flex-end", gap: 4 }}>
          {detail ? (
            <Text
              allowFontScaling
              maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
              style={{
                color: theme.textTertiary,
                fontSize: 13,
                textAlign: "right",
              }}
            >
              {detail}
            </Text>
          ) : null}
          <SFSymbol name="chevron.right" size={14} color={theme.textTertiary} />
        </View>
      </Pressable>
    </Link>
  );
}
