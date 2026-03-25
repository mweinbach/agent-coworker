import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { useAppTheme } from "@/theme/use-app-theme";

function SettingsRow({ label, detail, href }: { label: string; detail?: string; href: string }) {
  const theme = useAppTheme();
  return (
    <Link href={href as `/${string}`} asChild>
      <Pressable
        style={({ pressed }) => ({
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderRadius: 16,
          borderCurve: "continuous",
          backgroundColor: pressed ? theme.surfaceMuted : theme.surfaceElevated,
          borderWidth: 1,
          borderColor: pressed ? theme.primary : theme.borderMuted,
        })}
      >
        <Text style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>{label}</Text>
        {detail ? (
          <Text style={{ color: theme.textSecondary, fontSize: 14 }}>{detail}</Text>
        ) : null}
      </Pressable>
    </Link>
  );
}

export default function SettingsHubScreen() {
  const sessionState = useWorkspaceStore((state) => state.sessionState);

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      <SectionCard
        title="Configuration"
        description="Manage providers, models, integrations, and usage for the active workspace."
      >
        <View style={{ gap: 10 }}>
          <SettingsRow
            label="Providers"
            detail={sessionState?.provider ?? undefined}
            href="/(app)/(tabs)/(settings)/providers"
          />
          <SettingsRow
            label="Models"
            detail={sessionState?.effectiveModel ?? sessionState?.model ?? undefined}
            href="/(app)/(tabs)/(settings)/models"
          />
          <SettingsRow
            label="MCP Servers"
            href="/(app)/(tabs)/(settings)/mcp"
          />
          <SettingsRow
            label="Usage"
            href="/(app)/(tabs)/(settings)/usage"
          />
        </View>
      </SectionCard>
    </Screen>
  );
}
