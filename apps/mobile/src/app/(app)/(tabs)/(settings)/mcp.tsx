import { Text } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useAppTheme } from "@/theme/use-app-theme";

export default function McpServersScreen() {
  const theme = useAppTheme();

  return (
    <Screen scroll>
      <SectionCard title="MCP Servers" description="View and manage MCP server integrations.">
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          MCP server management will load here once connected to a workspace.
        </Text>
      </SectionCard>
    </Screen>
  );
}
