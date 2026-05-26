import { Stack, useRouter } from "expo-router";
import { Switch, Text, View } from "react-native";

import { AppButton } from "@/components/ui/app-button";
import { HubLinkRow } from "@/components/ui/hub-link-row";
import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useDisplayPreferencesStore } from "@/features/preferences/displayPreferencesStore";
import {
  describeTransportStatus,
  isWorkspaceConnectionReady,
  toneForTransportState,
} from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

export default function SettingsHubScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const activeWorkspaceCwd = useWorkspaceStore((state) => state.activeWorkspaceCwd);
  const controlSnapshot = useWorkspaceStore((state) => state.controlSnapshot);
  const connectionState = usePairingStore((state) => state.connectionState);
  const isConnected = isWorkspaceConnectionReady(connectionState);
  const showDebugMessages = useDisplayPreferencesStore((state) => state.showDebugMessages);
  const setShowDebugMessages = useDisplayPreferencesStore((state) => state.setShowDebugMessages);

  return (
    <>
      <Stack.Screen options={{ headerRight: () => null, unstable_headerRightItems: () => [] }} />
      <Screen scroll contentStyle={{ gap: 16 }}>
        <View
          style={{
            gap: 18,
            borderRadius: 30,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surface,
            padding: 22,
            boxShadow: theme.shadow,
          }}
        >
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              <StatusPill
                label={describeTransportStatus(connectionState)}
                tone={toneForTransportState(connectionState)}
              />
              {controlSnapshot?.config?.provider ? (
                <StatusPill label={controlSnapshot.config.provider} tone="primary" />
              ) : null}
            </View>
            <Text
              selectable
              style={{
                color: theme.text,
                fontSize: 30,
                lineHeight: 34,
                fontWeight: "800",
                letterSpacing: -0.6,
              }}
            >
              Companion settings
            </Text>
            <Text
              selectable
              style={{
                color: theme.textSecondary,
                fontSize: 15,
                lineHeight: 22,
              }}
            >
              Keep remote access, providers, integrations, memory, and workspace defaults close at
              hand from the phone.
            </Text>
          </View>

          <View
            style={{
              gap: 8,
              borderRadius: 20,
              borderCurve: "continuous",
              backgroundColor: theme.surfaceElevated,
              padding: 16,
            }}
          >
            <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>
              {activeWorkspaceName ?? "No active workspace"}
            </Text>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 19 }}>
              {activeWorkspaceCwd ?? "Pair with a desktop to populate the live workspace context."}
            </Text>
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <AppButton
              icon={isConnected ? "iphone.and.arrow.forward" : "qrcode.viewfinder"}
              onPress={() => router.push(isConnected ? "/(pairing)" : "/(pairing)/scan")}
            >
              {isConnected ? "Remote access" : "Connect desktop"}
            </AppButton>
            <AppButton
              variant="secondary"
              icon="sparkles"
              onPress={() => router.push("/(app)/(tabs)/skills")}
            >
              Skills
            </AppButton>
          </View>
        </View>

        <SectionCard
          title="Connection"
          description="Relay health, trusted computers, and the active workspace session."
        >
          <HubLinkRow
            label="Remote access"
            description="Scan a pairing code, reconnect a trusted computer, and inspect secure session details."
            detail={describeTransportStatus(connectionState)}
            href="/(pairing)"
            icon="iphone.and.arrow.forward"
          />
          <HubLinkRow
            label="Workspace hub"
            description="Jump to workspace-specific settings, memory, backups, and defaults."
            detail={activeWorkspaceName ?? undefined}
            href="/(app)/(tabs)/workspace"
            icon="square.grid.2x2"
          />
        </SectionCard>

        <SectionCard
          title="Workspace controls"
          description="These pages act on the live control session exposed by the paired desktop."
        >
          <HubLinkRow
            label="Providers"
            description="Authorization health, model availability, account context, and rate-limit snapshots."
            detail={controlSnapshot?.config?.provider ?? undefined}
            href="/(app)/settings/providers"
            icon="person.crop.circle.badge.checkmark"
          />
          <HubLinkRow
            label="Integrations"
            description="Manage MCP servers, auth flows, callbacks, and validation results."
            detail={controlSnapshot?.settings?.enableMcp ? "Enabled" : "Off"}
            href="/(app)/settings/mcp"
            icon="puzzlepiece.extension"
          />
          <HubLinkRow
            label="Usage"
            description="Inspect thread counts, token totals, and estimated spend from synced session snapshots."
            href="/(app)/settings/usage"
            icon="chart.bar"
          />
          <HubLinkRow
            label="Skills"
            description="Install, inspect, and update managed skills for the current workspace."
            href="/(app)/(tabs)/skills"
            icon="sparkles"
          />
        </SectionCard>

        <SectionCard title="Display" description="Tune how conversations render on this device.">
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
            }}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
                Show debug messages
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 19 }}>
                Include system and log lines such as observability health checks in thread feeds.
              </Text>
            </View>
            <Switch
              value={showDebugMessages}
              onValueChange={setShowDebugMessages}
              trackColor={{ true: theme.primary }}
            />
          </View>
        </SectionCard>

        <SectionCard
          title="Advanced workspace"
          description="Direct links to the workspace-specific editors already available on mobile."
        >
          <HubLinkRow
            label="General"
            description="Default provider, model routing, MCP toggle, and backup defaults."
            href="/(app)/workspace/general"
            icon="gearshape.2"
          />
          <HubLinkRow
            label="Memory"
            description="Create, filter, edit, and delete workspace or user memory entries."
            href="/(app)/workspace/memory"
            icon="brain.head.profile"
          />
          <HubLinkRow
            label="Backups"
            description="Create checkpoints, inspect deltas, restore snapshots, and clean up stale entries."
            href="/(app)/workspace/backups"
            icon="externaldrive.badge.timemachine"
          />
        </SectionCard>
      </Screen>
    </>
  );
}
