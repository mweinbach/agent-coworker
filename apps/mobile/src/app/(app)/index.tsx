import { Stack, Link } from "expo-router";
import { Fragment, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Image } from "expo-image";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { useThreadStore } from "@/features/cowork/threadStore";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import {
  describeTransportStatus,
  isWorkspaceConnectionReady,
  toneForTransportState,
} from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

export default function ThreadsScreen() {
  const theme = useAppTheme();
  const seedThread = useThreadStore((state) => state.seedThread);
  const threads = useThreadStore((state) => state.threads);
  const connectionState = usePairingStore((state) => state.connectionState);
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const controlSnapshot = useWorkspaceStore((state) => state.controlSnapshot);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const [switcherVisible, setSwitcherVisible] = useState(false);
  const connectionTone = toneForTransportState(connectionState);
  const isConnected = isWorkspaceConnectionReady(connectionState);
  const [searchQuery, setSearchQuery] = useState("");

  const modelLabel = controlSnapshot?.config?.model ?? null;

  const filteredThreads = threads.filter(t => t.title.toLowerCase().includes(searchQuery.toLowerCase()) || t.preview.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <Fragment>
      <Stack.Screen
        options={{
          title: activeWorkspaceName ?? "Cowork Mobile",
          headerLargeTitle: true,
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 16 }}>
              <Link href={"/(app)/skills" as any} asChild>
                <Pressable>
                  <Image source="sf:sparkles" style={{ width: 24, height: 24, tintColor: theme.text }} />
                </Pressable>
              </Link>
              <Link href={"/(app)/settings" as any} asChild>
                <Pressable>
                  <Image source="sf:gearshape" style={{ width: 24, height: 24, tintColor: theme.text }} />
                </Pressable>
              </Link>
            </View>
          ),
          headerLeft: () => (
            <Pressable
              onPress={() => setSwitcherVisible(true)}
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Text style={{ color: theme.text, fontSize: 17, fontWeight: "600" }}>
                {activeWorkspaceName ?? "Cowork Mobile"}
              </Text>
              <Image source="sf:chevron.down" style={{ width: 14, height: 14, tintColor: theme.textSecondary }} />
            </Pressable>
          ),
          headerSearchBarOptions: {
            placeholder: "Search threads...",
            hideWhenScrolling: false,
            onChangeText: (event) => setSearchQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setSearchQuery(""),
          },
        }}
      />
      <Screen scroll contentStyle={{ gap: 18 }}>
      <SectionCard
        title={activeWorkspaceName ?? "Cowork Mobile"}
        description={
          isConnected
            ? modelLabel
              ? `${controlSnapshot?.config?.provider ?? "provider"} / ${modelLabel}`
              : "Connected to desktop"
            : connectionState.transportMode === "fallback" && connectionState.status === "connected"
              ? "Fallback demo transport is active. Workspace controls stay disabled until native transport is available."
            : "Not connected to a desktop right now."
        }
        action={<StatusPill label={describeTransportStatus(connectionState)} tone={connectionTone} />}
      >
        <View style={{ gap: 10 }}>
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            {threads.length > 0
              ? `${threads.length} ${threads.length === 1 ? "conversation" : "conversations"} ready to open.`
              : "Start a draft thread to sketch thoughts on the go."}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                seedThread();
              }}
              style={({ pressed }) => ({
                borderRadius: 999,
                borderCurve: "continuous",
                backgroundColor: pressed ? theme.accent : theme.primary,
                paddingHorizontal: 16,
                paddingVertical: 11,
              })}
            >
              <Text style={{ color: theme.primaryText, fontWeight: "700" }}>New draft thread</Text>
            </Pressable>
            {workspaces.length > 1 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setSwitcherVisible(true)}
                style={({ pressed }) => ({
                  borderRadius: 999,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.border,
                  backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                  paddingHorizontal: 16,
                  paddingVertical: 11,
                })}
              >
                <Text style={{ color: theme.text, fontWeight: "700" }}>Switch workspace</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </SectionCard>

      <WorkspaceSwitcher
        visible={switcherVisible}
        onClose={() => setSwitcherVisible(false)}
      />

      <SectionCard
        title="Conversations"
        description={filteredThreads.length === 0 ? "No threads found" : `${filteredThreads.length} available on mobile`}
      >
        {threads.length === 0 ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Your mobile thread list will populate from the shared Cowork snapshot feed after pairing, and you can also start local drafts from here.
          </Text>
        ) : filteredThreads.length === 0 ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            No threads match your search.
          </Text>
        ) : (
          filteredThreads.map((thread) => (
            <Link
              key={thread.id}
              href={`/(app)/thread/${thread.id}` as any}
              asChild
            >
              <Pressable
                style={({ pressed }) => ({
                  gap: 10,
                  borderRadius: 22,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: pressed ? theme.primary : theme.borderMuted,
                  backgroundColor: pressed ? theme.surfaceMuted : theme.surfaceElevated,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                })}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                  <View style={{ flex: 1, gap: 5 }}>
                    <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>
                      {thread.title}
                    </Text>
                    <Text
                      numberOfLines={2}
                      selectable
                      style={{
                        color: theme.textSecondary,
                        fontSize: 14,
                        lineHeight: 20,
                      }}
                    >
                      {thread.preview}
                    </Text>
                  </View>
                  {thread.pendingPrompt ? <StatusPill label="awaiting input" tone="warning" /> : null}
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                  <Text
                    selectable
                    style={{
                      color: theme.textTertiary,
                      fontSize: 12,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {thread.updatedAtLabel}
                  </Text>
                  <Text
                    selectable
                    style={{
                      color: theme.textTertiary,
                      fontSize: 12,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {thread.feed.length} items
                  </Text>
                </View>
              </Pressable>
            </Link>
          ))
        )}
      </SectionCard>
    </Screen>
    </Fragment>
  );
}
