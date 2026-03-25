import type { ComponentProps } from "react";
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

type HubLinkRowProps = {
  label: string;
  description?: string;
  detail?: string;
  href: string;
};

export function HubLinkRow({ label, description, detail, href }: HubLinkRowProps) {
  const theme = useAppTheme();

  return (
    <Link href={href as ComponentProps<typeof Link>["href"]} asChild>
      <Pressable
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          borderRadius: 18,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: pressed ? theme.primary : theme.borderMuted,
          backgroundColor: pressed ? theme.surfaceMuted : theme.surfaceElevated,
          paddingHorizontal: 16,
          paddingVertical: 14,
        })}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>{label}</Text>
          {description ? (
            <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
              {description}
            </Text>
          ) : null}
        </View>
        {detail ? (
          <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "600" }}>
            {detail}
          </Text>
        ) : null}
      </Pressable>
    </Link>
  );
}
