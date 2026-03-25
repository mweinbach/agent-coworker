import { useState } from "react";
import { Pressable, Text, View } from "react-native";

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
  const preview = isLong
    ? lines.slice(0, 3).join("\n") + (lines.length > 3 ? "..." : "")
    : text;

  return (
    <Pressable
      onPress={isLong ? () => setExpanded(!expanded) : undefined}
      style={{
        gap: 8,
        borderRadius: 22,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: theme.border,
        borderLeftWidth: 3,
        borderLeftColor: theme.accent,
        backgroundColor: theme.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text
          style={{
            color: theme.accent,
            fontSize: 11,
            fontWeight: "700",
            letterSpacing: 0.6,
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
        selectable
        style={{
          color: theme.text,
          fontSize: 14,
          lineHeight: 21,
          fontStyle: "italic",
          opacity: 0.85,
        }}
      >
        {expanded ? text : preview}
      </Text>
    </Pressable>
  );
}
