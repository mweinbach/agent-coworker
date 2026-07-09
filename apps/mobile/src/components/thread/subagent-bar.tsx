import { ScrollView, Text, View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

/**
 * Compact horizontal chip strip for active subagents in a thread.
 *
 * Intentionally not mounted yet: mobile thread chrome does not currently
 * surface agent lists from the snapshot reducer with enough fidelity.
 * Keep this component for when thread detail gains a dedicated agents strip;
 * do not delete it as dead code until that surface ships or is cancelled.
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

function agentStateColor(
  state: string | null | undefined,
  theme: ReturnType<typeof useAppTheme>,
): string {
  switch (state) {
    // Mirror desktop ContextSidebar agentStatusIcon: running/pending_init=accent,
    // completed=success, errored=warning, idle/closed=muted. Values are the
    // AgentExecutionState union from the server (note: "errored", not "error").
    case "running":
    case "pending_init":
      return theme.primary;
    case "completed":
      return theme.success;
    case "errored":
      return theme.warning;
    default:
      return theme.textTertiary;
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
