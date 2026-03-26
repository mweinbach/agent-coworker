import { Text, View } from "react-native";

import { HubLinkRow } from "@/components/ui/hub-link-row";
import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";

export default function SettingsHubScreen() {
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const activeWorkspaceCwd = useWorkspaceStore((state) => state.activeWorkspaceCwd);
  const controlSnapshot = useWorkspaceStore((state) => state.controlSnapshot);

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      <SectionCard
        title="Settings"
        description={activeWorkspaceCwd ?? "Connect to a desktop to manage workspace-level settings."}
      >
        <Text selectable style={{ fontSize: 14, lineHeight: 21 }}>
          {activeWorkspaceName ?? "No workspace selected"}
        </Text>
      </SectionCard>

      <SectionCard
        title="Models & Tools"
        description="Provider auth, model defaults, and MCP integrations for this workspace."
      >
        <View style={{ gap: 10 }}>
          <HubLinkRow
            label="Providers"
            description="API keys, OAuth, account state, and rate limits."
            detail={controlSnapshot?.config?.provider}
            href={"/(app)/settings/providers" as any}
          />
          <HubLinkRow
            label="Integrations"
            description="Add, validate, authenticate, and migrate MCP servers."
            href={"/(app)/settings/mcp" as any}
          />
        </View>
      </SectionCard>

      <SectionCard
        title="Recovery & Data"
        description="Usage rolls up from the live workspace snapshot."
      >
        <View style={{ gap: 10 }}>
          <HubLinkRow
            label="Usage"
            description="Threads, token totals, and estimated spend."
            href={"/(app)/settings/usage" as any}
          />
        </View>
      </SectionCard>
    </Screen>
  );
}
