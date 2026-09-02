import { ScrollView, Text, View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

/**
 * Compact horizontal chip strip for active subagents in a thread.
 * Mounted from the thread detail header when snapshot.agents is non-empty.
 */

type AgentEntry = {
  sessionId?: string;
  nickname?: string | null;
  role?: string | null;
  executionState?: string | null;
};

type SubagentBarProps = {
  agents: AgentEntry[];
};

function agentStatus(
  state: string | null | undefined,
  theme: ReturnType<typeof useAppTheme>,
): { label: string; color: string } {
  switch (state) {
    case "running":
      return { label: "Running", color: theme.primary };
    case "pending_init":
      return { label: "Starting", color: theme.primary };
    case "completed":
      return { label: "Completed", color: theme.success };
    case "errored":
      return { label: "Failed", color: theme.warning };
    case "idle":
      return { label: "Idle", color: theme.textTertiary };
    case "closed":
      return { label: "Closed", color: theme.textTertiary };
    default:
      return { label: "Unknown", color: theme.textTertiary };
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
      {agents.map((agent, i) => {
        const name = agent.nickname ?? agent.role ?? "agent";
        const status = agentStatus(agent.executionState, theme);
        return (
          <View
            key={agent.sessionId ?? i}
            accessible
            accessibilityLabel={`${name}, ${status.label}`}
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
                backgroundColor: status.color,
              }}
            />
            <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>{name}</Text>
            <Text style={{ color: theme.textSecondary, fontSize: 11 }}>{status.label}</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}
