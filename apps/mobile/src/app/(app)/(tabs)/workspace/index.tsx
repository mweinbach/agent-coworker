import { Link, Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { AppButton } from "@/components/ui/app-button";
import { HeaderGlassButton } from "@/components/ui/header-glass-button";
import { HubLinkRow } from "@/components/ui/hub-link-row";
import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { SFSymbol } from "@/components/ui/sf-symbol";
import { StatusPill } from "@/components/ui/status-pill";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { describeTransportStatus, isWorkspaceConnectionReady, toneForTransportState } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

function WorkspaceMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        flex: 1,
        gap: 4,
        borderRadius: 18,
        borderCurve: "continuous",
        backgroundColor: theme.surfaceElevated,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <Text selectable style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "600" }}>
        {label}
      </Text>
      <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "800" }}>
        {value}
      </Text>
    </View>
  );
}

export default function WorkspaceHubScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const activeWorkspaceCwd = useWorkspaceStore((state) => state.activeWorkspaceCwd);
  const controlSnapshot = useWorkspaceStore((state) => state.controlSnapshot);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  
  const connectionState = usePairingStore((state) => state.connectionState);
  const isConnected = isWorkspaceConnectionReady(connectionState);
  const connectionTone = toneForTransportState(connectionState);
  
  const [switcherVisible, setSwitcherVisible] = useState(false);

  const providerLabel = controlSnapshot?.config?.provider ?? "Not set";
  const modelLabel = controlSnapshot?.config?.model ?? "Not set";
  const memoryLabel = controlSnapshot?.settings?.enableMemory ? "Enabled" : "Off";
  const mcpLabel = controlSnapshot?.settings?.enableMcp ? "Enabled" : "Off";

  return (
    <>
      <Stack.Screen
        options={{
          title: "Cowork Mobile",
          headerLeft: () => undefined,
          headerRight: () => (
            <Link href="/(app)/(tabs)/workspace" asChild>
              <Link.Trigger>
                <HeaderGlassButton
                  icon="ellipsis"
                  onPress={() => {}}
                />
              </Link.Trigger>
              <Link.Menu>
                <Link.MenuAction
                  title="Threads"
                  icon="bubble.left.and.bubble.right"
                  onPress={() => router.push("/(app)/(tabs)/threads")}
                />
                <Link.MenuAction
                  title="Skills"
                  icon="sparkles"
                  onPress={() => router.push("/(app)/(tabs)/skills")}
                />
                <Link.MenuAction
                  title="Settings"
                  icon="slider.horizontal.3"
                  onPress={() => router.push("/(app)/(tabs)/settings")}
                />
              </Link.Menu>
            </Link>
          ),
        }}
      />
      <Screen scroll contentStyle={{ gap: 16 }}>
        <View
          style={{
            gap: 16,
            borderRadius: 30,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surface,
            padding: 22,
            boxShadow: theme.shadow,
          }}
        >
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              <StatusPill
                label={describeTransportStatus(connectionState)}
                tone={connectionTone}
              />
              {controlSnapshot?.config?.provider ? (
                <StatusPill label={controlSnapshot.config.provider} tone="primary" />
              ) : null}
            </View>
            <View style={{ gap: 8 }}>
              <Pressable
                onPress={() => setSwitcherVisible(true)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  opacity: pressed ? 0.7 : 1,
                  alignSelf: "flex-start",
                  borderRadius: 14,
                  backgroundColor: theme.surfaceMuted,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderWidth: 1,
                  borderColor: theme.borderMuted,
                })}
              >
                <SFSymbol name="folder.fill" size={16} color={theme.primary} />
                <Text
                  style={{
                    color: theme.text,
                    fontSize: 16,
                    fontWeight: "800",
                    flexShrink: 1,
                  }}
                  numberOfLines={1}
                >
                  {activeWorkspaceName ?? "Select Workspace"}
                </Text>
                <SFSymbol name="chevron.up.chevron.down" size={12} color={theme.textSecondary} />
              </Pressable>
              <Text
                selectable
                style={{
                  color: theme.textSecondary,
                  fontSize: 15,
                  lineHeight: 22,
                }}
              >
                {isConnected
                  ? activeWorkspaceCwd ?? `Follow live work from your desktop and keep ${providerLabel} on ${modelLabel}.`
                  : "Pair with a desktop to bring live threads, approvals, and workspace defaults onto this phone."}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: "row", gap: 10 }}>
            <WorkspaceMetric label="Model" value={modelLabel} />
            <WorkspaceMetric label="Workspaces" value={String(workspaces.length || 1)} />
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <AppButton
              icon={isConnected ? "gearshape.2" : "qrcode.viewfinder"}
              onPress={() => router.push(isConnected ? "/(app)/workspace/general" : "/(pairing)/scan")}
            >
              {isConnected ? "Edit defaults" : "Scan QR Code"}
            </AppButton>
            {!isConnected ? (
              <AppButton
                variant="secondary"
                icon="gearshape.2"
                onPress={() => router.push("/(app)/(tabs)/settings")}
              >
                Open settings
              </AppButton>
            ) : (
              <AppButton
                variant="secondary"
                icon="brain.head.profile"
                onPress={() => router.push("/(app)/workspace/memory")}
              >
                Memory
              </AppButton>
            )}
          </View>
        </View>

        <SectionCard
          title="Workspace editors"
          description="These mobile pages already expose the active workspace controls instead of punting everything back to desktop."
        >
          <HubLinkRow
            label="General"
            description="Provider, model, child-model routing, MCP, and backup defaults."
            detail={providerLabel}
            href="/(app)/workspace/general"
            icon="gearshape.2"
          />
          <HubLinkRow
            label="Memory"
            description="Read and write workspace or user memory entries with scope filters."
            detail={memoryLabel}
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

        <SectionCard
          title="Related controls"
          description="Companion pages that affect the same live workspace session."
        >
          <HubLinkRow
            label="Providers"
            description="Current auth state, provider accounts, model catalogs, and limits."
            href="/(app)/settings/providers"
            icon="person.crop.circle.badge.checkmark"
          />
          <HubLinkRow
            label="Integrations"
            description="MCP servers, auth callbacks, API keys, and validation results."
            detail={mcpLabel}
            href="/(app)/settings/mcp"
            icon="puzzlepiece.extension"
          />
          <HubLinkRow
            label="Usage"
            description="Thread totals, token counts, and estimated spend from synced snapshots."
            href="/(app)/settings/usage"
            icon="chart.bar"
          />
        </SectionCard>

        <WorkspaceSwitcher
          visible={switcherVisible}
          onClose={() => setSwitcherVisible(false)}
        />
      </Screen>
    </>
  );
}
