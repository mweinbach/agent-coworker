import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  minimumTouchTarget,
} from "@/features/accessibility/mobile-accessibility";
import { radius } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";

type ReasoningCardProps = {
  mode: "reasoning" | "summary";
  text: string;
};

export function ReasoningCard({ mode, text }: ReasoningCardProps) {
  const theme = useAppTheme();
  const [expanded, setExpanded] = useState(false);

  const lines = text.split("\n");
  const isLong = lines.length > 4 || text.length > 300;
  const preview = isLong ? lines.slice(0, 3).join("\n") + (lines.length > 3 ? "..." : "") : text;

  return (
    <Pressable
      onPress={isLong ? () => setExpanded(!expanded) : undefined}
      accessibilityRole={isLong ? "button" : undefined}
      accessibilityLabel={
        isLong
          ? `${expanded ? "Collapse" : "Expand"} ${mode === "summary" ? "summary" : "reasoning"}`
          : undefined
      }
      accessibilityState={isLong ? { expanded } : undefined}
      style={{
        minHeight: minimumTouchTarget(),
        gap: 8,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text
          maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
          style={{
            color: theme.textTertiary,
            fontSize: 11,
            fontWeight: "600",
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          {mode === "summary" ? "Summary" : "Reasoning"}
        </Text>
        {isLong ? (
          <Text style={{ color: theme.primary, fontSize: 11, fontWeight: "600" }}>
            {expanded ? "collapse" : "expand"}
          </Text>
        ) : null}
      </View>
      <Text
        maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
        selectable
        style={{
          color: theme.textSecondary,
          fontSize: 14,
          lineHeight: 21,
        }}
      >
        {expanded ? text : preview}
      </Text>
    </Pressable>
  );
}
