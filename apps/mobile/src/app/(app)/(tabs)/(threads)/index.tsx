import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useThreadStore } from "@/features/cowork/threadStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useAppTheme } from "@/theme/use-app-theme";

export default function ThreadsScreen() {
  const theme = useAppTheme();
  const seedThread = useThreadStore((state) => state.seedThread);
  const threads = useThreadStore((state) => state.threads);
  const connectionState = usePairingStore((state) => state.connectionState);
  const connectionTone = connectionState.status === "connected"
    ? "success"
    : connectionState.status === "error"
      ? "danger"
      : connectionState.status === "connecting" || connectionState.status === "reconnecting" || connectionState.status === "pairing"
        ? "warning"
        : "neutral";

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      <SectionCard
        title="Your mobile coworker"
        description="Jump into a live desktop session or keep drafting locally while you are away from your keyboard."
        action={<StatusPill label={connectionState.status} tone={connectionTone} />}
      >
        <View style={{ gap: 10 }}>
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            {connectionState.connectedMacDeviceId
              ? `Connected to ${connectionState.connectedMacDeviceId}.`
              : "Not connected to a desktop right now."}{" "}
            {threads.length > 0
              ? `You have ${threads.length} ${threads.length === 1 ? "conversation" : "conversations"} ready to open.`
              : "Start a draft thread to sketch thoughts on the go."}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              seedThread();
            }}
            style={({ pressed }) => ({
              alignSelf: "flex-start",
              borderRadius: 999,
              borderCurve: "continuous",
              backgroundColor: pressed ? theme.accent : theme.primary,
              paddingHorizontal: 16,
              paddingVertical: 11,
            })}
          >
            <Text style={{ color: theme.primaryText, fontWeight: "700" }}>New draft thread</Text>
          </Pressable>
        </View>
      </SectionCard>

      <SectionCard
        title="Conversations"
        description={threads.length === 0 ? "No threads yet" : `${threads.length} available on mobile`}
      >
        {threads.length === 0 ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Your mobile thread list will populate from the shared Cowork snapshot feed after pairing, and you can also start local drafts from here.
          </Text>
        ) : (
          threads.map((thread) => (
            <Link
              key={thread.id}
              href={`/(app)/(tabs)/(threads)/thread/${thread.id}`}
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
  );
}
