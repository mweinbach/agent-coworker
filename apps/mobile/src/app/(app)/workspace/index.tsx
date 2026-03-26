import { Text, View } from "react-native";

import { HubLinkRow } from "@/components/ui/hub-link-row";
import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

export default function WorkspaceHubScreen() {
  const theme = useAppTheme();
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const activeWorkspaceCwd = useWorkspaceStore((state) => state.activeWorkspaceCwd);
  const controlSnapshot = useWorkspaceStore((state) => state.controlSnapshot);
  const isConnected = usePairingStore((state) => isWorkspaceConnectionReady(state.connectionState));
  const modelLabel = controlSnapshot?.config?.model ?? null;

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      <SectionCard
        title={activeWorkspaceName ?? "No workspace"}
        description={activeWorkspaceCwd ?? "Connect to a desktop to access workspace features."}
        action={
          controlSnapshot?.config?.provider ? (
            <StatusPill
              label={modelLabel ?? controlSnapshot.config.provider}
              tone="primary"
            />
          ) : null
        }
      >
        {!isConnected ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Pair with a desktop via the Remote Access tab to manage workspace settings, memory, skills, and backups.
          </Text>
        ) : null}
      </SectionCard>

      {isConnected ? (
        <SectionCard title="Workspace" description="Manage defaults and workspace-scoped tools.">
          <View style={{ gap: 10 }}>
            <HubLinkRow
              label="General"
              description="Workspace model defaults, MCP, backups, web search, and subagent routing."
              detail={controlSnapshot?.config?.provider}
              href="/(app)/(tabs)/(workspace)/general"
            />
            <HubLinkRow
              label="Skills"
              description="Install, update, copy, and manage workspace skills."
              href="/(app)/(tabs)/(workspace)/skills"
            />
            <HubLinkRow
              label="Memory"
              description="Refresh, filter, edit, and delete workspace or user memory."
              href="/(app)/(tabs)/(workspace)/memory"
            />
            <HubLinkRow
              label="Backup"
              description="Create checkpoints, inspect deltas, and restore workspace backups."
              href="/(app)/(tabs)/(workspace)/backups"
            />
          </View>
        </SectionCard>
      ) : null}
    </Screen>
  );
}
