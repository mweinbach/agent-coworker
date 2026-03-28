import type { ComponentProps } from "react";
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

import { SFSymbol } from "./sf-symbol";

type HubLinkRowProps = {
  label: string;
  description?: string;
  detail?: string;
  href: string;
  icon?: string;
};

export function HubLinkRow({
  label,
  description,
  detail,
  href,
  icon = "square.grid.2x2",
}: HubLinkRowProps) {
  const theme = useAppTheme();

  return (
    <Link href={href as ComponentProps<typeof Link>["href"]} asChild>
      <Pressable
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          borderRadius: 20,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: pressed ? theme.primary : theme.borderMuted,
          backgroundColor: pressed ? theme.surfaceMuted : theme.surfaceElevated,
          paddingHorizontal: 14,
          paddingVertical: 14,
        })}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 14,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.primaryMuted,
          }}
        >
          <SFSymbol name={icon} size={20} color={theme.primary} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>{label}</Text>
          {description ? (
            <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
              {description}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          {detail ? (
            <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "600" }}>
              {detail}
            </Text>
          ) : null}
          <SFSymbol name="chevron.right" size={14} color={theme.textTertiary} />
        </View>
      </Pressable>
    </Link>
  );
}
