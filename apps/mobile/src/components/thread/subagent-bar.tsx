import { ScrollView, Text, View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

type AgentEntry = {
  sessionId?: string;
  nickname?: string | null;
  role?: string | null;
  executionState?: string | null;
};

type SubagentBarProps = {
  agents: AgentEntry[];
};

function agentStateColor(state: string | null | undefined, theme: ReturnType<typeof useAppTheme>): string {
  switch (state) {
    case "running":
      return theme.success;
    case "completed":
      return theme.textTertiary;
    case "error":
      return theme.danger;
    default:
      return theme.textSecondary;
  }
}

export function SubagentBar({ agents }: SubagentBarProps) {
  const theme = useAppTheme();

  if (agents.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
      style={{ marginBottom: 8 }}
    >
      {agents.map((agent, i) => (
        <View
          key={agent.sessionId ?? i}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 999,
            borderCurve: "continuous",
            backgroundColor: theme.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.borderMuted,
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: agentStateColor(agent.executionState, theme),
            }}
          />
          <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>
            {agent.nickname ?? agent.role ?? "agent"}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}
