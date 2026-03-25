import type { ComponentProps } from "react";
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

type WorkspaceHref = ComponentProps<typeof Link>["href"];

function WorkspaceRow({ label, detail, href }: { label: string; detail?: string; href: WorkspaceHref }) {
  const theme = useAppTheme();
  return (
    <Link href={href} asChild>
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

export default function WorkspaceHubScreen() {
  const theme = useAppTheme();
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const activeWorkspaceCwd = useWorkspaceStore((state) => state.activeWorkspaceCwd);
  const sessionState = useWorkspaceStore((state) => state.sessionState);
  const isConnected = usePairingStore((state) => isWorkspaceConnectionReady(state.connectionState));

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      <SectionCard
        title={activeWorkspaceName ?? "No workspace"}
        description={activeWorkspaceCwd ?? "Connect to a desktop to access workspace features."}
        action={
          sessionState?.provider ? (
            <StatusPill
              label={sessionState.effectiveModel ?? sessionState.model ?? sessionState.provider}
              tone="primary"
            />
          ) : null
        }
      >
        {!isConnected ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Pair with a desktop via the Connection tab to manage workspace skills, memory, and backups.
          </Text>
        ) : null}
      </SectionCard>

      {isConnected ? (
        <SectionCard title="Manage" description="Skills, memory, and backups for this workspace.">
          <View style={{ gap: 10 }}>
            <WorkspaceRow
              label="Skills"
              href="/(app)/(tabs)/(workspace)/skills"
            />
            <WorkspaceRow
              label="Memory"
              href="/(app)/(tabs)/(workspace)/memory"
            />
            <WorkspaceRow
              label="Backups"
              href="/(app)/(tabs)/(workspace)/backups"
            />
          </View>
        </SectionCard>
      ) : null}
    </Screen>
  );
}
